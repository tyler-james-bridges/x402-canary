import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { evaluateEvidenceKernel } from "./evidence/kernel.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function usage(): void {
  console.log("Usage: npm run --silent evidence -- <evidence-input.json>");
  console.log("Evaluates sanitized observations only; no RPC, wallet, signer, or payment path is available.");
}

async function loadInput(filePath: string): Promise<unknown> {
  const resolved = path.resolve(filePath);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error("Evidence input must be a regular file");
  if (metadata.size > MAX_INPUT_BYTES) throw new Error("Evidence input exceeds 2MB");
  const parsed: unknown = JSON.parse(await readFile(resolved, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Evidence input must be a JSON object");
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const options = args.filter((arg) => arg.startsWith("--"));
  if (options.length > 0) throw new Error(`Unknown option: ${options.join(", ")}`);
  if (args.length !== 1) {
    usage();
    process.exitCode = 2;
    return;
  }

  const bundle = evaluateEvidenceKernel(await loadInput(args[0]!));
  console.log(JSON.stringify(bundle, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
