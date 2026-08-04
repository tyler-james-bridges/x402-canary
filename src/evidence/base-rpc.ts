import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import { canonicalJson } from "./canonical.js";
import type {
  AuthorizationStateObservation,
  BaseReceiptLog,
  BaseReceiptObservation,
  BaseTransactionReceipt,
  ExactAuthorizationDescriptor,
  JsonValue,
} from "./types.js";

export const BASE_CHAIN_ID_HEX = "0x2105";
export const BASE_GENESIS_BLOCK_HASH =
  "0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd";
export const CIRCLE_PROXY_IMPLEMENTATION_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

const REGISTRY_DOMAIN = "x402-canary:base-source-registry:v0.1";
const COLLECTION_DOMAIN = "x402-canary:base-evidence-collection:v0.1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const TRUST_DOMAIN = /^[a-z0-9][a-z0-9.-]{0,126}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,126}$/;
const MAX_REGISTRY_SOURCES = 8;
const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const USDC_NAME_SELECTOR = "0x06fdde03";
const USDC_VERSION_SELECTOR = "0x54fd4d50";
const USDC_DECIMALS_SELECTOR = "0x313ce567";
const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const REGISTRY_FIELDS = new Set([
  "schemaVersion",
  "networkId",
  "genesisBlockHash",
  "sources",
  "nativeUsdc",
]);
const SOURCE_FIELDS = new Set(["id", "trustDomain", "expectedOrigin", "endpointEnv"]);
const USDC_FIELDS = new Set([
  "asset",
  "proxyImplementationSlot",
  "allowedProxyCodeSha256",
  "allowedImplementationCodeSha256",
  "expectedName",
  "expectedVersion",
  "expectedDecimals",
]);
const COLLECTION_REQUEST_FIELDS = new Set(["authorization", "collectedAt", "transactionHash"]);
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
const derivedRegistries = new WeakSet<object>();
const resolvedSources = new WeakSet<object>();

export interface BaseRpcSourceManifestEntry {
  id: string;
  trustDomain: string;
  expectedOrigin: string;
  endpointEnv: string;
}

export interface BaseRpcSourceManifest {
  schemaVersion: "0.1";
  networkId: "eip155:8453";
  genesisBlockHash: string;
  sources: BaseRpcSourceManifestEntry[];
  nativeUsdc: {
    asset: string;
    proxyImplementationSlot: string;
    allowedProxyCodeSha256: string[];
    allowedImplementationCodeSha256: string[];
    expectedName: "USD Coin";
    expectedVersion: "2";
    expectedDecimals: 6;
  };
}

export interface BaseRpcSourceRegistry {
  manifest: BaseRpcSourceManifest;
  registryHash: string;
  sourceLabels: Record<string, string>;
}

export interface ResolvedBaseRpcSource extends BaseRpcSourceManifestEntry {
  label: string;
  endpoint: URL;
}

export type BaseReadRpcMethod =
  | "eth_chainId"
  | "eth_getBlockByNumber"
  | "eth_getBlockByHash"
  | "eth_getTransactionReceipt"
  | "eth_getCode"
  | "eth_getStorageAt"
  | "eth_call";

const READ_METHODS = new Set<BaseReadRpcMethod>([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
]);

export interface BaseRpcRequester {
  request(sourceId: string, method: BaseReadRpcMethod, params: readonly JsonValue[]): Promise<unknown>;
}

export interface BaseEvidenceCollectionRequest {
  authorization: ExactAuthorizationDescriptor;
  collectedAt: string;
  transactionHash?: string;
}

export interface BaseEvidenceCollection {
  schemaVersion: "0.1";
  registryHash: string;
  collectedAt: string;
  assurance: {
    transportAuthentication: "https_web_pki" | "test_injected";
    sourceIdentity: "hashed_operator_registry";
    independence: "operator_declared_distinct_trust_domains";
    finality: "shared_finalized_block_hash";
    stateBinding: "eip1898_require_canonical";
    quorum: "unanimous";
    paymentExecutionEnabled: false;
  };
  finalizedAnchor: {
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
  };
  nativeUsdc: {
    asset: string;
    proxyCodeSha256: string;
    implementationAddress: string;
    implementationCodeSha256: string;
    name: "USD Coin";
    version: "2";
    decimals: 6;
  };
  sources: Array<{
    id: string;
    label: string;
    trustDomain: string;
    finalizedHeadBlockNumber: string;
    finalizedHeadBlockHash: string;
  }>;
  receiptObservations: BaseReceiptObservation[];
  authorizationStateObservations: AuthorizationStateObservation[];
  readiness: "kernel_ready" | "pending_finality";
  reasons: string[];
  observationHash: string;
  collectionHash: string;
}

export class BaseRpcConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BaseRpcConfigurationError";
  }
}

export class BaseRpcTransportError extends Error {
  constructor(
    readonly code: string,
    readonly sourceId: string,
    readonly method: BaseReadRpcMethod,
  ) {
    super(`${code}:${sourceId}:${method}`);
    this.name = "BaseRpcTransportError";
  }
}

export class BaseEvidenceCollectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BaseEvidenceCollectionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new BaseRpcConfigurationError(`${label}_UNEXPECTED_FIELD`);
  }
}

function hashCanonical(namespace: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(`${namespace}\n${canonicalJson(value)}`, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function assertDerivedRegistry(registry: BaseRpcSourceRegistry): void {
  if (!isRecord(registry) || !derivedRegistries.has(registry)) {
    throw new BaseRpcConfigurationError("REGISTRY_NOT_DERIVED");
  }
  if (hashCanonical(REGISTRY_DOMAIN, registry.manifest) !== registry.registryHash) {
    throw new BaseRpcConfigurationError("REGISTRY_INTEGRITY_MISMATCH");
  }
}

function requireSortedUnique(values: unknown, label: string): string[] {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === "string" && SHA256.test(value))
  ) {
    throw new BaseRpcConfigurationError(`${label}_INVALID`);
  }
  const normalized = [...values] as string[];
  const sorted = [...new Set(normalized)].sort();
  if (sorted.length !== normalized.length || sorted.some((value, index) => value !== normalized[index])) {
    throw new BaseRpcConfigurationError(`${label}_NOT_SORTED_UNIQUE`);
  }
  return normalized;
}

function normalizeExpectedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new BaseRpcConfigurationError("SOURCE_ORIGIN_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BaseRpcConfigurationError("SOURCE_ORIGIN_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    isForbiddenHostname(url.hostname)
  ) {
    throw new BaseRpcConfigurationError("SOURCE_ORIGIN_INVALID");
  }
  return url.origin;
}

function isForbiddenHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    isIP(normalized) !== 0
  );
}

export function deriveBaseRpcSourceRegistry(value: unknown): BaseRpcSourceRegistry {
  if (!isRecord(value)) throw new BaseRpcConfigurationError("REGISTRY_INVALID");
  assertExactFields(value, REGISTRY_FIELDS, "REGISTRY");
  if (value.schemaVersion !== "0.1") throw new BaseRpcConfigurationError("REGISTRY_VERSION_INVALID");
  if (value.networkId !== BASE_MAINNET_NETWORK) {
    throw new BaseRpcConfigurationError("REGISTRY_NETWORK_INVALID");
  }
  if (
    typeof value.genesisBlockHash !== "string" ||
    value.genesisBlockHash.toLowerCase() !== BASE_GENESIS_BLOCK_HASH
  ) {
    throw new BaseRpcConfigurationError("REGISTRY_GENESIS_HASH_INVALID");
  }
  if (
    !Array.isArray(value.sources) ||
    value.sources.length < 2 ||
    value.sources.length > MAX_REGISTRY_SOURCES
  ) {
    throw new BaseRpcConfigurationError("REGISTRY_SOURCES_INVALID");
  }

  const sources = value.sources.map((raw): BaseRpcSourceManifestEntry => {
    if (!isRecord(raw)) throw new BaseRpcConfigurationError("SOURCE_INVALID");
    assertExactFields(raw, SOURCE_FIELDS, "SOURCE");
    if (typeof raw.id !== "string" || !SOURCE_ID.test(raw.id)) {
      throw new BaseRpcConfigurationError("SOURCE_ID_INVALID");
    }
    if (typeof raw.trustDomain !== "string" || !TRUST_DOMAIN.test(raw.trustDomain)) {
      throw new BaseRpcConfigurationError("SOURCE_TRUST_DOMAIN_INVALID");
    }
    if (typeof raw.endpointEnv !== "string" || !ENV_NAME.test(raw.endpointEnv)) {
      throw new BaseRpcConfigurationError("SOURCE_ENDPOINT_ENV_INVALID");
    }
    const source = {
      id: raw.id,
      trustDomain: raw.trustDomain,
      expectedOrigin: normalizeExpectedOrigin(raw.expectedOrigin),
      endpointEnv: raw.endpointEnv,
    };
    return source;
  });
  if (sources.some((source, index) => index > 0 && source.id <= sources[index - 1]!.id)) {
    throw new BaseRpcConfigurationError("REGISTRY_SOURCES_NOT_SORTED");
  }

  for (const [field, values] of [
    ["SOURCE_ID", sources.map((source) => source.id)],
    ["SOURCE_TRUST_DOMAIN", sources.map((source) => source.trustDomain)],
    ["SOURCE_ORIGIN", sources.map((source) => source.expectedOrigin)],
    ["SOURCE_ENDPOINT_ENV", sources.map((source) => source.endpointEnv)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new BaseRpcConfigurationError(`${field}_DUPLICATE`);
    }
  }

  if (!isRecord(value.nativeUsdc)) throw new BaseRpcConfigurationError("NATIVE_USDC_INVALID");
  assertExactFields(value.nativeUsdc, USDC_FIELDS, "NATIVE_USDC");
  const asset = typeof value.nativeUsdc.asset === "string" ? value.nativeUsdc.asset.toLowerCase() : "";
  if (!ADDRESS.test(String(value.nativeUsdc.asset ?? "")) || asset !== BASE_USDC_ASSET) {
    throw new BaseRpcConfigurationError("NATIVE_USDC_ASSET_INVALID");
  }
  const slot =
    typeof value.nativeUsdc.proxyImplementationSlot === "string"
      ? value.nativeUsdc.proxyImplementationSlot.toLowerCase()
      : "";
  if (slot !== CIRCLE_PROXY_IMPLEMENTATION_SLOT) {
    throw new BaseRpcConfigurationError("NATIVE_USDC_IMPLEMENTATION_SLOT_INVALID");
  }
  if (
    value.nativeUsdc.expectedName !== "USD Coin" ||
    value.nativeUsdc.expectedVersion !== "2" ||
    value.nativeUsdc.expectedDecimals !== 6
  ) {
    throw new BaseRpcConfigurationError("NATIVE_USDC_METADATA_POLICY_INVALID");
  }

  const manifest: BaseRpcSourceManifest = {
    schemaVersion: "0.1",
    networkId: BASE_MAINNET_NETWORK,
    genesisBlockHash: BASE_GENESIS_BLOCK_HASH,
    sources,
    nativeUsdc: {
      asset,
      proxyImplementationSlot: slot,
      allowedProxyCodeSha256: requireSortedUnique(
        value.nativeUsdc.allowedProxyCodeSha256,
        "NATIVE_USDC_PROXY_CODE_HASHES",
      ),
      allowedImplementationCodeSha256: requireSortedUnique(
        value.nativeUsdc.allowedImplementationCodeSha256,
        "NATIVE_USDC_IMPLEMENTATION_CODE_HASHES",
      ),
      expectedName: "USD Coin",
      expectedVersion: "2",
      expectedDecimals: 6,
    },
  };
  const registryHash = hashCanonical(REGISTRY_DOMAIN, manifest);
  const sourceLabels = Object.fromEntries(
    sources.map((source) => [source.id, `base-rpc:${source.id}:${registryHash}`]),
  );
  const registry = deepFreeze({ manifest: clone(manifest), registryHash, sourceLabels });
  derivedRegistries.add(registry);
  return registry;
}

export function resolveBaseRpcSources(
  registry: BaseRpcSourceRegistry,
  resolveEndpoint: (environmentName: string) => string | undefined,
): ResolvedBaseRpcSource[] {
  assertDerivedRegistry(registry);
  return registry.manifest.sources.map((source) => {
    let raw: string | undefined;
    try {
      raw = resolveEndpoint(source.endpointEnv);
    } catch {
      throw new BaseRpcConfigurationError(`SOURCE_ENDPOINT_RESOLUTION_FAILED:${source.id}`);
    }
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
      throw new BaseRpcConfigurationError(`SOURCE_ENDPOINT_MISSING:${source.id}`);
    }
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new BaseRpcConfigurationError(`SOURCE_ENDPOINT_INVALID:${source.id}`);
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.port !== "" ||
      endpoint.hash !== "" ||
      endpoint.origin !== source.expectedOrigin ||
      isForbiddenHostname(endpoint.hostname)
    ) {
      throw new BaseRpcConfigurationError(`SOURCE_ENDPOINT_POLICY_MISMATCH:${source.id}`);
    }
    const resolved = Object.freeze({
      ...source,
      label: registry.sourceLabels[source.id]!,
      endpoint,
    });
    resolvedSources.add(resolved);
    return resolved;
  });
}

const forbiddenAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  forbiddenAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  forbiddenAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicRpcAddress(address: string, family?: number): boolean {
  const resolvedFamily = family === 4 || family === 6 ? family : isIP(address);
  if (resolvedFamily === 4) return !forbiddenAddresses.check(address, "ipv4");
  if (resolvedFamily === 6) {
    if (address.toLowerCase().startsWith("::ffff:")) return false;
    return !forbiddenAddresses.check(address, "ipv6");
  }
  return false;
}

type ConnectionExecutor = (
  source: ResolvedBaseRpcSource,
  body: string,
  timeoutMs: number,
  maxResponseBytes: number,
) => Promise<string>;

async function executeHttpsRequest(
  source: ResolvedBaseRpcSource,
  body: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<string> {
  const addresses = await dns.lookup(source.endpoint.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicRpcAddress(entry.address, entry.family))) {
    throw new Error("DNS_POLICY_REJECTED");
  }
  const selected = addresses[0]!;
  const options: RequestOptions = {
    protocol: "https:",
    hostname: source.endpoint.hostname,
    port: 443,
    method: "POST",
    path: `${source.endpoint.pathname}${source.endpoint.search}`,
    servername: source.endpoint.hostname,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "user-agent": "x402-canary-evidence/0.1",
    },
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) {
        callback(
          null,
          addresses.map((entry) => ({ address: entry.address, family: entry.family })),
        );
        return;
      }
      callback(null, selected.address, selected.family);
    },
  };

  return new Promise<string>((resolve, reject) => {
    const request = httpsRequest(options, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("HTTP_STATUS_REJECTED"));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        response.resume();
        reject(new Error("CONTENT_TYPE_REJECTED"));
        return;
      }
      if (response.headers["content-encoding"] !== undefined) {
        response.resume();
        reject(new Error("CONTENT_ENCODING_REJECTED"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.resume();
        reject(new Error("RESPONSE_TOO_LARGE"));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxResponseBytes) {
          request.destroy(new Error("RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("REQUEST_TIMEOUT")));
    request.on("error", reject);
    request.end(body);
  });
}

export class HttpsBaseRpcTransport implements BaseRpcRequester {
  private readonly sources: Map<string, ResolvedBaseRpcSource>;
  private nextId = 1;
  readonly sourceAuthentication: "https_web_pki" | "test_injected";

  constructor(
    sources: readonly ResolvedBaseRpcSource[],
    private readonly options: {
      timeoutMs?: number;
      maxResponseBytes?: number;
      connectionExecutor?: ConnectionExecutor;
    } = {},
  ) {
    if (sources.some((source) => !resolvedSources.has(source))) {
      throw new BaseRpcConfigurationError("RESOLVED_SOURCE_NOT_DERIVED");
    }
    this.sources = new Map(
      sources.map((source) => {
        const endpoint = new URL(source.endpoint.toString());
        if (
          endpoint.protocol !== "https:" ||
          endpoint.origin !== source.expectedOrigin ||
          endpoint.username !== "" ||
          endpoint.password !== "" ||
          endpoint.port !== "" ||
          endpoint.hash !== "" ||
          isForbiddenHostname(endpoint.hostname)
        ) {
          throw new BaseRpcConfigurationError("RESOLVED_SOURCE_INTEGRITY_MISMATCH");
        }
        return [source.id, { ...source, endpoint }] as const;
      }),
    );
    if (this.sources.size !== sources.length || sources.length < 2) {
      throw new BaseRpcConfigurationError("RESOLVED_SOURCES_INVALID");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const maxBytes = options.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new BaseRpcConfigurationError("RPC_TIMEOUT_INVALID");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024) {
      throw new BaseRpcConfigurationError("RPC_RESPONSE_LIMIT_INVALID");
    }
    this.sourceAuthentication = options.connectionExecutor ? "test_injected" : "https_web_pki";
  }

  async request(
    sourceId: string,
    method: BaseReadRpcMethod,
    params: readonly JsonValue[],
  ): Promise<unknown> {
    const source = this.sources.get(sourceId);
    if (!source) throw new BaseRpcTransportError("SOURCE_NOT_REGISTERED", sourceId, method);
    if (!READ_METHODS.has(method)) {
      throw new BaseRpcTransportError("RPC_METHOD_NOT_ALLOWED", sourceId, method);
    }
    if (!Array.isArray(params)) throw new BaseRpcTransportError("RPC_PARAMS_INVALID", sourceId, method);
    canonicalJson(params);

    const id = this.nextId;
    this.nextId = this.nextId === Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const executor = this.options.connectionExecutor ?? executeHttpsRequest;
    let text: string;
    try {
      text = await executor(
        source,
        body,
        this.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
        this.options.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES,
      );
    } catch {
      throw new BaseRpcTransportError("RPC_REQUEST_FAILED", sourceId, method);
    }
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text, "utf8") > (this.options.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES)
    ) {
      throw new BaseRpcTransportError("RPC_RESPONSE_TOO_LARGE", sourceId, method);
    }

    let response: unknown;
    try {
      response = JSON.parse(text) as unknown;
    } catch {
      throw new BaseRpcTransportError("RPC_RESPONSE_JSON_INVALID", sourceId, method);
    }
    if (!isRecord(response)) {
      throw new BaseRpcTransportError("RPC_RESPONSE_SHAPE_INVALID", sourceId, method);
    }
    const fields = Object.keys(response);
    if (
      fields.some((field) => !new Set(["jsonrpc", "id", "result", "error"]).has(field)) ||
      response.jsonrpc !== "2.0" ||
      response.id !== id
    ) {
      throw new BaseRpcTransportError("RPC_RESPONSE_ENVELOPE_INVALID", sourceId, method);
    }
    const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
    const hasError = Object.prototype.hasOwnProperty.call(response, "error");
    if (hasResult === hasError) {
      throw new BaseRpcTransportError("RPC_RESPONSE_RESULT_INVALID", sourceId, method);
    }
    if (hasError) throw new BaseRpcTransportError("RPC_PROVIDER_ERROR", sourceId, method);
    return clone(response.result);
  }
}

interface RpcBlock {
  number: bigint;
  numberDecimal: string;
  numberHex: string;
  hash: string;
  timestamp: bigint;
  timestampDecimal: string;
}

function parseQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= 1n << 256n) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  return parsed;
}

function quantityHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  return value.toLowerCase();
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  return value.toLowerCase();
}

function requireHexBytes(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  return value.toLowerCase();
}

function parseBlock(value: unknown, field: string): RpcBlock {
  if (!isRecord(value)) throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  const number = parseQuantity(value.number, `${field}_NUMBER`);
  const timestamp = parseQuantity(value.timestamp, `${field}_TIMESTAMP`);
  return {
    number,
    numberDecimal: number.toString(),
    numberHex: quantityHex(number),
    hash: requireHash(value.hash, `${field}_HASH`),
    timestamp,
    timestampDecimal: timestamp.toString(),
  };
}

function bytesSha256(hex: string, field: string): string {
  const normalized = requireHexBytes(hex, field);
  if (normalized === "0x") throw new BaseEvidenceCollectionError(`${field}_EMPTY`);
  return `sha256:${createHash("sha256").update(Buffer.from(normalized.slice(2), "hex")).digest("hex")}`;
}

function decodeAddressSlot(value: unknown): string {
  const word = requireHexBytes(value, "IMPLEMENTATION_SLOT");
  if (word.length !== 66 || !/^0x0{24}[0-9a-f]{40}$/.test(word)) {
    throw new BaseEvidenceCollectionError("IMPLEMENTATION_SLOT_INVALID");
  }
  const address = `0x${word.slice(-40)}`;
  if (address === `0x${"0".repeat(40)}`) {
    throw new BaseEvidenceCollectionError("IMPLEMENTATION_ADDRESS_ZERO");
  }
  return address;
}

function decodeUintWord(value: unknown, field: string): bigint {
  const data = requireHexBytes(value, field);
  if (data.length !== 66) throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  return BigInt(data);
}

function decodeBoolWord(value: unknown, field: string): boolean {
  const decoded = decodeUintWord(value, field);
  if (decoded !== 0n && decoded !== 1n) throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  return decoded === 1n;
}

function decodeAbiString(value: unknown, field: string): string {
  const data = requireHexBytes(value, field);
  if (data.length < 130) throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  const buffer = Buffer.from(data.slice(2), "hex");
  const offset = Number(BigInt(`0x${buffer.subarray(0, 32).toString("hex")}`));
  if (!Number.isSafeInteger(offset) || offset !== 32 || buffer.length < offset + 32) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  const length = Number(BigInt(`0x${buffer.subarray(offset, offset + 32).toString("hex")}`));
  const paddedLength = Math.ceil(length / 32) * 32;
  if (
    !Number.isSafeInteger(length) ||
    length > 256 ||
    buffer.length !== offset + 32 + paddedLength
  ) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  if (buffer.subarray(offset + 32 + length).some((byte) => byte !== 0)) {
    throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  }
  const text = buffer.subarray(offset + 32, offset + 32 + length).toString("utf8");
  if (!/^[\x20-\x7e]+$/.test(text)) throw new BaseEvidenceCollectionError(`${field}_INVALID`);
  return text;
}

function addressWord(address: string): string {
  return address.slice(2).padStart(64, "0");
}

function validateAuthorizationForCollection(value: ExactAuthorizationDescriptor): {
  authorization: ExactAuthorizationDescriptor;
  from: string;
  nonce: string;
} {
  if (!isRecord(value)) throw new BaseEvidenceCollectionError("AUTHORIZATION_INVALID");
  for (const field of Object.keys(value)) {
    if (!AUTHORIZATION_FIELDS.has(field)) {
      throw new BaseEvidenceCollectionError("AUTHORIZATION_UNEXPECTED_FIELD");
    }
  }
  for (const field of AUTHORIZATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new BaseEvidenceCollectionError("AUTHORIZATION_REQUIRED_FIELD_MISSING");
    }
  }
  if (value.networkId !== BASE_MAINNET_NETWORK) {
    throw new BaseEvidenceCollectionError("AUTHORIZATION_NETWORK_INVALID");
  }
  const asset = requireAddress(value.asset, "AUTHORIZATION_ASSET");
  if (asset !== BASE_USDC_ASSET) throw new BaseEvidenceCollectionError("AUTHORIZATION_ASSET_INVALID");
  const from = requireAddress(value.from, "AUTHORIZATION_FROM");
  const to = requireAddress(value.to, "AUTHORIZATION_TO");
  if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) {
    throw new BaseEvidenceCollectionError("AUTHORIZATION_ZERO_ADDRESS");
  }
  if (!HASH.test(value.nonce)) throw new BaseEvidenceCollectionError("AUTHORIZATION_NONCE_INVALID");
  const quantities: bigint[] = [];
  for (const field of ["valueAtomic", "validAfter", "validBefore"] as const) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value[field])) {
      throw new BaseEvidenceCollectionError(`AUTHORIZATION_${field.toUpperCase()}_INVALID`);
    }
    const parsed = BigInt(value[field]);
    if (parsed > UINT256_MAX) {
      throw new BaseEvidenceCollectionError(`AUTHORIZATION_${field.toUpperCase()}_INVALID`);
    }
    quantities.push(parsed);
  }
  if (quantities[0] === 0n) {
    throw new BaseEvidenceCollectionError("AUTHORIZATION_VALUEATOMIC_INVALID");
  }
  if (quantities[2]! <= quantities[1]!) {
    throw new BaseEvidenceCollectionError("AUTHORIZATION_VALIDITY_WINDOW_INVALID");
  }
  return { authorization: clone(value), from, nonce: value.nonce.toLowerCase() };
}

function validateCollectedAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new BaseEvidenceCollectionError("COLLECTED_AT_INVALID");
  }
  return value;
}

function normalizeReceipt(value: unknown, expectedTransactionHash: string): BaseTransactionReceipt | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new BaseEvidenceCollectionError("RECEIPT_INVALID");
  const transactionHash = requireHash(value.transactionHash, "RECEIPT_TRANSACTION_HASH");
  if (transactionHash !== expectedTransactionHash) {
    throw new BaseEvidenceCollectionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
  }
  const blockHash = requireHash(value.blockHash, "RECEIPT_BLOCK_HASH");
  const blockNumber = parseQuantity(value.blockNumber, "RECEIPT_BLOCK_NUMBER");
  const statusQuantity = parseQuantity(value.status, "RECEIPT_STATUS");
  if (statusQuantity !== 0n && statusQuantity !== 1n) {
    throw new BaseEvidenceCollectionError("RECEIPT_STATUS_INVALID");
  }
  if (!Array.isArray(value.logs) || value.logs.length > 10_000) {
    throw new BaseEvidenceCollectionError("RECEIPT_LOGS_INVALID");
  }
  const indexes = new Set<number>();
  const logs = value.logs.map((raw): BaseReceiptLog => {
    if (!isRecord(raw)) throw new BaseEvidenceCollectionError("RECEIPT_LOG_INVALID");
    const logTransactionHash = requireHash(raw.transactionHash, "LOG_TRANSACTION_HASH");
    if (logTransactionHash !== transactionHash) {
      throw new BaseEvidenceCollectionError("LOG_TRANSACTION_HASH_MISMATCH");
    }
    const indexValue = parseQuantity(raw.logIndex, "LOG_INDEX");
    if (indexValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BaseEvidenceCollectionError("LOG_INDEX_INVALID");
    }
    const logIndex = Number(indexValue);
    if (indexes.has(logIndex)) throw new BaseEvidenceCollectionError("LOG_INDEX_DUPLICATE");
    indexes.add(logIndex);
    if (!Array.isArray(raw.topics) || raw.topics.length > 4) {
      throw new BaseEvidenceCollectionError("LOG_TOPICS_INVALID");
    }
    const topics = raw.topics.map((topic) => requireHash(topic, "LOG_TOPIC"));
    if (raw.removed !== undefined && typeof raw.removed !== "boolean") {
      throw new BaseEvidenceCollectionError("LOG_REMOVED_INVALID");
    }
    return {
      address: requireAddress(raw.address, "LOG_ADDRESS"),
      topics,
      data: requireHexBytes(raw.data, "LOG_DATA"),
      logIndex,
      transactionHash,
      ...(raw.removed === undefined ? {} : { removed: raw.removed }),
    };
  });
  logs.sort((left, right) => left.logIndex - right.logIndex);
  return {
    transactionHash,
    blockHash,
    blockNumber: blockNumber.toString(),
    status: statusQuantity === 1n ? "success" : "reverted",
    logs,
  };
}

function fingerprint(value: unknown): string {
  return canonicalJson(value);
}

async function requestAll<T>(
  registry: BaseRpcSourceRegistry,
  requester: BaseRpcRequester,
  action: (source: BaseRpcSourceManifestEntry) => Promise<T>,
): Promise<Array<{ source: BaseRpcSourceManifestEntry; value: T }>> {
  return Promise.all(
    registry.manifest.sources.map(async (source) => ({ source, value: await action(source) })),
  );
}

function canonicalBlockParameter(block: RpcBlock): JsonValue {
  return { blockHash: block.hash, requireCanonical: true };
}

export async function collectBaseEvidence(
  registry: BaseRpcSourceRegistry,
  requester: BaseRpcRequester,
  request: BaseEvidenceCollectionRequest,
): Promise<BaseEvidenceCollection> {
  assertDerivedRegistry(registry);
  if (!isRecord(request)) throw new BaseEvidenceCollectionError("COLLECTION_REQUEST_INVALID");
  for (const field of Object.keys(request)) {
    if (!COLLECTION_REQUEST_FIELDS.has(field)) {
      throw new BaseEvidenceCollectionError("COLLECTION_REQUEST_UNEXPECTED_FIELD");
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(request, "authorization") ||
    !Object.prototype.hasOwnProperty.call(request, "collectedAt")
  ) {
    throw new BaseEvidenceCollectionError("COLLECTION_REQUEST_REQUIRED_FIELD_MISSING");
  }
  const checkedAuthorization = validateAuthorizationForCollection(request.authorization);
  const collectedAt = validateCollectedAt(request.collectedAt);
  const collectedAtSeconds = BigInt(Math.floor(Date.parse(collectedAt) / 1_000));
  const transactionHash =
    request.transactionHash === undefined
      ? undefined
      : requireHash(request.transactionHash, "TRANSACTION_HASH");

  const heads = await requestAll(registry, requester, async (source) => {
    const chainId = await requester.request(source.id, "eth_chainId", []);
    if (typeof chainId !== "string" || chainId.toLowerCase() !== BASE_CHAIN_ID_HEX) {
      throw new BaseEvidenceCollectionError("RPC_CHAIN_ID_MISMATCH");
    }
    const genesis = parseBlock(
      await requester.request(source.id, "eth_getBlockByNumber", ["0x0", false]),
      "GENESIS_BLOCK",
    );
    if (genesis.number !== 0n || genesis.hash !== registry.manifest.genesisBlockHash) {
      throw new BaseEvidenceCollectionError("RPC_GENESIS_HASH_MISMATCH");
    }
    const block = parseBlock(
      await requester.request(source.id, "eth_getBlockByNumber", ["finalized", false]),
      "FINALIZED_HEAD",
    );
    return block;
  });
  const anchorNumber = heads.reduce(
    (minimum, entry) => (entry.value.number < minimum ? entry.value.number : minimum),
    heads[0]!.value.number,
  );
  const anchorHex = quantityHex(anchorNumber);
  const anchorBlocks = await requestAll(registry, requester, async (source) =>
    parseBlock(
      await requester.request(source.id, "eth_getBlockByNumber", [anchorHex, false]),
      "FINALIZED_ANCHOR",
    ),
  );
  const firstAnchor = anchorBlocks[0]!.value;
  if (
    firstAnchor.number !== anchorNumber ||
    anchorBlocks.some(
      (entry) =>
        entry.value.number !== anchorNumber ||
        entry.value.hash !== firstAnchor.hash ||
        entry.value.timestamp !== firstAnchor.timestamp,
    )
  ) {
    throw new BaseEvidenceCollectionError("FINALIZED_ANCHOR_CONTRADICTION");
  }
  for (const head of heads) {
    if (head.value.number !== anchorNumber) continue;
    const exactAnchor = anchorBlocks.find((entry) => entry.source.id === head.source.id)!.value;
    if (
      head.value.hash !== exactAnchor.hash ||
      head.value.timestamp !== exactAnchor.timestamp
    ) {
      throw new BaseEvidenceCollectionError("FINALIZED_HEAD_ANCHOR_CONTRADICTION");
    }
  }
  if (firstAnchor.timestamp > collectedAtSeconds) {
    throw new BaseEvidenceCollectionError("FINALIZED_ANCHOR_FROM_FUTURE");
  }

  const blockParameter = canonicalBlockParameter(firstAnchor);
  const identities = await requestAll(registry, requester, async (source) => {
    const proxyCode = requireHexBytes(
      await requester.request(source.id, "eth_getCode", [BASE_USDC_ASSET, blockParameter]),
      "NATIVE_USDC_PROXY_CODE",
    );
    const implementationAddress = decodeAddressSlot(
      await requester.request(source.id, "eth_getStorageAt", [
        BASE_USDC_ASSET,
        CIRCLE_PROXY_IMPLEMENTATION_SLOT,
        blockParameter,
      ]),
    );
    const [implementationCode, nameResult, versionResult, decimalsResult] = await Promise.all([
      requester.request(source.id, "eth_getCode", [implementationAddress, blockParameter]),
      requester.request(source.id, "eth_call", [
        { to: BASE_USDC_ASSET, data: USDC_NAME_SELECTOR },
        blockParameter,
      ]),
      requester.request(source.id, "eth_call", [
        { to: BASE_USDC_ASSET, data: USDC_VERSION_SELECTOR },
        blockParameter,
      ]),
      requester.request(source.id, "eth_call", [
        { to: BASE_USDC_ASSET, data: USDC_DECIMALS_SELECTOR },
        blockParameter,
      ]),
    ]);
    return {
      asset: BASE_USDC_ASSET,
      proxyCodeSha256: bytesSha256(proxyCode, "NATIVE_USDC_PROXY_CODE"),
      implementationAddress,
      implementationCodeSha256: bytesSha256(
        requireHexBytes(implementationCode, "NATIVE_USDC_IMPLEMENTATION_CODE"),
        "NATIVE_USDC_IMPLEMENTATION_CODE",
      ),
      name: decodeAbiString(nameResult, "NATIVE_USDC_NAME"),
      version: decodeAbiString(versionResult, "NATIVE_USDC_VERSION"),
      decimals: Number(decodeUintWord(decimalsResult, "NATIVE_USDC_DECIMALS")),
    };
  });
  const firstIdentity = identities[0]!.value;
  if (identities.some((entry) => fingerprint(entry.value) !== fingerprint(firstIdentity))) {
    throw new BaseEvidenceCollectionError("NATIVE_USDC_IDENTITY_CONTRADICTION");
  }
  if (
    !registry.manifest.nativeUsdc.allowedProxyCodeSha256.includes(firstIdentity.proxyCodeSha256) ||
    !registry.manifest.nativeUsdc.allowedImplementationCodeSha256.includes(
      firstIdentity.implementationCodeSha256,
    )
  ) {
    throw new BaseEvidenceCollectionError("NATIVE_USDC_CODE_NOT_ALLOWED");
  }
  if (
    firstIdentity.name !== "USD Coin" ||
    firstIdentity.version !== "2" ||
    firstIdentity.decimals !== 6
  ) {
    throw new BaseEvidenceCollectionError("NATIVE_USDC_METADATA_MISMATCH");
  }

  const stateCallData = `${AUTHORIZATION_STATE_SELECTOR}${addressWord(checkedAuthorization.from)}${checkedAuthorization.nonce.slice(2)}`;
  const states = await requestAll(registry, requester, async (source) =>
    decodeBoolWord(
      await requester.request(source.id, "eth_call", [
        { to: BASE_USDC_ASSET, data: stateCallData },
        blockParameter,
      ]),
      "AUTHORIZATION_STATE",
    ),
  );
  if (new Set(states.map((entry) => entry.value)).size !== 1) {
    throw new BaseEvidenceCollectionError("AUTHORIZATION_STATE_CONTRADICTION");
  }

  let readiness: BaseEvidenceCollection["readiness"] = "kernel_ready";
  const reasons: string[] = [];
  let receiptObservations: BaseReceiptObservation[] = [];
  if (transactionHash !== undefined) {
    const receipts = await requestAll(registry, requester, async (source) =>
      normalizeReceipt(
        await requester.request(source.id, "eth_getTransactionReceipt", [transactionHash]),
        transactionHash,
      ),
    );
    const present = receipts.filter((entry) => entry.value !== null);
    if (present.length > 0 && present.length < receipts.length) {
      const anyBeyondAnchor = present.some(
        (entry) => BigInt(entry.value!.blockNumber) > anchorNumber,
      );
      if (!anyBeyondAnchor) throw new BaseEvidenceCollectionError("RECEIPT_PRESENCE_CONTRADICTION");
      readiness = "pending_finality";
      reasons.push("RECEIPT_NOT_FINALIZED_BY_ALL_SOURCES");
    } else if (present.length === receipts.length) {
      const firstReceipt = present[0]!.value!;
      if (present.some((entry) => fingerprint(entry.value) !== fingerprint(firstReceipt))) {
        throw new BaseEvidenceCollectionError("RECEIPT_CONTRADICTION");
      }
      if (BigInt(firstReceipt.blockNumber) > anchorNumber) {
        readiness = "pending_finality";
        reasons.push("RECEIPT_PENDING_FINALITY");
      } else {
        const receiptBlocks = await requestAll(registry, requester, async (source) =>
          parseBlock(
            await requester.request(source.id, "eth_getBlockByNumber", [
              quantityHex(BigInt(firstReceipt.blockNumber)),
              false,
            ]),
            "RECEIPT_CANONICAL_BLOCK",
          ),
        );
        if (
          receiptBlocks.some(
            (entry) =>
              entry.value.hash !== firstReceipt.blockHash ||
              entry.value.number !== BigInt(firstReceipt.blockNumber),
          )
        ) {
          throw new BaseEvidenceCollectionError("RECEIPT_CANONICAL_BLOCK_CONTRADICTION");
        }
        receiptObservations = receipts.map(({ source, value }) => ({
          networkId: BASE_MAINNET_NETWORK,
          source: registry.sourceLabels[source.id]!,
          observedAt: collectedAt,
          observedHeadBlockNumber: firstAnchor.numberDecimal,
          canonicalBlockHash: value!.blockHash,
          receipt: value,
        }));
      }
    } else {
      receiptObservations = receipts.map(({ source }) => ({
        networkId: BASE_MAINNET_NETWORK,
        source: registry.sourceLabels[source.id]!,
        observedAt: collectedAt,
        observedHeadBlockNumber: firstAnchor.numberDecimal,
        canonicalBlockHash: null,
        receipt: null,
      }));
      reasons.push("RECEIPT_NOT_OBSERVED_AT_FINALIZED_ANCHOR");
    }
  } else {
    reasons.push("TRANSACTION_HASH_NOT_PROVIDED");
  }

  const authorizationStateObservations: AuthorizationStateObservation[] = states.map(
    ({ source, value }) => ({
      networkId: BASE_MAINNET_NETWORK,
      asset: BASE_USDC_ASSET,
      source: registry.sourceLabels[source.id]!,
      authorizer: checkedAuthorization.from,
      nonce: checkedAuthorization.nonce,
      used: value,
      observedBlockNumber: firstAnchor.numberDecimal,
      observedBlockHash: firstAnchor.hash,
      observedBlockTimestamp: firstAnchor.timestampDecimal,
      observedHeadBlockNumber: heads.find((entry) => entry.source.id === source.id)!.value
        .numberDecimal,
    }),
  );
  const sources = registry.manifest.sources.map((source) => ({
    id: source.id,
    label: registry.sourceLabels[source.id]!,
    trustDomain: source.trustDomain,
    finalizedHeadBlockNumber: heads.find((entry) => entry.source.id === source.id)!.value
      .numberDecimal,
    finalizedHeadBlockHash: heads.find((entry) => entry.source.id === source.id)!.value.hash,
  }));
  const observationPayload = {
    finalizedAnchor: {
      blockNumber: firstAnchor.numberDecimal,
      blockHash: firstAnchor.hash,
      blockTimestamp: firstAnchor.timestampDecimal,
    },
    nativeUsdc: firstIdentity,
    sources,
    receiptObservations,
    authorizationStateObservations,
    readiness,
    reasons: [...new Set(reasons)].sort(),
  };
  const observationHash = hashCanonical("x402-canary:base-observations:v0.1", observationPayload);
  const transportAuthentication =
    requester instanceof HttpsBaseRpcTransport
      ? requester.sourceAuthentication
      : "test_injected";
  const unsigned = {
    schemaVersion: "0.1" as const,
    registryHash: registry.registryHash,
    collectedAt,
    assurance: {
      transportAuthentication,
      sourceIdentity: "hashed_operator_registry" as const,
      independence: "operator_declared_distinct_trust_domains" as const,
      finality: "shared_finalized_block_hash" as const,
      stateBinding: "eip1898_require_canonical" as const,
      quorum: "unanimous" as const,
      paymentExecutionEnabled: false as const,
    },
    ...observationPayload,
    observationHash,
  };
  return {
    ...unsigned,
    nativeUsdc: {
      ...unsigned.nativeUsdc,
      name: "USD Coin",
      version: "2",
      decimals: 6,
    },
    collectionHash: hashCanonical(COLLECTION_DOMAIN, unsigned),
  };
}
