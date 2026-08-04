import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  HttpsBaseRpcTransport,
  collectBaseEvidence,
  deriveBaseRpcSourceRegistry,
  resolveBaseRpcSources,
  type BaseEvidenceCollectionRequest,
} from "./evidence/base-rpc.js";

const MAX_INPUT_BYTES = 128 * 1024;

function usage(): void {
  console.log(
    "Usage: npm run --silent base:collect -- <source-registry.json> <collection-request.json>",
  );
  console.log(
    "Performs registry-pinned HTTPS Base reads only; no wallet, signer, transaction submission, or payment path is available.",
  );
}

async function loadJson(filePath: string, label: string): Promise<unknown> {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`);
  }
  if (metadata.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds 128KB`);
  const parsed: unknown = JSON.parse(await readFile(resolved, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const options = args.filter((argument) => argument.startsWith("--"));
  if (options.length > 0) throw new Error(`Unknown option: ${options.join(", ")}`);
  if (args.length !== 2) {
    usage();
    process.exitCode = 2;
    return;
  }

  const registry = deriveBaseRpcSourceRegistry(await loadJson(args[0]!, "Source registry"));
  const request = (await loadJson(args[1]!, "Collection request")) as BaseEvidenceCollectionRequest;
  const sources = resolveBaseRpcSources(registry, (environmentName) => process.env[environmentName]);
  const transport = new HttpsBaseRpcTransport(sources);
  const collection = await collectBaseEvidence(registry, transport, request);
  console.log(JSON.stringify(collection, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
