import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveEffectAuthorityRegistry,
  effectObservationsFromVerifiedAttestation,
  resolveEffectQuery,
  verifyEffectAttestation,
} from "./evidence/effect-authority.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 256 * 1024;
const REQUEST_FIELDS = new Set(["query", "verifiedAt"]);

function usage(): void {
  console.log(
    "Usage: npm run --silent effect:verify -- <expected-registry-hash> <registry.json> <verification-request.json> <signed-attestation.json>",
  );
  console.log(
    "Verifies local Ed25519 effect evidence only; no network, database write, retry, wallet, signer, transaction, or payment path is available.",
  );
}

async function loadJson(filePath: string, label: string): Promise<unknown> {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`);
  }
  if (metadata.size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds 256KB`);
  const parsed: unknown = JSON.parse(await readFile(resolved, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function verificationRequest(input: unknown): { query: unknown; verifiedAt: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Verification request must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(field)) throw new Error("Verification request contains an unexpected field");
  }
  for (const field of REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error("Verification request is missing a required field");
    }
  }
  if (typeof value.verifiedAt !== "string") {
    throw new Error("Verification request verifiedAt must be a string");
  }
  return { query: value.query, verifiedAt: value.verifiedAt };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const options = args.filter((argument) => argument.startsWith("--"));
  if (options.length > 0) throw new Error(`Unknown option: ${options.join(", ")}`);
  if (args.length !== 4) {
    usage();
    process.exitCode = 2;
    return;
  }
  const [expectedRegistryHash, registryPath, requestPath, attestationPath] = args as [
    string,
    string,
    string,
    string,
  ];
  if (!SHA256.test(expectedRegistryHash)) throw new Error("Expected registry hash is invalid");

  const registry = deriveEffectAuthorityRegistry(await loadJson(registryPath, "Authority registry"));
  if (registry.registryHash !== expectedRegistryHash) {
    throw new Error("Authority registry does not match the out-of-band expected hash");
  }
  const request = verificationRequest(await loadJson(requestPath, "Verification request"));
  const query = resolveEffectQuery(registry, request.query);
  const verified = verifyEffectAttestation(
    registry,
    query,
    await loadJson(attestationPath, "Signed attestation"),
    request.verifiedAt,
  );
  console.log(
    JSON.stringify(
      {
        verified,
        effectObservations: effectObservationsFromVerifiedAttestation(verified),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
