import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./fixtures/reconciliation-v0.1.json" with { type: "json" };
import {
  deriveRetrySafety,
  deriveTerminalState,
  evaluateOperationInvariant,
  type RetryFacts,
  type TerminalFacts,
  type TerminalState,
} from "../reconciliation-policy.js";

interface ReconciliationFixture {
  name: string;
  publicHttpStatus: number;
  executionPhase: string;
  facts: TerminalFacts;
  retry: RetryFacts;
  expected: {
    terminal: TerminalState;
    sameAuthorizationReplaySafe: boolean;
    newAuthorizationSafe: boolean;
  };
}

for (const fixture of fixtures as ReconciliationFixture[]) {
  test(`reconciliation fixture: ${fixture.name}`, () => {
    assert.equal(deriveTerminalState(fixture.facts), fixture.expected.terminal);
    const retry = deriveRetrySafety(fixture.retry);
    assert.equal(
      retry.sameAuthorizationReplaySafe,
      fixture.expected.sameAuthorizationReplaySafe,
    );
    assert.equal(retry.newAuthorizationSafe, fixture.expected.newAuthorizationSafe);
  });
}

test("the same 502 shape does not determine retry or terminal safety", () => {
  const cases = fixtures as ReconciliationFixture[];
  const preSubmit = cases.find((fixture) => fixture.name === "pre-submission 502");
  const postSubmit = cases.find((fixture) => fixture.name === "post-submission 502");
  assert.ok(preSubmit);
  assert.ok(postSubmit);
  assert.equal(preSubmit.publicHttpStatus, postSubmit.publicHttpStatus);
  assert.notEqual(preSubmit.executionPhase, postSubmit.executionPhase);
  assert.notEqual(deriveTerminalState(preSubmit.facts), deriveTerminalState(postSubmit.facts));
});

test("one semantic operation allows at most one settlement and one effect", () => {
  assert.deepEqual(evaluateOperationInvariant(1, 1), {
    settlementCount: 1,
    effectCount: 1,
    maximumSettlements: 1,
    maximumEffects: 1,
    passed: true,
  });
  assert.equal(evaluateOperationInvariant(2, 1).passed, false);
  assert.equal(evaluateOperationInvariant(1, 2).passed, false);
});

test("duplicate settlement has terminal precedence", () => {
  const base = (fixtures as ReconciliationFixture[]).find(
    (fixture) => fixture.name === "concurrent identical-key replay produces one settlement and one effect",
  );
  assert.ok(base);
  assert.equal(
    deriveTerminalState({ ...base.facts, settlementCount: 2 }),
    "duplicate_settlement",
  );
});

test("an idempotency contract alone does not make either retry mode safe", () => {
  const retry = deriveRetrySafety({
    priorAuthorizationUnusable: "unknown",
    settlementAbsenceAuthoritative: "unknown",
    effectAbsenceAuthoritative: "unknown",
    idempotencyContractVerified: "pass",
    sameKeyReplayCreatesNoNewSettlement: "unknown",
    sameKeyReplayCreatesNoNewEffect: "unknown",
  });
  assert.equal(retry.sameAuthorizationReplaySafe, false);
  assert.equal(retry.newAuthorizationSafe, false);
});
