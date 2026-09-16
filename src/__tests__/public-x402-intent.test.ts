import assert from "node:assert/strict";
import test from "node:test";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createX402IntentHandler } from "../../api/x402-intent.js";
import { BASE_USDC_ASSET } from "../contracts.js";
import type {
  BaseTransactionObservationRequest,
  BaseTransactionObservationV01,
} from "../evidence/base-transaction.js";
import {
  PUBLIC_X402_INTENT_ASSURANCE,
  PUBLIC_X402_INTENT_CAPABILITIES,
  PUBLIC_X402_INTENT_LIMITATIONS,
  PUBLIC_X402_INTENT_PRIVACY,
  parsePublicX402IntentRequest,
} from "../public-x402-intent.js";

const HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const NONCE = `0x${"c".repeat(64)}`;
const FROM = `0x${"d".repeat(40)}`;
const TO = `0x${"e".repeat(40)}`;
const CHECKED_AT = "2026-08-05T20:00:00.000Z";
const ANCHOR_TIMESTAMP = String(Math.floor(Date.parse(CHECKED_AT) / 1_000) - 30);

interface ResponseState {
  statusCode: number;
  body: unknown;
  headers: Map<string, string | number | readonly string[]>;
}

function paymentRequirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "19483",
    asset: BASE_USDC_ASSET,
    payTo: TO,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USD Coin",
      version: "2",
    },
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    transactionHash: HASH,
    paymentRequirements: paymentRequirements(),
    ...overrides,
  };
}

function request(
  overrides: Partial<{
    method: string;
    url: string;
    query: unknown;
    body: unknown;
    headers: Record<string, string | undefined>;
  }> = {},
): VercelRequest {
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? "/api/x402-intent",
    query: overrides.query ?? {},
    body: Object.prototype.hasOwnProperty.call(overrides, "body")
      ? overrides.body
      : body(),
    headers: overrides.headers ?? { "content-type": "application/json" },
  } as unknown as VercelRequest;
}

function response(): { res: VercelResponse; state: ResponseState } {
  const state: ResponseState = {
    statusCode: 200,
    body: undefined,
    headers: new Map(),
  };
  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers.set(name.toLowerCase(), value);
      return res;
    },
    status(statusCode: number) {
      state.statusCode = statusCode;
      return res;
    },
    json(value: unknown) {
      state.body = value;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, state };
}

function observation(
  input: BaseTransactionObservationRequest,
  overrides: Partial<BaseTransactionObservationV01> = {},
): BaseTransactionObservationV01 {
  return {
    schemaVersion: "0.1",
    kind: "base_transaction_observation",
    checkedAt: input.checkedAt,
    networkId: "eip155:8453",
    transactionHash: input.transactionHash,
    registryHash: `sha256:${"1".repeat(64)}`,
    status: "confirmed",
    receipt: {
      transactionHash: input.transactionHash,
      blockHash: BLOCK_HASH,
      blockNumber: "50000000",
      status: "success",
    },
    finalizedAnchor: {
      blockNumber: "50000010",
      blockHash: `0x${"f".repeat(64)}`,
      blockTimestamp: ANCHOR_TIMESTAMP,
    },
    sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
    confirmations: 11,
    settlementCount: 1,
    settlements: [
      {
        from: FROM,
        to: TO,
        valueAtomic: "19483",
        nonce: NONCE,
        authorizationUsedLogIndex: 184,
        transferLogIndex: 185,
      },
    ],
    truncated: false,
    reasons: [
      "FINALIZED_RECEIPT_UNANIMOUS",
      "NATIVE_USDC_EIP3009_PAIR_OBSERVED",
    ],
    observationHash: `sha256:${"2".repeat(64)}`,
    ...overrides,
  };
}

test("the intent handler returns a hashed exact match report without execution authority", async () => {
  let calls = 0;
  let sawSignal = false;
  const handler = createX402IntentHandler({
    collect: async (input, signal) => {
      calls += 1;
      sawSignal = signal instanceof AbortSignal && !signal.aborted;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  const { res, state } = response();
  await handler(request(), res);

  assert.equal(state.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(sawSignal, true);
  const result = state.body as Record<string, any>;
  assert.deepEqual(Object.keys(result).sort(), [
    "assurance",
    "baseEvidence",
    "capabilities",
    "caseId",
    "checkedAt",
    "comparisons",
    "intent",
    "kind",
    "limitations",
    "observedPayment",
    "privacy",
    "reasons",
    "reportHash",
    "schemaVersion",
    "status",
    "transactionHash",
  ]);
  assert.equal(result.schemaVersion, "0.2");
  assert.equal(result.kind, "public_x402_requirement_verification");
  assert.equal(result.status, "settlement_terms_matched");
  assert.equal(result.transactionHash, HASH);
  assert.equal(result.observedPayment.from, FROM);
  assert.equal(result.observedPayment.nonce, NONCE);
  assert.match(result.intent.intentHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.caseId, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.reportHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.assurance, PUBLIC_X402_INTENT_ASSURANCE);
  assert.deepEqual(result.capabilities, PUBLIC_X402_INTENT_CAPABILITIES);
  assert.deepEqual(result.privacy, PUBLIC_X402_INTENT_PRIVACY);
  assert.deepEqual(result.limitations, PUBLIC_X402_INTENT_LIMITATIONS);
  assert.equal("registryHash" in result.baseEvidence, false);
  assert.equal(JSON.stringify(result).includes("https://"), false);
  assert.equal(state.headers.get("cache-control"), "no-store");
  assert.equal(state.headers.has("access-control-allow-origin"), false);
  assert.equal(state.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("controlled recipient and amount mutations return explicit mismatches", async () => {
  const handler = createX402IntentHandler({
    collect: async (input) => observation(input),
    now: () => new Date(CHECKED_AT),
  });

  for (const [overrides, reason] of [
    [{ payTo: `0x${"1".repeat(40)}` }, "RECIPIENT_MISMATCH"],
    [{ amount: "19484" }, "AMOUNT_MISMATCH"],
  ] as const) {
    const { res, state } = response();
    await handler(
      request({
        body: body({ paymentRequirements: paymentRequirements(overrides) }),
      }),
      res,
    );
    assert.equal(state.statusCode, 200);
    const result = state.body as Record<string, any>;
    assert.equal(result.status, "settlement_terms_mismatch");
    assert.ok(result.reasons.includes(reason));
    assert.notEqual(result.status, "settlement_terms_matched");
  }
});

test("concurrent same-hash cases share one collection but retain distinct intent reports", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = createX402IntentHandler({
    collect: async (input) => {
      calls += 1;
      await gate;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  const matched = response();
  const mismatched = response();
  const first = handler(request(), matched.res);
  const second = handler(
    request({
      body: body({
        paymentRequirements: paymentRequirements({ amount: "19484" }),
      }),
    }),
    mismatched.res,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  const firstBody = matched.state.body as Record<string, any>;
  const secondBody = mismatched.state.body as Record<string, any>;
  assert.equal(firstBody.status, "settlement_terms_matched");
  assert.equal(secondBody.status, "settlement_terms_mismatch");
  assert.notEqual(firstBody.caseId, secondBody.caseId);
  assert.equal(firstBody.checkedAt, secondBody.checkedAt);
  assert.equal(firstBody.baseEvidence.observationHash, secondBody.baseEvidence.observationHash);
});

test("all invalid or unsupported requests fail before collection with bounded reason codes", async () => {
  let calls = 0;
  const handler = createX402IntentHandler({
    collect: async (input) => {
      calls += 1;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  const cases: Array<{
    req: VercelRequest;
    status: number;
    reason?: string;
  }> = [
    { req: request({ method: "GET", headers: {} }), status: 405 },
    { req: request({ headers: {} }), status: 400, reason: "CONTENT_TYPE_INVALID" },
    { req: request({ url: "/api/x402-intent?rpcUrl=https://example.test" }), status: 400 },
    { req: request({ query: { rpcUrl: "https://example.test" } }), status: 400 },
    { req: request({ body: { ...body(), rpcUrl: "https://example.test" } }), status: 400 },
    {
      req: request({
        body: body({ paymentRequirements: paymentRequirements({ scheme: "upto" }) }),
      }),
      status: 400,
      reason: "PAYMENT_REQUIREMENTS_SCHEME_UNSUPPORTED",
    },
    {
      req: request({
        body: body({
          paymentRequirements: paymentRequirements({
            extra: {
              name: "USD Coin",
              version: "2",
              signature: `0x${"1".repeat(130)}`,
            },
          }),
        }),
      }),
      status: 400,
      reason: "PAYMENT_REQUIREMENTS_EXTRA_FIELDS_INVALID",
    },
    {
      req: request({
        headers: {
          "content-type": "application/json",
          "content-length": "9000",
        },
      }),
      status: 413,
      reason: "REQUEST_BODY_TOO_LARGE",
    },
    {
      req: request({
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
      }),
      status: 400,
      reason: "REQUEST_CONTEXT_INVALID",
    },
  ];

  for (const candidate of cases) {
    const { res, state } = response();
    await handler(candidate.req, res);
    assert.equal(state.statusCode, candidate.status);
    if (candidate.reason) {
      assert.equal((state.body as any).error.reason, candidate.reason);
    }
    assert.equal(state.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("query accessors and body accessors fail closed before normalization", () => {
  const query = {};
  Object.defineProperty(query, "rpcUrl", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () =>
      parsePublicX402IntentRequest({
        method: "POST",
        url: "/api/x402-intent",
        query,
        body: body(),
      }),
    /REQUEST_URL_INVALID/,
  );

  const accessorBody = body();
  Object.defineProperty(accessorBody, "transactionHash", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () =>
      parsePublicX402IntentRequest({
        method: "POST",
        url: "/api/x402-intent",
        query: {},
        body: accessorBody,
      }),
    /REQUEST_BODY_FIELDS_INVALID/,
  );

  let nestedAccessorExecutions = 0;
  const accessorExtra = {
    assetTransferMethod: "eip3009",
    version: "2",
  } as Record<string, unknown>;
  Object.defineProperty(accessorExtra, "name", {
    enumerable: true,
    get() {
      nestedAccessorExecutions += 1;
      return "USD Coin";
    },
  });
  assert.throws(
    () =>
      parsePublicX402IntentRequest({
        method: "POST",
        url: "/api/x402-intent",
        query: {},
        body: body({
          paymentRequirements: paymentRequirements({ extra: accessorExtra }),
        }),
      }),
    /PAYMENT_REQUIREMENTS_EXTRA_FIELDS_INVALID/,
  );
  assert.equal(nestedAccessorExecutions, 0);
});

test("provider failures collapse to one secret-free unavailable response", async () => {
  let collectionSignal: AbortSignal | undefined;
  const handler = createX402IntentHandler({
    collect: async (_input, signal) => {
      collectionSignal = signal;
      throw new Error("https://secret-provider.example/key-should-not-leak");
    },
    now: () => new Date(CHECKED_AT),
  });
  const { res, state } = response();
  await handler(request(), res);

  assert.equal(state.statusCode, 503);
  assert.deepEqual(state.body, {
    error: {
      code: "VERIFICATION_UNAVAILABLE",
      message: "Fixed-source Base verification is temporarily unavailable.",
    },
    status: "unavailable",
  });
  assert.equal(JSON.stringify(state.body).includes("secret-provider"), false);
  assert.equal(collectionSignal?.aborted, true);
});
