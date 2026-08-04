import { createHash } from "node:crypto";
import {
  deriveRetrySafety,
  deriveTerminalState,
  evaluateOperationInvariant,
  type Predicate,
  type SettlementVerdict,
} from "../reconciliation-policy.js";
import { evaluateBaseSettlement } from "./base-settlement.js";
import { canonicalJson, deriveAuthorizationIdentity, deriveOperationIdentity } from "./canonical.js";
import { evaluateEffectEvidence } from "./effect.js";
import type {
  EffectEvaluation,
  EvidenceBundle,
  EvidenceKernelInput,
  SettlementEvaluation,
} from "./types.js";

const HASH_PREFIX = "sha256:";
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PREDICATES = new Set<Predicate>(["pass", "fail", "unknown", "not_applicable"]);
const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "evaluatedAt",
  "operation",
  "authorization",
  "attempt",
  "minimumConfirmations",
  "receiptObservations",
  "authorizationStateObservations",
  "effectObservations",
  "retryAssertions",
]);
const ATTEMPT_FIELDS = new Set([
  "authorizationCreated",
  "preflightPassed",
  "policyRejectedBeforeAuthorization",
  "authorizationTransmitted",
  "signingRejected",
  "deliveryContractApplicable",
  "delivery",
  "effectContractApplicable",
]);
const RETRY_ASSERTION_FIELDS = new Set([
  "idempotencyContractVerified",
  "identicalReplayCreatesNoNewSettlement",
  "identicalReplayCreatesNoNewEffect",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`${label} contains unexpected field: ${field}`);
  }
}

function requireBooleanField(value: Record<string, unknown>, field: string, label: string): void {
  if (typeof value[field] !== "boolean") throw new Error(`${label}.${field} must be a boolean`);
}

function validateKernelInput(value: unknown): asserts value is EvidenceKernelInput {
  if (!isRecord(value)) throw new Error("Evidence input must be a plain object");
  assertExactFields(value, TOP_LEVEL_FIELDS, "Evidence input");
  for (const required of TOP_LEVEL_FIELDS) {
    if (required === "retryAssertions") continue;
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new Error(`Evidence input is missing required field: ${required}`);
    }
  }

  if (value.schemaVersion !== "0.1") throw new Error("Unsupported evidence schemaVersion");
  requireIsoTimestamp(value.evaluatedAt, "evaluatedAt");
  requirePositiveConfirmations(value.minimumConfirmations);

  if (!isRecord(value.operation)) throw new Error("operation must be a plain object");
  if (!isRecord(value.authorization)) throw new Error("authorization must be a plain object");
  if (!isRecord(value.attempt)) throw new Error("attempt must be a plain object");
  assertExactFields(value.attempt, ATTEMPT_FIELDS, "attempt");
  for (const field of ATTEMPT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value.attempt, field)) {
      throw new Error(`attempt is missing required field: ${field}`);
    }
  }
  for (const field of [
    "authorizationCreated",
    "preflightPassed",
    "policyRejectedBeforeAuthorization",
    "signingRejected",
    "deliveryContractApplicable",
    "effectContractApplicable",
  ]) {
    requireBooleanField(value.attempt, field, "attempt");
  }
  if (!PREDICATES.has(value.attempt.authorizationTransmitted as Predicate)) {
    throw new Error("attempt.authorizationTransmitted must be a valid predicate");
  }
  if (!PREDICATES.has(value.attempt.delivery as Predicate)) {
    throw new Error("attempt.delivery must be a valid predicate");
  }
  if (!value.attempt.deliveryContractApplicable && value.attempt.delivery !== "not_applicable") {
    throw new Error("attempt.delivery must be not_applicable when no delivery contract applies");
  }

  for (const [field, observations] of [
    ["receiptObservations", value.receiptObservations],
    ["authorizationStateObservations", value.authorizationStateObservations],
    ["effectObservations", value.effectObservations],
  ] as const) {
    if (!Array.isArray(observations)) throw new Error(`${field} must be an array`);
  }

  if (value.retryAssertions !== undefined) {
    if (!isRecord(value.retryAssertions)) throw new Error("retryAssertions must be a plain object");
    assertExactFields(value.retryAssertions, RETRY_ASSERTION_FIELDS, "retryAssertions");
    for (const [field, assertion] of Object.entries(value.retryAssertions)) {
      if (typeof assertion !== "boolean") {
        throw new Error(`retryAssertions.${field} must be a boolean`);
      }
    }
  }
}

function hashCanonical(namespace: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(`${namespace}\n${canonicalJson(value)}`, "utf8")
    .digest("hex");
  return `${HASH_PREFIX}${digest}`;
}

function requireIsoTimestamp(value: unknown, field: string): Date {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC timestamp`);
  }
  return parsed;
}

function requirePositiveConfirmations(value: unknown): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 100_000
  ) {
    throw new Error("minimumConfirmations must be an integer between 1 and 100000");
  }
}

function boolPredicate(value: boolean | undefined): Predicate {
  return value === undefined ? "unknown" : value ? "pass" : "fail";
}

function rejectFutureEvidence(input: EvidenceKernelInput, evaluatedAt: Date): void {
  const evaluatedAtMs = evaluatedAt.getTime();
  for (const [field, observations] of [
    ["receiptObservations", input.receiptObservations],
    ["effectObservations", input.effectObservations],
  ] as const) {
    observations.forEach((observation, index) => {
      if (!isRecord(observation) || typeof observation.observedAt !== "string") return;
      const observedAtMs = Date.parse(observation.observedAt);
      if (Number.isFinite(observedAtMs) && observedAtMs > evaluatedAtMs) {
        throw new Error(`${field}[${index}].observedAt must not be after evaluatedAt`);
      }
    });
  }

  const evaluatedAtSeconds = BigInt(Math.floor(evaluatedAtMs / 1_000));
  input.authorizationStateObservations.forEach((observation, index) => {
    if (
      !isRecord(observation) ||
      typeof observation.observedBlockTimestamp !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(observation.observedBlockTimestamp)
    ) return;
    if (BigInt(observation.observedBlockTimestamp) > evaluatedAtSeconds) {
      throw new Error(
        `authorizationStateObservations[${index}].observedBlockTimestamp must not be after evaluatedAt`,
      );
    }
  });
}

function settlementVerdict(
  authorizationCreated: boolean,
  settlement: SettlementEvaluation,
): SettlementVerdict {
  if (!authorizationCreated) return "not_attempted";
  if (settlement.status === "confirmed" || settlement.status === "pending_finality") return "pass";
  if (settlement.status === "absent") return "failed";
  return "unknown";
}

function finalityPredicate(settlement: SettlementEvaluation): Predicate {
  if (settlement.status === "confirmed") return "pass";
  if (settlement.status === "pending_finality") return "fail";
  return "not_applicable";
}

function effectPredicate(effect: EffectEvaluation): Predicate {
  if (effect.status === "committed") return "pass";
  if (effect.status === "absent") return "fail";
  if (effect.status === "unknown") return "unknown";
  return "fail";
}

function attemptContradiction(
  input: EvidenceKernelInput,
  settlement: SettlementEvaluation,
  effect: EffectEvaluation,
): boolean {
  if (!input.attempt.authorizationCreated && settlement.settlementCount > 0) return true;
  if (!input.attempt.authorizationCreated && input.attempt.authorizationTransmitted === "pass") {
    return true;
  }
  if (
    input.attempt.policyRejectedBeforeAuthorization &&
    input.attempt.authorizationTransmitted === "pass"
  ) return true;
  if (
    settlement.settlementCount > 0 &&
    (input.attempt.authorizationTransmitted === "fail" ||
      input.attempt.authorizationTransmitted === "not_applicable")
  ) return true;
  if (settlement.settlementCount > 0 && input.attempt.signingRejected) return true;
  if (!input.attempt.effectContractApplicable && input.effectObservations.length > 0) return true;
  if (!input.attempt.effectContractApplicable && effect.effectCount > 0) return true;
  return false;
}

function authorizationExpired(input: EvidenceKernelInput, evaluatedAt: Date): Predicate {
  if (!/^(0|[1-9][0-9]*)$/.test(input.authorization.validBefore)) return "unknown";
  const validBefore = BigInt(input.authorization.validBefore);
  const evaluatedAtSeconds = BigInt(Math.floor(evaluatedAt.getTime() / 1_000));
  return evaluatedAtSeconds >= validBefore ? "pass" : "fail";
}

export function evaluateEvidenceKernel(input: unknown): EvidenceBundle {
  validateKernelInput(input);
  const evaluatedAt = requireIsoTimestamp(input.evaluatedAt, "evaluatedAt");
  rejectFutureEvidence(input, evaluatedAt);

  const operation = deriveOperationIdentity(input.operation);
  const authorization = deriveAuthorizationIdentity(input.authorization);
  const settlement = evaluateBaseSettlement(
    input.authorization,
    input.receiptObservations,
    input.authorizationStateObservations,
    input.minimumConfirmations,
  );
  const effect = evaluateEffectEvidence(operation.id, input.effectObservations);
  const contradiction =
    attemptContradiction(input, settlement, effect) ||
    settlement.status === "mismatch" ||
    settlement.status === "contradiction" ||
    effect.status === "contradiction";

  const terminalState = deriveTerminalState({
    paymentAuthorized: input.attempt.authorizationCreated,
    preflightPassed: input.attempt.preflightPassed,
    policyRejectedBeforeAuthorization: input.attempt.policyRejectedBeforeAuthorization,
    authorizationTransmitted: input.attempt.authorizationTransmitted,
    signingRejected: input.attempt.signingRejected,
    settlement: settlementVerdict(input.attempt.authorizationCreated, settlement),
    settlementCount: settlement.settlementCount,
    requiredFinalityReached: finalityPredicate(settlement),
    deliveryContractApplicable: input.attempt.deliveryContractApplicable,
    delivery: input.attempt.delivery,
    effectContractApplicable: input.attempt.effectContractApplicable,
    effect: effectPredicate(effect),
    effectCount: effect.effectCount,
    evidenceContradiction: contradiction,
  });

  const derivedRetry = deriveRetrySafety({
    priorAuthorizationUnusable: authorizationExpired(input, evaluatedAt),
    settlementAbsenceAuthoritative:
      settlement.status === "absent" && settlement.authoritative ? "pass" : "fail",
    effectAbsenceAuthoritative:
      effect.status === "absent" && effect.authoritative ? "pass" : "fail",
    idempotencyContractVerified: boolPredicate(input.retryAssertions?.idempotencyContractVerified),
    sameKeyReplayCreatesNoNewSettlement: boolPredicate(
      input.retryAssertions?.identicalReplayCreatesNoNewSettlement,
    ),
    sameKeyReplayCreatesNoNewEffect: boolPredicate(
      input.retryAssertions?.identicalReplayCreatesNoNewEffect,
    ),
  });
  const invariant = evaluateOperationInvariant(settlement.settlementCount, effect.effectCount);
  const evidenceIntegrityFailed =
    contradiction ||
    settlement.status === "duplicate" ||
    effect.status === "duplicate" ||
    !invariant.passed;
  const retry = evidenceIntegrityFailed
    ? {
        sameAuthorizationReplaySafe: false,
        newAuthorizationSafe: false,
        reasons: [
          ...new Set([
            ...derivedRetry.reasons,
            "RETRY_BLOCKED_BY_EVIDENCE_INTEGRITY_FAILURE",
          ]),
        ],
      }
    : derivedRetry;
  const generatedAt = evaluatedAt.toISOString();
  const inputHash = hashCanonical("x402-canary:evidence-input:v0.1", input);
  const unsignedBundle = {
    schemaVersion: "0.1" as const,
    operationId: operation.id,
    authorizationId: authorization.id,
    inputHash,
    assurance: {
      scope: "trusted_prevalidated_observations" as const,
      sourceAuthentication: "not_performed" as const,
      externalAuthorityProven: false as const,
      paymentExecutionEnabled: false as const,
    },
    settlement,
    effect,
    terminalState,
    retry,
    invariant: {
      settlementCount: invariant.settlementCount,
      effectCount: invariant.effectCount,
      maximumSettlements: 1 as const,
      maximumEffects: 1 as const,
      passed: invariant.passed,
    },
    generatedAt,
  };

  return {
    ...unsignedBundle,
    bundleHash: hashCanonical("x402-canary:evidence-bundle:v0.1", unsignedBundle),
  };
}
