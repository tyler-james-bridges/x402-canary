import assert from "node:assert/strict";
import test from "node:test";
import fixtures from "./fixtures/base-settlement-v0.1.json" with { type: "json" };
import {
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  evaluateBaseSettlement,
} from "../evidence/base-settlement.js";
import type {
  AuthorizationStateObservation,
  BaseReceiptObservation,
  ExactAuthorizationDescriptor,
  SettlementStatus,
} from "../evidence/types.js";

interface SettlementFixture {
  name: string;
  authorization: ExactAuthorizationDescriptor;
  receiptObservations: BaseReceiptObservation[];
  authorizationStateObservations: AuthorizationStateObservation[];
  minimumConfirmations: number;
  expected: {
    status: SettlementStatus;
    authoritative: boolean;
    settlementCount: number;
    confirmations: number;
    reason: string;
  };
}

const settlementFixtures = fixtures as unknown as SettlementFixture[];

function fixture(name: string): SettlementFixture {
  const found = settlementFixtures.find((candidate) => candidate.name === name);
  assert.ok(found, `missing fixture: ${name}`);
  return structuredClone(found);
}

function validFixture(): SettlementFixture {
  return fixture("valid finalized native Base USDC settlement");
}

function firstReceipt(target: SettlementFixture): Record<string, any> {
  const observation = target.receiptObservations[0] as unknown as Record<string, any>;
  assert.ok(observation?.receipt);
  return observation.receipt as Record<string, any>;
}

function firstLog(target: SettlementFixture): Record<string, any> {
  const receipt = firstReceipt(target);
  assert.ok(Array.isArray(receipt.logs));
  const found = receipt.logs.find(
    (log: Record<string, any>) => log.topics?.[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC,
  );
  assert.ok(found, "missing Transfer fixture log");
  return found as Record<string, any>;
}

function authorizationUsedLog(target: SettlementFixture): Record<string, any> {
  const receipt = firstReceipt(target);
  assert.ok(Array.isArray(receipt.logs));
  const found = receipt.logs.find(
    (log: Record<string, any>) =>
      log.topics?.[0]?.toLowerCase() === EIP3009_AUTHORIZATION_USED_TOPIC,
  );
  assert.ok(found, "missing AuthorizationUsed fixture log");
  return found as Record<string, any>;
}

function isolateFirstReceipt(target: SettlementFixture): void {
  target.receiptObservations = [target.receiptObservations[0]!];
  target.authorizationStateObservations = [];
}

function evaluate(target: SettlementFixture) {
  return evaluateBaseSettlement(
    target.authorization,
    target.receiptObservations,
    target.authorizationStateObservations,
    target.minimumConfirmations,
  );
}

for (const target of settlementFixtures) {
  test(`Base settlement fixture: ${target.name}`, () => {
    const actual = evaluate(target);
    assert.equal(actual.status, target.expected.status);
    assert.equal(actual.authoritative, target.expected.authoritative);
    assert.equal(actual.settlementCount, target.expected.settlementCount);
    assert.equal(actual.confirmations, target.expected.confirmations);
    assert.ok(actual.reasons.includes(target.expected.reason));
  });
}

test("the Transfer topic is pinned to the ERC-20 event signature", () => {
  assert.equal(
    ERC20_TRANSFER_TOPIC,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
});

test("the authorization topic is pinned to AuthorizationUsed(address,bytes32)", () => {
  assert.equal(
    EIP3009_AUTHORIZATION_USED_TOPIC,
    "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5",
  );
});

test("a finalized receipt exposes its canonical transaction identity", () => {
  const actual = evaluate(validFixture());
  assert.equal(
    actual.transactionHash,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.equal(actual.blockNumber, "1000");
  assert.equal(actual.confirmations, 12, "minimum independently observed head is used");
});

test("independent observation order cannot change the settlement evaluation", () => {
  const target = validFixture();
  const forward = evaluate(target);
  target.receiptObservations.reverse();
  target.authorizationStateObservations.reverse();
  assert.deepEqual(evaluate(target), forward);
});

test("wrong Base chain observation fails closed", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  (target.receiptObservations[0] as unknown as Record<string, unknown>).networkId =
    "eip155:1";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("RECEIPT_NETWORK_MISMATCH"));
});

for (const [name, mutate, reason] of [
  [
    "wrong token",
    (target: SettlementFixture) => {
      firstLog(target).address = "0x9999999999999999999999999999999999999999";
    },
    "TRANSFER_TOKEN_MISMATCH",
  ],
  [
    "wrong sender",
    (target: SettlementFixture) => {
      firstLog(target).topics[1] =
        "0x0000000000000000000000009999999999999999999999999999999999999999";
    },
    "TRANSFER_FROM_MISMATCH",
  ],
  [
    "wrong recipient",
    (target: SettlementFixture) => {
      firstLog(target).topics[2] =
        "0x0000000000000000000000009999999999999999999999999999999999999999";
    },
    "TRANSFER_TO_MISMATCH",
  ],
  [
    "wrong amount",
    (target: SettlementFixture) => {
      firstLog(target).data =
        "0x0000000000000000000000000000000000000000000000000000000000002711";
    },
    "TRANSFER_VALUE_MISMATCH",
  ],
] as const) {
  test(`${name} transfer cannot satisfy settlement`, () => {
    const target = validFixture();
    isolateFirstReceipt(target);
    mutate(target);
    const actual = evaluate(target);
    assert.equal(actual.status, "mismatch");
    assert.equal(actual.authoritative, false);
    assert.ok(actual.reasons.includes(reason));
  });
}

test("a reverted receipt cannot prove settlement", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  firstReceipt(target).status = "reverted";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("RECEIPT_REVERTED"));
});

test("removed logs are rejected even when their fields otherwise match", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  firstLog(target).removed = true;
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("REMOVED_LOG_REJECTED"));
});

test("a log transaction hash must match its containing receipt", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  firstLog(target).transactionHash =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("LOG_TRANSACTION_HASH_MISMATCH"));
});

test("a Transfer without the same-receipt AuthorizationUsed event is not settlement proof", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  const receipt = firstReceipt(target);
  receipt.logs = receipt.logs.filter(
    (log: Record<string, any>) =>
      log.topics?.[0]?.toLowerCase() !== EIP3009_AUTHORIZATION_USED_TOPIC,
  );
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.equal(actual.authoritative, false);
  assert.equal(actual.settlementCount, 0);
  assert.ok(actual.reasons.includes("AUTHORIZATION_USED_EVENT_MISSING"));
});

test("AuthorizationUsed must bind the exact EIP-3009 nonce", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  authorizationUsedLog(target).topics[2] =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.equal(actual.authoritative, false);
  assert.equal(actual.settlementCount, 0);
  assert.ok(actual.reasons.includes("AUTHORIZATION_USED_NONCE_MISMATCH"));
});

test("batched existential event matches cannot be cross-paired", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  const receipt = firstReceipt(target);
  const expectedAuthorizationUsed = structuredClone(authorizationUsedLog(target));
  const wrongAssociatedTransfer = structuredClone(firstLog(target));
  wrongAssociatedTransfer.topics[2] =
    "0x0000000000000000000000009999999999999999999999999999999999999999";
  wrongAssociatedTransfer.logIndex = 1;

  const otherAuthorizationUsed = structuredClone(expectedAuthorizationUsed);
  otherAuthorizationUsed.topics[2] =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  otherAuthorizationUsed.logIndex = 2;

  const expectedTransfer = structuredClone(firstLog(target));
  expectedTransfer.logIndex = 3;
  receipt.logs = [
    expectedAuthorizationUsed,
    wrongAssociatedTransfer,
    otherAuthorizationUsed,
    expectedTransfer,
  ];

  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.equal(actual.authoritative, false);
  assert.equal(actual.settlementCount, 0);
  assert.ok(actual.reasons.includes("AUTHORIZATION_TRANSFER_PAIR_MISSING"));
});

test("malformed log topics fail closed", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  firstLog(target).topics[2] = "0x22";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("RECEIPT_LOG_MALFORMED"));
});

test("a non-object receipt log fails closed rather than throwing", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  firstReceipt(target).logs = [null];
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("RECEIPT_LOG_MALFORMED"));
});

test("a receipt observed ahead of its purported head is malformed", () => {
  const target = validFixture();
  isolateFirstReceipt(target);
  (target.receiptObservations[0] as unknown as Record<string, unknown>)
    .observedHeadBlockNumber = "999";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("OBSERVED_HEAD_PRECEDES_RECEIPT"));
});

test("independent present and missing receipt observations contradict", () => {
  const target = validFixture();
  target.authorizationStateObservations = [];
  target.receiptObservations[1] = {
    networkId: "eip155:8453",
    source: "base-rpc-b",
    observedAt: "2026-08-03T12:00:01.000Z",
    observedHeadBlockNumber: "1013",
    canonicalBlockHash: null,
    receipt: null,
  };
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.equal(actual.authoritative, false);
  assert.ok(actual.reasons.includes("INDEPENDENT_RECEIPT_OBSERVATIONS_CONTRADICT"));
});

test("independent observations of different matching transactions contradict", () => {
  const target = validFixture();
  target.authorizationStateObservations = [];
  const secondReceipt = (target.receiptObservations[1] as unknown as Record<string, any>)
    .receipt as Record<string, any>;
  secondReceipt.transactionHash =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  for (const log of secondReceipt.logs) log.transactionHash = secondReceipt.transactionHash;
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.equal(actual.settlementCount, 2);
});

test("duplicate receipt sources are not counted as independent", () => {
  const target = validFixture();
  target.authorizationStateObservations = [];
  (target.receiptObservations[1] as unknown as Record<string, unknown>).source =
    "base-rpc-a";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("DUPLICATE_RECEIPT_OBSERVATION_SOURCE"));
});

for (const [name, mutate, reason] of [
  [
    "network",
    (authorization: Record<string, unknown>) => {
      authorization.networkId = "eip155:1";
    },
    "AUTHORIZATION_NETWORK_MISMATCH",
  ],
  [
    "asset",
    (authorization: Record<string, unknown>) => {
      authorization.asset = "0x9999999999999999999999999999999999999999";
    },
    "AUTHORIZATION_ASSET_MISMATCH",
  ],
  [
    "sender",
    (authorization: Record<string, unknown>) => {
      authorization.from = "0x0000000000000000000000000000000000000000";
    },
    "AUTHORIZATION_FROM_INVALID",
  ],
  [
    "recipient",
    (authorization: Record<string, unknown>) => {
      authorization.to = "not-an-address";
    },
    "AUTHORIZATION_TO_INVALID",
  ],
  [
    "amount",
    (authorization: Record<string, unknown>) => {
      authorization.valueAtomic = "010000";
    },
    "AUTHORIZATION_VALUE_INVALID",
  ],
  [
    "validity window",
    (authorization: Record<string, unknown>) => {
      authorization.validBefore = authorization.validAfter;
    },
    "AUTHORIZATION_VALIDITY_WINDOW_INVALID",
  ],
  [
    "nonce",
    (authorization: Record<string, unknown>) => {
      authorization.nonce = "0x01";
    },
    "AUTHORIZATION_NONCE_INVALID",
  ],
] as const) {
  test(`invalid authorization ${name} is rejected before receipt evaluation`, () => {
    const target = validFixture();
    mutate(target.authorization as unknown as Record<string, unknown>);
    const actual = evaluate(target);
    assert.equal(actual.status, "mismatch");
    assert.ok(actual.reasons.includes(reason));
  });
}

for (const [name, mutate, reason] of [
  [
    "network",
    (state: Record<string, unknown>) => {
      state.networkId = "eip155:1";
    },
    "AUTHORIZATION_STATE_NETWORK_MISMATCH",
  ],
  [
    "asset",
    (state: Record<string, unknown>) => {
      state.asset = "0x9999999999999999999999999999999999999999";
    },
    "AUTHORIZATION_STATE_ASSET_MISMATCH",
  ],
  [
    "authorizer",
    (state: Record<string, unknown>) => {
      state.authorizer = "0x9999999999999999999999999999999999999999";
    },
    "AUTHORIZATION_STATE_AUTHORIZER_MISMATCH",
  ],
  [
    "nonce",
    (state: Record<string, unknown>) => {
      state.nonce = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    },
    "AUTHORIZATION_STATE_NONCE_MISMATCH",
  ],
  [
    "canonical block hash",
    (state: Record<string, unknown>) => {
      state.observedBlockHash = "0x01";
    },
    "AUTHORIZATION_STATE_BLOCK_HASH_INVALID",
  ],
  [
    "canonical block timestamp",
    (state: Record<string, unknown>) => {
      state.observedBlockTimestamp = "01700000200";
    },
    "AUTHORIZATION_STATE_BLOCK_TIMESTAMP_INVALID",
  ],
  [
    "canonical head block",
    (state: Record<string, unknown>) => {
      state.observedHeadBlockNumber = "01022";
    },
    "AUTHORIZATION_STATE_HEAD_BLOCK_INVALID",
  ],
] as const) {
  test(`authorizationState ${name} must exactly match canonical input`, () => {
    const target = fixture("expired unused authorization independently confirms absence");
    mutate(target.authorizationStateObservations[0] as unknown as Record<string, unknown>);
    const actual = evaluate(target);
    assert.equal(actual.status, "mismatch");
    assert.ok(actual.reasons.includes(reason));
  });
}

test("one expired unused state observation cannot authoritatively prove absence", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  target.receiptObservations = [target.receiptObservations[0]!];
  target.authorizationStateObservations = [target.authorizationStateObservations[0]!];
  const actual = evaluate(target);
  assert.equal(actual.status, "unknown");
  assert.equal(actual.authoritative, false);
  assert.ok(actual.reasons.includes("INDEPENDENT_ABSENCE_OBSERVATIONS_INSUFFICIENT"));
});

test("post-expiry unused state observations must independently reach finality", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  for (const state of target.authorizationStateObservations) {
    (state as unknown as Record<string, unknown>).observedHeadBlockNumber = "1015";
  }
  const actual = evaluate(target);
  assert.equal(actual.status, "unknown");
  assert.equal(actual.authoritative, false);
  assert.ok(
    actual.reasons.includes("AUTHORIZATION_STATE_MINIMUM_CONFIRMATIONS_NOT_REACHED"),
  );
});

test("post-expiry unused observations at divergent heights do not prove absence", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  const second = target.authorizationStateObservations[1] as unknown as Record<string, unknown>;
  second.observedBlockNumber = "1012";
  second.observedBlockHash =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  second.observedBlockTimestamp = "1700000202";
  second.observedHeadBlockNumber = "1023";
  const actual = evaluate(target);
  assert.equal(actual.status, "unknown");
  assert.equal(actual.authoritative, false);
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_SNAPSHOT_DISAGREEMENT"));
});

test("an authorizationState head cannot precede its observed state block", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  (target.authorizationStateObservations[0] as unknown as Record<string, unknown>)
    .observedHeadBlockNumber = "1010";
  const actual = evaluate(target);
  assert.equal(actual.status, "mismatch");
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_HEAD_PRECEDES_OBSERVATION"));
});

test("unused observations at validBefore do not close absence", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  for (const state of target.authorizationStateObservations) {
    (state as unknown as Record<string, unknown>).observedBlockTimestamp = "1700000100";
  }
  const actual = evaluate(target);
  assert.equal(actual.status, "unknown");
  assert.equal(actual.authoritative, false);
});

test("same-block authorizationState hash disagreement is a contradiction", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  (target.authorizationStateObservations[1] as unknown as Record<string, unknown>)
    .observedBlockHash =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_CANONICAL_BLOCK_CONTRADICTION"));
});

test("same-block used disagreement is a contradiction, never absence", () => {
  const target = fixture("expired unused authorization independently confirms absence");
  (target.authorizationStateObservations[1] as unknown as Record<string, unknown>).used = true;
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.equal(actual.authoritative, false);
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_VALUE_CONTRADICTION"));
});

test("authorizationState cannot regress from used to unused", () => {
  const target = fixture("used authorization without receipt remains unknown");
  const later = target.authorizationStateObservations[1] as unknown as Record<string, unknown>;
  later.used = false;
  later.observedBlockNumber = "1012";
  later.observedBlockHash =
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  later.observedBlockTimestamp = "1700000202";
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_MONOTONICITY_CONTRADICTION"));
});

test("an unused state at or after a matching receipt contradicts settlement", () => {
  const target = validFixture();
  (target.authorizationStateObservations[0] as unknown as Record<string, unknown>).used = false;
  (target.authorizationStateObservations[1] as unknown as Record<string, unknown>).used = false;
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.ok(actual.reasons.includes("AUTHORIZATION_STATE_RECEIPT_CONTRADICTION"));
});

test("same-height receipt and authorizationState hashes must agree", () => {
  const target = validFixture();
  for (const state of target.authorizationStateObservations) {
    (state as unknown as Record<string, unknown>).observedBlockHash =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  }
  const actual = evaluate(target);
  assert.equal(actual.status, "contradiction");
  assert.equal(actual.authoritative, false);
  assert.ok(
    actual.reasons.includes("AUTHORIZATION_STATE_RECEIPT_BLOCK_HASH_CONTRADICTION"),
  );
});

test("minimum confirmations must be a positive safe integer", () => {
  for (const minimum of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const target = validFixture();
    target.minimumConfirmations = minimum;
    const actual = evaluate(target);
    assert.equal(actual.status, "mismatch");
    assert.deepEqual(actual.reasons, ["MINIMUM_CONFIRMATIONS_INVALID"]);
  }
});

test("malformed runtime observation arrays fail closed rather than throwing", () => {
  const target = validFixture();
  const invalidReceipts = evaluateBaseSettlement(
    target.authorization,
    null as unknown as BaseReceiptObservation[],
    [],
    1,
  );
  assert.equal(invalidReceipts.status, "mismatch");
  assert.deepEqual(invalidReceipts.reasons, ["RECEIPT_OBSERVATIONS_INVALID"]);

  const invalidStates = evaluateBaseSettlement(
    target.authorization,
    [],
    null as unknown as AuthorizationStateObservation[],
    1,
  );
  assert.equal(invalidStates.status, "mismatch");
  assert.deepEqual(invalidStates.reasons, ["AUTHORIZATION_STATE_OBSERVATIONS_INVALID"]);
});
