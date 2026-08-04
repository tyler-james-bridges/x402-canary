import type { HttpMethod } from "../contracts.js";
import type { Predicate } from "../reconciliation-policy.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface OperationDescriptor {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: JsonValue;
}

/** The EIP-3009 fields that identify an authorization; signatures are never journaled. */
export interface ExactAuthorizationDescriptor {
  networkId: "eip155:8453";
  asset: string;
  from: string;
  to: string;
  valueAtomic: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface CanonicalIdentity {
  algorithm: "sha256";
  canonical: string;
  id: string;
}

export type JournalEventKind =
  | "attempt_opened"
  | "authorization_recorded"
  | "authorization_transmitted"
  | "settlement_observed"
  | "effect_observed"
  | "kernel_input_committed"
  | "kernel_bundle_committed"
  | "attempt_closed";

export interface JournalEventInput {
  eventId: string;
  operationId: string;
  authorizationId?: string;
  kind: JournalEventKind;
  occurredAt: string;
  evidence?: JsonValue;
}

export interface JournalRecord extends JournalEventInput {
  journalId: string;
  sequence: number;
  previousHash: string | null;
  recordHash: string;
}

export interface BaseReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  transactionHash: string;
  removed?: boolean;
}

export interface BaseTransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: "success" | "reverted";
  logs: BaseReceiptLog[];
}

/** A receipt plus canonical-head facts obtained from an independently configured Base RPC. */
export interface BaseReceiptObservation {
  networkId: "eip155:8453";
  source: string;
  observedAt: string;
  observedHeadBlockNumber: string;
  canonicalBlockHash: string | null;
  receipt: BaseTransactionReceipt | null;
}

/** Native USDC authorizationState(authorizer, nonce), observed at a canonical Base block. */
export interface AuthorizationStateObservation {
  networkId: "eip155:8453";
  asset: string;
  source: string;
  authorizer: string;
  nonce: string;
  used: boolean;
  observedBlockNumber: string;
  observedBlockHash: string;
  observedBlockTimestamp: string;
  observedHeadBlockNumber: string;
}

export type SettlementStatus =
  | "confirmed"
  | "pending_finality"
  | "absent"
  | "unknown"
  | "mismatch"
  | "duplicate"
  | "contradiction";

export interface SettlementEvaluation {
  status: SettlementStatus;
  authoritative: boolean;
  settlementCount: number;
  confirmations: number;
  transactionHash?: string;
  blockNumber?: string;
  reasons: string[];
}

export type EffectStatus = "committed" | "absent" | "unknown" | "duplicate" | "contradiction";

export interface EffectObservation {
  operationId: string;
  source: string;
  queryKey: string;
  effectType: string;
  status: "committed" | "absent" | "unknown";
  authoritative: boolean;
  observedAt: string;
  finalAfter: string;
  effectId?: string;
  payloadHash?: string;
}

export interface EffectEvaluation {
  status: EffectStatus;
  authoritative: boolean;
  effectCount: number;
  effectIds: string[];
  reasons: string[];
}

export interface EvidenceKernelInput {
  schemaVersion: "0.1";
  evaluatedAt: string;
  operation: OperationDescriptor;
  authorization: ExactAuthorizationDescriptor;
  attempt: {
    authorizationCreated: boolean;
    preflightPassed: boolean;
    policyRejectedBeforeAuthorization: boolean;
    authorizationTransmitted: Predicate;
    signingRejected: boolean;
    deliveryContractApplicable: boolean;
    delivery: Predicate;
    effectContractApplicable: boolean;
  };
  minimumConfirmations: number;
  receiptObservations: BaseReceiptObservation[];
  authorizationStateObservations: AuthorizationStateObservation[];
  effectObservations: EffectObservation[];
  retryAssertions?: {
    idempotencyContractVerified?: boolean;
    identicalReplayCreatesNoNewSettlement?: boolean;
    identicalReplayCreatesNoNewEffect?: boolean;
  };
}

export interface EvidenceBundle {
  schemaVersion: "0.1";
  operationId: string;
  authorizationId: string;
  inputHash: string;
  assurance: {
    scope: "trusted_prevalidated_observations";
    sourceAuthentication: "not_performed";
    externalAuthorityProven: false;
    paymentExecutionEnabled: false;
  };
  settlement: SettlementEvaluation;
  effect: EffectEvaluation;
  terminalState: string;
  retry: {
    sameAuthorizationReplaySafe: boolean;
    newAuthorizationSafe: boolean;
    reasons: string[];
  };
  invariant: {
    settlementCount: number;
    effectCount: number;
    maximumSettlements: 1;
    maximumEffects: 1;
    passed: boolean;
  };
  generatedAt: string;
  bundleHash: string;
}
