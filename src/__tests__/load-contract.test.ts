import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadContract, parseContract } from "../load-contract.js";

const bankrPayment = {
  protocol: "x402",
  network: "base",
  scheme: "exact",
  networkId: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
  maxAmountAtomic: "10000",
  maxAmountUsd: 0.01,
};

function validContract() {
  return {
    name: "Bankr x402 Lint",
    request: {
      url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint",
      method: "POST",
      body: { url: "https://canary.0x402.sh/api/health" },
    },
    payment: { ...bankrPayment },
    delivery: { jsonPaths: ["ok", "grade", "score", "findings"] },
  };
}

test("parses a Base mainnet USDC exact contract with a bound payee and atomic cap", () => {
  const contract = parseContract(validContract());

  assert.equal(contract.request.method, "POST");
  assert.deepEqual(contract.delivery.jsonPaths, ["ok", "grade", "score", "findings"]);
  assert.deepEqual(contract.payment, bankrPayment);
});

test("loads the packaged Bankr lint contract with the same bound policy", async () => {
  const filePath = fileURLToPath(new URL("../../contracts/bankr-lint.json", import.meta.url));
  const contract = await loadContract(filePath);
  assert.deepEqual(contract.payment, bankrPayment);
  assert.deepEqual(contract.request.body, { url: "https://canary.0x402.sh/api/health" });
});

test("rejects a contract without a positive spend cap", () => {
  const contract = validContract();
  contract.payment.maxAmountUsd = 0;
  assert.throws(() => parseContract(contract), /maxAmountUsd/);
});

test("requires the USD and atomic caps to describe the same USDC amount", () => {
  const contract = validContract();
  contract.payment.maxAmountAtomic = "9999";
  assert.throws(() => parseContract(contract), /must equal payment.maxAmountAtomic/);
});

test("requires meaningful delivery assertions", () => {
  const contract = validContract();
  contract.delivery.jsonPaths = [];
  assert.throws(() => parseContract(contract), /jsonPaths must not be empty/);
});

test("rejects payment credentials in challenge headers", () => {
  const contract = validContract();
  (contract.request as Record<string, unknown>)["headers"] = {
    "Payment-Signature": "signed-payment",
  };
  assert.throws(() => parseContract(contract), /payment credentials/);
});

test("rejects a GET contract with a body", () => {
  const contract = validContract();
  contract.request.method = "GET";
  assert.throws(() => parseContract(contract), /GET contracts must not include/);
});

test("rejects a non-HTTPS contracted resource", () => {
  const contract = validContract();
  contract.request.url = "http://fixture.invalid/lint";
  assert.throws(() => parseContract(contract), /request.url must use HTTPS/);
});

for (const [name, value, message] of [
  ["network", "solana", /payment.network must be base/],
  ["scheme", "upto", /payment.scheme must be exact/],
  ["networkId", "eip155:1", /payment.networkId must be eip155:8453/],
  ["asset", "0x1111111111111111111111111111111111111111", /native Base USDC/],
  ["payTo", "not-an-address", /payment.payTo/],
] as const) {
  test(`rejects a contract with the wrong ${name}`, () => {
    const contract = validContract();
    (contract.payment as Record<string, unknown>)[name] = value;
    assert.throws(() => parseContract(contract), message);
  });
}

test("requires every bound payment-policy field", () => {
  for (const field of ["scheme", "networkId", "asset", "payTo", "maxAmountAtomic"] as const) {
    const contract = validContract();
    Reflect.deleteProperty(contract.payment, field);
    assert.throws(() => parseContract(contract), /payment\./);
  }
});

test("rejects the zero address as payment recipient", () => {
  const contract = validContract();
  contract.payment.payTo = "0x0000000000000000000000000000000000000000";
  assert.throws(() => parseContract(contract), /nonzero/);
});
