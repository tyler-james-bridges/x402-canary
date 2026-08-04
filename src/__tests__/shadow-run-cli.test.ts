import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import { EvidenceArtifactStore } from "../evidence/artifact-store.js";
import {
  BASE_GENESIS_BLOCK_HASH,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  deriveBaseRpcSourceRegistry,
  type BaseReadRpcMethod,
  type BaseRpcRequester,
  type BaseRpcSourceManifest,
} from "../evidence/base-rpc.js";
import {
  deriveAuthorizationIdentity,
  deriveOperationIdentity,
} from "../evidence/canonical.js";
import { EvidenceJournal } from "../evidence/journal.js";
import {
  computeShadowRunManifestHash,
  deriveShadowRunIntent,
  runJournalBoundShadow,
  type ShadowRunManifestV01,
  type ShadowRunTrustPinsV01,
} from "../evidence/shadow-runner.js";
import type { ExactAuthorizationDescriptor, JsonValue, OperationDescriptor } from "../evidence/types.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OPENED_AT = "2026-08-04T02:00:00.000Z";
const RECORDED_AT = "2026-08-04T02:00:01.000Z";
const RUN_AT = "2026-08-04T02:10:00.000Z";
const HASH_A = `0x${"a".repeat(64)}`;
const IMPLEMENTATION = `0x${"1".repeat(40)}`;
const FROM = `0x${"2".repeat(40)}`;
const TO = `0x${"3".repeat(40)}`;
const NONCE = `0x${"4".repeat(64)}`;
const PROXY_CODE = "0x6000";
const IMPLEMENTATION_CODE = "0x6001";

const operation: OperationDescriptor = {
  url: "https://merchant.example/v1/fulfill",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "shadow-cli-fixture",
  },
  body: { orderId: "shadow-cli-fixture" },
};

const authorization: ExactAuthorizationDescriptor = {
  networkId: BASE_MAINNET_NETWORK,
  asset: BASE_USDC_ASSET,
  from: FROM,
  to: TO,
  valueAtomic: "1000000",
  validAfter: "1",
  validBefore: "100",
  nonce: NONCE,
};

function codeHash(code: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex")}`;
}

function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8").toString("hex");
  const paddedLength = Math.ceil(bytes.length / 64) * 64;
  return `0x${word(32).slice(2)}${word(Buffer.byteLength(value)).slice(2)}${bytes.padEnd(paddedLength, "0")}`;
}

function baseRegistry(): BaseRpcSourceManifest {
  return {
    schemaVersion: "0.1",
    networkId: BASE_MAINNET_NETWORK,
    genesisBlockHash: BASE_GENESIS_BLOCK_HASH,
    sources: [
      {
        id: "alpha",
        trustDomain: "provider-a.example",
        expectedOrigin: "https://rpc-a.example",
        endpointEnv: "BASE_RPC_ALPHA_URL",
      },
      {
        id: "bravo",
        trustDomain: "provider-b.example",
        expectedOrigin: "https://rpc-b.example",
        endpointEnv: "BASE_RPC_BRAVO_URL",
      },
    ],
    nativeUsdc: {
      asset: BASE_USDC_ASSET,
      proxyImplementationSlot: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      allowedProxyCodeSha256: [codeHash(PROXY_CODE)],
      allowedImplementationCodeSha256: [codeHash(IMPLEMENTATION_CODE)],
      expectedName: "USD Coin",
      expectedVersion: "2",
      expectedDecimals: 6,
    },
  };
}

function manifest(): ShadowRunManifestV01 {
  return {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run",
    mode: "shadow_no_action",
    baseRegistry: baseRegistry(),
    operation: structuredClone(operation),
    authorization: structuredClone(authorization),
    transactionHash: null,
    declaredAttempt: {
      preflightPassed: true,
      policyRejectedBeforeAuthorization: false,
      signingRejected: false,
      deliveryContractApplicable: false,
      delivery: "not_applicable",
    },
    minimumConfirmations: 12,
    effects: { mode: "not_applicable" },
  };
}

function pinsFor(
  selectedManifest: ShadowRunManifestV01,
  overrides: Partial<ShadowRunTrustPinsV01["journal"]> = {},
): ShadowRunTrustPinsV01 {
  const operationId = deriveOperationIdentity(selectedManifest.operation).id;
  const authorizationId = deriveAuthorizationIdentity(selectedManifest.authorization).id;
  return {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run_pins",
    manifestHash: computeShadowRunManifestHash(selectedManifest),
    journal: {
      expectedHead: {
        journalId: `sha256:${"5".repeat(64)}`,
        sequence: 2,
        recordHash: `sha256:${"6".repeat(64)}`,
      },
      attemptOpenedRecordHash: `sha256:${"7".repeat(64)}`,
      operationId,
      authorizationId,
      ...overrides,
    },
    baseRegistryHash: deriveBaseRpcSourceRegistry(selectedManifest.baseRegistry).registryHash,
    effects: [],
  };
}

class DeterministicBaseRpc implements BaseRpcRequester {
  async request(
    _sourceId: string,
    method: BaseReadRpcMethod,
    params: readonly JsonValue[],
  ): Promise<unknown> {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      if (tag === "0x0") {
        return { number: "0x0", hash: BASE_GENESIS_BLOCK_HASH, timestamp: "0x0" };
      }
      if (tag === "finalized" || tag === "0x78") {
        return { number: "0x78", hash: HASH_A, timestamp: "0xc8" };
      }
      throw new Error("unexpected block tag");
    }
    if (method === "eth_getCode") {
      const address = String(params[0]).toLowerCase();
      if (address === BASE_USDC_ASSET) return PROXY_CODE;
      if (address === IMPLEMENTATION) return IMPLEMENTATION_CODE;
      throw new Error("unexpected code address");
    }
    if (method === "eth_getStorageAt") {
      return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`;
    }
    if (method === "eth_call") {
      const call = params[0] as Record<string, unknown>;
      const data = String(call.data);
      if (data === "0x06fdde03") return abiString("USD Coin");
      if (data === "0x54fd4d50") return abiString("2");
      if (data === "0x313ce567") return word(6);
      if (data.startsWith("0xe94a0102")) return word(0);
      throw new Error("unexpected eth_call");
    }
    if (method === "eth_getTransactionReceipt") return null;
    throw new Error("unexpected RPC method");
  }
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/shadow-run-cli.ts", ...args],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      timeout: 15_000,
    },
  );
}

async function withTempRoot(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "x402-shadow-cli-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI help is explicit and manifest hashing is deterministic", async () => {
  const help = runCli("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /shadow:run -- hash/);
  assert.match(help.stdout, /registry-pinned read-only Base RPC only/);
  assert.match(help.stdout, /cannot execute, retry, sign, submit a transaction, use a wallet, or make a payment/);

  await withTempRoot(async (root) => {
    const selectedManifest = manifest();
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(selectedManifest), { mode: 0o600 });
    const hashed = runCli("hash", manifestPath);
    assert.equal(hashed.status, 0, hashed.stderr);
    assert.equal(hashed.stderr, "");
    assert.deepEqual(JSON.parse(hashed.stdout), {
      schemaVersion: "0.1",
      manifestHash: computeShadowRunManifestHash(selectedManifest),
    });
  });
});

test("CLI rejects dangerous options, unknown options, and unknown commands", () => {
  for (const option of [
    "--pay",
    "--retry",
    "--wallet",
    "--sign",
    "--send",
    "--rpc",
    "--url",
    "--execute",
    "--output",
    "-x",
  ]) {
    const result = runCli(option);
    assert.equal(result.status, 2, option);
    assert.equal(result.stdout, "", option);
    assert.equal(result.stderr, "SHADOW_CLI_OPTION_NOT_ALLOWED\n", option);
  }

  const unknown = runCli("launch");
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, "SHADOW_CLI_COMMAND_INVALID\n");

  const badHelp = runCli("--help", "extra");
  assert.equal(badHelp.status, 2);
  assert.equal(badHelp.stdout, "");
  assert.equal(badHelp.stderr, "SHADOW_CLI_HELP_ARGUMENTS_INVALID\n");
});

test("malformed, symlinked, and oversized documents fail with redacted stable errors", async () => {
  await withTempRoot(async (root) => {
    const secretMarker = "DO_NOT_ECHO_DOCUMENT_PATH_SECRET";
    const malformedPath = join(root, `${secretMarker}-malformed.json`);
    await writeFile(malformedPath, `{ "secret": "${secretMarker}"`, { mode: 0o600 });
    const malformed = runCli("hash", malformedPath);
    assert.equal(malformed.status, 2);
    assert.equal(malformed.stdout, "");
    assert.equal(malformed.stderr, "SHADOW_CLI_DOCUMENT_JSON_INVALID\n");
    assert.equal(malformed.stderr.includes(secretMarker), false);

    const targetPath = join(root, "target.json");
    const linkedPath = join(root, `${secretMarker}-linked.json`);
    await writeFile(targetPath, JSON.stringify(manifest()), { mode: 0o600 });
    await symlink(targetPath, linkedPath, "file");
    const linked = runCli("hash", linkedPath);
    assert.equal(linked.status, 2);
    assert.equal(linked.stdout, "");
    assert.equal(linked.stderr, "SHADOW_CLI_DOCUMENT_READ_FAILED\n");
    assert.equal(linked.stderr.includes(secretMarker), false);

    const oversizedPath = join(root, `${secretMarker}-oversized.json`);
    await writeFile(oversizedPath, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
    const oversized = runCli("hash", oversizedPath);
    assert.equal(oversized.status, 2);
    assert.equal(oversized.stdout, "");
    assert.equal(oversized.stderr, "SHADOW_CLI_DOCUMENT_SIZE_INVALID\n");
    assert.equal(oversized.stderr.includes(secretMarker), false);
  });
});

test("close requires an existing journal and creates no missing storage paths", async () => {
  await withTempRoot(async (root) => {
    const selectedManifest = manifest();
    const pins = pinsFor(selectedManifest);
    const pinsPath = join(root, "pins.json");
    const manifestPath = join(root, "manifest.json");
    const missingParent = join(root, "must-not-exist");
    const missingJournal = join(missingParent, "events.jsonl");
    const artifactPath = join(root, "must-not-create-artifacts");
    await Promise.all([
      writeFile(pinsPath, JSON.stringify(pins), { mode: 0o600 }),
      writeFile(manifestPath, JSON.stringify(selectedManifest), { mode: 0o600 }),
    ]);

    const result = runCli("close", pinsPath, manifestPath, missingJournal, artifactPath);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "ENOENT\n");
    await assert.rejects(stat(missingParent));
    await assert.rejects(stat(missingJournal));
    await assert.rejects(stat(`${missingJournal}.meta.json`));
    await assert.rejects(stat(`${missingJournal}.lock`));
    await assert.rejects(stat(artifactPath));
  });
});

test("production CLI refuses offline replay of a test-injected Base closure", async () => {
  await withTempRoot(async (root) => {
    const selectedManifest = manifest();
    const journalPath = join(root, "private", "events.jsonl");
    const artifactPath = join(root, "private", "artifacts");
    const journal = await EvidenceJournal.open(journalPath);
    const operationId = deriveOperationIdentity(selectedManifest.operation).id;
    const authorizationId = deriveAuthorizationIdentity(selectedManifest.authorization).id;
    const opened = await journal.append({
      eventId: "shadow-cli-attempt-open",
      operationId,
      kind: "attempt_opened",
      occurredAt: OPENED_AT,
    });
    await journal.append({
      eventId: "shadow-cli-authorization-recorded",
      operationId,
      authorizationId,
      kind: "authorization_recorded",
      occurredAt: RECORDED_AT,
    });
    const expectedHead = journal.head();
    const pins = pinsFor(selectedManifest, {
      expectedHead,
      attemptOpenedRecordHash: opened.recordHash,
      operationId,
      authorizationId,
    });
    const intent = deriveShadowRunIntent(pins, selectedManifest);
    const artifactStore = await EvidenceArtifactStore.open(artifactPath);
    await runJournalBoundShadow(intent, {
      journal,
      artifactStore,
      clock: { now: () => RUN_AT },
      createBaseRequester: () => new DeterministicBaseRpc(),
      requiredBaseTransportAuthentication: "test_injected",
    });
    await journal.close();

    const pinsPath = join(root, "pins.json");
    const manifestPath = join(root, "manifest.json");
    await Promise.all([
      writeFile(pinsPath, JSON.stringify(pins), { mode: 0o600 }),
      writeFile(manifestPath, JSON.stringify(selectedManifest), { mode: 0o600 }),
    ]);
    const replay = runCli("close", pinsPath, manifestPath, journalPath, artifactPath);
    assert.equal(replay.status, 2);
    assert.equal(replay.stdout, "");
    assert.equal(replay.stderr, "SHADOW_BASE_TRANSPORT_ASSURANCE_MISMATCH\n");
  });
});

test("production source is HTTPS registry-resolved and imports no action capability", () => {
  const cliSource = readFileSync(
    new URL("../shadow-run-cli.ts", import.meta.url),
    "utf8",
  );
  const runnerSource = readFileSync(
    new URL("../evidence/shadow-runner.ts", import.meta.url),
    "utf8",
  );
  const source = `${cliSource}\n${runnerSource}`;

  assert.match(cliSource, /HttpsBaseRpcTransport/);
  assert.match(cliSource, /resolveBaseRpcSources/);
  assert.match(cliSource, /requiredBaseTransportAuthentication:\s*"https_web_pki"/);
  assert.doesNotMatch(cliSource, /requiredBaseTransportAuthentication:\s*"test_injected"/);
  assert.doesNotMatch(cliSource, /\bfetch\s*\(/);
  assert.doesNotMatch(cliSource, /node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:agentcash|paid-path|payment-proxy|verify\.js|x402-challenge)[^"']*["']/,
  );
  assert.doesNotMatch(source, /eth_sendRawTransaction|eth_sendTransaction|personal_sign|eth_sign/);
});
