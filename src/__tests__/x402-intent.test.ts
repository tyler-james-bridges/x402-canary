import assert from "node:assert/strict";
import test from "node:test";

import { BASE_USDC_ASSET } from "../contracts.js";
import type { BaseTransactionObservationV01 } from "../evidence/base-transaction.js";
import {
  X402RequirementIntentError,
  evaluateX402RequirementCase,
  normalizeX402RequirementIntent,
} from "../evidence/x402-intent.js";

const HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const NONCE = `0x${"c".repeat(64)}`;
const FROM = `0x${"d".repeat(40)}`;
const TO = `0x${"e".repeat(40)}`;

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "19483",
    asset: BASE_USDC_ASSET,
    payTo: TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "eip3009",
    },
    ...overrides,
  };
}

function observation(
  status: BaseTransactionObservationV01["status"] = "confirmed",
  overrides: Partial<BaseTransactionObservationV01> = {},
): BaseTransactionObservationV01 {
  const settlement = {
    from: FROM,
    to: TO,
    valueAtomic: "19483",
    nonce: NONCE,
    authorizationUsedLogIndex: 10,
    transferLogIndex: 11,
  };
  const settlementCount = status === "confirmed" ? 1 : status === "multiple" ? 2 : 0;
  const settlements =
    status === "confirmed"
      ? [settlement]
      : status === "multiple"
        ? [settlement, { ...settlement, nonce: `0x${"f".repeat(64)}` }]
        : [];
  return {
    schemaVersion: "0.1",
    kind: "base_transaction_observation",
    checkedAt: "2026-08-05T20:00:00.000Z",
    networkId: "eip155:8453",
    transactionHash: HASH,
    registryHash: `sha256:${"1".repeat(64)}`,
    status,
    receipt:
      status === "not_observed" || status === "contradiction"
        ? null
        : {
            transactionHash: HASH,
            blockHash: BLOCK_HASH,
            blockNumber: "50000000",
            status: status === "reverted" ? "reverted" : "success",
          },
    finalizedAnchor:
      status === "not_observed" || status === "contradiction"
        ? null
        : {
            blockNumber: "50000010",
            blockHash: `0x${"f".repeat(64)}`,
            blockTimestamp: "1785960000",
          },
    sourceAgreement: {
      configured: 2,
      agreeing: status === "contradiction" ? 1 : 2,
      quorum: "unanimous",
    },
    confirmations: status === "pending_finality" ? 0 : 11,
    settlementCount,
    settlements,
    truncated: false,
    reasons: [],
    observationHash: `sha256:${"2".repeat(64)}`,
    ...overrides,
  };
}

test("normalization pins the supported v2 Base USDC EIP-3009 requirement", () => {
  const intent = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: requirement({
      asset: BASE_USDC_ASSET.toUpperCase().replace("0X", "0x"),
      payTo: TO.toUpperCase().replace("0X", "0x"),
      extra: { name: "USD Coin", version: "2" },
    }),
  });

  assert.equal(intent.paymentRequirements.asset, BASE_USDC_ASSET);
  assert.equal(intent.paymentRequirements.payTo, TO);
  assert.equal(intent.paymentRequirements.extra.assetTransferMethod, "eip3009");
  assert.match(intent.intentHash, /^sha256:[0-9a-f]{64}$/);

  const reordered = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: {
      extra: { version: "2", name: "USD Coin" },
      maxTimeoutSeconds: 300,
      payTo: TO,
      asset: BASE_USDC_ASSET,
      amount: "19483",
      network: "eip155:8453",
      scheme: "exact",
    },
  });
  assert.equal(reordered.intentHash, intent.intentHash);
});

test("one finalized exact event pair produces settlement_terms_matched", () => {
  const intent = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: requirement(),
  });
  const result = evaluateX402RequirementCase(intent, observation());

  assert.equal(result.status, "settlement_terms_matched");
  assert.deepEqual(result.reasons, ["SETTLEMENT_TERMS_MATCHED"]);
  assert.equal(result.observedSettlement?.from, FROM);
  assert.equal(result.observedSettlement?.nonce, NONCE);
  assert.match(result.caseId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    result.comparisons.map(({ field, status }) => [field, status]),
    [
      ["scheme", "declared_only"],
      ["network", "matched"],
      ["asset", "matched"],
      ["transferMethod", "matched"],
      ["tokenDomain", "matched"],
      ["recipient", "matched"],
      ["amount", "matched"],
      ["maxTimeoutSeconds", "declared_only"],
    ],
  );
});

test("recipient and amount mismatches are explicit and cannot match", () => {
  const intent = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: requirement(),
  });
  const result = evaluateX402RequirementCase(
    intent,
    observation("confirmed", {
      settlements: [
        {
          from: FROM,
          to: `0x${"1".repeat(40)}`,
          valueAtomic: "19484",
          nonce: NONCE,
          authorizationUsedLogIndex: 10,
          transferLogIndex: 11,
        },
      ],
    }),
  );

  assert.equal(result.status, "settlement_terms_mismatch");
  assert.deepEqual(result.reasons, ["AMOUNT_MISMATCH", "RECIPIENT_MISMATCH"]);
  assert.deepEqual(
    result.comparisons.slice(-3).map(({ field, status }) => [field, status]),
    [
      ["recipient", "mismatched"],
      ["amount", "mismatched"],
      ["maxTimeoutSeconds", "declared_only"],
    ],
  );
});

test("pending, missing, reverted, non-EIP-3009, multiple, and contradictory evidence never match", () => {
  const intent = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: requirement(),
  });
  const cases: Array<{
    observationStatus: BaseTransactionObservationV01["status"];
    caseStatus: ReturnType<typeof evaluateX402RequirementCase>["status"];
    reason: string;
  }> = [
    {
      observationStatus: "pending_finality",
      caseStatus: "pending_finality",
      reason: "SHARED_FINALITY_PENDING",
    },
    {
      observationStatus: "not_observed",
      caseStatus: "not_observed",
      reason: "TRANSACTION_NOT_OBSERVED",
    },
    {
      observationStatus: "reverted",
      caseStatus: "not_observed",
      reason: "TRANSACTION_REVERTED",
    },
    {
      observationStatus: "not_eip3009_usdc",
      caseStatus: "not_observed",
      reason: "NATIVE_USDC_EIP3009_PAYMENT_NOT_OBSERVED",
    },
    {
      observationStatus: "multiple",
      caseStatus: "multiple_payments_observed",
      reason: "MULTIPLE_EIP3009_PAYMENTS_OBSERVED",
    },
    {
      observationStatus: "contradiction",
      caseStatus: "contradiction",
      reason: "BASE_EVIDENCE_CONTRADICTION",
    },
  ];

  for (const candidate of cases) {
    const result = evaluateX402RequirementCase(
      intent,
      observation(candidate.observationStatus),
    );
    assert.equal(result.status, candidate.caseStatus);
    assert.ok(result.reasons.includes(candidate.reason));
    assert.notEqual(result.status, "settlement_terms_matched");
    assert.equal(result.observedSettlement, null);
    assert.deepEqual(
      result.comparisons.map(({ field, status }) => [field, status]),
      [
        ["scheme", "declared_only"],
        ["network", "not_evaluated"],
        ["asset", "not_evaluated"],
        ["transferMethod", "not_evaluated"],
        ["tokenDomain", "not_evaluated"],
        ["recipient", "not_evaluated"],
        ["amount", "not_evaluated"],
        ["maxTimeoutSeconds", "declared_only"],
      ],
    );
  }
});

test("unsupported or ambiguous requirements fail closed", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [requirement({ scheme: "upto" }), "PAYMENT_REQUIREMENTS_SCHEME_UNSUPPORTED"],
    [requirement({ network: "eip155:1" }), "PAYMENT_REQUIREMENTS_NETWORK_UNSUPPORTED"],
    [requirement({ asset: `0x${"1".repeat(40)}` }), "PAYMENT_REQUIREMENTS_ASSET_UNSUPPORTED"],
    [requirement({ payTo: `0x${"0".repeat(40)}` }), "PAYMENT_REQUIREMENTS_PAY_TO_ZERO"],
    [requirement({ amount: "019483" }), "PAYMENT_REQUIREMENTS_AMOUNT_INVALID"],
    [requirement({ amount: "0" }), "PAYMENT_REQUIREMENTS_AMOUNT_INVALID"],
    [requirement({ maxTimeoutSeconds: 0 }), "PAYMENT_REQUIREMENTS_TIMEOUT_UNSUPPORTED"],
    [
      requirement({
        extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
      }),
      "PAYMENT_REQUIREMENTS_TRANSFER_METHOD_UNSUPPORTED",
    ],
    [
      requirement({ extra: { name: "USDC", version: "2" } }),
      "PAYMENT_REQUIREMENTS_TOKEN_DOMAIN_UNSUPPORTED",
    ],
    [
      { ...requirement(), resource: "https://attacker.example" },
      "PAYMENT_REQUIREMENTS_FIELDS_INVALID",
    ],
  ];

  for (const [paymentRequirements, code] of cases) {
    assert.throws(
      () =>
        normalizeX402RequirementIntent({
          x402Version: 2,
          paymentRequirements,
        }),
      (error: unknown) =>
        error instanceof X402RequirementIntentError && error.code === code,
      code,
    );
  }
  assert.throws(
    () =>
      normalizeX402RequirementIntent({
        x402Version: 1,
        paymentRequirements: requirement(),
      }),
    (error: unknown) =>
      error instanceof X402RequirementIntentError &&
      error.code === "X402_VERSION_UNSUPPORTED",
  );
});

test("confirmed status with an impossible settlement shape becomes contradiction", () => {
  const intent = normalizeX402RequirementIntent({
    x402Version: 2,
    paymentRequirements: requirement(),
  });
  const impossible: Partial<BaseTransactionObservationV01>[] = [
    { settlementCount: 2 },
    { receipt: null },
    { finalizedAnchor: null },
    {
      receipt: {
        transactionHash: HASH,
        blockHash: BLOCK_HASH,
        blockNumber: "50000000",
        status: "reverted",
      },
    },
    {
      receipt: {
        transactionHash: `0x${"1".repeat(64)}`,
        blockHash: BLOCK_HASH,
        blockNumber: "50000000",
        status: "success",
      },
    },
    { sourceAgreement: { configured: 2, agreeing: 0, quorum: "unanimous" } },
    { confirmations: 0 },
    { confirmations: 10 },
    {
      finalizedAnchor: {
        blockNumber: "50000000",
        blockHash: `0x${"1".repeat(64)}`,
        blockTimestamp: "1785960000",
      },
      confirmations: 1,
    },
  ];

  for (const overrides of impossible) {
    const result = evaluateX402RequirementCase(
      intent,
      observation("confirmed", overrides),
    );
    assert.equal(result.status, "contradiction");
    assert.deepEqual(result.reasons, ["CONFIRMED_OBSERVATION_SHAPE_INVALID"]);
    assert.equal(result.observedSettlement, null);
  }
});
