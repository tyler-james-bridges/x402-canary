import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateNoSpendResponse,
  singleRequirementHeader,
  validatePaymentRequired,
} from "../x402-challenge.js";
import {
  baseExactPayment,
  encodeChallenge,
  exactEip3009Requirement,
  FIXTURE_RESOURCE_URL,
  issue3020NoSpendShape,
  passingNoSpendShape,
} from "./fixtures/base-exact-no-spend.js";

test("accepts one capped Base-USDC x402 v2 exact EIP-3009 requirement", () => {
  const result = validatePaymentRequired(
    encodeChallenge([exactEip3009Requirement()]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.accepted.scheme, "exact");
  assert.equal(result.accepted.network, "eip155:8453");
  assert.equal(result.accepted.amount, "10000");
  assert.equal(result.accepted.payTo.toLowerCase(), baseExactPayment.payTo.toLowerCase());
  assert.equal(result.quotedUsd, 0.01);
});

test("emits only the one contract-compatible requirement", () => {
  const upto = {
    ...exactEip3009Requirement(),
    scheme: "upto",
    extra: { facilitatorAddress: "0x1111111111111111111111111111111111111111" },
  };
  const result = validatePaymentRequired(
    encodeChallenge([upto, exactEip3009Requirement()]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const narrowed = JSON.parse(Buffer.from(singleRequirementHeader(result), "base64").toString("utf8")) as {
    accepts: Array<{ scheme: string }>;
  };
  assert.deepEqual(narrowed.accepts.map(({ scheme }) => scheme), ["exact"]);
});

test("rejects an upto-only challenge", () => {
  const requirement = {
    ...exactEip3009Requirement(),
    scheme: "upto",
    extra: { facilitatorAddress: "0x1111111111111111111111111111111111111111" },
  };
  const result = validatePaymentRequired(
    encodeChallenge([requirement]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
});

test("rejects a Base exact Permit2 requirement", () => {
  const requirement = {
    ...exactEip3009Requirement(),
    extra: { assetTransferMethod: "permit2" },
  };
  const result = validatePaymentRequired(
    encodeChallenge([requirement]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
});

test("accepts an explicit EIP-3009 transfer-method marker", () => {
  const requirement = {
    ...exactEip3009Requirement(),
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
  };
  const result = validatePaymentRequired(
    encodeChallenge([requirement]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, true);
});

for (const [field, value] of [
  ["name", "Definitely Not USD Coin"],
  ["version", "999"],
] as const) {
  test(`rejects the wrong Base USDC EIP-712 domain ${field}`, () => {
    const requirement = exactEip3009Requirement();
    requirement.extra = { ...requirement.extra as Record<string, unknown>, [field]: value };
    const result = validatePaymentRequired(
      encodeChallenge([requirement]),
      baseExactPayment,
      FIXTURE_RESOURCE_URL,
    );
    assert.equal(result.ok, false);
  });
}

for (const [field, value] of [
  ["network", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
  ["asset", "0x1111111111111111111111111111111111111111"],
  ["payTo", "0x2222222222222222222222222222222222222222"],
  ["amount", "10001"],
] as const) {
  test(`rejects a requirement outside the bound ${field} policy`, () => {
    const requirement = { ...exactEip3009Requirement(), [field]: value };
    const result = validatePaymentRequired(
      encodeChallenge([requirement]),
      baseExactPayment,
      FIXTURE_RESOURCE_URL,
    );
    assert.equal(result.ok, false);
  });
}

test("rejects ambiguous duplicate contract-compatible requirements", () => {
  const result = validatePaymentRequired(
    encodeChallenge([exactEip3009Requirement(), exactEip3009Requirement()]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Ambiguous/);
});

test("rejects a zero-address payment policy and requirement", () => {
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const result = validatePaymentRequired(
    encodeChallenge([{ ...exactEip3009Requirement(), payTo: zeroAddress }]),
    { ...baseExactPayment, payTo: zeroAddress },
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
});

for (const maxAmountUsd of [0.02, Number.NaN]) {
  test(`rejects an invalid programmatic USD cap (${String(maxAmountUsd)})`, () => {
    const result = validatePaymentRequired(
      encodeChallenge([exactEip3009Requirement()]),
      { ...baseExactPayment, maxAmountUsd },
      FIXTURE_RESOURCE_URL,
    );
    assert.equal(result.ok, false);
  });
}

test("rejects unknown x402 versions", () => {
  const header = Buffer.from(JSON.stringify({
    x402Version: 3,
    accepts: [exactEip3009Requirement()],
  })).toString("base64");
  const result = validatePaymentRequired(header, baseExactPayment, FIXTURE_RESOURCE_URL);
  assert.equal(result.ok, false);
});

test("rejects a challenge whose resource is not the contracted request", () => {
  const result = validatePaymentRequired(
    encodeChallenge([exactEip3009Requirement()]),
    baseExactPayment,
    "https://fixture.invalid/different-operation",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /RESOURCE_MISMATCH/);
});

test("rejects validation without a bound HTTPS resource", () => {
  const result = validatePaymentRequired(
    encodeChallenge([exactEip3009Requirement()]),
    baseExactPayment,
    "",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /RESOURCE_UNBOUND/);
});

test("rejects a requirement without a challenge timeout", () => {
  const requirement = exactEip3009Requirement();
  Reflect.deleteProperty(requirement, "maxTimeoutSeconds");
  const result = validatePaymentRequired(
    encodeChallenge([requirement]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
});

test("rejects a challenge timeout above the policy ceiling", () => {
  const requirement = { ...exactEip3009Requirement(), maxTimeoutSeconds: 3600 };
  const result = validatePaymentRequired(
    encodeChallenge([requirement]),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.ok, false);
});

test("reports independent passing no-spend predicates without making a payment", () => {
  const result = evaluateNoSpendResponse(
    passingNoSpendShape(),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.deepEqual({
    returns402: result.returns402,
    challengeValid: result.challengeValid,
    browserReadable: result.browserReadable,
    preflightValid: result.preflightValid,
    contractCompatible: result.contractCompatible,
  }, {
    returns402: true,
    challengeValid: true,
    browserReadable: true,
    preflightValid: true,
    contractCompatible: true,
  });
});

test("keeps the sanitized #3020 defects as separate deterministic regressions", () => {
  const result = evaluateNoSpendResponse(
    issue3020NoSpendShape(),
    baseExactPayment,
    FIXTURE_RESOURCE_URL,
  );
  assert.equal(result.returns402, true);
  assert.equal(result.challengeValid, false);
  assert.equal(result.browserReadable, false);
  assert.equal(result.preflightValid, false);
  assert.equal(result.contractCompatible, false);
  assert.match(result.errors.challenge.join("; "), /noncanonical payment prefix/);
  assert.match(result.errors.challenge.join("; "), /conflicts with x402Version 2/);
  assert.match(result.errors.browser.join("; "), /does not expose Payment-Required/);
  assert.match(result.errors.preflight.join("; "), /HTTP 501/);
});

test("does not collapse missing browser exposure into challenge incompatibility", () => {
  const shape = passingNoSpendShape();
  shape.challenge.headers["Access-Control-Expose-Headers"] = "Content-Type, Payment-Response";
  const result = evaluateNoSpendResponse(shape, baseExactPayment, FIXTURE_RESOURCE_URL);
  assert.equal(result.challengeValid, true);
  assert.equal(result.contractCompatible, true);
  assert.equal(result.browserReadable, false);
  assert.equal(result.preflightValid, true);
});

test("does not collapse a failed preflight into an invalid challenge", () => {
  const shape = passingNoSpendShape();
  if (!shape.browser) throw new Error("fixture must include a browser observation");
  shape.browser.preflight = { status: 501, headers: {} };
  const result = evaluateNoSpendResponse(shape, baseExactPayment, FIXTURE_RESOURCE_URL);
  assert.equal(result.challengeValid, true);
  assert.equal(result.contractCompatible, true);
  assert.equal(result.browserReadable, true);
  assert.equal(result.preflightValid, false);
});
