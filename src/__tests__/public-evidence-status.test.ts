import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import evidenceStatusHandler from "../../api/evidence-status.js";
import {
  createPublicEvidenceStatus,
  PUBLIC_EVIDENCE_RELEASE,
  PublicEvidenceStatusError,
} from "../public-evidence-status.js";

interface ResponseState {
  body: unknown;
  ended: boolean;
  headers: Map<string, string | number | readonly string[]>;
  statusCode: number;
}

function request(
  method: string,
  query: Record<string, unknown> = {},
  body: unknown = {},
): VercelRequest {
  return { method, query, body } as unknown as VercelRequest;
}

function response(): { res: VercelResponse; state: ResponseState } {
  const state: ResponseState = {
    body: undefined,
    ended: false,
    headers: new Map(),
    statusCode: 200,
  };

  const res = {
    setHeader(name: string, value: string | number | readonly string[]) {
      state.headers.set(name.toLowerCase(), value);
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(value: unknown) {
      state.body = value;
      return res;
    },
    end() {
      state.ended = true;
      return res;
    },
  } as unknown as VercelResponse;

  return { res, state };
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, seen);
  }
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("the public v0.1 release status exposes the fixed verified evidence surface", () => {
  const status = createPublicEvidenceStatus({
    environment: "production",
    gitCommitSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
    servedAt: "2026-08-04T12:34:56.789Z",
  });

  assert.equal(status.schemaVersion, "0.1");
  assert.equal(status.kind, "public_evidence_release_status");
  assert.equal(status.service, "x402-canary");
  assert.equal(status.mode, "shadow_no_action");
  assert.equal(
    status.evidenceCoreCommit,
    "3ead8680d764ecbafe0739865f3789f8928f0fa6",
  );
  assert.deepEqual(status.verification, {
    session: 6,
    deterministicSuite: { passed: 283, total: 283, status: "PASS" },
    independentReview: { status: "PASS" },
  });

  assert.equal(status.evidenceLayers.count, 4);
  assert.equal(status.evidenceLayers.items.length, 4);
  assert.deepEqual(
    status.evidenceLayers.items.map((layer) => layer.id),
    [
      "authenticated_base_collection",
      "signed_effect_authority",
      "journal_bound_integrity",
      "no_action_shadow_runner",
    ],
  );
  assert.ok(status.evidenceLayers.items.every((layer) => layer.status === "verified"));

  assert.equal(status.outcomeMatrix.rowCount, 9);
  assert.equal(status.outcomeMatrix.rows.length, 9);
  assert.deepEqual(
    status.outcomeMatrix.rows.map((row) => row.id),
    [
      "confirmed_committed",
      "absent_absent",
      "pending_confirmations",
      "base_contradiction",
      "duplicate_settlement",
      "confirmed_effect_absent",
      "confirmed_effect_unknown",
      "confirmed_effect_duplicate",
      "confirmed_effect_contradiction",
    ],
  );

  assert.deepEqual(status.capabilities, {
    paymentExecutionEnabled: false,
    walletAccessEnabled: false,
    signingEnabled: false,
    transactionSubmissionEnabled: false,
    retryExecutionEnabled: false,
    actionExecutionEnabled: false,
    callerSelectedTargetEnabled: false,
    callerSelectedTransactionHashEnabled: true,
    fixedSourceBaseVerificationEnabled: true,
    publicOutboundMonitoringEnabled: false,
  });
  assert.deepEqual(status.liveVerifier, {
    schemaVersion: "0.1",
    scope: "transaction_only",
    networkId: "eip155:8453",
    nativeUsdcAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    configuredSources: 2,
    quorum: "unanimous",
    finality: "shared_finalized_anchor",
    callerSelectedRpcEnabled: false,
  });
  assert.deepEqual(status.trust, {
    externalTruthProven: false,
    operatorDatabaseTruthIndependentlyProven: false,
    externalAntiRollbackCheckpoint: false,
    trustedLocalWriterRequired: true,
    historicalTransportReauthentication: false,
    historicalSignatureReverification: false,
  });
  assert.deepEqual(
    status.publicRoutes.map((route) => route.path),
    [
      "/api/base-transaction",
      "/api/evidence-status",
      "/api/health",
      "/api/trust",
      "/api/preflight",
    ],
  );
  assert.ok(status.publicRoutes.every((route) => route.callerSelectedTargetEnabled === false));
  assert.equal(
    status.publicRoutes.find((route) => route.path === "/api/base-transaction")
      ?.outboundRequestsEnabled,
    true,
  );
  assert.ok(
    status.publicRoutes
      .filter((route) => route.path !== "/api/base-transaction")
      .every((route) => route.outboundRequestsEnabled === false),
  );
  assert.deepEqual(status.deployment, {
    environment: "production",
    gitCommitSha: "abcdef0123456789abcdef0123456789abcdef01",
    servedAt: "2026-08-04T12:34:56.789Z",
  });
});

test("release facts and generated status objects are recursively immutable", () => {
  const status = createPublicEvidenceStatus({
    environment: "local",
    servedAt: "2026-08-04T00:00:00.000Z",
  });

  assertDeepFrozen(PUBLIC_EVIDENCE_RELEASE);
  assertDeepFrozen(status);

  assert.throws(() => {
    (status as unknown as { mode: string }).mode = "action";
  }, TypeError);
  assert.throws(() => {
    (status.evidenceLayers.items as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (status.deployment as { environment: string }).environment = "production";
  }, TypeError);
  assert.equal(status.mode, "shadow_no_action");
  assert.equal(status.evidenceLayers.items.length, 4);
  assert.equal(status.deployment.environment, "local");
});

test("deployment metadata is canonicalized through a strict input allowlist", () => {
  for (const environment of ["production", "preview", "development", "local"] as const) {
    assert.equal(
      createPublicEvidenceStatus({
        environment,
        servedAt: "2026-08-04T00:00:00.000Z",
      }).deployment.environment,
      environment,
    );
  }

  for (const environment of ["PRODUCTION", " production ", "prod", 1, null]) {
    assert.equal(
      createPublicEvidenceStatus({
        environment,
        servedAt: "2026-08-04T00:00:00.000Z",
      }).deployment.environment,
      "unknown",
    );
  }

  assert.equal(
    createPublicEvidenceStatus({
      gitCommitSha: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      servedAt: "2026-08-04T00:00:00.000Z",
    }).deployment.gitCommitSha,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(
    createPublicEvidenceStatus({
      gitCommitSha: "not-a-canonical-sha",
      servedAt: "2026-08-04T00:00:00.000Z",
    }).deployment.gitCommitSha,
    null,
  );

  assert.throws(
    () =>
      createPublicEvidenceStatus({
        servedAt: "2026-08-04T00:00:00Z",
      }),
    (error: unknown) =>
      error instanceof PublicEvidenceStatusError &&
      error.code === "PUBLIC_EVIDENCE_STATUS_SERVED_AT_INVALID",
  );
  assert.throws(
    () =>
      createPublicEvidenceStatus({
        environment: "local",
        servedAt: "2026-08-04T00:00:00.000Z",
        privateKey: "must-not-be-accepted",
      } as never),
    (error: unknown) =>
      error instanceof PublicEvidenceStatusError &&
      error.code === "PUBLIC_EVIDENCE_STATUS_INPUT_FIELD_INVALID",
  );

  let getterCalls = 0;
  const accessorInput = Object.defineProperty({}, "environment", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "production";
    },
  });
  assert.throws(
    () => createPublicEvidenceStatus(accessorInput),
    (error: unknown) =>
      error instanceof PublicEvidenceStatusError &&
      error.code === "PUBLIC_EVIDENCE_STATUS_INPUT_DESCRIPTOR_INVALID",
  );
  assert.equal(getterCalls, 0);
});

test("the public handler supports only GET, HEAD, and OPTIONS with no-store CORS", () => {
  const previousEnvironment = process.env.VERCEL_ENV;
  const previousCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_GIT_COMMIT_SHA = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

  try {
    const get = response();
    evidenceStatusHandler(request("GET"), get.res);
    assert.equal(get.state.statusCode, 200);
    assert.equal(get.state.headers.get("access-control-allow-origin"), "*");
    assert.equal(
      get.state.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
    assert.equal(get.state.headers.get("access-control-allow-headers"), "Content-Type");
    assert.equal(get.state.headers.get("cache-control"), "no-store");
    assert.equal(
      (get.state.body as { deployment: { environment: string } }).deployment.environment,
      "preview",
    );
    assert.equal(
      (get.state.body as { deployment: { gitCommitSha: string } }).deployment.gitCommitSha,
      "abcdef0123456789abcdef0123456789abcdef01",
    );

    const head = response();
    evidenceStatusHandler(request("HEAD"), head.res);
    assert.equal(head.state.statusCode, 200);
    assert.equal(head.state.ended, true);
    assert.equal(head.state.body, undefined);
    assert.equal(head.state.headers.get("cache-control"), "no-store");

    const options = response();
    evidenceStatusHandler(request("OPTIONS"), options.res);
    assert.equal(options.state.statusCode, 204);
    assert.equal(options.state.ended, true);
    assert.equal(options.state.body, undefined);
    assert.equal(options.state.headers.get("cache-control"), "no-store");

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const unsupported = response();
      evidenceStatusHandler(request(method), unsupported.res);
      assert.equal(unsupported.state.statusCode, 405);
      assert.equal(unsupported.state.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.equal(unsupported.state.headers.get("cache-control"), "no-store");
      assert.deepEqual(unsupported.state.body, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Evidence status supports GET, HEAD, and OPTIONS only.",
        },
      });
    }
  } finally {
    restoreEnvironmentVariable("VERCEL_ENV", previousEnvironment);
    restoreEnvironmentVariable("VERCEL_GIT_COMMIT_SHA", previousCommit);
  }
});

test("untrusted request and process secrets never enter the public response", () => {
  const environmentNames = [
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_SHA",
    "DATABASE_URL",
    "PRIVATE_KEY",
    "API_TOKEN",
  ] as const;
  const previous = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const secretValues = [
    "environment-secret-7b3e",
    "database-secret-c55a",
    "private-key-secret-d44c",
    "api-token-secret-e995",
    "query-secret-f600",
    "body-secret-a2c1",
  ];

  process.env.VERCEL_ENV = secretValues[0];
  process.env.VERCEL_GIT_COMMIT_SHA = "commit-secret-invalid";
  process.env.DATABASE_URL = secretValues[1];
  process.env.PRIVATE_KEY = secretValues[2];
  process.env.API_TOKEN = secretValues[3];

  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = (async () => {
    outboundRequests += 1;
    throw new Error("public evidence status attempted an outbound request");
  }) as typeof fetch;

  try {
    const result = response();
    evidenceStatusHandler(
      request("GET", { target: secretValues[4] }, { authorization: secretValues[5] }),
      result.res,
    );
    assert.equal(result.state.statusCode, 200);
    assert.equal(outboundRequests, 0);

    const status = result.state.body as {
      deployment: { environment: string; gitCommitSha: string | null };
    };
    assert.equal(status.deployment.environment, "unknown");
    assert.equal(status.deployment.gitCommitSha, null);

    const serialized = JSON.stringify(result.state.body);
    for (const secret of secretValues) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.doesNotMatch(
      serialized,
      /"(?:DATABASE_URL|PRIVATE_KEY|API_TOKEN|authorization|target|signature|endpoint)"\s*:/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of environmentNames) {
      restoreEnvironmentVariable(name, previous.get(name));
    }
  }
});

test("the status implementation is statically isolated from evidence and action modules", () => {
  const dtoSource = readFileSync(
    new URL("../public-evidence-status.ts", import.meta.url),
    "utf8",
  );
  const handlerSource = readFileSync(
    new URL("../../api/evidence-status.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(dtoSource, /^\s*import\s/m);
  assert.match(
    handlerSource,
    /from\s+["']\.\.\/src\/public-evidence-status\.js["']/,
  );
  assert.doesNotMatch(handlerSource, /\bfetch\s*\(/);
  assert.doesNotMatch(handlerSource, /\brequire\s*\(|\bimport\s*\(/);
  assert.doesNotMatch(handlerSource, /process\.env\s*\[/);
  assert.doesNotMatch(handlerSource, /\.\.\.process\.env|Object\.(?:keys|values|entries)\(process\.env\)/);
  assert.deepEqual(
    [...handlerSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)]
      .map((match) => match[1])
      .sort(),
    ["VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA"],
  );
  assert.doesNotMatch(
    handlerSource,
    /from\s+["'][^"']*(?:agentcash|base-rpc|effect-authority|journal|payment|paid-path|shadow-runner|wallet|signing|transaction|retry|action)[^"']*["']/i,
  );
});
