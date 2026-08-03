import path from "node:path";
import { formatVerificationResult } from "./format-result.js";
import { loadContract } from "./load-contract.js";
import { verifyPaidPath } from "./paid-path.js";

const PAID_EXECUTION_DISABLED =
  "PAID_EXECUTION_DISABLED: independent Base settlement verification, observation journaling, and replay/effect gates are not complete";

function usage(): void {
  console.log("Usage: npm run verify -- <contract.json> [--json]");
  console.log("Only the challenge and optional CORS preflight are checked; paid execution is disabled.");
}

function printText(result: Awaited<ReturnType<typeof verifyPaidPath>>): void {
  for (const line of formatVerificationResult(result)) console.log(line);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) {
    usage();
    process.exitCode = 2;
    return;
  }
  const unknown = args.filter(
    (arg) => arg.startsWith("--") && arg !== "--pay" && arg !== "--json",
  );
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown.join(", ")}`);

  const pay = args.includes("--pay");
  if (pay) throw new Error(PAID_EXECUTION_DISABLED);
  const contract = await loadContract(path.resolve(file));
  const result = await verifyPaidPath(contract, {
    pay: false,
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
