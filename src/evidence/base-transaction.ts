import { createHash } from "node:crypto";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import {
  BASE_CHAIN_ID_HEX,
  BASE_GENESIS_BLOCK_HASH,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  deriveBaseRpcSourceRegistry,
  type BaseRpcRequester,
  type BaseRpcSourceRegistry,
} from "./base-rpc.js";
import { canonicalJson } from "./canonical.js";
import {
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
} from "./base-settlement.js";
import type { BaseReceiptLog, BaseTransactionReceipt } from "./types.js";

const OBSERVATION_DOMAIN = "x402-canary:base-transaction-observation:v0.1";
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const MAX_RECEIPT_LOGS = 10_000;
const MAX_LOG_DATA_BYTES = 512 * 1024;
export const MAX_PUBLIC_BASE_SETTLEMENTS = 32;

const REQUEST_FIELDS = new Set(["transactionHash", "checkedAt"]);

export type BaseTransactionObservationStatus =
  | "confirmed"
  | "multiple"
  | "pending_finality"
  | "not_observed"
  | "not_eip3009_usdc"
  | "reverted"
  | "contradiction";

export interface BaseTransactionObservationRequest {
  transactionHash: string;
  checkedAt: string;
}

export interface NormalizedBaseRpcBlock {
  number: string;
  numberHex: string;
  hash: string;
  timestamp: string;
}

export interface BaseTransactionReceiptSummary {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: "success" | "reverted";
}

export interface NativeUsdcEip3009Settlement {
  from: string;
  to: string;
  valueAtomic: string;
  nonce: string;
  authorizationUsedLogIndex: number;
  transferLogIndex: number;
}

export interface NativeUsdcEip3009Extraction {
  settlementCount: number;
  settlements: NativeUsdcEip3009Settlement[];
  truncated: boolean;
}

export interface BaseTransactionObservationV01 {
  schemaVersion: "0.1";
  kind: "base_transaction_observation";
  checkedAt: string;
  networkId: "eip155:8453";
  transactionHash: string;
  registryHash: string;
  status: BaseTransactionObservationStatus;
  receipt: BaseTransactionReceiptSummary | null;
  finalizedAnchor: {
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
  } | null;
  sourceAgreement: {
    configured: 2;
    agreeing: number;
    quorum: "unanimous";
  };
  confirmations: number;
  settlementCount: number;
  settlements: NativeUsdcEip3009Settlement[];
  truncated: boolean;
  reasons: string[];
  observationHash: string;
}

export class BaseTransactionObservationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BaseTransactionObservationError";
  }
}

function fail(code: string): never {
  throw new BaseTransactionObservationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function parseQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) fail(`${field}_INVALID`);
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > UINT256_MAX) fail(`${field}_INVALID`);
  return parsed;
}

function quantityHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${field}_INVALID`);
  return value.toLowerCase();
}

function requireAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail(`${field}_INVALID`);
  return value.toLowerCase();
}

function requireHexBytes(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_BYTES.test(value)) fail(`${field}_INVALID`);
  return value.toLowerCase();
}

function bytesSha256(value: unknown, field: string): string {
  const bytes = requireHexBytes(value, field);
  if (bytes === "0x") fail(`${field}_EMPTY`);
  return `sha256:${createHash("sha256")
    .update(Buffer.from(bytes.slice(2), "hex"))
    .digest("hex")}`;
}

function implementationAddress(value: unknown): string {
  const word = requireHexBytes(value, "NATIVE_USDC_IMPLEMENTATION_SLOT");
  if (word.length !== 66 || !/^0x0{24}[0-9a-f]{40}$/.test(word)) {
    fail("NATIVE_USDC_IMPLEMENTATION_SLOT_INVALID");
  }
  const address = `0x${word.slice(-40)}`;
  if (address === `0x${"0".repeat(40)}`) {
    fail("NATIVE_USDC_IMPLEMENTATION_ADDRESS_ZERO");
  }
  return address;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !ISO_UTC_MILLISECONDS.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(`${field}_INVALID`);
  }
  return value;
}

/** Strictly normalize a 32-byte transaction hash without assigning intent to it. */
export function normalizeBaseTransactionHash(value: unknown): string {
  if (typeof value !== "string" || !TRANSACTION_HASH.test(value)) {
    fail("TRANSACTION_HASH_INVALID");
  }
  return value.toLowerCase();
}

/** Normalize the block fields used for chain, anchor, and canonicality comparisons. */
export function normalizeBaseRpcBlock(
  value: unknown,
  field = "BLOCK",
): NormalizedBaseRpcBlock {
  if (!isRecord(value)) fail(`${field}_INVALID`);
  const number = parseQuantity(value.number, `${field}_NUMBER`);
  const timestamp = parseQuantity(value.timestamp, `${field}_TIMESTAMP`);
  return {
    number: number.toString(),
    numberHex: quantityHex(number),
    hash: requireHash(value.hash, `${field}_HASH`),
    timestamp: timestamp.toString(),
  };
}

/**
 * Normalize a provider receipt into the existing evidence receipt type. Unknown
 * provider fields are discarded, log indexes are made unique, and all values
 * used in agreement checks are canonicalized.
 */
export function normalizeBaseTransactionReceipt(
  value: unknown,
  expectedTransactionHash: string,
): BaseTransactionReceipt | null {
  const expectedHash = normalizeBaseTransactionHash(expectedTransactionHash);
  if (value === null) return null;
  if (!isRecord(value)) fail("RECEIPT_INVALID");

  const transactionHash = requireHash(value.transactionHash, "RECEIPT_TRANSACTION_HASH");
  if (transactionHash !== expectedHash) fail("RECEIPT_TRANSACTION_HASH_MISMATCH");
  const blockHash = requireHash(value.blockHash, "RECEIPT_BLOCK_HASH");
  const blockNumber = parseQuantity(value.blockNumber, "RECEIPT_BLOCK_NUMBER");
  const status = parseQuantity(value.status, "RECEIPT_STATUS");
  if (status !== 0n && status !== 1n) fail("RECEIPT_STATUS_INVALID");
  if (!Array.isArray(value.logs) || value.logs.length > MAX_RECEIPT_LOGS) {
    fail("RECEIPT_LOGS_INVALID");
  }

  const logIndexes = new Set<number>();
  let totalDataBytes = 0;
  const logs = value.logs.map((raw): BaseReceiptLog => {
    if (!isRecord(raw)) fail("RECEIPT_LOG_INVALID");
    const logTransactionHash = requireHash(raw.transactionHash, "LOG_TRANSACTION_HASH");
    if (logTransactionHash !== transactionHash) fail("LOG_TRANSACTION_HASH_MISMATCH");
    const rawIndex = parseQuantity(raw.logIndex, "LOG_INDEX");
    if (rawIndex > BigInt(Number.MAX_SAFE_INTEGER)) fail("LOG_INDEX_INVALID");
    const logIndex = Number(rawIndex);
    if (logIndexes.has(logIndex)) fail("LOG_INDEX_DUPLICATE");
    logIndexes.add(logIndex);
    if (!Array.isArray(raw.topics) || raw.topics.length > 4) fail("LOG_TOPICS_INVALID");
    const topics = raw.topics.map((topic) => requireHash(topic, "LOG_TOPIC"));
    const data = requireHexBytes(raw.data, "LOG_DATA");
    totalDataBytes += (data.length - 2) / 2;
    if (totalDataBytes > MAX_LOG_DATA_BYTES) fail("RECEIPT_LOG_DATA_TOO_LARGE");
    if (raw.removed !== undefined && typeof raw.removed !== "boolean") {
      fail("LOG_REMOVED_INVALID");
    }
    return {
      address: requireAddress(raw.address, "LOG_ADDRESS"),
      topics,
      data,
      logIndex,
      transactionHash,
      removed: raw.removed === true,
    };
  });
  logs.sort((left, right) => left.logIndex - right.logIndex);
  return {
    transactionHash,
    blockHash,
    blockNumber: blockNumber.toString(),
    status: status === 1n ? "success" : "reverted",
    logs,
  };
}

function topicAddress(topic: string): string | null {
  if (!ADDRESS_TOPIC.test(topic)) return null;
  const address = `0x${topic.slice(-40)}`;
  return address === ZERO_ADDRESS ? null : address;
}

function transferValue(data: string): bigint | null {
  if (!/^0x[0-9a-f]{64}$/.test(data)) return null;
  const value = BigInt(data);
  return value > 0n ? value : null;
}

/**
 * Extract only native Base USDC EIP-3009 pairs established by receipt logs.
 * Circle emits AuthorizationUsed immediately before its matching Transfer;
 * existential matches elsewhere in a batched transaction are not paired.
 */
export function extractNativeUsdcEip3009Settlements(
  receipt: BaseTransactionReceipt,
): NativeUsdcEip3009Extraction {
  if (receipt.status !== "success") {
    return { settlementCount: 0, settlements: [], truncated: false };
  }
  const logsByIndex = new Map(receipt.logs.map((log) => [log.logIndex, log]));
  const all: NativeUsdcEip3009Settlement[] = [];
  for (const authorizationUsed of receipt.logs) {
    if (
      authorizationUsed.address !== BASE_USDC_ASSET ||
      authorizationUsed.removed === true ||
      authorizationUsed.topics.length !== 3 ||
      authorizationUsed.topics[0] !== EIP3009_AUTHORIZATION_USED_TOPIC ||
      authorizationUsed.data !== "0x"
    ) {
      continue;
    }
    const from = topicAddress(authorizationUsed.topics[1]!);
    const nonce = authorizationUsed.topics[2]!;
    if (from === null || !HASH.test(nonce)) continue;

    const transfer = logsByIndex.get(authorizationUsed.logIndex + 1);
    if (
      transfer === undefined ||
      transfer.address !== BASE_USDC_ASSET ||
      transfer.removed === true ||
      transfer.topics.length !== 3 ||
      transfer.topics[0] !== ERC20_TRANSFER_TOPIC ||
      transfer.topics[1] !== authorizationUsed.topics[1]
    ) {
      continue;
    }
    const to = topicAddress(transfer.topics[2]!);
    const value = transferValue(transfer.data);
    if (to === null || value === null) continue;
    all.push({
      from,
      to,
      valueAtomic: value.toString(),
      nonce,
      authorizationUsedLogIndex: authorizationUsed.logIndex,
      transferLogIndex: transfer.logIndex,
    });
  }
  all.sort(
    (left, right) =>
      left.authorizationUsedLogIndex - right.authorizationUsedLogIndex ||
      left.transferLogIndex - right.transferLogIndex,
  );
  return {
    settlementCount: all.length,
    settlements: all.slice(0, MAX_PUBLIC_BASE_SETTLEMENTS),
    truncated: all.length > MAX_PUBLIC_BASE_SETTLEMENTS,
  };
}

function receiptSummary(receipt: BaseTransactionReceipt): BaseTransactionReceiptSummary {
  return {
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
  };
}

function observation(
  base: Pick<
    BaseTransactionObservationV01,
    "checkedAt" | "transactionHash" | "registryHash"
  >,
  result: Omit<
    BaseTransactionObservationV01,
    | "schemaVersion"
    | "kind"
    | "checkedAt"
    | "networkId"
    | "transactionHash"
    | "registryHash"
    | "observationHash"
  >,
): BaseTransactionObservationV01 {
  const unsigned = {
    schemaVersion: "0.1" as const,
    kind: "base_transaction_observation" as const,
    checkedAt: base.checkedAt,
    networkId: BASE_MAINNET_NETWORK,
    transactionHash: base.transactionHash,
    registryHash: base.registryHash,
    ...result,
    reasons: [...new Set(result.reasons)].sort(),
  };
  const observationHash = `sha256:${createHash("sha256")
    .update(`${OBSERVATION_DOMAIN}\n${canonicalJson(unsigned)}`, "utf8")
    .digest("hex")}`;
  return deepFreeze({ ...unsigned, observationHash });
}

function emptyExtraction(): NativeUsdcEip3009Extraction {
  return { settlementCount: 0, settlements: [], truncated: false };
}

function parseRequest(value: BaseTransactionObservationRequest): BaseTransactionObservationRequest {
  if (!isRecord(value)) fail("OBSERVATION_REQUEST_INVALID");
  for (const field of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(field)) fail("OBSERVATION_REQUEST_UNEXPECTED_FIELD");
  }
  for (const field of REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail("OBSERVATION_REQUEST_REQUIRED_FIELD_MISSING");
    }
  }
  return {
    transactionHash: normalizeBaseTransactionHash(value.transactionHash),
    checkedAt: canonicalTimestamp(value.checkedAt, "CHECKED_AT"),
  };
}

function validateRegistry(registry: BaseRpcSourceRegistry): BaseRpcSourceRegistry {
  if (!isRecord(registry)) fail("REGISTRY_INVALID");
  let canonical: BaseRpcSourceRegistry;
  try {
    canonical = deriveBaseRpcSourceRegistry(registry.manifest);
  } catch {
    fail("REGISTRY_INVALID");
  }
  if (
    canonical.registryHash !== registry.registryHash ||
    canonicalJson(canonical.sourceLabels) !== canonicalJson(registry.sourceLabels)
  ) {
    fail("REGISTRY_INTEGRITY_MISMATCH");
  }
  if (canonical.manifest.sources.length !== 2) fail("REGISTRY_REQUIRES_TWO_SOURCES");
  return canonical;
}

function sameBlock(left: NormalizedBaseRpcBlock, right: NormalizedBaseRpcBlock): boolean {
  return (
    left.number === right.number &&
    left.hash === right.hash &&
    left.timestamp === right.timestamp
  );
}

function safeConfirmations(anchor: bigint, receiptBlock: bigint): number {
  const confirmations = anchor - receiptBlock + 1n;
  if (confirmations < 1n || confirmations > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CONFIRMATION_COUNT_INVALID");
  }
  return Number(confirmations);
}

/**
 * Collect a transaction-only Base observation from exactly two registry-owned
 * sources. The caller controls only the transaction hash and observation time;
 * this function performs read RPC methods only and never retries.
 */
export async function collectBaseTransactionObservation(
  registry: BaseRpcSourceRegistry,
  requester: BaseRpcRequester,
  request: BaseTransactionObservationRequest,
): Promise<BaseTransactionObservationV01> {
  const checkedRegistry = validateRegistry(registry);
  const checkedRequest = parseRequest(request);
  const base = {
    checkedAt: checkedRequest.checkedAt,
    transactionHash: checkedRequest.transactionHash,
    registryHash: checkedRegistry.registryHash,
  };
  const sources = checkedRegistry.manifest.sources;

  const initial = await Promise.all(
    sources.map(async (source) => {
      const [chainId, genesisValue, finalizedValue, receiptValue] = await Promise.all([
        requester.request(source.id, "eth_chainId", []),
        requester.request(source.id, "eth_getBlockByNumber", ["0x0", false]),
        requester.request(source.id, "eth_getBlockByNumber", ["finalized", false]),
        requester.request(source.id, "eth_getTransactionReceipt", [
          checkedRequest.transactionHash,
        ]),
      ]);
      return {
        chainId:
          typeof chainId === "string" && chainId.toLowerCase() === BASE_CHAIN_ID_HEX,
        genesis: normalizeBaseRpcBlock(genesisValue, "GENESIS_BLOCK"),
        finalized: normalizeBaseRpcBlock(finalizedValue, "FINALIZED_HEAD"),
        receipt: normalizeBaseTransactionReceipt(
          receiptValue,
          checkedRequest.transactionHash,
        ),
      };
    }),
  );

  if (initial.some((entry) => !entry.chainId)) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor: null,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RPC_CHAIN_ID_MISMATCH"],
    });
  }
  if (
    initial.some(
      (entry) =>
        entry.genesis.number !== "0" || entry.genesis.hash !== BASE_GENESIS_BLOCK_HASH,
    )
  ) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor: null,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RPC_GENESIS_HASH_MISMATCH"],
    });
  }

  const anchorNumber = initial.reduce(
    (minimum, entry) =>
      BigInt(entry.finalized.number) < minimum
        ? BigInt(entry.finalized.number)
        : minimum,
    BigInt(initial[0]!.finalized.number),
  );
  const anchorHex = quantityHex(anchorNumber);
  const anchorBlocks = await Promise.all(
    sources.map(async (source) =>
      normalizeBaseRpcBlock(
        await requester.request(source.id, "eth_getBlockByNumber", [anchorHex, false]),
        "FINALIZED_ANCHOR",
      ),
    ),
  );
  const firstAnchor = anchorBlocks[0]!;
  if (
    firstAnchor.number !== anchorNumber.toString() ||
    anchorBlocks.some(
      (block) => block.number !== anchorNumber.toString() || !sameBlock(block, firstAnchor),
    )
  ) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor: null,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["FINALIZED_ANCHOR_CONTRADICTION"],
    });
  }
  for (let index = 0; index < initial.length; index += 1) {
    const head = initial[index]!.finalized;
    if (head.number === anchorNumber.toString() && !sameBlock(head, anchorBlocks[index]!)) {
      return observation(base, {
        status: "contradiction",
        receipt: null,
        finalizedAnchor: null,
        sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
        confirmations: 0,
        ...emptyExtraction(),
        reasons: ["FINALIZED_HEAD_ANCHOR_CONTRADICTION"],
      });
    }
  }
  if (BigInt(firstAnchor.timestamp) > BigInt(Math.floor(Date.parse(checkedRequest.checkedAt) / 1_000))) {
    fail("FINALIZED_ANCHOR_FROM_FUTURE");
  }
  const finalizedAnchor = {
    blockNumber: firstAnchor.number,
    blockHash: firstAnchor.hash,
    blockTimestamp: firstAnchor.timestamp,
  };

  const canonicalAnchor = { blockHash: firstAnchor.hash, requireCanonical: true } as const;
  const nativeUsdcIdentities = await Promise.all(
    sources.map(async (source) => {
      const [proxyCode, implementationSlot] = await Promise.all([
        requester.request(source.id, "eth_getCode", [BASE_USDC_ASSET, canonicalAnchor]),
        requester.request(source.id, "eth_getStorageAt", [
          BASE_USDC_ASSET,
          CIRCLE_PROXY_IMPLEMENTATION_SLOT,
          canonicalAnchor,
        ]),
      ]);
      const address = implementationAddress(implementationSlot);
      const implementationCode = await requester.request(source.id, "eth_getCode", [
        address,
        canonicalAnchor,
      ]);
      return {
        proxyCodeSha256: bytesSha256(proxyCode, "NATIVE_USDC_PROXY_CODE"),
        implementationAddress: address,
        implementationCodeSha256: bytesSha256(
          implementationCode,
          "NATIVE_USDC_IMPLEMENTATION_CODE",
        ),
      };
    }),
  );
  if (canonicalJson(nativeUsdcIdentities[0]) !== canonicalJson(nativeUsdcIdentities[1])) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["NATIVE_USDC_IDENTITY_CONTRADICTION"],
    });
  }
  const nativeUsdcIdentity = nativeUsdcIdentities[0]!;
  if (
    !checkedRegistry.manifest.nativeUsdc.allowedProxyCodeSha256.includes(
      nativeUsdcIdentity.proxyCodeSha256,
    ) ||
    !checkedRegistry.manifest.nativeUsdc.allowedImplementationCodeSha256.includes(
      nativeUsdcIdentity.implementationCodeSha256,
    )
  ) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["NATIVE_USDC_CODE_NOT_ALLOWED"],
    });
  }

  const present = initial.flatMap((entry) => (entry.receipt === null ? [] : [entry.receipt]));
  if (present.length === 0) {
    return observation(base, {
      status: "not_observed",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RECEIPT_NOT_OBSERVED"],
    });
  }
  if (present.some((receipt) => receipt.logs.some((log) => log.removed === true))) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["REMOVED_LOG_REJECTED"],
    });
  }
  if (present.length === 1) {
    const representative = present[0]!;
    if (BigInt(representative.blockNumber) > anchorNumber) {
      return observation(base, {
        status: "pending_finality",
        receipt: receiptSummary(representative),
        finalizedAnchor,
        sourceAgreement: { configured: 2, agreeing: 1, quorum: "unanimous" },
        confirmations: 0,
        ...emptyExtraction(),
        reasons: ["RECEIPT_NOT_FINALIZED_BY_ALL_SOURCES"],
      });
    }
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 1, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RECEIPT_PRESENCE_CONTRADICTION"],
    });
  }

  const firstReceipt = present[0]!;
  if (canonicalJson(firstReceipt) !== canonicalJson(present[1]!)) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RECEIPT_CONTRADICTION"],
    });
  }

  if (BigInt(firstReceipt.blockNumber) > anchorNumber) {
    return observation(base, {
      status: "pending_finality",
      receipt: receiptSummary(firstReceipt),
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
      confirmations: 0,
      ...extractNativeUsdcEip3009Settlements(firstReceipt),
      reasons: ["RECEIPT_PENDING_FINALITY"],
    });
  }

  const receiptBlockHex = quantityHex(BigInt(firstReceipt.blockNumber));
  const receiptBlocks = await Promise.all(
    sources.map(async (source) =>
      normalizeBaseRpcBlock(
        await requester.request(source.id, "eth_getBlockByNumber", [receiptBlockHex, false]),
        "RECEIPT_CANONICAL_BLOCK",
      ),
    ),
  );
  if (
    receiptBlocks.some(
      (block) =>
        block.number !== firstReceipt.blockNumber || block.hash !== firstReceipt.blockHash,
    ) ||
    !sameBlock(receiptBlocks[0]!, receiptBlocks[1]!)
  ) {
    return observation(base, {
      status: "contradiction",
      receipt: null,
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" },
      confirmations: 0,
      ...emptyExtraction(),
      reasons: ["RECEIPT_CANONICAL_BLOCK_CONTRADICTION"],
    });
  }

  const confirmations = safeConfirmations(anchorNumber, BigInt(firstReceipt.blockNumber));
  if (firstReceipt.status === "reverted") {
    return observation(base, {
      status: "reverted",
      receipt: receiptSummary(firstReceipt),
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
      confirmations,
      ...emptyExtraction(),
      reasons: ["FINALIZED_RECEIPT_UNANIMOUS", "RECEIPT_REVERTED"],
    });
  }

  const extraction = extractNativeUsdcEip3009Settlements(firstReceipt);
  if (extraction.settlementCount === 0) {
    return observation(base, {
      status: "not_eip3009_usdc",
      receipt: receiptSummary(firstReceipt),
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
      confirmations,
      ...extraction,
      reasons: [
        "FINALIZED_RECEIPT_UNANIMOUS",
        "NATIVE_USDC_EIP3009_PAIR_NOT_OBSERVED",
      ],
    });
  }
  if (extraction.settlementCount > 1) {
    return observation(base, {
      status: "multiple",
      receipt: receiptSummary(firstReceipt),
      finalizedAnchor,
      sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
      confirmations,
      ...extraction,
      reasons: [
        "FINALIZED_RECEIPT_UNANIMOUS",
        "MULTIPLE_NATIVE_USDC_EIP3009_PAIRS_OBSERVED",
      ],
    });
  }
  return observation(base, {
    status: "confirmed",
    receipt: receiptSummary(firstReceipt),
    finalizedAnchor,
    sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
    confirmations,
    ...extraction,
    reasons: ["FINALIZED_RECEIPT_UNANIMOUS", "NATIVE_USDC_EIP3009_PAIR_OBSERVED"],
  });
}
