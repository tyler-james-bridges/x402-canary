import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { EvidenceArtifactStore } from "./evidence/artifact-store.js";
import {
  HttpsBaseRpcTransport,
  resolveBaseRpcSources,
  type BaseRpcSourceRegistry,
} from "./evidence/base-rpc.js";
import { EvidenceJournal } from "./evidence/journal.js";
import {
  computeShadowRunManifestHash,
  deriveShadowRunIntent,
  publicShadowRunResult,
  runJournalBoundShadow,
} from "./evidence/shadow-runner.js";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

class ShadowRunCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ShadowRunCliError";
  }
}

function usage(): void {
  console.log("Usage:");
  console.log("  npm run --silent shadow:run -- hash <shadow-manifest.json>");
  console.log(
    "  npm run --silent shadow:run -- close <trust-pins.json> <shadow-manifest.json> <existing-journal.jsonl> <private-artifact-directory>",
  );
  console.log(
    "Closes evidence in shadow mode using registry-pinned read-only Base RPC only. It cannot execute, retry, sign, submit a transaction, use a wallet, or make a payment.",
  );
}

async function readJsonDocument(filePath: string): Promise<unknown> {
  const resolved = path.resolve(filePath);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw new ShadowRunCliError("SHADOW_CLI_DOCUMENT_NOT_REGULAR");
    if (before.size <= 0 || before.size > MAX_DOCUMENT_BYTES) {
      throw new ShadowRunCliError("SHADOW_CLI_DOCUMENT_SIZE_INVALID");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      Buffer.byteLength(text, "utf8") !== after.size
    ) throw new ShadowRunCliError("SHADOW_CLI_DOCUMENT_CHANGED_DURING_READ");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ShadowRunCliError("SHADOW_CLI_DOCUMENT_JSON_INVALID");
    }
  } catch (error) {
    if (error instanceof ShadowRunCliError) throw error;
    throw new ShadowRunCliError("SHADOW_CLI_DOCUMENT_READ_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function productionRequester(registry: BaseRpcSourceRegistry): HttpsBaseRpcTransport {
  const sources = resolveBaseRpcSources(
    registry,
    (environmentName) => process.env[environmentName],
  );
  return new HttpsBaseRpcTransport(sources);
}

async function closeShadow(args: readonly string[]): Promise<unknown> {
  if (args.length !== 4) throw new ShadowRunCliError("SHADOW_CLI_ARGUMENT_COUNT_INVALID");
  const [pinsPath, manifestPath, journalPath, artifactPath] = args as [
    string,
    string,
    string,
    string,
  ];
  const [pins, manifest] = await Promise.all([
    readJsonDocument(pinsPath),
    readJsonDocument(manifestPath),
  ]);
  const intent = deriveShadowRunIntent(pins, manifest);
  let journal: EvidenceJournal | undefined;
  try {
    journal = await EvidenceJournal.openExisting(journalPath);
    const artifactStore = await EvidenceArtifactStore.open(artifactPath);
    const run = await runJournalBoundShadow(intent, {
      journal,
      artifactStore,
      clock: { now: () => new Date().toISOString() },
      createBaseRequester: productionRequester,
      requiredBaseTransportAuthentication: "https_web_pki",
    });
    return publicShadowRunResult(run);
  } finally {
    await journal?.close();
  }
}

function publicErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,127}$/.test(error.code)
  ) return error.code;
  return "SHADOW_RUN_FAILED";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) throw new ShadowRunCliError("SHADOW_CLI_HELP_ARGUMENTS_INVALID");
    usage();
    return;
  }
  if (args.some((argument) => argument.startsWith("-"))) {
    throw new ShadowRunCliError("SHADOW_CLI_OPTION_NOT_ALLOWED");
  }
  const command = args[0];
  if (command === "hash") {
    if (args.length !== 2) throw new ShadowRunCliError("SHADOW_CLI_ARGUMENT_COUNT_INVALID");
    const manifestHash = computeShadowRunManifestHash(await readJsonDocument(args[1]!));
    console.log(JSON.stringify({ schemaVersion: "0.1", manifestHash }, null, 2));
    return;
  }
  if (command !== "close") throw new ShadowRunCliError("SHADOW_CLI_COMMAND_INVALID");
  const output = await closeShadow(args.slice(1));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(publicErrorCode(error));
  process.exitCode = 2;
});
