import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import evidenceStatusHandler from "../../api/evidence-status.js";
import healthHandler from "../../api/health.js";
import preflightHandler from "../../api/preflight.js";
import trustHandler from "../../api/trust.js";
import bankrHandler from "../../x402/trust/index.js";
import { checkEndpoint } from "../canary.js";
import { startDashboard } from "../dashboard.js";

interface ResponseState {
  body: unknown;
  ended: boolean;
  headers: Map<string, string | number | readonly string[]>;
  statusCode: number;
}

function request(method: string): VercelRequest {
  return { method, query: {}, body: {} } as unknown as VercelRequest;
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
    json(body: unknown) {
      state.body = body;
      return res;
    },
    end() {
      state.ended = true;
      return res;
    },
  } as unknown as VercelResponse;

  return { res, state };
}

function localRequest(
  port: number,
  route: string,
  method: string,
  body?: string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: route,
      method,
      headers: body === undefined
        ? undefined
        : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: responseBody,
        headers: response.headers,
      }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("public handlers never make outbound requests", async () => {
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = (async () => {
    outboundRequests += 1;
    throw new Error("outbound fetch attempted during containment test");
  }) as typeof fetch;

  try {
    const health = response();
    healthHandler(request("GET"), health.res);
    assert.equal(health.state.statusCode, 200);
    assert.deepEqual(health.state.body, {
      service: "x402-canary",
      status: "contained",
      publicOutboundMonitoring: false,
      publicProbeRoutes: "disabled",
      outboundRequestsMade: 0,
    });

    const evidenceStatus = response();
    evidenceStatusHandler(request("GET"), evidenceStatus.res);
    assert.equal(evidenceStatus.state.statusCode, 200);
    assert.equal(
      (evidenceStatus.state.body as { mode: string }).mode,
      "shadow_no_action",
    );
    assert.deepEqual(
      (evidenceStatus.state.body as { capabilities: Record<string, boolean> })
        .capabilities,
      {
        paymentExecutionEnabled: false,
        walletAccessEnabled: false,
        signingEnabled: false,
        transactionSubmissionEnabled: false,
        retryExecutionEnabled: false,
        actionExecutionEnabled: false,
        callerSelectedTargetEnabled: false,
        publicOutboundMonitoringEnabled: false,
      },
    );

    const trust = response();
    trustHandler(request("GET"), trust.res);
    assert.equal(trust.state.statusCode, 410);
    assert.equal(
      (trust.state.body as { outboundRequestsMade: number }).outboundRequestsMade,
      0,
    );

    const preflight = response();
    preflightHandler(request("POST"), preflight.res);
    assert.equal(preflight.state.statusCode, 410);
    assert.equal(
      (preflight.state.body as { outboundRequestsMade: number }).outboundRequestsMade,
      0,
    );

    const bankr = bankrHandler(
      new Request("https://example.test/x402/trust?url=http://127.0.0.1", {
        method: "GET",
      }),
    );
    assert.equal(bankr.status, 410);
    assert.equal((await bankr.json()).outboundRequestsMade, 0);
    assert.equal(outboundRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preflight requests are handled without activating a target route", () => {
  const trust = response();
  trustHandler(request("OPTIONS"), trust.res);
  assert.equal(trust.state.statusCode, 204);
  assert.equal(trust.state.ended, true);

  const preflight = response();
  preflightHandler(request("OPTIONS"), preflight.res);
  assert.equal(preflight.state.statusCode, 204);
  assert.equal(preflight.state.ended, true);

  const bankr = bankrHandler(
    new Request("https://example.test/x402/trust", { method: "OPTIONS" }),
  );
  assert.equal(bankr.status, 204);
});

test("the local start path binds loopback and cannot revive outbound probes", async () => {
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = (async () => {
    outboundRequests += 1;
    throw new Error("outbound fetch attempted during local containment test");
  }) as typeof fetch;

  const server = startDashboard({ port: 0, log: false });
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;

  try {
    assert.equal(address.address, "127.0.0.1");
    const preflight = await localRequest(
      address.port,
      "/api/preflight",
      "POST",
      JSON.stringify({ url: "http://127.0.0.1/private", method: "POST" }),
    );
    assert.equal(preflight.status, 410);
    assert.equal(JSON.parse(preflight.body).outboundRequestsMade, 0);

    const health = await localRequest(address.port, "/api/health", "GET");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).outboundRequestsMade, 0);

    const evidenceStatus = await localRequest(
      address.port,
      "/api/evidence-status",
      "GET",
    );
    assert.equal(evidenceStatus.status, 200);
    assert.equal(JSON.parse(evidenceStatus.body).mode, "shadow_no_action");
    assert.equal(
      JSON.parse(evidenceStatus.body).capabilities.actionExecutionEnabled,
      false,
    );
    assert.equal(evidenceStatus.headers["cache-control"], "no-store");
    assert.match(
      String(evidenceStatus.headers["content-security-policy"] ?? ""),
      /default-src 'none'/,
    );

    const rejectedStatusWrite = await localRequest(
      address.port,
      "/api/evidence-status",
      "POST",
      JSON.stringify({ action: "execute" }),
    );
    assert.equal(rejectedStatusWrite.status, 405);
    assert.equal(
      JSON.parse(rejectedStatusWrite.body).error.code,
      "METHOD_NOT_ALLOWED",
    );

    for (const assetRoute of ["/", "/styles.css", "/app.js", "/llms.txt", "/og.png"]) {
      const asset = await localRequest(address.port, assetRoute, "GET");
      assert.equal(asset.status, 200, assetRoute);
      assert.equal(asset.headers["cache-control"], "no-store", assetRoute);
      assert.match(
        String(asset.headers["content-security-policy"] ?? ""),
        /script-src 'self'/,
        assetRoute,
      );
    }

    await assert.rejects(
      checkEndpoint("https://example.test", "POST"),
      /PUBLIC_PROBE_DISABLED/,
    );
    assert.equal(outboundRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("public artifacts do not advertise the disabled product", () => {
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  const llms = readFileSync(new URL("../../public/llms.txt", import.meta.url), "utf8");
  const manifest = JSON.parse(
    readFileSync(new URL("../../bankr.x402.json", import.meta.url), "utf8"),
  ) as { services?: Record<string, unknown> };

  assert.doesNotMatch(html, /safe-to-pay|proceed-with-caution|paste any endpoint/i);
  assert.doesNotMatch(html, /fetch\s*\(/);
  assert.doesNotMatch(llms, /safe-to-pay|proceed-with-caution/i);
  assert.deepEqual(manifest.services, {});

  const localEntry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const localDashboard = readFileSync(new URL("../dashboard.ts", import.meta.url), "utf8");
  const scheduledTargets = readFileSync(new URL("../endpoints.ts", import.meta.url), "utf8");
  assert.doesNotMatch(localEntry, /setInterval|checkEndpoint|runChecks/);
  assert.doesNotMatch(localDashboard, /checkEndpoint|from ["']\.\/endpoints/);
  assert.match(scheduledTargets, /endpoints:\s*readonly Endpoint\[\]\s*=\s*\[\]/);
});
