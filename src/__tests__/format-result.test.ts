import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationResult } from "../contracts.js";
import { formatVerificationResult } from "../format-result.js";

test("unknown settlement is printed before a metadata-only provider claim", () => {
  const result: VerificationResult = {
    name: "metadata-only fixture",
    passed: false,
    paymentStatus: "unknown",
    durationMs: 1,
    checks: [{ stage: "settlement", passed: false, detail: "independent verification missing" }],
    payment: {
      protocol: "x402",
      network: "base",
      price: "$0.01",
      transactionHash: "0xprovider",
    },
  };

  const lines = formatVerificationResult(result);
  const unknownIndex = lines.findIndex((line) => line.startsWith("Payment: UNKNOWN"));
  const claimIndex = lines.findIndex((line) => line.startsWith("Provider claim:"));
  assert.ok(unknownIndex >= 0);
  assert.ok(claimIndex > unknownIndex);
  assert.equal(lines.some((line) => line.startsWith("Payment: CONFIRMED")), false);
});
