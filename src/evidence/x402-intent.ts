import { createHash } from "node:crypto";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import { canonicalJson } from "./canonical.js";
import type {
  BaseTransactionObservationV01,
  NativeUsdcEip3009Settlement,
} from "./base-transaction.js";

const INTENT_DOMAIN = "x402-canary:x402-requirement:v0.2";
const CASE_DOMAIN = "x402-canary:x402-requirement-case:v0.2";
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CANONICAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const REQUIREMENT_FIELDS = new Set([
  "scheme",
  "network",
  "amount",
  "asset",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
]);
const REQUIREMENT_EXTRA_FIELDS = new Set([
  "assetTransferMethod",
  "name",
  "version",
]);

export const X402_INTENT_MAX_TIMEOUT_SECONDS = 86_400;

export interface X402ExactBaseUsdcRequirementV02 {
  scheme: "exact";
  network: "eip155:8453";
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: "eip3009";
    name: "USD Coin";
    version: "2";
  };
}

export interface X402RequirementIntentV02 {
  x402Version: 2;
  paymentRequirements: X402ExactBaseUsdcRequirementV02;
  intentHash: string;
}

export type X402RequirementCaseStatus =
  | "settlement_terms_matched"
  | "settlement_terms_mismatch"
  | "pending_finality"
  | "not_observed"
  | "multiple_payments_observed"
  | "contradiction";

export type X402RequirementComparisonStatus =
  | "matched"
  | "mismatched"
  | "declared_only"
  | "not_evaluated";

export type X402RequirementComparisonField =
  | "scheme"
  | "network"
  | "asset"
  | "transferMethod"
  | "tokenDomain"
  | "recipient"
  | "amount"
  | "maxTimeoutSeconds";

export interface X402RequirementComparison {
  field: X402RequirementComparisonField;
  expected: string;
  observed: string | null;
  status: X402RequirementComparisonStatus;
  basis:
    | "supported_requirement"
    | "fixed_source_base_observation"
    | "native_usdc_identity"
    | "eip3009_event_pair"
    | "caller_declaration";
}

export interface X402RequirementCaseEvaluationV02 {
  schemaVersion: "0.2";
  kind: "x402_requirement_case_evaluation";
  status: X402RequirementCaseStatus;
  transactionHash: string;
  intentHash: string;
  caseId: string;
  reasons: string[];
  comparisons: X402RequirementComparison[];
  observedSettlement: NativeUsdcEip3009Settlement | null;
}

export class X402RequirementIntentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "X402RequirementIntentError";
  }
}

function fail(code: string): never {
  throw new X402RequirementIntentError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactOwnKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  field: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.size) {
    fail(`${field}_FIELDS_INVALID`);
  }
  for (const key of keys) {
    if (typeof key !== "string" || !expected.has(key)) fail(`${field}_FIELDS_INVALID`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      fail(`${field}_FIELDS_INVALID`);
    }
  }
}

function normalizeAddress(value: unknown, field: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) fail(`${field}_INVALID`);
  const normalized = value.toLowerCase();
  if (normalized === ZERO_ADDRESS) fail(`${field}_ZERO`);
  return normalized;
}

function normalizeAmount(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value)) {
    fail("PAYMENT_REQUIREMENTS_AMOUNT_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > UINT256_MAX) {
    fail("PAYMENT_REQUIREMENTS_AMOUNT_INVALID");
  }
  return value;
}

function sha256Domain(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

/**
 * Strictly normalize the one x402 v2 requirement supported by the public case
 * verifier. Unsupported schemes and assets fail before any RPC runtime exists.
 */
export function normalizeX402RequirementIntent(input: {
  x402Version: unknown;
  paymentRequirements: unknown;
}): X402RequirementIntentV02 {
  if (input.x402Version !== 2) fail("X402_VERSION_UNSUPPORTED");
  if (!isPlainRecord(input.paymentRequirements)) {
    fail("PAYMENT_REQUIREMENTS_INVALID");
  }
  exactOwnKeys(
    input.paymentRequirements,
    REQUIREMENT_FIELDS,
    "PAYMENT_REQUIREMENTS",
  );

  if (input.paymentRequirements.scheme !== "exact") {
    fail("PAYMENT_REQUIREMENTS_SCHEME_UNSUPPORTED");
  }
  if (input.paymentRequirements.network !== BASE_MAINNET_NETWORK) {
    fail("PAYMENT_REQUIREMENTS_NETWORK_UNSUPPORTED");
  }
  const asset = normalizeAddress(
    input.paymentRequirements.asset,
    "PAYMENT_REQUIREMENTS_ASSET",
  );
  if (asset !== BASE_USDC_ASSET) {
    fail("PAYMENT_REQUIREMENTS_ASSET_UNSUPPORTED");
  }
  const payTo = normalizeAddress(
    input.paymentRequirements.payTo,
    "PAYMENT_REQUIREMENTS_PAY_TO",
  );
  const amount = normalizeAmount(input.paymentRequirements.amount);
  const maxTimeoutSeconds = input.paymentRequirements.maxTimeoutSeconds;
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    typeof maxTimeoutSeconds !== "number" ||
    maxTimeoutSeconds <= 0 ||
    maxTimeoutSeconds > X402_INTENT_MAX_TIMEOUT_SECONDS
  ) {
    fail("PAYMENT_REQUIREMENTS_TIMEOUT_UNSUPPORTED");
  }

  const extra = input.paymentRequirements.extra;
  if (!isPlainRecord(extra)) fail("PAYMENT_REQUIREMENTS_EXTRA_INVALID");
  const extraKeys = Reflect.ownKeys(extra);
  if (
    extraKeys.some((key) => typeof key !== "string") ||
    extraKeys.some((key) => !REQUIREMENT_EXTRA_FIELDS.has(String(key))) ||
    !Object.prototype.hasOwnProperty.call(extra, "name") ||
    !Object.prototype.hasOwnProperty.call(extra, "version")
  ) {
    fail("PAYMENT_REQUIREMENTS_EXTRA_FIELDS_INVALID");
  }
  for (const key of extraKeys) {
    if (typeof key !== "string") fail("PAYMENT_REQUIREMENTS_EXTRA_FIELDS_INVALID");
    const descriptor = Object.getOwnPropertyDescriptor(extra, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail("PAYMENT_REQUIREMENTS_EXTRA_FIELDS_INVALID");
    }
  }
  if (
    extra.assetTransferMethod !== undefined &&
    extra.assetTransferMethod !== "eip3009"
  ) {
    fail("PAYMENT_REQUIREMENTS_TRANSFER_METHOD_UNSUPPORTED");
  }
  if (extra.name !== "USD Coin" || extra.version !== "2") {
    fail("PAYMENT_REQUIREMENTS_TOKEN_DOMAIN_UNSUPPORTED");
  }

  const paymentRequirements: X402ExactBaseUsdcRequirementV02 = {
    scheme: "exact",
    network: BASE_MAINNET_NETWORK,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USD Coin",
      version: "2",
    },
  };
  const hashInput = { x402Version: 2 as const, paymentRequirements };
  return deepFreeze({
    ...hashInput,
    intentHash: sha256Domain(INTENT_DOMAIN, hashInput),
  });
}

function comparison(
  field: X402RequirementComparisonField,
  expected: string,
  observed: string | null,
  status: X402RequirementComparisonStatus,
  basis: X402RequirementComparison["basis"],
): X402RequirementComparison {
  return { field, expected, observed, status, basis };
}

function staticComparisons(
  intent: X402RequirementIntentV02,
  settlementObserved: boolean,
): X402RequirementComparison[] {
  const requirement = intent.paymentRequirements;
  return [
    comparison(
      "scheme",
      requirement.scheme,
      null,
      "declared_only",
      "caller_declaration",
    ),
    comparison(
      "network",
      requirement.network,
      settlementObserved ? BASE_MAINNET_NETWORK : null,
      settlementObserved ? "matched" : "not_evaluated",
      "fixed_source_base_observation",
    ),
    comparison(
      "asset",
      requirement.asset,
      settlementObserved ? BASE_USDC_ASSET : null,
      settlementObserved ? "matched" : "not_evaluated",
      "native_usdc_identity",
    ),
    comparison(
      "transferMethod",
      requirement.extra.assetTransferMethod,
      settlementObserved ? "eip3009" : null,
      settlementObserved ? "matched" : "not_evaluated",
      "eip3009_event_pair",
    ),
    comparison(
      "tokenDomain",
      `${requirement.extra.name}@${requirement.extra.version}`,
      settlementObserved ? "USD Coin@2" : null,
      settlementObserved ? "matched" : "not_evaluated",
      "native_usdc_identity",
    ),
  ];
}

function unevaluatedSettlementComparisons(
  intent: X402RequirementIntentV02,
): X402RequirementComparison[] {
  return [
    comparison(
      "recipient",
      intent.paymentRequirements.payTo,
      null,
      "not_evaluated",
      "eip3009_event_pair",
    ),
    comparison(
      "amount",
      intent.paymentRequirements.amount,
      null,
      "not_evaluated",
      "eip3009_event_pair",
    ),
    comparison(
      "maxTimeoutSeconds",
      String(intent.paymentRequirements.maxTimeoutSeconds),
      null,
      "declared_only",
      "caller_declaration",
    ),
  ];
}

function sortedReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)].sort();
}

function hasConfirmedObservationShape(
  observation: BaseTransactionObservationV01,
): boolean {
  const receipt = observation.receipt;
  const anchor = observation.finalizedAnchor;
  if (
    observation.schemaVersion !== "0.1" ||
    observation.kind !== "base_transaction_observation" ||
    observation.networkId !== BASE_MAINNET_NETWORK ||
    receipt === null ||
    anchor === null ||
    receipt.status !== "success" ||
    receipt.transactionHash !== observation.transactionHash ||
    observation.sourceAgreement.configured !== 2 ||
    observation.sourceAgreement.agreeing !== 2 ||
    observation.sourceAgreement.quorum !== "unanimous" ||
    !Number.isSafeInteger(observation.confirmations) ||
    observation.confirmations < 1
  ) {
    return false;
  }

  try {
    const receiptBlock = BigInt(receipt.blockNumber);
    const anchorBlock = BigInt(anchor.blockNumber);
    if (receiptBlock < 0n || anchorBlock < receiptBlock) return false;
    if (anchorBlock - receiptBlock + 1n !== BigInt(observation.confirmations)) {
      return false;
    }
    if (anchorBlock === receiptBlock && anchor.blockHash !== receipt.blockHash) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** Evaluate one fixed-source Base observation against one normalized requirement. */
export function evaluateX402RequirementCase(
  intent: X402RequirementIntentV02,
  observation: BaseTransactionObservationV01,
): X402RequirementCaseEvaluationV02 {
  let staticChecks: X402RequirementComparison[];
  let status: X402RequirementCaseStatus;
  let reasons: string[];
  let observedSettlement: NativeUsdcEip3009Settlement | null = null;
  let settlementChecks: X402RequirementComparison[];

  switch (observation.status) {
    case "confirmed": {
      if (
        !hasConfirmedObservationShape(observation) ||
        observation.settlementCount !== 1 ||
        observation.settlements.length !== 1 ||
        observation.truncated
      ) {
        status = "contradiction";
        reasons = ["CONFIRMED_OBSERVATION_SHAPE_INVALID"];
        staticChecks = staticComparisons(intent, false);
        settlementChecks = unevaluatedSettlementComparisons(intent);
        break;
      }
      staticChecks = staticComparisons(intent, true);
      observedSettlement = { ...observation.settlements[0]! };
      const recipientMatches =
        observedSettlement.to === intent.paymentRequirements.payTo;
      const amountMatches =
        observedSettlement.valueAtomic === intent.paymentRequirements.amount;
      status =
        recipientMatches && amountMatches
          ? "settlement_terms_matched"
          : "settlement_terms_mismatch";
      reasons = [];
      if (recipientMatches && amountMatches) reasons.push("SETTLEMENT_TERMS_MATCHED");
      if (!recipientMatches) reasons.push("RECIPIENT_MISMATCH");
      if (!amountMatches) reasons.push("AMOUNT_MISMATCH");
      settlementChecks = [
        comparison(
          "recipient",
          intent.paymentRequirements.payTo,
          observedSettlement.to,
          recipientMatches ? "matched" : "mismatched",
          "eip3009_event_pair",
        ),
        comparison(
          "amount",
          intent.paymentRequirements.amount,
          observedSettlement.valueAtomic,
          amountMatches ? "matched" : "mismatched",
          "eip3009_event_pair",
        ),
        comparison(
          "maxTimeoutSeconds",
          String(intent.paymentRequirements.maxTimeoutSeconds),
          null,
          "declared_only",
          "caller_declaration",
        ),
      ];
      break;
    }
    case "multiple":
      staticChecks = staticComparisons(intent, false);
      status = "multiple_payments_observed";
      reasons = ["MULTIPLE_EIP3009_PAYMENTS_OBSERVED"];
      if (observation.truncated) reasons.push("SETTLEMENT_LIST_TRUNCATED");
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
    case "pending_finality":
      staticChecks = staticComparisons(intent, false);
      status = "pending_finality";
      reasons = ["SHARED_FINALITY_PENDING"];
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
    case "not_observed":
      staticChecks = staticComparisons(intent, false);
      status = "not_observed";
      reasons = ["TRANSACTION_NOT_OBSERVED"];
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
    case "not_eip3009_usdc":
      staticChecks = staticComparisons(intent, false);
      status = "not_observed";
      reasons = ["NATIVE_USDC_EIP3009_PAYMENT_NOT_OBSERVED"];
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
    case "reverted":
      staticChecks = staticComparisons(intent, false);
      status = "not_observed";
      reasons = ["TRANSACTION_REVERTED"];
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
    case "contradiction":
      staticChecks = staticComparisons(intent, false);
      status = "contradiction";
      reasons = ["BASE_EVIDENCE_CONTRADICTION"];
      settlementChecks = unevaluatedSettlementComparisons(intent);
      break;
  }

  const caseId = sha256Domain(CASE_DOMAIN, {
    intentHash: intent.intentHash,
    transactionHash: observation.transactionHash,
  });
  return deepFreeze({
    schemaVersion: "0.2",
    kind: "x402_requirement_case_evaluation",
    status,
    transactionHash: observation.transactionHash,
    intentHash: intent.intentHash,
    caseId,
    reasons: sortedReasons(reasons),
    comparisons: [...staticChecks, ...settlementChecks],
    observedSettlement,
  });
}
