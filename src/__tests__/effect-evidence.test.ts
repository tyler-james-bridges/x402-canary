import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./fixtures/effect-evidence-v0.1.json" with { type: "json" };
import { evaluateEffectEvidence } from "../evidence/effect.js";
import type {
  EffectEvaluation,
  EffectObservation,
} from "../evidence/types.js";

interface EffectFixture {
  name: string;
  operationId: string;
  observations: EffectObservation[];
  expected: EffectEvaluation;
}

for (const fixture of fixtures as EffectFixture[]) {
  test(`effect evidence fixture: ${fixture.name}`, () => {
    assert.deepEqual(
      evaluateEffectEvidence(fixture.operationId, fixture.observations),
      fixture.expected,
    );
  });
}

const OPERATION_ID =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PAYLOAD_HASH =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function committed(overrides: Partial<EffectObservation> = {}): EffectObservation {
  return {
    operationId: OPERATION_ID,
    source: "operator-db",
    queryKey: "idempotency-key/order-test",
    effectType: "order.created",
    status: "committed",
    authoritative: true,
    observedAt: "2026-08-03T18:05:00.000Z",
    finalAfter: "2026-08-03T18:10:00.000Z",
    effectId: "order-test",
    payloadHash: PAYLOAD_HASH,
    ...overrides,
  };
}

test("a non-authoritative committed claim never passes", () => {
  assert.deepEqual(evaluateEffectEvidence(OPERATION_ID, [committed({ authoritative: false })]), {
    status: "unknown",
    authoritative: false,
    effectCount: 0,
    effectIds: [],
    reasons: ["COMMIT_NOT_AUTHORITATIVE", "NO_AUTHORITATIVE_EFFECT_EVIDENCE"],
  });
});

test("canonical operation and payload hashes reject bare or uppercase encodings", () => {
  const bareOperationId = OPERATION_ID.slice("sha256:".length);
  assert.deepEqual(evaluateEffectEvidence(bareOperationId, []), {
    status: "contradiction",
    authoritative: false,
    effectCount: 0,
    effectIds: [],
    reasons: ["INVALID_OPERATION_ID"],
  });

  const uppercasePayload = `sha256:${PAYLOAD_HASH.slice("sha256:".length).toUpperCase()}`;
  assert.equal(
    evaluateEffectEvidence(OPERATION_ID, [committed({ payloadHash: uppercasePayload })]).status,
    "contradiction",
  );
});

test("missing committed effect identity fails closed", () => {
  const observation = committed();
  delete observation.effectId;
  assert.deepEqual(evaluateEffectEvidence(OPERATION_ID, [observation]), {
    status: "contradiction",
    authoritative: false,
    effectCount: 0,
    effectIds: [],
    reasons: ["INVALID_COMMITTED_EFFECT_ID"],
  });
});

test("effect query-key or type conflicts fail closed", () => {
  const evaluation = evaluateEffectEvidence(OPERATION_ID, [
    committed(),
    committed({
      source: "operator-db-replica",
      queryKey: "idempotency-key/different",
      effectType: "email.sent",
    }),
  ]);
  assert.equal(evaluation.status, "contradiction");
  assert.deepEqual(evaluation.reasons, ["EFFECT_QUERY_KEY_CONFLICT", "EFFECT_TYPE_CONFLICT"]);
});

test("conflicting effect finalization horizons cannot prove authoritative absence", () => {
  const first: EffectObservation = {
    operationId: OPERATION_ID,
    source: "operator-db-primary",
    queryKey: "idempotency-key/order-test",
    effectType: "order.created",
    status: "absent",
    authoritative: true,
    observedAt: "2026-08-03T18:15:00.000Z",
    finalAfter: "2026-08-03T18:10:00.000Z",
  };
  const second: EffectObservation = {
    ...first,
    source: "operator-db-replica",
    finalAfter: "2026-08-03T18:20:00.000Z",
  };
  const evaluation = evaluateEffectEvidence(OPERATION_ID, [first, second]);
  assert.equal(evaluation.status, "contradiction");
  assert.equal(evaluation.authoritative, false);
  assert.ok(evaluation.reasons.includes("EFFECT_FINAL_AFTER_CONFLICT"));
});

test("input order cannot change the verdict or reason ordering", () => {
  const first = committed({ effectId: "effect-b" });
  const second = committed({
    source: "operator-db-replica",
    effectId: "effect-a",
    payloadHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  });
  assert.deepEqual(
    evaluateEffectEvidence(OPERATION_ID, [first, second]),
    evaluateEffectEvidence(OPERATION_ID, [second, first]),
  );
});

test("no observations cannot prove either commit or absence", () => {
  assert.deepEqual(evaluateEffectEvidence(OPERATION_ID, []), {
    status: "unknown",
    authoritative: false,
    effectCount: 0,
    effectIds: [],
    reasons: ["NO_EFFECT_OBSERVATIONS"],
  });
});
