import { createHash } from "node:crypto";

import { BASE_USDC_ASSET } from "../contracts.js";
import type {
  CanonicalIdentity,
  ExactAuthorizationDescriptor,
  JsonValue,
  OperationDescriptor,
} from "./types.js";

const OPERATION_DOMAIN = "x402-canary:operation:v0.1";
const AUTHORIZATION_DOMAIN = "x402-canary:authorization:v0.1";
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const OPERATION_FIELDS = new Set(["url", "method", "headers", "body"]);
const AUTHORIZATION_FIELDS = new Set([
  "networkId",
  "asset",
  "from",
  "to",
  "valueAtomic",
  "validAfter",
  "validBefore",
  "nonce",
]);

const PAYMENT_HEADER_NAMES = new Set([
  "authorization",
  "payment",
  "payment-authorization",
  "payment-signature",
  "x-payment",
  "x-payment-token",
  "x402-authorization",
  "x402-payment",
  "x402-payment-signature",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON numbers must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON integers must be within the safe integer range");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Canonical JSON must not contain cycles");
    ancestors.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error("Canonical JSON arrays must not be sparse");
        }
        items.push(canonicalize(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    throw new Error("Canonical JSON accepts only JSON primitives, arrays, and plain objects");
  }
  if (ancestors.has(value)) throw new Error("Canonical JSON must not contain cycles");
  ancestors.add(value);
  try {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Deterministic JSON serialization with recursive object-key ordering. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

function sha256Id(preimage: string): string {
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

function normalizeHttpsUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("Operation URL is required");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Operation URL must be an absolute HTTPS URL");
  }

  if (url.protocol !== "https:") throw new Error("Operation URL must use HTTPS");
  if (url.username || url.password) throw new Error("Operation URL must not contain credentials");
  if (url.hash) throw new Error("Operation URL must not contain a fragment");
  if (!url.hostname) throw new Error("Operation URL must include a hostname");

  // WHATWG URL serialization lowercases the host, removes the default port,
  // resolves dot segments, and percent-encodes unsafe characters. Query order
  // is deliberately retained because some request handlers treat it as semantic.
  return url.toString();
}

function isPaymentHeader(name: string): boolean {
  return (
    PAYMENT_HEADER_NAMES.has(name) ||
    name.startsWith("x-payment-") ||
    name.startsWith("x402-payment-")
  );
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new Error("Operation headers must be a plain object");

  const normalized = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(raw)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName)) {
      throw new Error(`Invalid HTTP header name: ${rawName}`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`HTTP header ${rawName} must have a string value`);
    }

    const name = rawName.toLowerCase();
    if (isPaymentHeader(name)) {
      throw new Error(`Payment credential header must not be included in an operation identity: ${name}`);
    }
    if (normalized.has(name)) {
      throw new Error(`Duplicate HTTP header after normalization: ${name}`);
    }
    if (/[^\t\x20-\x7e\x80-\xff]/.test(rawValue)) {
      throw new Error(`HTTP header ${rawName} contains a prohibited control character`);
    }

    // Leading/trailing optional whitespace is not semantic HTTP field-value
    // content. Internal whitespace is preserved because application headers
    // can assign meaning to it.
    normalized.set(name, rawValue.replace(/^[ \t]+|[ \t]+$/g, ""));
  }

  return Object.fromEntries([...normalized.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function deriveOperationIdentity(operation: OperationDescriptor): CanonicalIdentity {
  if (!isPlainObject(operation)) throw new Error("Operation must be a plain object");
  for (const key of Object.keys(operation)) {
    if (!OPERATION_FIELDS.has(key)) throw new Error(`Unexpected operation field: ${key}`);
  }

  const rawMethod = operation.method as unknown;
  if (typeof rawMethod !== "string") throw new Error("Operation method is required");
  const method = rawMethod.toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new Error(`Unsupported operation method: ${rawMethod}`);

  const body = operation.body;
  if (body !== undefined) canonicalJson(body);

  const payload: JsonValue = {
    body: body === undefined ? { present: false } : { present: true, value: body },
    headers: normalizeHeaders(operation.headers),
    method,
    url: normalizeHttpsUrl(operation.url),
  };
  const canonical = `${OPERATION_DOMAIN}\n${canonicalJson(payload)}`;

  return { algorithm: "sha256", canonical, id: sha256Id(canonical) };
}

function normalizeAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${field} must be a 20-byte 0x-prefixed EVM address`);
  }
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) throw new Error(`${field} must not be the zero address`);
  return normalized;
}

function normalizeUint256Decimal(value: unknown, field: string, allowZero: boolean): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(`${field} exceeds uint256`);
  if (!allowZero && parsed === 0n) throw new Error(`${field} must be greater than zero`);
  return value;
}

function normalizeNonce(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("nonce must be a 32-byte 0x-prefixed value");
  }
  return value.toLowerCase();
}

export function deriveAuthorizationIdentity(
  authorization: ExactAuthorizationDescriptor,
): CanonicalIdentity {
  if (!isPlainObject(authorization)) throw new Error("Authorization must be a plain object");
  for (const key of Object.keys(authorization)) {
    if (!AUTHORIZATION_FIELDS.has(key)) {
      throw new Error(`Unexpected authorization field: ${key}`);
    }
  }
  for (const field of AUTHORIZATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(authorization, field)) {
      throw new Error(`Missing authorization field: ${field}`);
    }
  }

  if (authorization.networkId !== "eip155:8453") {
    throw new Error("Authorization networkId must be Base mainnet eip155:8453");
  }
  const asset = normalizeAddress(authorization.asset, "asset");
  if (asset !== BASE_USDC_ASSET) {
    throw new Error(`Authorization asset must be native Base USDC ${BASE_USDC_ASSET}`);
  }

  const valueAtomic = normalizeUint256Decimal(authorization.valueAtomic, "valueAtomic", false);
  const validAfter = normalizeUint256Decimal(authorization.validAfter, "validAfter", true);
  const validBefore = normalizeUint256Decimal(authorization.validBefore, "validBefore", false);
  if (BigInt(validBefore) <= BigInt(validAfter)) {
    throw new Error("validBefore must be greater than validAfter");
  }

  const payload: JsonValue = {
    asset,
    from: normalizeAddress(authorization.from, "from"),
    networkId: authorization.networkId,
    nonce: normalizeNonce(authorization.nonce),
    to: normalizeAddress(authorization.to, "to"),
    validAfter,
    validBefore,
    valueAtomic,
  };
  const canonical = `${AUTHORIZATION_DOMAIN}\n${canonicalJson(payload)}`;

  return { algorithm: "sha256", canonical, id: sha256Id(canonical) };
}
