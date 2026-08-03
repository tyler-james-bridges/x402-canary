import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentContract, RequestContract } from "../contracts.js";
import { startPaymentProxy } from "../payment-proxy.js";

const request: RequestContract = {
  url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint",
  method: "POST",
  body: { url: "https://canary.0x402.sh/api/health" },
};
const payment: PaymentContract = {
  protocol: "x402",
  network: "base",
  scheme: "exact",
  networkId: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
  maxAmountAtomic: "10000",
  maxAmountUsd: 0.01,
};

function challengeHeader(): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: {
      url: request.url,
      description: "Deterministic Bankr lint fixture",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        amount: "1000000",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        payTo: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        maxTimeoutSeconds: 60,
        extra: { feePayer: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      },
    ],
  })).toString("base64");
}

test("exposes only the validated capped payment requirement", async () => {
  const proxy = await startPaymentProxy(request, payment, async () => new Response(null, {
    status: 402,
    headers: { "payment-required": challengeHeader() },
  }));
  try {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 402);
    const header = response.headers.get("payment-required");
    assert.ok(header);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(header, Buffer.from(JSON.stringify(decoded)).toString("base64"));
    assert.equal(decoded.accepts.length, 1);
    assert.equal(decoded.accepts[0].network, "eip155:8453");
    assert.equal(decoded.accepts[0].amount, "10000");
  } finally {
    await proxy.close();
  }
});

test("blocks redirects on the request carrying payment", async () => {
  const proxy = await startPaymentProxy(request, payment, async () => new Response(null, {
    status: 303,
    headers: { location: "https://canary.0x402.sh/rewritten" },
  }));
  try {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": "signed-request",
      },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 502);
    assert.equal(proxy.observations.redirectBlocked, true);
  } finally {
    await proxy.close();
  }
});

test("records CORS exposure on the paid response", async () => {
  const corsRequest = { ...request, corsOrigin: "https://canary.0x402.sh" };
  const proxy = await startPaymentProxy(corsRequest, payment, async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("origin"), corsRequest.corsOrigin);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "payment-response": "receipt",
        "access-control-allow-origin": corsRequest.corsOrigin,
        "access-control-expose-headers": "payment-response",
      },
    });
  });
  try {
    await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": "signed-request" },
      body: JSON.stringify(request.body),
    });
    assert.equal(proxy.observations.paidResponseCors, true);
  } finally {
    await proxy.close();
  }
});

test("turns an over-cap challenge into a non-payable response", async () => {
  const payload = JSON.parse(Buffer.from(challengeHeader(), "base64").toString("utf8"));
  payload.accepts[0].amount = "1000000";
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const proxy = await startPaymentProxy(request, payment, async () => new Response(null, {
    status: 402,
    headers: { "payment-required": header },
  }));
  try {
    const response = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    assert.equal(response.status, 409);
  } finally {
    await proxy.close();
  }
});

test("allows SIWX before enforcing the no-payment poll cap", async () => {
  const payload = JSON.parse(Buffer.from(challengeHeader(), "base64").toString("utf8"));
  payload.extensions = {
    "sign-in-with-x": {
      info: { domain: "x402.bankr.bot", uri: request.url, version: "1", nonce: "canary" },
      supportedChains: [{ chainId: "eip155:8453", type: "eip191" }],
    },
  };
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const noPayment = { ...payment, maxAmountAtomic: "0", maxAmountUsd: 0 };
  const proxy = await startPaymentProxy(request, noPayment, async () => new Response(null, {
    status: 402,
    headers: { "payment-required": header },
  }));
  try {
    const initial = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    });
    assert.equal(initial.status, 402);

    const authenticated = await fetch(proxy.url, {
      method: "POST",
      headers: { "content-type": "application/json", "sign-in-with-x": "signed-proof" },
      body: JSON.stringify(request.body),
    });
    assert.equal(authenticated.status, 409);
  } finally {
    await proxy.close();
  }
});
