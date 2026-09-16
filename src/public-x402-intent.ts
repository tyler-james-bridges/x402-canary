import { createHash } from "node:crypto";

import { canonicalJson } from "./evidence/canonical.js";
import { normalizeBaseTransactionHash } from "./evidence/base-transaction.js";
import {
  X402RequirementIntentError,
  evaluateX402RequirementCase,
  normalizeX402RequirementIntent,
  type X402ExactBaseUsdcRequirementV02,
  type X402RequirementCaseEvaluationV02,
  type X402RequirementCaseStatus,
  type X402RequirementComparison,
  type X402RequirementIntentV02,
} from "./evidence/x402-intent.js";
import type { PublicBaseTransactionResponseV01 } from "./public-base-transaction.js";

const PUBLIC_ROUTE = "/api/x402-intent";
const RAW_ROUTE = /^\/api\/x402-intent$/;
const REQUEST_FIELDS = new Set([
  "x402Version",
  "transactionHash",
  "paymentRequirements",
]);
const REPORT_DOMAIN = "x402-canary:public-x402-requirement-report:v0.2";

export const PUBLIC_X402_INTENT_MAX_CANONICAL_BODY_BYTES = 6_144;
export const PUBLIC_X402_INTENT_MAX_WIRE_BODY_BYTES = 8_192;

export interface PublicX402IntentHttpRequest {
  method: string | undefined;
  url: string | undefined;
  query: unknown;
  body: unknown;
}

export interface ParsedPublicX402IntentRequest {
  transactionHash: string;
  intent: X402RequirementIntentV02;
}

export interface PublicX402IntentResponseV02 {
  schemaVersion: "0.2";
  kind: "public_x402_requirement_verification";
  checkedAt: string;
  status: X402RequirementCaseStatus;
  transactionHash: string;
  caseId: string;
  reportHash: string;
  intent: {
    x402Version: 2;
    paymentRequirements: X402ExactBaseUsdcRequirementV02;
    intentHash: string;
  };
  comparisons: X402RequirementComparison[];
  observedPayment: X402RequirementCaseEvaluationV02["observedSettlement"];
  baseEvidence: {
    status: PublicBaseTransactionResponseV01["status"];
    observationHash: string;
    receipt: PublicBaseTransactionResponseV01["receipt"];
    finalizedAnchor: PublicBaseTransactionResponseV01["finalizedAnchor"];
    sourceAgreement: PublicBaseTransactionResponseV01["sourceAgreement"];
    confirmations: number;
    settlementCount: number;
    truncated: boolean;
  };
  reasons: string[];
  assurance: typeof PUBLIC_X402_INTENT_ASSURANCE;
  capabilities: typeof PUBLIC_X402_INTENT_CAPABILITIES;
  privacy: typeof PUBLIC_X402_INTENT_PRIVACY;
  limitations: typeof PUBLIC_X402_INTENT_LIMITATIONS;
}

export class PublicX402IntentRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 405 | 413,
  ) {
    super(code);
    this.name = "PublicX402IntentRequestError";
  }
}

export class PublicX402IntentBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PublicX402IntentBoundaryError";
  }
}

export const PUBLIC_X402_INTENT_ASSURANCE = Object.freeze({
  scope: "supported_x402_v2_settlement_terms" as const,
  requirementSource: "caller_declared" as const,
  sourceIdentity: "server_pinned_origins" as const,
  finality: "shared_finalized_block_hash" as const,
  quorum: "unanimous" as const,
  reportIntegrity: "unsigned_sha256_content_identity" as const,
  externalTruthProven: false as const,
});

export const PUBLIC_X402_INTENT_CAPABILITIES = Object.freeze({
  x402RequirementComparisonEnabled: true as const,
  fixedSourceBaseVerificationEnabled: true as const,
  callerDeclaredRequirementEnabled: true as const,
  callerSelectedTransactionHashEnabled: true as const,
  callerSelectedTargetEnabled: false as const,
  callerSelectedRpcEnabled: false as const,
  callerDeclaredResourceUrlEnabled: false as const,
  paymentExecutionEnabled: false as const,
  walletAccessEnabled: false as const,
  signingEnabled: false as const,
  transactionSubmissionEnabled: false as const,
  retryExecutionEnabled: false as const,
  actionExecutionEnabled: false as const,
});

export const PUBLIC_X402_INTENT_PRIVACY = Object.freeze({
  transactionHashTransport: "request_body" as const,
  requirementTransport: "request_body" as const,
  paymentRequirementsForwardedToRpc: false as const,
  applicationPersistenceEnabled: false as const,
});

export const PUBLIC_X402_INTENT_LIMITATIONS = Object.freeze({
  x402WireExchangeProven: false as const,
  requirementAuthenticityProven: false as const,
  resourceBindingProven: false as const,
  expectedPayerProven: false as const,
  expectedNonceProven: false as const,
  authorizationWindowProven: false as const,
  timeoutComplianceProven: false as const,
  authorizationSignatureProven: false as const,
  httpDeliveryProven: false as const,
  businessEffectProven: false as const,
  duplicatePurchaseProven: false as const,
  retrySafetyProven: false as const,
});

function requestError(code: string, statusCode: 400 | 405 | 413 = 400): never {
  throw new PublicX402IntentRequestError(code, statusCode);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactBody(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) requestError("REQUEST_BODY_INVALID");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== REQUEST_FIELDS.size ||
    keys.some((key) => typeof key !== "string" || !REQUEST_FIELDS.has(key))
  ) {
    requestError("REQUEST_BODY_FIELDS_INVALID");
  }
  for (const key of keys) {
    if (typeof key !== "string") requestError("REQUEST_BODY_FIELDS_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      requestError("REQUEST_BODY_FIELDS_INVALID");
    }
  }
  return value;
}

function emptyQuery(value: unknown): boolean {
  return isPlainRecord(value) && Reflect.ownKeys(value).length === 0;
}

function cloneRequirement(
  requirement: X402ExactBaseUsdcRequirementV02,
): X402ExactBaseUsdcRequirementV02 {
  return {
    ...requirement,
    extra: { ...requirement.extra },
  };
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function reportHash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${REPORT_DOMAIN}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

/** Parse every caller-controlled field before a Base RPC runtime can be built. */
export function parsePublicX402IntentRequest(
  request: PublicX402IntentHttpRequest,
): ParsedPublicX402IntentRequest {
  if (request.method !== "POST") requestError("METHOD_NOT_ALLOWED", 405);
  if (
    typeof request.url !== "string" ||
    !RAW_ROUTE.test(request.url) ||
    !emptyQuery(request.query)
  ) {
    requestError("REQUEST_URL_INVALID");
  }
  const body = exactBody(request.body);
  let transactionHash: string;
  try {
    transactionHash = normalizeBaseTransactionHash(body.transactionHash);
  } catch {
    requestError("TRANSACTION_HASH_INVALID");
  }

  try {
    const intent = normalizeX402RequirementIntent({
      x402Version: body.x402Version,
      paymentRequirements: body.paymentRequirements,
    });
    const canonicalBody = canonicalJson({
      x402Version: intent.x402Version,
      transactionHash,
      paymentRequirements: intent.paymentRequirements,
    });
    if (
      Buffer.byteLength(canonicalBody, "utf8") >
      PUBLIC_X402_INTENT_MAX_CANONICAL_BODY_BYTES
    ) {
      requestError("REQUEST_BODY_TOO_LARGE", 413);
    }
    return deepFreeze({ transactionHash, intent });
  } catch (error) {
    if (error instanceof PublicX402IntentRequestError) throw error;
    if (error instanceof X402RequirementIntentError) {
      requestError(error.code);
    }
    requestError("PAYMENT_REQUIREMENTS_INVALID");
  }
}

function assertBindings(
  parsed: ParsedPublicX402IntentRequest,
  base: PublicBaseTransactionResponseV01,
  evaluation: X402RequirementCaseEvaluationV02,
): void {
  if (
    base.schemaVersion !== "0.1" ||
    base.kind !== "public_base_transaction_verification" ||
    base.transactionHash !== parsed.transactionHash ||
    evaluation.schemaVersion !== "0.2" ||
    evaluation.kind !== "x402_requirement_case_evaluation" ||
    evaluation.transactionHash !== parsed.transactionHash ||
    evaluation.intentHash !== parsed.intent.intentHash
  ) {
    throw new PublicX402IntentBoundaryError("CASE_BINDING_INVALID");
  }
}

/** Build the exact redacted public report from already-bound public Base evidence. */
export function createPublicX402IntentResponse(
  parsed: ParsedPublicX402IntentRequest,
  base: PublicBaseTransactionResponseV01,
  evaluation: X402RequirementCaseEvaluationV02,
): PublicX402IntentResponseV02 {
  assertBindings(parsed, base, evaluation);
  const core = {
    schemaVersion: "0.2" as const,
    kind: "public_x402_requirement_verification" as const,
    checkedAt: base.checkedAt,
    status: evaluation.status,
    transactionHash: parsed.transactionHash,
    caseId: evaluation.caseId,
    intent: {
      x402Version: 2 as const,
      paymentRequirements: cloneRequirement(parsed.intent.paymentRequirements),
      intentHash: parsed.intent.intentHash,
    },
    comparisons: evaluation.comparisons.map((item) => ({ ...item })),
    observedPayment:
      evaluation.observedSettlement === null
        ? null
        : { ...evaluation.observedSettlement },
    baseEvidence: {
      status: base.status,
      observationHash: base.observationHash,
      receipt: base.receipt === null ? null : { ...base.receipt },
      finalizedAnchor:
        base.finalizedAnchor === null ? null : { ...base.finalizedAnchor },
      sourceAgreement: { ...base.sourceAgreement },
      confirmations: base.confirmations,
      settlementCount: base.settlementCount,
      truncated: base.truncated,
    },
    reasons: [...evaluation.reasons],
    assurance: PUBLIC_X402_INTENT_ASSURANCE,
    capabilities: PUBLIC_X402_INTENT_CAPABILITIES,
    privacy: PUBLIC_X402_INTENT_PRIVACY,
    limitations: PUBLIC_X402_INTENT_LIMITATIONS,
  };
  return deepFreeze({
    ...core,
    reportHash: reportHash(core),
  });
}

export function evaluatePublicX402Intent(
  parsed: ParsedPublicX402IntentRequest,
  baseObservation: Parameters<typeof evaluateX402RequirementCase>[1],
): X402RequirementCaseEvaluationV02 {
  return evaluateX402RequirementCase(parsed.intent, baseObservation);
}

export const PUBLIC_X402_INTENT_PATH = PUBLIC_ROUTE;
