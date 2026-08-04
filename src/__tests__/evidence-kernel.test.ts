import assert from "node:assert/strict";
import test from "node:test";

import expectedBundleJson from "../../examples/evidence-kernel-v0.1.bundle.json" with { type: "json" };
import exampleInputJson from "../../examples/evidence-kernel-v0.1.input.json" with { type: "json" };
import { evaluateEvidenceKernel } from "../evidence/kernel.js";
import type {
  AuthorizationStateObservation,
  BaseReceiptObservation,
  EvidenceKernelInput,
} from "../evidence/types.js";

function exampleInput(): EvidenceKernelInput {
  return structuredClone(exampleInputJson) as unknown as EvidenceKernelInput;
}

function receipt(target: EvidenceKernelInput): NonNullable<BaseReceiptObservation["receipt"]> {
  const observed = target.receiptObservations[0]?.receipt;
  assert.ok(observed);
  return observed;
}

test("the sanitized v0.1 input recomputes the checked-in evidence bundle exactly", () => {
  const input = exampleInput();
  const before = structuredClone(input);
  const bundle = evaluateEvidenceKernel(input);
  assert.deepEqual(bundle, expectedBundleJson);
  assert.deepEqual(bundle.assurance, {
    scope: "trusted_prevalidated_observations",
    sourceAuthentication: "not_performed",
    externalAuthorityProven: false,
    paymentExecutionEnabled: false,
  });
  assert.deepEqual(input, before, "evaluation must not mutate caller evidence");
});

test("object property order cannot change canonical identities or bundle hashes", () => {
  const reordered = exampleInput();
  reordered.operation.headers = {
    "idempotency-key": "order-0001",
    "content-type": "application/json",
  };
  reordered.operation.body = {
    quantity: 1,
    sku: "agent-credit",
    orderId: "order-0001",
  };
  assert.deepEqual(evaluateEvidenceKernel(reordered), expectedBundleJson);
});

test("wrong AuthorizationUsed nonce fails the whole bundle closed", () => {
  const input = exampleInput();
  receipt(input).logs[0]!.topics[2] = `0x${"f".repeat(64)}`;
  const bundle = evaluateEvidenceKernel(input);
  assert.equal(bundle.settlement.status, "mismatch");
  assert.ok(bundle.settlement.reasons.includes("AUTHORIZATION_USED_NONCE_MISMATCH"));
  assert.equal(bundle.terminalState, "evidence_contradiction");
  assert.equal(bundle.retry.sameAuthorizationReplaySafe, false);
  assert.equal(bundle.retry.newAuthorizationSafe, false);
});

test("duplicate settlement or effect evidence trips the operation invariant", () => {
  const duplicateSettlement = exampleInput();
  duplicateSettlement.retryAssertions = {
    idempotencyContractVerified: true,
    identicalReplayCreatesNoNewSettlement: true,
    identicalReplayCreatesNoNewEffect: true,
  };
  const duplicateTransfer = structuredClone(receipt(duplicateSettlement).logs[1]!);
  duplicateTransfer.logIndex = 2;
  receipt(duplicateSettlement).logs.push(duplicateTransfer);
  const settlementBundle = evaluateEvidenceKernel(duplicateSettlement);
  assert.equal(settlementBundle.settlement.status, "duplicate");
  assert.equal(settlementBundle.settlement.settlementCount, 2);
  assert.equal(settlementBundle.terminalState, "duplicate_settlement");
  assert.equal(settlementBundle.invariant.passed, false);
  assert.equal(settlementBundle.retry.sameAuthorizationReplaySafe, false);
  assert.equal(settlementBundle.retry.newAuthorizationSafe, false);
  assert.ok(
    settlementBundle.retry.reasons.includes("RETRY_BLOCKED_BY_EVIDENCE_INTEGRITY_FAILURE"),
  );

  const duplicateEffect = exampleInput();
  duplicateEffect.effectObservations.push({
    ...structuredClone(duplicateEffect.effectObservations[0]!),
    source: "operator-system-of-record-replica",
    effectId: "order-0002",
    payloadHash: `sha256:${"1".repeat(64)}`,
  });
  const effectBundle = evaluateEvidenceKernel(duplicateEffect);
  assert.equal(effectBundle.effect.status, "duplicate");
  assert.equal(effectBundle.effect.effectCount, 2);
  assert.equal(effectBundle.terminalState, "settled_delivery_failed");
  assert.equal(effectBundle.invariant.passed, false);
});

test("reorg mismatch and insufficient finality never become confirmed settlement", () => {
  const reorged = exampleInput();
  reorged.receiptObservations[0]!.canonicalBlockHash = `0x${"d".repeat(64)}`;
  const reorgBundle = evaluateEvidenceKernel(reorged);
  assert.equal(reorgBundle.settlement.status, "mismatch");
  assert.equal(reorgBundle.terminalState, "evidence_contradiction");

  const pending = exampleInput();
  pending.receiptObservations[0]!.observedHeadBlockNumber = "1002";
  const pendingBundle = evaluateEvidenceKernel(pending);
  assert.equal(pendingBundle.settlement.status, "pending_finality");
  assert.equal(pendingBundle.settlement.authoritative, false);
  assert.equal(pendingBundle.terminalState, "settled_pending_finality");
});

test("missing evidence stays unknown and never enables either retry mode", () => {
  const input = exampleInput();
  input.receiptObservations = [];
  input.authorizationStateObservations = [];
  input.effectObservations = [];
  const bundle = evaluateEvidenceKernel(input);
  assert.equal(bundle.settlement.status, "unknown");
  assert.equal(bundle.effect.status, "unknown");
  assert.equal(bundle.terminalState, "settlement_unknown");
  assert.equal(bundle.retry.sameAuthorizationReplaySafe, false);
  assert.equal(bundle.retry.newAuthorizationSafe, false);
});

test("a new authorization is safe only after finalized settlement and effect absence", () => {
  const input = exampleInput();
  input.receiptObservations = ["absence-rpc-a", "absence-rpc-b"].map(
    (source, index): BaseReceiptObservation => ({
      networkId: "eip155:8453",
      source,
      observedAt: `2026-08-03T18:1${index.toString()}:00.000Z`,
      observedHeadBlockNumber: "1022",
      canonicalBlockHash: null,
      receipt: null,
    }),
  );
  input.authorizationStateObservations = ["absence-rpc-a", "absence-rpc-b"].map(
    (source): AuthorizationStateObservation => ({
      networkId: "eip155:8453",
      asset: input.authorization.asset,
      source,
      authorizer: input.authorization.from,
      nonce: input.authorization.nonce,
      used: false,
      observedBlockNumber: "1011",
      observedHeadBlockNumber: "1022",
      observedBlockHash: `0x${"e".repeat(64)}`,
      observedBlockTimestamp: "1700000200",
    }),
  );
  input.effectObservations = [
    {
      operationId: input.effectObservations[0]!.operationId,
      source: "operator-system-of-record",
      queryKey: "idempotency-key/order-0001",
      effectType: "order.created",
      status: "absent",
      authoritative: true,
      observedAt: "2026-08-03T18:12:00.000Z",
      finalAfter: "2026-08-03T18:10:00.000Z",
    },
  ];

  const bundle = evaluateEvidenceKernel(input);
  assert.equal(bundle.settlement.status, "absent");
  assert.equal(bundle.settlement.authoritative, true);
  assert.equal(bundle.effect.status, "absent");
  assert.equal(bundle.effect.authoritative, true);
  assert.equal(bundle.retry.sameAuthorizationReplaySafe, false);
  assert.equal(bundle.retry.newAuthorizationSafe, true);
});

test("identical replay needs all three explicit safety assertions", () => {
  const proven = exampleInput();
  proven.retryAssertions = {
    idempotencyContractVerified: true,
    identicalReplayCreatesNoNewSettlement: true,
    identicalReplayCreatesNoNewEffect: true,
  };
  assert.equal(evaluateEvidenceKernel(proven).retry.sameAuthorizationReplaySafe, true);

  const incomplete = exampleInput();
  incomplete.retryAssertions = {
    idempotencyContractVerified: true,
    identicalReplayCreatesNoNewSettlement: true,
    identicalReplayCreatesNoNewEffect: false,
  };
  assert.equal(evaluateEvidenceKernel(incomplete).retry.sameAuthorizationReplaySafe, false);
});

test("operation or attempt contradictions have terminal precedence", () => {
  const wrongOperation = exampleInput();
  wrongOperation.retryAssertions = {
    idempotencyContractVerified: true,
    identicalReplayCreatesNoNewSettlement: true,
    identicalReplayCreatesNoNewEffect: true,
  };
  wrongOperation.operation.body = { orderId: "order-0002" };
  const wrongOperationBundle = evaluateEvidenceKernel(wrongOperation);
  assert.equal(wrongOperationBundle.terminalState, "evidence_contradiction");
  assert.equal(wrongOperationBundle.retry.sameAuthorizationReplaySafe, false);
  assert.equal(wrongOperationBundle.retry.newAuthorizationSafe, false);

  const impossibleTransmission = exampleInput();
  impossibleTransmission.attempt.authorizationTransmitted = "fail";
  assert.equal(
    evaluateEvidenceKernel(impossibleTransmission).terminalState,
    "evidence_contradiction",
  );
});

test("runtime input validation rejects ambiguous or malformed JSON facts", () => {
  const cases: Array<[string, (input: Record<string, any>) => void, RegExp]> = [
    [
      "unexpected field",
      (input) => {
        input.unboundClaim = true;
      },
      /unexpected field/,
    ],
    [
      "non-boolean attempt",
      (input) => {
        input.attempt.authorizationCreated = "true";
      },
      /must be a boolean/,
    ],
    [
      "noncanonical timestamp",
      (input) => {
        input.evaluatedAt = "2026-08-03T18:15:00Z";
      },
      /canonical ISO-8601/,
    ],
    [
      "wrong confirmations type",
      (input) => {
        input.minimumConfirmations = "12";
      },
      /integer between 1 and 100000/,
    ],
    [
      "inapplicable delivery claim",
      (input) => {
        input.attempt.delivery = "pass";
      },
      /must be not_applicable/,
    ],
    [
      "future receipt evidence",
      (input) => {
        input.receiptObservations[0].observedAt = "2099-01-01T00:00:00.000Z";
      },
      /observedAt must not be after evaluatedAt/,
    ],
    [
      "future effect evidence",
      (input) => {
        input.effectObservations[0].observedAt = "2099-01-01T00:00:00.000Z";
      },
      /observedAt must not be after evaluatedAt/,
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    const input = exampleInput() as unknown as Record<string, any>;
    mutate(input);
    assert.throws(() => evaluateEvidenceKernel(input), expected, name);
  }

  const futureState = exampleInput();
  futureState.authorizationStateObservations = [
    {
      networkId: "eip155:8453",
      asset: futureState.authorization.asset,
      source: "future-state",
      authorizer: futureState.authorization.from,
      nonce: futureState.authorization.nonce,
      used: true,
      observedBlockNumber: "1000",
      observedHeadBlockNumber: "1011",
      observedBlockHash: `0x${"c".repeat(64)}`,
      observedBlockTimestamp: "4070908800",
    },
  ];
  assert.throws(
    () => evaluateEvidenceKernel(futureState),
    /observedBlockTimestamp must not be after evaluatedAt/,
  );
});
