import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithAgentCash, PAID_EXECUTION_DISABLED } from "../agentcash.js";

test("the executable AgentCash adapter fails closed before starting a payment path", async () => {
  await assert.rejects(
    fetchWithAgentCash(
      { url: "https://fixture.invalid/resource", method: "POST", body: { value: 1 } },
      {
        protocol: "x402",
        network: "base",
        scheme: "exact",
        networkId: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
        maxAmountAtomic: "10000",
        maxAmountUsd: 0.01,
      },
    ),
    (error: unknown) => error instanceof Error && error.message === PAID_EXECUTION_DISABLED,
  );
});
