import type {
  BaseTransactionObservationRequest,
  BaseTransactionObservationStatus,
  BaseTransactionObservationV01,
  BaseTransactionReceiptSummary,
  NativeUsdcEip3009Settlement,
} from "./evidence/base-transaction.js";

const PUBLIC_ROUTE = "/api/base-transaction";
const RAW_ROUTE = /^\/api\/base-transaction\?transactionHash=(0x[0-9a-f]{64})$/;
const QUERY_FIELDS = new Set(["transactionHash"]);
const MAX_FINALIZED_ANCHOR_AGE_SECONDS = 60 * 60;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;

export interface PublicBaseTransactionHttpRequest {
  method: string | undefined;
  url: string | undefined;
  query: unknown;
  hasBody: boolean;
}

export type PublicBaseTransactionCollector = (
  request: BaseTransactionObservationRequest,
) => Promise<BaseTransactionObservationV01>;

export interface PublicBaseTransactionResponseV01 {
  schemaVersion: "0.1";
  kind: "public_base_transaction_verification";
  checkedAt: string;
  networkId: "eip155:8453";
  transactionHash: string;
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
  assurance: {
    scope: "fixed_source_base_receipt_and_native_usdc_eip3009_events";
    sourceIdentity: "server_pinned_origins";
    finality: "shared_finalized_block_hash";
    quorum: "unanimous";
    externalTruthProven: false;
  };
  capabilities: {
    fixedSourceBaseVerificationEnabled: true;
    callerSelectedTransactionHashEnabled: true;
    callerSelectedTargetEnabled: false;
    callerSelectedRpcEnabled: false;
    paymentExecutionEnabled: false;
    walletAccessEnabled: false;
    signingEnabled: false;
    transactionSubmissionEnabled: false;
    retryExecutionEnabled: false;
    actionExecutionEnabled: false;
  };
  privacy: {
    transactionHashTransport: "public_url_query";
    transactionHashMayAppearInPlatformLogs: true;
    applicationPersistenceEnabled: false;
  };
  limitations: {
    intendedX402TermsProven: false;
    httpDeliveryProven: false;
    businessEffectProven: false;
    retrySafetyProven: false;
  };
}

export class PublicBaseTransactionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 405,
  ) {
    super(code);
    this.name = "PublicBaseTransactionRequestError";
  }
}

export class PublicBaseTransactionBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PublicBaseTransactionBoundaryError";
  }
}

export const PUBLIC_BASE_TRANSACTION_ASSURANCE = Object.freeze({
  scope: "fixed_source_base_receipt_and_native_usdc_eip3009_events" as const,
  sourceIdentity: "server_pinned_origins" as const,
  finality: "shared_finalized_block_hash" as const,
  quorum: "unanimous" as const,
  externalTruthProven: false as const,
});

export const PUBLIC_BASE_TRANSACTION_CAPABILITIES = Object.freeze({
  fixedSourceBaseVerificationEnabled: true as const,
  callerSelectedTransactionHashEnabled: true as const,
  callerSelectedTargetEnabled: false as const,
  callerSelectedRpcEnabled: false as const,
  paymentExecutionEnabled: false as const,
  walletAccessEnabled: false as const,
  signingEnabled: false as const,
  transactionSubmissionEnabled: false as const,
  retryExecutionEnabled: false as const,
  actionExecutionEnabled: false as const,
});

export const PUBLIC_BASE_TRANSACTION_PRIVACY = Object.freeze({
  transactionHashTransport: "public_url_query" as const,
  transactionHashMayAppearInPlatformLogs: true as const,
  applicationPersistenceEnabled: false as const,
});

export const PUBLIC_BASE_TRANSACTION_LIMITATIONS = Object.freeze({
  intendedX402TermsProven: false as const,
  httpDeliveryProven: false as const,
  businessEffectProven: false as const,
  retrySafetyProven: false as const,
});

function requestError(code: string, statusCode: 400 | 405): never {
  throw new PublicBaseTransactionRequestError(code, statusCode);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactQueryHash(value: unknown): string {
  if (!isPlainRecord(value)) requestError("QUERY_INVALID", 400);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== 1 ||
    ownKeys[0] !== "transactionHash" ||
    !QUERY_FIELDS.has(String(ownKeys[0]))
  ) {
    requestError("QUERY_FIELDS_INVALID", 400);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "transactionHash");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    typeof descriptor.value !== "string"
  ) {
    requestError("QUERY_INVALID", 400);
  }
  if (!/^0x[0-9a-f]{64}$/.test(descriptor.value)) {
    requestError("TRANSACTION_HASH_INVALID", 400);
  }
  return descriptor.value;
}

/** Validate the raw URL and Vercel's parsed query before any runtime is built. */
export function parsePublicBaseTransactionRequest(
  request: PublicBaseTransactionHttpRequest,
): string {
  if (request.method !== "GET") requestError("METHOD_NOT_ALLOWED", 405);
  if (request.hasBody) requestError("REQUEST_BODY_NOT_ALLOWED", 400);
  if (typeof request.url !== "string" || request.url.length > 256) {
    requestError("REQUEST_URL_INVALID", 400);
  }
  const match = RAW_ROUTE.exec(request.url);
  if (match === null) requestError("QUERY_INVALID", 400);
  const rawHash = match[1]!;
  const parsedHash = exactQueryHash(request.query);
  if (rawHash !== parsedHash) requestError("QUERY_MISMATCH", 400);
  return rawHash;
}

function cloneReceipt(
  receipt: BaseTransactionReceiptSummary | null,
): BaseTransactionReceiptSummary | null {
  return receipt === null ? null : { ...receipt };
}

function assertObservationBinding(
  observation: BaseTransactionObservationV01,
  transactionHash: string,
  checkedAt: string,
): void {
  if (
    observation.schemaVersion !== "0.1" ||
    observation.kind !== "base_transaction_observation" ||
    observation.networkId !== "eip155:8453" ||
    observation.transactionHash !== transactionHash ||
    observation.checkedAt !== checkedAt
  ) {
    throw new PublicBaseTransactionBoundaryError("OBSERVATION_BINDING_INVALID");
  }
  if (observation.finalizedAnchor !== null) {
    const timestamp = observation.finalizedAnchor.blockTimestamp;
    if (!CANONICAL_UINT.test(timestamp)) {
      throw new PublicBaseTransactionBoundaryError("FINALIZED_ANCHOR_TIMESTAMP_INVALID");
    }
    const checkedAtSeconds = BigInt(Math.floor(Date.parse(checkedAt) / 1_000));
    const anchorSeconds = BigInt(timestamp);
    if (
      anchorSeconds > checkedAtSeconds ||
      checkedAtSeconds - anchorSeconds > BigInt(MAX_FINALIZED_ANCHOR_AGE_SECONDS)
    ) {
      throw new PublicBaseTransactionBoundaryError("FINALIZED_ANCHOR_TIME_UNTRUSTED");
    }
  }
}

function publicResponse(
  observation: BaseTransactionObservationV01,
): PublicBaseTransactionResponseV01 {
  const response: PublicBaseTransactionResponseV01 = {
    schemaVersion: "0.1",
    kind: "public_base_transaction_verification",
    checkedAt: observation.checkedAt,
    networkId: "eip155:8453",
    transactionHash: observation.transactionHash,
    status: observation.status,
    receipt: cloneReceipt(observation.receipt),
    finalizedAnchor:
      observation.finalizedAnchor === null
        ? null
        : { ...observation.finalizedAnchor },
    sourceAgreement: { ...observation.sourceAgreement },
    confirmations: observation.confirmations,
    settlementCount: observation.settlementCount,
    settlements: observation.settlements.map((settlement) => ({ ...settlement })),
    truncated: observation.truncated,
    reasons: [...observation.reasons],
    observationHash: observation.observationHash,
    assurance: PUBLIC_BASE_TRANSACTION_ASSURANCE,
    capabilities: PUBLIC_BASE_TRANSACTION_CAPABILITIES,
    privacy: PUBLIC_BASE_TRANSACTION_PRIVACY,
    limitations: PUBLIC_BASE_TRANSACTION_LIMITATIONS,
  };
  return Object.freeze(response);
}

export async function verifyPublicBaseTransaction(
  request: PublicBaseTransactionHttpRequest,
  collector: PublicBaseTransactionCollector,
  checkedAt: string,
): Promise<PublicBaseTransactionResponseV01> {
  const transactionHash = parsePublicBaseTransactionRequest(request);
  const observation = await collector({ transactionHash, checkedAt });
  assertObservationBinding(observation, transactionHash, checkedAt);
  return publicResponse(observation);
}

export const PUBLIC_BASE_TRANSACTION_PATH = PUBLIC_ROUTE;
