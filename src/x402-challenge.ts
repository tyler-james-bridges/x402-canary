import type { PaymentContract } from "./contracts.js";
import {
  BASE_MAINNET_NETWORK,
  BASE_USDC_ASSET,
} from "./contracts.js";

const MAX_CHALLENGE_TIMEOUT_SECONDS = 60;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE_USDC_EIP712_DOMAIN = {
  name: "USD Coin",
  version: "2",
} as const;

export interface X402Requirement extends Record<string, unknown> {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface X402Payload extends Record<string, unknown> {
  x402Version: number;
  resource: {
    url: string;
    [key: string]: unknown;
  };
  accepts: unknown[];
}

export interface RecordedHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
}

export interface RecordedBrowserObservation {
  origin: string;
  requestMethod: string;
  requestHeaders: string[];
  preflight: RecordedHttpResponse;
}

export interface NoSpendResponseShape {
  challenge: RecordedHttpResponse;
  browser?: RecordedBrowserObservation;
}

export interface NoSpendAcceptancePredicates {
  returns402: boolean;
  challengeValid: boolean;
  browserReadable: boolean;
  preflightValid: boolean;
  contractCompatible: boolean;
  errors: {
    challenge: string[];
    browser: string[];
    preflight: string[];
    contract: string[];
  };
}

export type ChallengeValidation =
  | { ok: true; payload: X402Payload; accepted: X402Requirement; quotedUsd: number }
  | { ok: false; error: string };

export function hasSiwxExtension(header: string | null): boolean {
  if (!header) return false;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
    if (!record(payload) || !record(payload["extensions"])) return false;
    const siwx = payload["extensions"]["sign-in-with-x"];
    return record(siwx) && record(siwx["info"]);
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function headerTokens(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean));
}

function allowsOrigin(headers: Record<string, string | undefined>, origin: string): boolean {
  const allowed = headerValue(headers, "access-control-allow-origin");
  return allowed === "*" || allowed === origin;
}

function structurallyValidRequirement(value: unknown): boolean {
  if (!record(value)) return false;
  const amount = value["amount"];
  return typeof value["scheme"] === "string" && value["scheme"].length > 0 &&
    typeof value["network"] === "string" && value["network"].length > 0 &&
    typeof amount === "string" && /^\d+$/.test(amount) && BigInt(amount) > 0n &&
    typeof value["asset"] === "string" && value["asset"].length > 0 &&
    typeof value["payTo"] === "string" && value["payTo"].length > 0 &&
    typeof value["maxTimeoutSeconds"] === "number" &&
    Number.isInteger(value["maxTimeoutSeconds"]) && value["maxTimeoutSeconds"] > 0;
}

function normalizedHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function decodeChallengeHeader(header: string | null | undefined): {
  payload?: X402Payload;
  errors: string[];
} {
  if (!header) return { errors: ["Missing Payment-Required header"] };

  const errors: string[] = [];
  let encoded = header.trim();
  const noncanonicalPrefix = encoded.match(/^payment\s+(.+)$/i);
  if (noncanonicalPrefix) {
    errors.push("Payment-Required uses a noncanonical payment prefix");
    encoded = noncanonicalPrefix[1];
  }
  if (!BASE64.test(encoded)) {
    return { errors: [...errors, "Payment-Required is not canonical base64"] };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
  } catch {
    return { errors: [...errors, "Payment-Required is not valid base64 JSON"] };
  }
  if (!record(payload) || payload["x402Version"] !== 2 || !Array.isArray(payload["accepts"])) {
    return { errors: [...errors, "Payment-Required is not a valid x402 v2 challenge"] };
  }
  if (!record(payload["resource"]) || normalizedHttpsUrl(payload["resource"]["url"]) === undefined) {
    errors.push("Payment-Required resource.url must be an HTTPS URL");
  }
  if (payload["accepts"].length === 0 || !payload["accepts"].every(structurallyValidRequirement)) {
    errors.push("Payment-Required contains a structurally invalid payment requirement");
  }
  return { payload: payload as X402Payload, errors };
}

function paymentMaxAtomic(payment: PaymentContract): bigint | undefined {
  if (!/^\d+$/.test(payment.maxAmountAtomic)) return undefined;
  const value = BigInt(payment.maxAmountAtomic);
  return value > 0n ? value : undefined;
}

function matchingUsdCap(payment: PaymentContract, maxAmountAtomic: bigint | undefined): boolean {
  if (!Number.isFinite(payment.maxAmountUsd) || payment.maxAmountUsd <= 0) return false;
  const usdAtomic = Math.round(payment.maxAmountUsd * 1_000_000);
  return maxAmountAtomic !== undefined &&
    Number.isSafeInteger(usdAtomic) &&
    Math.abs((usdAtomic / 1_000_000) - payment.maxAmountUsd) <= Number.EPSILON &&
    BigInt(usdAtomic) === maxAmountAtomic;
}

function validPaymentPolicy(payment: PaymentContract): boolean {
  const maxAmountAtomic = paymentMaxAtomic(payment);
  return payment.protocol === "x402" &&
    payment.network === "base" &&
    payment.scheme === "exact" &&
    payment.networkId === BASE_MAINNET_NETWORK &&
    payment.asset.toLowerCase() === BASE_USDC_ASSET &&
    EVM_ADDRESS.test(payment.payTo) &&
    payment.payTo.toLowerCase() !== ZERO_ADDRESS &&
    matchingUsdCap(payment, maxAmountAtomic);
}

function validEip3009Extra(value: Record<string, unknown>): boolean {
  const extra = value["extra"];
  if (!record(extra)) return false;
  if (
    extra["assetTransferMethod"] !== undefined &&
    extra["assetTransferMethod"] !== "eip3009"
  ) return false;
  return extra["name"] === BASE_USDC_EIP712_DOMAIN.name &&
    extra["version"] === BASE_USDC_EIP712_DOMAIN.version;
}

function validRequirement(value: unknown, payment: PaymentContract): value is X402Requirement {
  if (!record(value)) return false;
  const expectedNetwork = payment.networkId;
  const expectedAsset = payment.asset.toLowerCase();
  const expectedPayTo = payment.payTo.toLowerCase();
  const maxAmountAtomic = paymentMaxAtomic(payment);
  const amount = value["amount"];
  const asset = value["asset"];
  const payTo = value["payTo"];
  return value["scheme"] === payment.scheme &&
    value["network"] === expectedNetwork &&
    typeof amount === "string" && /^\d+$/.test(amount) && BigInt(amount) > 0n &&
    maxAmountAtomic !== undefined && BigInt(amount) <= maxAmountAtomic &&
    typeof asset === "string" && asset.toLowerCase() === expectedAsset &&
    typeof payTo === "string" && EVM_ADDRESS.test(payTo) &&
    payTo.toLowerCase() !== ZERO_ADDRESS &&
    payTo.toLowerCase() === expectedPayTo &&
    typeof value["maxTimeoutSeconds"] === "number" &&
    Number.isInteger(value["maxTimeoutSeconds"]) && value["maxTimeoutSeconds"] > 0 &&
    value["maxTimeoutSeconds"] <= MAX_CHALLENGE_TIMEOUT_SECONDS &&
    validEip3009Extra(value);
}

export function validatePaymentRequired(
  header: string | null,
  payment: PaymentContract,
  expectedResourceUrl: string,
): ChallengeValidation {
  if (!validPaymentPolicy(payment)) {
    return { ok: false, error: "Payment contract must bind Base mainnet, native USDC, exact, payTo, and an atomic cap" };
  }
  const normalizedExpectedResource = normalizedHttpsUrl(expectedResourceUrl);
  if (!normalizedExpectedResource) {
    return { ok: false, error: "RESOURCE_UNBOUND: an HTTPS contracted resource URL is required" };
  }
  const decoded = decodeChallengeHeader(header);
  if (!decoded.payload || decoded.errors.length > 0) {
    return { ok: false, error: decoded.errors.join("; ") };
  }
  if (normalizedHttpsUrl(decoded.payload.resource.url) !== normalizedExpectedResource) {
    return {
      ok: false,
      error: `RESOURCE_MISMATCH: challenge resource ${decoded.payload.resource.url} does not match ${normalizedExpectedResource}`,
    };
  }
  const requirements = decoded.payload.accepts.filter(
    (value): value is X402Requirement => validRequirement(value, payment),
  );
  if (requirements.length === 0) {
    return { ok: false, error: "No contract-compatible Base USDC exact EIP-3009 requirement" };
  }
  if (requirements.length > 1) {
    return { ok: false, error: "Ambiguous challenge contains multiple contract-compatible requirements" };
  }
  const accepted = requirements[0];
  const quotedUsd = Number(BigInt(accepted.amount)) / 1_000_000;
  if (!Number.isFinite(quotedUsd) || quotedUsd > payment.maxAmountUsd) {
    return {
      ok: false,
      error: `Quoted price $${quotedUsd} exceeds the $${payment.maxAmountUsd} cap`,
    };
  }
  return { ok: true, payload: decoded.payload, accepted, quotedUsd };
}

export function singleRequirementHeader(validation: Extract<ChallengeValidation, { ok: true }>): string {
  const payload = { ...validation.payload, accepts: [validation.accepted] };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function evaluateNoSpendResponse(
  shape: NoSpendResponseShape,
  payment: PaymentContract,
  expectedResourceUrl: string,
): NoSpendAcceptancePredicates {
  const errors: NoSpendAcceptancePredicates["errors"] = {
    challenge: [],
    browser: [],
    preflight: [],
    contract: [],
  };
  const returns402 = shape.challenge.status === 402;
  if (!returns402) errors.challenge.push(`Expected HTTP 402, got HTTP ${shape.challenge.status}`);

  const paymentRequired = headerValue(shape.challenge.headers, "payment-required");
  const decoded = decodeChallengeHeader(paymentRequired);
  errors.challenge.push(...decoded.errors);
  const advertisedVersion = headerValue(shape.challenge.headers, "x-payment-version");
  if (
    advertisedVersion !== undefined &&
    decoded.payload !== undefined &&
    Number(advertisedVersion) !== decoded.payload.x402Version
  ) {
    errors.challenge.push(
      `X-Payment-Version ${advertisedVersion} conflicts with x402Version ${decoded.payload.x402Version}`,
    );
  }
  const challengeValid = returns402 && errors.challenge.length === 0;

  let browserReadable = false;
  let preflightValid = false;
  if (!shape.browser) {
    errors.browser.push("Browser observation is missing");
    errors.preflight.push("Preflight observation is missing");
  } else {
    const exposed = headerTokens(headerValue(
      shape.challenge.headers,
      "access-control-expose-headers",
    ));
    if (!allowsOrigin(shape.challenge.headers, shape.browser.origin)) {
      errors.browser.push("Challenge response does not allow the browser origin");
    }
    if (!exposed.has("*") && !exposed.has("payment-required")) {
      errors.browser.push("Challenge response does not expose Payment-Required");
    }
    browserReadable = returns402 && paymentRequired !== undefined && errors.browser.length === 0;

    const preflight = shape.browser.preflight;
    if (preflight.status < 200 || preflight.status >= 300) {
      errors.preflight.push(`Preflight returned HTTP ${preflight.status}`);
    }
    if (!allowsOrigin(preflight.headers, shape.browser.origin)) {
      errors.preflight.push("Preflight does not allow the browser origin");
    }
    const methods = headerTokens(headerValue(preflight.headers, "access-control-allow-methods"));
    if (!methods.has(shape.browser.requestMethod.toLowerCase())) {
      errors.preflight.push(`Preflight does not allow ${shape.browser.requestMethod.toUpperCase()}`);
    }
    const allowedHeaders = headerTokens(headerValue(
      preflight.headers,
      "access-control-allow-headers",
    ));
    const missingHeaders = shape.browser.requestHeaders.filter(
      (name) => !allowedHeaders.has("*") && !allowedHeaders.has(name.toLowerCase()),
    );
    if (missingHeaders.length > 0) {
      errors.preflight.push(`Preflight does not allow headers: ${missingHeaders.join(", ")}`);
    }
    preflightValid = errors.preflight.length === 0;
  }

  let contractCompatible = false;
  if (challengeValid) {
    const validation = validatePaymentRequired(paymentRequired ?? null, payment, expectedResourceUrl);
    contractCompatible = validation.ok;
    if (!validation.ok) errors.contract.push(validation.error);
  } else {
    errors.contract.push("Challenge must be valid before contract compatibility is evaluated");
  }

  return {
    returns402,
    challengeValid,
    browserReadable,
    preflightValid,
    contractCompatible,
    errors,
  };
}
