import assert from "node:assert/strict";
import test from "node:test";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createBaseTransactionHandler } from "../../api/base-transaction.js";
import type {
  BaseTransactionObservationRequest,
  BaseTransactionObservationV01,
} from "../evidence/base-transaction.js";
import { BaseRpcConfigurationError } from "../evidence/base-rpc.js";
import {
  PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  PUBLIC_BASE_TRANSACTION_DRPC_ENV,
  PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN,
  PUBLIC_BASE_TRANSACTION_MAX_RPC_RESPONSE_BYTES,
  PUBLIC_BASE_TRANSACTION_REGISTRY,
  PUBLIC_BASE_TRANSACTION_RPC_TIMEOUT_MS,
  PUBLIC_BASE_TRANSACTION_TENDERLY_ENV,
  PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN,
  createPublicBaseTransactionRpcRuntime,
} from "../public-base-transaction-config.js";
import {
  PUBLIC_BASE_TRANSACTION_CAPABILITIES,
  PUBLIC_BASE_TRANSACTION_LIMITATIONS,
  PUBLIC_BASE_TRANSACTION_PRIVACY,
  parsePublicBaseTransactionRequest,
} from "../public-base-transaction.js";

const HASH = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const NONCE = `0x${"c".repeat(64)}`;
const FROM = `0x${"d".repeat(40)}`;
const TO = `0x${"e".repeat(40)}`;
const VALID_URL = `/api/base-transaction?transactionHash=${HASH}`;
const CHECKED_AT = "2026-08-04T12:00:00.000Z";

interface ResponseState {
  statusCode: number;
  body: unknown;
  headers: Map<string, string | number | readonly string[]>;
}

function request(
  overrides: Partial<{
    method: string;
    url: string;
    query: unknown;
    body: unknown;
    headers: Record<string, string | undefined>;
    readableLength: number;
  }> = {},
): VercelRequest {
  return {
    method: overrides.method ?? "GET",
    url: overrides.url ?? VALID_URL,
    query: overrides.query ?? { transactionHash: HASH },
    body: Object.prototype.hasOwnProperty.call(overrides, "body")
      ? overrides.body
      : undefined,
    headers: overrides.headers ?? {},
    readableLength: overrides.readableLength ?? 0,
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
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, state };
}

function observation(
  request: BaseTransactionObservationRequest,
): BaseTransactionObservationV01 {
  return {
    schemaVersion: "0.1",
    kind: "base_transaction_observation",
    checkedAt: request.checkedAt,
    networkId: "eip155:8453",
    transactionHash: request.transactionHash,
    registryHash: `sha256:${"1".repeat(64)}`,
    status: "confirmed",
    receipt: {
      transactionHash: request.transactionHash,
      blockHash: BLOCK_HASH,
      blockNumber: "50000000",
      status: "success",
    },
    finalizedAnchor: {
      blockNumber: "50000010",
      blockHash: `0x${"f".repeat(64)}`,
      blockTimestamp: "1785843600",
    },
    sourceAgreement: { configured: 2, agreeing: 2, quorum: "unanimous" },
    confirmations: 11,
    settlementCount: 1,
    settlements: [
      {
        from: FROM,
        to: TO,
        valueAtomic: "18837",
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
  };
}

test("the public handler returns a redacted exact DTO with explicit no-action capabilities", async () => {
  let calls = 0;
  let sawSignal = false;
  const handler = createBaseTransactionHandler({
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
  const body = state.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "assurance",
    "capabilities",
    "checkedAt",
    "confirmations",
    "finalizedAnchor",
    "kind",
    "limitations",
    "networkId",
    "observationHash",
    "privacy",
    "reasons",
    "receipt",
    "schemaVersion",
    "settlementCount",
    "settlements",
    "sourceAgreement",
    "status",
    "transactionHash",
    "truncated",
  ]);
  assert.equal(body.kind, "public_base_transaction_verification");
  assert.equal(body.transactionHash, HASH);
  assert.equal(body.status, "confirmed");
  assert.equal("registryHash" in body, false);
  assert.deepEqual(body.capabilities, PUBLIC_BASE_TRANSACTION_CAPABILITIES);
  assert.deepEqual(body.privacy, PUBLIC_BASE_TRANSACTION_PRIVACY);
  assert.deepEqual(body.limitations, PUBLIC_BASE_TRANSACTION_LIMITATIONS);
  assert.deepEqual(body.capabilities, {
    fixedSourceBaseVerificationEnabled: true,
    callerSelectedTransactionHashEnabled: true,
    callerSelectedTargetEnabled: false,
    callerSelectedRpcEnabled: false,
    paymentExecutionEnabled: false,
    walletAccessEnabled: false,
    signingEnabled: false,
    transactionSubmissionEnabled: false,
    retryExecutionEnabled: false,
    actionExecutionEnabled: false,
  });
  assert.match(String(state.headers.get("cache-control")), /s-maxage=5/);
  assert.equal(state.headers.has("access-control-allow-origin"), false);
  assert.equal(state.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("concurrent same-hash requests share one flight-owned observation time", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const times = [
    new Date(CHECKED_AT),
    new Date("2026-08-04T12:00:00.020Z"),
  ];
  const handler = createBaseTransactionHandler({
    collect: async (input) => {
      calls += 1;
      await gate;
      return observation(input);
    },
    now: () => times.shift() ?? new Date("2026-08-04T12:00:00.040Z"),
  });
  const first = response();
  const second = response();
  const firstPending = handler(request(), first.res);
  const secondPending = handler(request(), second.res);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([firstPending, secondPending]);

  assert.equal(first.state.statusCode, 200);
  assert.equal(second.state.statusCode, 200);
  assert.equal((first.state.body as { checkedAt: string }).checkedAt, CHECKED_AT);
  assert.equal((second.state.body as { checkedAt: string }).checkedAt, CHECKED_AT);
  assert.deepEqual(first.state.body, second.state.body);
});

test("only one canonical raw and parsed transactionHash query is accepted", () => {
  assert.equal(
    parsePublicBaseTransactionRequest({
      method: "GET",
      url: VALID_URL,
      query: { transactionHash: HASH },
      hasBody: false,
    }),
    HASH,
  );

  for (const candidate of [
    {
      url: "/api/base-transaction",
      query: {},
    },
    {
      url: `${VALID_URL}&transactionHash=${HASH}`,
      query: { transactionHash: [HASH, HASH] },
    },
    {
      url: `${VALID_URL}&url=http://169.254.169.254/latest/meta-data`,
      query: {
        transactionHash: HASH,
        url: "http://169.254.169.254/latest/meta-data",
      },
    },
    {
      url: `/api/base-transaction?transactionHash=${HASH.toUpperCase()}`,
      query: { transactionHash: HASH.toUpperCase() },
    },
    {
      url: `/api/base-transaction?transactionHash=%20${HASH}`,
      query: { transactionHash: ` ${HASH}` },
    },
    {
      url: `/api/base-transaction?transactionHash=${HASH}%20`,
      query: { transactionHash: `${HASH} ` },
    },
    {
      url: `/api/base-transaction/?transactionHash=${HASH}`,
      query: { transactionHash: HASH },
    },
  ]) {
    assert.throws(
      () =>
        parsePublicBaseTransactionRequest({
          method: "GET",
          url: candidate.url,
          query: candidate.query,
          hasBody: false,
        }),
      /QUERY|TRANSACTION_HASH/,
    );
  }
});

test("invalid methods, query shapes, and request bodies make zero collector calls", async () => {
  let calls = 0;
  const handler = createBaseTransactionHandler({
    collect: async (input) => {
      calls += 1;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  const cases: Array<{
    req: VercelRequest;
    status: number;
  }> = [
    { req: request({ method: "POST" }), status: 405 },
    { req: request({ method: "HEAD" }), status: 405 },
    { req: request({ method: "OPTIONS" }), status: 405 },
    {
      req: request({
        url: "/api/base-transaction",
        query: {},
      }),
      status: 400,
    },
    {
      req: request({
        url: `${VALID_URL}&transactionHash=${HASH}`,
        query: { transactionHash: [HASH, HASH] },
      }),
      status: 400,
    },
    {
      req: request({
        url: `${VALID_URL}&rpcUrl=http://127.0.0.1`,
        query: { transactionHash: HASH, rpcUrl: "http://127.0.0.1" },
      }),
      status: 400,
    },
    { req: request({ body: " " }), status: 400 },
    {
      req: request({ headers: { "content-length": "1" } }),
      status: 400,
    },
    {
      req: request({ headers: { "transfer-encoding": "chunked" } }),
      status: 400,
    },
    { req: request({ readableLength: 1 }), status: 400 },
  ];

  for (const candidate of cases) {
    const { res, state } = response();
    await handler(candidate.req, res);
    assert.equal(state.statusCode, candidate.status);
    assert.equal(state.headers.get("cache-control"), "no-store");
    assert.equal(state.headers.has("access-control-allow-origin"), false);
  }
  assert.equal(calls, 0);
});

test("cross-site browser contexts are rejected before collection", async () => {
  let calls = 0;
  const handler = createBaseTransactionHandler({
    collect: async (input) => {
      calls += 1;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { origin: "https://evil.example", host: "canary.0x402.sh" },
  ]) {
    const { res, state } = response();
    await handler(request({ headers }), res);
    assert.equal(state.statusCode, 400);
    assert.equal(state.headers.get("cache-control"), "no-store");
  }
  const allowed = response();
  await handler(
    request({
      headers: {
        origin: "https://canary.0x402.sh",
        host: "canary.0x402.sh",
      },
    }),
    allowed.res,
  );
  assert.equal(allowed.state.statusCode, 200);
  assert.equal(calls, 1);
});

test("stale finalized anchors are contained as unavailable", async () => {
  const handler = createBaseTransactionHandler({
    collect: async (input) => ({
      ...observation(input),
      finalizedAnchor: {
        ...observation(input).finalizedAnchor!,
        blockTimestamp: "1785830000",
      },
    }),
    now: () => new Date(CHECKED_AT),
  });
  const { res, state } = response();
  await handler(request(), res);
  assert.equal(state.statusCode, 503);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "VERIFICATION_UNAVAILABLE",
  );
});

test("pending and unobserved responses receive only the transient CDN lifetime", async () => {
  for (const status of ["pending_finality", "not_observed"] as const) {
    const handler = createBaseTransactionHandler({
      collect: async (input) => ({
        ...observation(input),
        status,
        reasons: [status.toUpperCase()],
        receipt:
          status === "not_observed"
            ? null
            : {
                ...observation(input).receipt!,
                blockNumber: observation(input).finalizedAnchor!.blockNumber + 1,
              },
        confirmations: 0,
        settlementCount: 0,
        settlements: [],
      }),
      now: () => new Date(CHECKED_AT),
    });
    const { res, state } = response();
    await handler(request(), res);
    assert.equal(state.statusCode, 200);
    assert.match(String(state.headers.get("cache-control")), /s-maxage=1/);
  }
});

test("query accessors, symbols, and parser mismatch fail before collection", async () => {
  let calls = 0;
  const handler = createBaseTransactionHandler({
    collect: async (input) => {
      calls += 1;
      return observation(input);
    },
    now: () => new Date(CHECKED_AT),
  });
  const accessorQuery = {} as Record<string, unknown>;
  Object.defineProperty(accessorQuery, "transactionHash", {
    enumerable: true,
    get: () => HASH,
  });
  const symbolQuery = { transactionHash: HASH } as Record<PropertyKey, unknown>;
  symbolQuery[Symbol("target")] = "https://evil.example";
  for (const candidate of [
    request({ query: accessorQuery }),
    request({ query: symbolQuery }),
    request({ query: { transactionHash: `0x${"b".repeat(64)}` } }),
  ]) {
    const { res, state } = response();
    await handler(candidate, res);
    assert.equal(state.statusCode, 400);
  }
  assert.equal(calls, 0);
});

test("provider and configuration failures return one stable secret-free 503", async () => {
  const secret = "DO_NOT_ECHO_PROVIDER_SECRET";
  const handler = createBaseTransactionHandler({
    collect: async () => {
      throw new Error(`https://base.drpc.org/${secret}`);
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
  });
  assert.doesNotMatch(JSON.stringify(state.body), new RegExp(secret));
  assert.equal(state.headers.get("cache-control"), "no-store");
});

test("a malformed or cross-request observation is contained as unavailable", async () => {
  const handler = createBaseTransactionHandler({
    collect: async (input) => ({
      ...observation(input),
      transactionHash: `0x${"b".repeat(64)}`,
    }),
    now: () => new Date(CHECKED_AT),
  });
  const { res, state } = response();
  await handler(request(), res);
  assert.equal(state.statusCode, 503);
  assert.equal(
    (state.body as { error: { code: string } }).error.code,
    "VERIFICATION_UNAVAILABLE",
  );
});

test("the production runtime pins exactly dRPC and Tenderly with bounded transport policy", () => {
  assert.equal(PUBLIC_BASE_TRANSACTION_RPC_TIMEOUT_MS, 2_500);
  assert.equal(PUBLIC_BASE_TRANSACTION_MAX_RPC_RESPONSE_BYTES, 512 * 1024);
  assert.equal(PUBLIC_BASE_TRANSACTION_DEADLINE_MS, 8_000);
  assert.deepEqual(
    PUBLIC_BASE_TRANSACTION_REGISTRY.manifest.sources.map((source) => ({
      id: source.id,
      origin: source.expectedOrigin,
      environment: source.endpointEnv,
    })),
    [
      {
        id: "drpc",
        origin: PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN,
        environment: PUBLIC_BASE_TRANSACTION_DRPC_ENV,
      },
      {
        id: "tenderly",
        origin: PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN,
        environment: PUBLIC_BASE_TRANSACTION_TENDERLY_ENV,
      },
    ],
  );

  const controller = new AbortController();
  assert.doesNotThrow(() =>
    createPublicBaseTransactionRpcRuntime(controller.signal, {}),
  );
  assert.doesNotThrow(() =>
    createPublicBaseTransactionRpcRuntime(controller.signal, {
      [PUBLIC_BASE_TRANSACTION_DRPC_ENV]:
        `${PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN}/v1/private-token?project=canary`,
      [PUBLIC_BASE_TRANSACTION_TENDERLY_ENV]:
        `${PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN}/private-token`,
    }),
  );
});

test("optional provider endpoints cannot escape their code-pinned origins or echo secrets", () => {
  const controller = new AbortController();
  const secret = "DO_NOT_ECHO_THIS_RPC_SECRET";
  for (const endpoint of [
    `http://base.drpc.org/${secret}`,
    `https://evil.example/${secret}`,
    `https://base.drpc.org.evil.example/${secret}`,
    `https://user:${secret}@base.drpc.org/`,
    `https://base.drpc.org:444/${secret}`,
  ]) {
    assert.throws(
      () =>
        createPublicBaseTransactionRpcRuntime(controller.signal, {
          [PUBLIC_BASE_TRANSACTION_DRPC_ENV]: endpoint,
          [PUBLIC_BASE_TRANSACTION_TENDERLY_ENV]:
            `${PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN}/`,
        }),
      (error: unknown) =>
        error instanceof BaseRpcConfigurationError &&
        !error.message.includes(secret) &&
        !error.message.includes(endpoint),
    );
  }
});
