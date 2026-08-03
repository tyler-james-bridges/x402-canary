export type Predicate = "pass" | "fail" | "unknown" | "not_applicable";

export type TerminalState =
  | "not_attempted"
  | "rejected_before_authorization"
  | "authorization_rejected"
  | "settlement_unknown"
  | "settlement_failed"
  | "settled_pending_finality"
  | "settled_delivery_unverified"
  | "settled_delivery_failed"
  | "settled_delivered"
  | "delivered_settlement_unknown"
  | "zero_claimed_pending_expiry"
  | "zero_settled_delivery_failed"
  | "zero_settled_delivered"
  | "duplicate_settlement"
  | "evidence_contradiction";

export type SettlementVerdict =
  | "not_attempted"
  | "unknown"
  | "failed"
  | "pass"
  | "zero_claimed_pending_expiry"
  | "zero_closed";

export interface TerminalFacts {
  paymentAuthorized: boolean;
  preflightPassed: boolean;
  policyRejectedBeforeAuthorization: boolean;
  authorizationTransmitted: Predicate;
  signingRejected: boolean;
  settlement: SettlementVerdict;
  settlementCount: number;
  requiredFinalityReached: Predicate;
  deliveryContractApplicable: boolean;
  delivery: Predicate;
  effectContractApplicable: boolean;
  effect: Predicate;
  effectCount: number;
  evidenceContradiction?: boolean;
}

export interface RetryFacts {
  priorAuthorizationUnusable: Predicate;
  settlementAbsenceAuthoritative: Predicate;
  effectAbsenceAuthoritative: Predicate;
  idempotencyContractVerified: Predicate;
  sameKeyReplayCreatesNoNewSettlement: Predicate;
  sameKeyReplayCreatesNoNewEffect: Predicate;
}

export interface RetrySafety {
  sameAuthorizationReplaySafe: boolean;
  newAuthorizationSafe: boolean;
  reasons: string[];
}

export interface OperationInvariant {
  settlementCount: number;
  effectCount: number;
  maximumSettlements: number;
  maximumEffects: number;
}

function requiredOutcomes(facts: TerminalFacts): Predicate[] {
  return [
    ...(facts.deliveryContractApplicable ? [facts.delivery] : []),
    ...(facts.effectContractApplicable ? [facts.effect] : []),
  ];
}

/**
 * Derive a terminal state from independently observed facts. Callers do not get
 * to set a stronger state just because an HTTP response or vendor flag says so.
 */
export function deriveTerminalState(facts: TerminalFacts): TerminalState {
  if (facts.evidenceContradiction) return "evidence_contradiction";
  if (facts.settlementCount > 1) return "duplicate_settlement";

  if (!facts.paymentAuthorized) return "not_attempted";
  if (facts.policyRejectedBeforeAuthorization) return "rejected_before_authorization";
  if (!facts.preflightPassed) return "not_attempted";
  if (
    facts.signingRejected &&
    facts.authorizationTransmitted === "fail" &&
    facts.settlement === "not_attempted"
  ) {
    return "authorization_rejected";
  }

  const outcomes = requiredOutcomes(facts);
  const allRequiredOutcomesPass = outcomes.length > 0 && outcomes.every((value) => value === "pass");
  const anyRequiredOutcomeFails = outcomes.some((value) => value === "fail");
  const duplicateEffect = facts.effectContractApplicable && facts.effectCount > 1;

  if (facts.settlement === "not_attempted") return "not_attempted";
  if (facts.settlement === "zero_claimed_pending_expiry") {
    return "zero_claimed_pending_expiry";
  }
  if (facts.settlement === "zero_closed") {
    return allRequiredOutcomesPass && !duplicateEffect
      ? "zero_settled_delivered"
      : "zero_settled_delivery_failed";
  }
  if (facts.settlement === "unknown") {
    return allRequiredOutcomesPass && !duplicateEffect
      ? "delivered_settlement_unknown"
      : "settlement_unknown";
  }
  if (facts.settlement === "failed") return "settlement_failed";

  if (facts.requiredFinalityReached !== "pass") return "settled_pending_finality";
  if (duplicateEffect || anyRequiredOutcomeFails) return "settled_delivery_failed";
  if (!allRequiredOutcomesPass) return "settled_delivery_unverified";
  return "settled_delivered";
}

/**
 * Replaying an existing signed request and issuing a fresh authorization are
 * separate decisions. Neither elapsed time nor an idempotency key alone is
 * sufficient for either decision.
 */
export function deriveRetrySafety(facts: RetryFacts): RetrySafety {
  const sameAuthorizationReplaySafe =
    facts.idempotencyContractVerified === "pass" &&
    facts.sameKeyReplayCreatesNoNewSettlement === "pass" &&
    facts.sameKeyReplayCreatesNoNewEffect === "pass";
  const newAuthorizationSafe =
    facts.priorAuthorizationUnusable === "pass" &&
    facts.settlementAbsenceAuthoritative === "pass" &&
    facts.effectAbsenceAuthoritative === "pass";

  const reasons: string[] = [];
  if (!sameAuthorizationReplaySafe) reasons.push("IDENTICAL_REPLAY_NOT_PROVEN_NON_CHARGING");
  if (!newAuthorizationSafe) reasons.push("NEW_AUTHORIZATION_ABSENCE_PROOF_INCOMPLETE");
  return { sameAuthorizationReplaySafe, newAuthorizationSafe, reasons };
}

export function evaluateOperationInvariant(
  settlementCount: number,
  effectCount: number,
): OperationInvariant & { passed: boolean } {
  const invariant: OperationInvariant = {
    settlementCount,
    effectCount,
    maximumSettlements: 1,
    maximumEffects: 1,
  };
  return {
    ...invariant,
    passed: settlementCount <= invariant.maximumSettlements && effectCount <= invariant.maximumEffects,
  };
}
