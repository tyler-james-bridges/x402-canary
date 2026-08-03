import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCashResult, PaidPathContract, PollContract } from "../contracts.js";
import { verifyPaidPath } from "../paid-path.js";

const bankrLintContract: PaidPathContract = {
  name: "Bankr x402 Lint",
  request: {
    url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint",
    method: "POST",
    body: { url: "https://canary.0x402.sh/api/health" },
  },
  payment: {
    protocol: "x402",
    network: "base",
    scheme: "exact",
    networkId: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
    maxAmountAtomic: "10000",
    maxAmountUsd: 0.01,
  },
  delivery: { jsonPaths: ["ok", "grade", "score", "findings"] },
};

const paymentRequired = Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: {
    url: bankrLintContract.request.url,
    description: "Deterministic Bankr lint fixture",
    mimeType: "application/json",
  },
  accepts: [{
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  }],
})).toString("base64");

const challengeFetch: typeof fetch = async () => new Response(null, {
  status: 402,
  headers: { "payment-required": paymentRequired },
});

function pendingResult(): AgentCashResult {
  return {
    success: true,
    data: { status: "pending", pollUrl: "/api/jobs/7fbb21b9" },
    metadata: {
      protocol: "x402",
      network: "base",
      price: "$0.01",
      payment: { success: true, transactionHash: "0xabc" },
    },
  };
}

function asyncContract(overrides: Partial<PollContract> = {}): PaidPathContract {
  return {
    ...bankrLintContract,
    delivery: { jsonPaths: ["result.url"] },
    poll: {
      urlPath: "pollUrl",
      statusPath: "status",
      pending: ["pending"],
      success: ["completed"],
      failure: ["failed"],
      intervalMs: 1,
      ...overrides,
    },
  };
}

test("probes the contract with its real method and body", async () => {
  let requestInit: RequestInit | undefined;
  const fetchMock: typeof fetch = async (_input, init) => {
    requestInit = init;
    return new Response(null, {
      status: 402,
      headers: { "payment-required": paymentRequired },
    });
  };

  const result = await verifyPaidPath(bankrLintContract, { pay: false, fetch: fetchMock });
  assert.equal(result.passed, true);
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.body, JSON.stringify(bankrLintContract.request.body));
});

test("rejects a malformed payment challenge before paying", async () => {
  let paymentCalled = false;
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async () => new Response(null, {
      status: 402,
      headers: { "payment-required": Buffer.from("{}").toString("base64") },
    }),
    paidFetch: async () => { paymentCalled = true; return { success: true }; },
  });

  assert.equal(result.passed, false);
  assert.equal(result.paymentStatus, "not-attempted");
  assert.equal(paymentCalled, false);
});

test("rejects redirects that can rewrite the contracted request", async () => {
  let redirectMode: RequestRedirect | undefined;
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 303, headers: { location: "/rewritten" } });
    },
    paidFetch: async () => { throw new Error("should not run"); },
  });

  assert.equal(redirectMode, "manual");
  assert.equal(result.paymentStatus, "not-attempted");
  assert.equal(result.passed, false);
});

test("does not promote AgentCash metadata to independent settlement confirmation", async () => {
  const fetchMock: typeof fetch = async () => new Response(null, {
    status: 402,
    headers: { "payment-required": paymentRequired },
  });
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: fetchMock,
    paidFetch: async (_request, payment) => {
      assert.deepEqual(payment, bankrLintContract.payment);
      return {
        success: true,
        data: { ok: true, grade: "A", score: 100, findings: [] },
        metadata: {
          protocol: "x402",
          network: "base",
          price: "$0.01",
          payment: { success: true, transactionHash: "0xabc" },
        },
      };
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.paymentStatus, "unknown");
  assert.equal(result.payment?.transactionHash, "0xabc");
  assert.equal(result.checks.find((check) => check.stage === "settlement")?.passed, false);
  assert.deepEqual(result.checks.map((check) => check.stage), [
    "challenge", "payment", "settlement", "delivery",
  ]);
});

test("fails when AgentCash returns data without a payment receipt", async () => {
  const fetchMock: typeof fetch = async () => new Response(null, {
    status: 402,
    headers: { "payment-required": paymentRequired },
  });
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: fetchMock,
    paidFetch: async () => ({
      success: true,
      data: { ok: true, grade: "A", score: 100, findings: [] },
      metadata: null,
    }),
  });

  assert.equal(result.passed, false);
  assert.equal(result.paymentStatus, "unknown");
  assert.equal(result.checks.find((check) => check.stage === "settlement")?.passed, false);
});

test("surfaces a settlement on an unexpected network", async () => {
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: challengeFetch,
    paidFetch: async () => ({
      success: true,
      data: { ok: true, grade: "A", score: 100, findings: [] },
      metadata: {
        protocol: "x402",
        network: "solana",
        price: "$0.01",
        payment: { success: true, transactionHash: "5HueCGU8rMjxEXxiPuD5BDu" },
      },
    }),
  });
  assert.equal(result.payment?.network, "solana");
  assert.equal(result.paymentStatus, "unknown");
  assert.equal(result.checks.find((check) => check.stage === "settlement")?.passed, false);
});

test("fails when a required output field is null", async () => {
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async () => new Response(null, {
      status: 402,
      headers: { "payment-required": paymentRequired },
    }),
    paidFetch: async () => ({
      success: true,
      data: { ok: true, grade: "A", score: 100, findings: null },
      metadata: {
        protocol: "x402",
        network: "base",
        price: "$0.01",
        payment: { success: true, transactionHash: "0xabc" },
      },
    }),
  });
  assert.equal(result.checks.find((check) => check.stage === "delivery")?.passed, false);
});

test("marks a rejected paid fetch as an unknown payment outcome", async () => {
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async () => new Response(null, {
      status: 402,
      headers: { "payment-required": paymentRequired },
    }),
    paidFetch: async () => { throw new Error("request timed out"); },
  });

  assert.equal(result.paymentStatus, "unknown");
  assert.match(result.checks.at(-1)?.detail ?? "", /do not issue a new authorization/);
});

test("marks an AgentCash error response as an unknown payment outcome", async () => {
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async () => new Response(null, {
      status: 402,
      headers: { "payment-required": paymentRequired },
    }),
    paidFetch: async () => ({ success: false, error: { message: "request timed out" } }),
  });
  assert.equal(result.paymentStatus, "unknown");
});

test("polls an async job without authorizing another payment", async () => {
  const caps: number[] = [];
  const atomicCaps: string[] = [];
  let calls = 0;
  const result = await verifyPaidPath(asyncContract(), {
    pay: true,
    fetch: challengeFetch,
    sleep: async () => undefined,
    paidFetch: async (_request, payment) => {
      caps.push(payment.maxAmountUsd);
      atomicCaps.push(payment.maxAmountAtomic);
      calls += 1;
      return calls === 1 ? pendingResult() : {
        success: true,
        data: { status: "completed", result: { url: "https://canary.0x402.sh/result" } },
      };
    },
  });
  assert.equal(result.passed, false);
  assert.equal(result.paymentStatus, "unknown");
  assert.equal(result.checks.find((check) => check.stage === "poll")?.passed, true);
  assert.deepEqual(caps, [0.01, 0]);
  assert.deepEqual(atomicCaps, ["10000", "0"]);
});

test("stops async polling at the contract deadline", async () => {
  let calls = 0;
  let now = 0;
  const result = await verifyPaidPath(asyncContract({ intervalMs: 20, timeoutMs: 5 }), {
    pay: true,
    fetch: challengeFetch,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    paidFetch: async () => { calls += 1; return pendingResult(); },
  });
  assert.equal(calls, 1);
  assert.equal(result.checks.find((check) => check.stage === "poll")?.passed, false);
});

test("rejects a terminal poll response that arrives after the deadline", async () => {
  let calls = 0;
  const result = await verifyPaidPath(asyncContract({ timeoutMs: 5 }), {
    pay: true,
    fetch: challengeFetch,
    sleep: async () => undefined,
    paidFetch: async () => {
      calls += 1;
      if (calls === 1) return pendingResult();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        success: true,
        data: { status: "completed", result: { url: "https://canary.0x402.sh/result" } },
      };
    },
  });
  assert.equal(result.checks.find((check) => check.stage === "poll")?.passed, false);
});

test("verifies browser payment CORS preflight", async () => {
  const contract = { ...bankrLintContract, corsOrigin: "https://canary.0x402.sh" };
  const fetchMock: typeof fetch = async (_input, init) => {
    if (init?.method !== "OPTIONS") {
      return new Response(null, {
        status: 402,
        headers: {
          "payment-required": paymentRequired,
          "access-control-allow-origin": "https://canary.0x402.sh",
          "access-control-expose-headers": "payment-required",
        },
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://canary.0x402.sh",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, payment-signature",
        "access-control-expose-headers": "payment-required, payment-response",
      },
    });
  };

  const result = await verifyPaidPath(contract, { pay: false, fetch: fetchMock });
  assert.equal(result.passed, true);
  assert.equal(result.checks.find((check) => check.stage === "cors")?.passed, true);
});

test("rejects substring matches in CORS methods", async () => {
  const result = await verifyPaidPath(
    { ...bankrLintContract, corsOrigin: "https://canary.0x402.sh" },
    {
      pay: false,
      fetch: async (_input, init) => init?.method === "OPTIONS"
        ? new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POSTER",
            "access-control-allow-headers": "*",
            "access-control-expose-headers": "*",
          },
        })
        : new Response(null, { status: 402, headers: { "payment-required": paymentRequired } }),
    },
  );
  assert.equal(result.checks.find((check) => check.stage === "cors")?.passed, false);
});

test("does not pay when the contract request has no payment challenge", async () => {
  let paymentCalled = false;
  const result = await verifyPaidPath(bankrLintContract, {
    pay: true,
    fetch: async () => new Response(null, { status: 400 }),
    paidFetch: async () => {
      paymentCalled = true;
      return { success: true };
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.paymentStatus, "not-attempted");
  assert.equal(paymentCalled, false);
});

test("does not pay after a failed CORS preflight", async () => {
  let paymentCalled = false;
  const result = await verifyPaidPath(
    { ...bankrLintContract, corsOrigin: "https://canary.0x402.sh" },
    {
      pay: true,
      fetch: async (_input, init) => init?.method === "OPTIONS"
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 402, headers: { "payment-required": paymentRequired } }),
      paidFetch: async () => { paymentCalled = true; return { success: true }; },
    },
  );
  assert.equal(result.paymentStatus, "not-attempted");
  assert.equal(paymentCalled, false);
});
