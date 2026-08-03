import type { VerificationResult } from "./contracts.js";

export function formatVerificationResult(result: VerificationResult): string[] {
  const lines = result.checks.map(
    (check) => `[${check.passed ? "PASS" : "FAIL"}] ${check.stage}: ${check.detail}`,
  );

  if (result.paymentStatus === "unknown") {
    lines.push(
      "Payment: UNKNOWN; do not issue a new authorization until settlement and business-effect evidence are reconciled",
    );
  } else if (result.paymentStatus === "attempted") {
    lines.push("Payment: ATTEMPTED, no independent settlement was confirmed");
  } else if (result.paymentStatus === "confirmed") {
    lines.push("Payment: CONFIRMED by independent settlement verification");
  }

  if (result.payment) {
    const reference = result.payment.transactionHash ?? result.payment.channelId ?? "reference reported";
    lines.push(
      `Provider claim: ${result.payment.price} via ${result.payment.protocol} on ${result.payment.network} (${reference})`,
    );
  }

  lines.push(`${result.passed ? "PASS" : "FAIL"}: ${result.name} (${result.durationMs}ms)`);
  return lines;
}
