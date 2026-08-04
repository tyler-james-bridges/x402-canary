import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import { EvidenceArtifactError, EvidenceArtifactStore, type ArtifactReceipt } from "../evidence/artifact-store.js";
import {
  BASE_GENESIS_BLOCK_HASH,
  BaseEvidenceCollectionError,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  collectBaseEvidence,
  deriveBaseRpcSourceRegistry,
  type BaseEvidenceCollection,
  type BaseReadRpcMethod,
  type BaseRpcRequester,
  type BaseRpcSourceRegistry,
  type BaseRpcSourceManifest,
} from "../evidence/base-rpc.js";
import {
  canonicalJson,
  deriveAuthorizationIdentity,
  deriveOperationIdentity,
} from "../evidence/canonical.js";
import {
  EffectAuthorityError,
  computeEffectAuthorityContractId,
  computeEffectAuthorityKeyId,
  deriveEffectAuthorityRegistry,
  resolveEffectQuery,
  verifyEffectAttestation,
  type EffectAuthorityContractPolicy,
  type SignedEffectAttestation,
  type VerifiedEffectAttestation,
} from "../evidence/effect-authority.js";
import {
  JournalBundleError,
  auditJournalBoundBundleRecovery,
  closeJournalBoundEvidenceBundle,
  recoverJournalBoundClosureReceipt,
  verifyJournalBoundBundleIntegrity,
  type ArtifactReference,
  type JournalBoundKernelInputV02,
} from "../evidence/journal-bundle.js";
import { EvidenceJournal, type JournalHead } from "../evidence/journal.js";
import type {
  ExactAuthorizationDescriptor,
  JsonValue,
  OperationDescriptor,
} from "../evidence/types.js";

const OPENED_AT = "2026-08-04T02:00:00.000Z";
const AUTHORIZED_AT = "2026-08-04T02:00:01.000Z";
const COLLECTED_AT = "2026-08-04T02:05:00.000Z";
const EVALUATED_AT = "2026-08-04T02:10:00.000Z";
const HASH_A = `0x${"a".repeat(64)}`;
const PENDING_TRANSACTION_HASH = `0x${"9".repeat(64)}`;
const PENDING_BLOCK_HASH = `0x${"b".repeat(64)}`;
const IMPLEMENTATION = `0x${"1".repeat(40)}`;
const FROM = `0x${"2".repeat(40)}`;
const TO = `0x${"3".repeat(40)}`;
const NONCE = `0x${"4".repeat(64)}`;
const OTHER_NONCE = `0x${"5".repeat(64)}`;
const PROXY_CODE = "0x6000";
const IMPLEMENTATION_CODE = "0x6001";
const EFFECT_ATTESTATION_DOMAIN = "x402-canary:effect-authority-attestation:v0.1";
const EFFECT_OBSERVED_AT = "2026-08-04T02:06:00.000Z";
const EFFECT_SIGNED_AT = "2026-08-04T02:06:01.000Z";
const EFFECT_VERIFIED_AT = "2026-08-04T02:06:02.000Z";
const EFFECT_CLOSED_AT = "2026-08-04T02:05:00.000Z";
const EFFECT_HASH_A = `sha256:${"6".repeat(64)}`;
const EFFECT_HASH_B = `sha256:${"7".repeat(64)}`;
const EFFECT_HASH_C = `sha256:${"8".repeat(64)}`;

const operation: OperationDescriptor = {
  url: "https://merchant.example/v1/fulfill",
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "bundle-fixture-0001",
  },
  body: { orderId: "bundle-fixture-0001" },
};

const otherOperation: OperationDescriptor = {
  ...operation,
  body: { orderId: "bundle-fixture-0002" },
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

const otherAuthorization: ExactAuthorizationDescriptor = {
  ...authorization,
  nonce: OTHER_NONCE,
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

function baseManifest(): BaseRpcSourceManifest {
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
      throw new Error(`unexpected block tag: ${String(tag)}`);
    }
    if (method === "eth_getCode") {
      const address = String(params[0]).toLowerCase();
      if (address === BASE_USDC_ASSET) return PROXY_CODE;
      if (address === IMPLEMENTATION) return IMPLEMENTATION_CODE;
      throw new Error(`unexpected code address: ${address}`);
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
      throw new Error(`unexpected eth_call: ${data}`);
    }
    if (method === "eth_getTransactionReceipt") return null;
    throw new Error(`unexpected RPC method: ${method}`);
  }
}

class PendingFinalityBaseRpc extends DeterministicBaseRpc {
  override async request(
    sourceId: string,
    method: BaseReadRpcMethod,
    params: readonly JsonValue[],
  ): Promise<unknown> {
    if (method === "eth_getTransactionReceipt") {
      return {
        transactionHash: PENDING_TRANSACTION_HASH,
        blockHash: PENDING_BLOCK_HASH,
        blockNumber: "0x79",
        status: "0x1",
        logs: [],
      };
    }
    return super.request(sourceId, method, params);
  }
}

function core(effectContractApplicable = false): JournalBoundKernelInputV02 {
  return {
    schemaVersion: "0.2",
    evaluatedAt: EVALUATED_AT,
    operation: structuredClone(operation),
    authorization: structuredClone(authorization),
    attempt: {
      authorizationCreated: true,
      preflightPassed: true,
      policyRejectedBeforeAuthorization: false,
      authorizationTransmitted: "fail",
      signingRejected: false,
      deliveryContractApplicable: false,
      delivery: "not_applicable",
      effectContractApplicable,
    },
    minimumConfirmations: 12,
  };
}

interface Harness {
  journal: EvidenceJournal;
  artifactStore: EvidenceArtifactStore;
  registry: BaseRpcSourceRegistry;
  collection: BaseEvidenceCollection;
  core: JournalBoundKernelInputV02;
  expectedHead: JournalHead;
  headAfterOpen: JournalHead;
  operationId: string;
  authorizationId: string;
}

async function createHarness(
  root: string,
  name: string,
  options: {
    effectContractApplicable?: boolean;
    journalOperationId?: string;
    journalAuthorizationId?: string;
    journalAuthorizationAt?: string;
  } = {},
): Promise<Harness> {
  const selectedCore = core(options.effectContractApplicable ?? false);
  const operationId = deriveOperationIdentity(selectedCore.operation).id;
  const authorizationId = deriveAuthorizationIdentity(selectedCore.authorization).id;
  const registry = deriveBaseRpcSourceRegistry(baseManifest());
  const collection = await collectBaseEvidence(registry, new DeterministicBaseRpc(), {
    authorization: selectedCore.authorization,
    collectedAt: COLLECTED_AT,
  });
  const journal = await EvidenceJournal.open(join(root, name, "events.jsonl"));
  const journalOperationId = options.journalOperationId ?? operationId;
  await journal.append({
    eventId: `attempt-open-${name}`,
    operationId: journalOperationId,
    kind: "attempt_opened",
    occurredAt: OPENED_AT,
  });
  const headAfterOpen = journal.head();
  await journal.append({
    eventId: `authorization-recorded-${name}`,
    operationId: journalOperationId,
    authorizationId: options.journalAuthorizationId ?? authorizationId,
    kind: "authorization_recorded",
    occurredAt: options.journalAuthorizationAt ?? AUTHORIZED_AT,
  });
  const artifactStore = await EvidenceArtifactStore.open(join(root, name, "artifacts"));
  return {
    journal,
    artifactStore,
    registry,
    collection,
    core: selectedCore,
    expectedHead: journal.head(),
    headAfterOpen,
    operationId,
    authorizationId,
  };
}

async function withHarness(
  callback: (harness: Harness) => Promise<void>,
  options: Parameters<typeof createHarness>[2] = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "x402-journal-bundle-"));
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, "primary", options);
    await callback(harness);
  } finally {
    await harness?.journal.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function closureInput(
  harness: Harness,
  overrides: Partial<Parameters<typeof closeJournalBoundEvidenceBundle>[0]> = {},
): Parameters<typeof closeJournalBoundEvidenceBundle>[0] {
  return {
    journal: harness.journal,
    artifactStore: harness.artifactStore,
    expectedHead: harness.expectedHead,
    core: harness.core,
    baseRegistry: harness.registry,
    baseCollection: harness.collection,
    verifiedEffects: [],
    ...overrides,
  };
}

function bundleError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof JournalBundleError && error.code === code;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, seen);
  }
}

function artifactReference(receipt: ArtifactReceipt): ArtifactReference {
  return {
    namespace: receipt.namespace,
    artifactHash: receipt.artifactHash,
    byteLength: receipt.byteLength,
  };
}

function artifactPath(store: EvidenceArtifactStore, hash: string): string {
  return join(store.root, `${hash.slice("sha256:".length)}.json`);
}

const effectKeys = generateKeyPairSync("ed25519");
const effectPublicKey = (
  effectKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer
).toString("base64url");
const effectKeyId = computeEffectAuthorityKeyId(effectPublicKey);

function effectPolicy(): EffectAuthorityContractPolicy {
  return {
    authorityId: "primary-sor",
    adapterId: "effect-read-adapter",
    adapterVersion: "v1.0.0",
    environment: "production",
    tenantIdHash: EFFECT_HASH_A,
    effectType: "order.fulfilled",
    payloadProjectionId: EFFECT_HASH_B,
    query: {
      kind: "operation_header",
      name: "idempotency-key",
      canonicalization: "trim_outer_ows_v1",
    },
    cardinality: {
      maximum: 1,
      enforcement: "primary_transactional_unique_constraint",
    },
    finalizationDelaySeconds: 300,
    absence: {
      kind: "transactional_closure_marker",
      markerType: "outbox-watermark",
      requiredConsistency: "linearizable",
    },
    freshness: {
      maxObservationToSignatureSeconds: 60,
      maxAttestationAgeSeconds: 600,
    },
  };
}

function verifiedEffect(
  selectedOperation: OperationDescriptor,
  operationStartedAt: string,
): VerifiedEffectAttestation {
  const policy = effectPolicy();
  const contractId = computeEffectAuthorityContractId(policy);
  const registry = deriveEffectAuthorityRegistry({
    schemaVersion: "0.1",
    authorities: [
      {
        authorityId: policy.authorityId,
        keyId: effectKeyId,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: effectPublicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        allowedContractIds: [contractId],
      },
    ],
    contracts: [{ contractId, ...policy }],
  });
  const query = resolveEffectQuery(registry, {
    contractId,
    operation: selectedOperation,
    operationStartedAt,
  });
  const payload: SignedEffectAttestation["payload"] = {
    registryHash: registry.registryHash,
    authorityId: policy.authorityId,
    contractId,
    operationId: query.operationId,
    operationStartedAt: query.operationStartedAt,
    adapterId: policy.adapterId,
    adapterVersion: policy.adapterVersion,
    environment: policy.environment,
    tenantIdHash: policy.tenantIdHash,
    queryKeyHash: query.queryKeyHash,
    effectType: policy.effectType,
    payloadProjectionId: policy.payloadProjectionId,
    observedAt: EFFECT_OBSERVED_AT,
    signedAt: EFFECT_SIGNED_AT,
    outcome: {
      kind: "zero",
      closure: {
        markerType: "outbox-watermark",
        markerHash: EFFECT_HASH_C,
        consistency: "linearizable",
        effectSetComplete: true,
        eligibleThrough: EFFECT_CLOSED_AT,
        closedAt: EFFECT_CLOSED_AT,
      },
    },
  };
  const signedBody = {
    schemaVersion: "0.1" as const,
    protected: { algorithm: "Ed25519" as const, keyId: effectKeyId },
    payload,
  };
  const attestation: SignedEffectAttestation = {
    ...signedBody,
    signature: sign(
      null,
      Buffer.from(`${EFFECT_ATTESTATION_DOMAIN}\n${canonicalJson(signedBody)}`, "utf8"),
      effectKeys.privateKey,
    ).toString("base64url"),
  };
  return verifyEffectAttestation(registry, query, attestation, EFFECT_VERIFIED_AT);
}

test("happy closure is deeply frozen, no-action, offline-verifiable, and recovery-clean", async () => {
  await withHarness(async (harness) => {
    const result = await closeJournalBoundEvidenceBundle(closureInput(harness));

    assertDeepFrozen(result);
    assert.equal(result.bundle.mode, "shadow_no_action");
    assert.deepEqual(result.bundle.assurance.execution, {
      paymentExecutionEnabled: false,
      transactionSubmissionEnabled: false,
      retryExecutionEnabled: false,
      actionExecutionEnabled: false,
    });
    assert.equal(result.bundle.assurance.externalTruthProven, false);
    assert.equal(result.bundle.assurance.persistence.externalAntiRollbackCheckpoint, false);
    assert.equal(
      result.bundle.assurance.effectAuthority.runtimeSignatureVerification,
      "not_applicable",
    );
    assert.equal(JSON.stringify(result.bundle).includes("receiptHash"), false);
    assert.deepEqual(
      harness.journal.readAll().slice(-2).map((record) => record.kind),
      ["kernel_input_committed", "kernel_bundle_committed"],
    );

    const verified = await verifyJournalBoundBundleIntegrity(
      harness.journal,
      harness.artifactStore,
      result.receipt,
    );
    assert.deepEqual(verified, result.bundle);
    assertDeepFrozen(verified);
    const recovered = await recoverJournalBoundClosureReceipt(
      harness.journal,
      harness.artifactStore,
      result.receipt.bundleCommit.sequence,
    );
    assert.deepEqual(recovered, result.receipt);
    assertDeepFrozen(recovered);
    assert.deepEqual(
      await auditJournalBoundBundleRecovery(harness.journal, harness.artifactStore),
      {
        status: "clean",
        pendingInputRecords: [],
        orphanArtifactHashes: [],
        issues: [],
        temporaryFiles: [],
      },
    );
  });
});

test("exact closure replay regenerates the same receipt after unrelated journal activity", async () => {
  await withHarness(async (harness) => {
    const first = await closeJournalBoundEvidenceBundle(closureInput(harness));
    await harness.journal.append({
      eventId: "unrelated-operation-open",
      operationId: deriveOperationIdentity(otherOperation).id,
      kind: "attempt_opened",
      occurredAt: EVALUATED_AT,
    });
    const countBeforeReplay = harness.journal.readAll().length;

    const replayed = await closeJournalBoundEvidenceBundle(closureInput(harness));
    assert.deepEqual(replayed, first);
    assert.equal(replayed.receipt.receiptHash, first.receipt.receiptHash);
    assert.equal(harness.journal.readAll().length, countBeforeReplay);
    assert.equal(
      (await auditJournalBoundBundleRecovery(harness.journal, harness.artifactStore)).status,
      "clean",
    );
  });
});

test("a cloned Base collection loses its runtime authority before any input commit", async () => {
  await withHarness(async (harness) => {
    const cloned = structuredClone(harness.collection);
    const headBefore = harness.journal.head();
    await assert.rejects(
      closeJournalBoundEvidenceBundle(
        closureInput(harness, { baseCollection: cloned }),
      ),
      (error: unknown) =>
        error instanceof BaseEvidenceCollectionError &&
        error.code === "COLLECTION_NOT_RUNTIME_VERIFIED",
    );
    assert.deepEqual(harness.journal.head(), headBefore);
    assert.equal((await harness.artifactStore.inspect()).artifacts.length, 0);
  });
});

test("a runtime-verified Base collection pending finality fails before artifacts or input commit", async () => {
  await withHarness(async (harness) => {
    const pendingCollection = await collectBaseEvidence(
      harness.registry,
      new PendingFinalityBaseRpc(),
      {
        authorization: harness.core.authorization,
        collectedAt: COLLECTED_AT,
        transactionHash: PENDING_TRANSACTION_HASH,
      },
    );
    assert.equal(pendingCollection.readiness, "pending_finality");
    assert.ok(pendingCollection.reasons.includes("RECEIPT_PENDING_FINALITY"));

    const recordsBefore = harness.journal.readAll();
    const headBefore = harness.journal.head();
    await assert.rejects(
      closeJournalBoundEvidenceBundle(
        closureInput(harness, { baseCollection: pendingCollection }),
      ),
      bundleError("BASE_COLLECTION_NOT_KERNEL_READY"),
    );

    assert.deepEqual(harness.journal.readAll(), recordsBefore);
    assert.deepEqual(harness.journal.head(), headBefore);
    assert.equal(
      harness.journal
        .readAll()
        .some(
          (record) =>
            record.kind === "kernel_input_committed" ||
            record.kind === "kernel_bundle_committed",
        ),
      false,
    );
    assert.deepEqual(await harness.artifactStore.inspect(), {
      artifacts: [],
      temporaryFiles: [],
      unexpectedFiles: [],
      errors: [],
    });
  });
});

test("stale and foreign source heads fail before an input commit", async () => {
  await withHarness(async (harness) => {
    await assert.rejects(
      closeJournalBoundEvidenceBundle(
        closureInput(harness, { expectedHead: harness.headAfterOpen }),
      ),
      bundleError("SOURCE_JOURNAL_HEAD_MISMATCH"),
    );

    const foreign = await EvidenceJournal.open(join(harness.artifactStore.root, "foreign.jsonl"));
    const foreignHead = foreign.head();
    await foreign.close();
    await assert.rejects(
      closeJournalBoundEvidenceBundle(
        closureInput(harness, { expectedHead: foreignHead }),
      ),
      bundleError("SOURCE_JOURNAL_HEAD_MISMATCH"),
    );
    assert.equal(harness.journal.readAll().some((record) => record.kind === "kernel_input_committed"), false);
  });
});

test("journal operation and authorization mismatches fail closed", async () => {
  const wrongOperationId = deriveOperationIdentity(otherOperation).id;
  await withHarness(
    async (harness) => {
      await assert.rejects(
        closeJournalBoundEvidenceBundle(closureInput(harness)),
        bundleError("ATTEMPT_OPEN_RECORD_COUNT_INVALID"),
      );
      assert.equal(harness.journal.readAll().length, 2);
    },
    { journalOperationId: wrongOperationId },
  );

  const wrongAuthorizationId = deriveAuthorizationIdentity(otherAuthorization).id;
  await withHarness(
    async (harness) => {
      await assert.rejects(
        closeJournalBoundEvidenceBundle(closureInput(harness)),
        bundleError("ATTEMPT_AUTHORIZATION_ID_CONFLICT"),
      );
      assert.equal(harness.journal.readAll().length, 2);
    },
    { journalAuthorizationId: wrongAuthorizationId },
  );

  await withHarness(
    async (harness) => {
      await assert.rejects(
        closeJournalBoundEvidenceBundle(closureInput(harness)),
        bundleError("ATTEMPT_AUTHORIZATION_EVENT_ORDER_OR_TIME_INVALID"),
      );
      assert.equal(harness.journal.readAll().length, 2);
    },
    { journalAuthorizationAt: "2026-08-04T02:11:00.000Z" },
  );
});

test("offline verification rejects missing and tampered referenced artifacts", async () => {
  await withHarness(async (harness) => {
    const result = await closeJournalBoundEvidenceBundle(closureInput(harness));
    await unlink(artifactPath(harness.artifactStore, result.receipt.bundle.artifactHash));
    await assert.rejects(
      verifyJournalBoundBundleIntegrity(
        harness.journal,
        harness.artifactStore,
        result.receipt,
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT",
    );
  });

  await withHarness(async (harness) => {
    const result = await closeJournalBoundEvidenceBundle(closureInput(harness));
    const manifest = (await harness.artifactStore.getByReference(
      result.receipt.inputManifest,
    )) as unknown as { artifacts: { evaluatorInput: ArtifactReference } };
    await writeFile(
      artifactPath(harness.artifactStore, manifest.artifacts.evaluatorInput.artifactHash),
      "{}\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      verifyJournalBoundBundleIntegrity(
        harness.journal,
        harness.artifactStore,
        result.receipt,
      ),
      (error: unknown) =>
        error instanceof EvidenceArtifactError && error.code === "ARTIFACT_SHAPE_INVALID",
    );
  });
});

test("a closure receipt cannot be substituted across journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-journal-substitution-"));
  let first: Harness | undefined;
  let second: Harness | undefined;
  try {
    first = await createHarness(root, "first");
    second = await createHarness(root, "second");
    const firstResult = await closeJournalBoundEvidenceBundle(closureInput(first));
    await closeJournalBoundEvidenceBundle(closureInput(second));

    await assert.rejects(
      verifyJournalBoundBundleIntegrity(
        second.journal,
        second.artifactStore,
        firstResult.receipt,
      ),
      bundleError("CLOSURE_JOURNAL_MISMATCH"),
    );
  } finally {
    await first?.journal.close().catch(() => undefined);
    await second?.journal.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery audit reports a pending input and an otherwise valid orphan", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-journal-recovery-"));
  let journal: EvidenceJournal | undefined;
  try {
    journal = await EvidenceJournal.open(join(root, "events.jsonl"));
    const store = await EvidenceArtifactStore.open(join(root, "artifacts"));
    const operationId = deriveOperationIdentity(operation).id;
    const authorizationId = deriveAuthorizationIdentity(authorization).id;
    await journal.append({
      eventId: "pending-open",
      operationId,
      kind: "attempt_opened",
      occurredAt: OPENED_AT,
    });
    const sourceHead = journal.head();
    const attempt = await store.put("operation-attempt", { fixture: "attempt" });
    const base = await store.put("base-collection", { fixture: "base" });
    const evaluator = await store.put("kernel-evaluator-input", { fixture: "evaluator" });
    const manifest = await store.put("kernel-input-manifest", {
      schemaVersion: "0.2",
      kind: "kernel_input_manifest",
      operationId,
      authorizationId,
      attemptOpenedAt: OPENED_AT,
      sourceHead,
      artifacts: {
        attempt: artifactReference(attempt),
        base: artifactReference(base),
        effects: [],
        evaluatorInput: artifactReference(evaluator),
      },
    });
    const orphan = await store.put("orphan-fixture", { fixture: "unreferenced" });
    const input = await journal.append({
      eventId: "pending-input",
      operationId,
      authorizationId,
      kind: "kernel_input_committed",
      occurredAt: EVALUATED_AT,
      evidence: { inputManifestArtifactHash: manifest.artifactHash },
    });

    assert.deepEqual(await auditJournalBoundBundleRecovery(journal, store), {
      status: "incomplete",
      pendingInputRecords: [input.sequence],
      orphanArtifactHashes: [orphan.artifactHash],
      issues: [],
      temporaryFiles: [],
    });
  } finally {
    await journal?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("real signed effect authority is accepted while clones and start-time mismatches fail", async () => {
  await withHarness(
    async (harness) => {
      const verified = verifiedEffect(harness.core.operation, OPENED_AT);
      const result = await closeJournalBoundEvidenceBundle(
        closureInput(harness, { verifiedEffects: [verified] }),
      );
    assert.equal(
      result.bundle.assurance.effectAuthority.runtimeSignatureVerification,
      "verified",
    );
      assert.equal(result.bundle.evaluation.effect.status, "absent");
      assert.deepEqual(
        await verifyJournalBoundBundleIntegrity(
          harness.journal,
          harness.artifactStore,
          result.receipt,
        ),
        result.bundle,
      );
    },
    { effectContractApplicable: true },
  );

  await withHarness(
    async (harness) => {
      const cloned = structuredClone(verifiedEffect(harness.core.operation, OPENED_AT));
      const head = harness.journal.head();
      await assert.rejects(
        closeJournalBoundEvidenceBundle(
          closureInput(harness, { verifiedEffects: [cloned] }),
        ),
        (error: unknown) =>
          error instanceof EffectAuthorityError && error.code === "ATTESTATION_NOT_VERIFIED",
      );
      assert.deepEqual(harness.journal.head(), head);
    },
    { effectContractApplicable: true },
  );

  await withHarness(
    async (harness) => {
      const wrongStart = verifiedEffect(
        harness.core.operation,
        "2026-08-04T01:59:00.000Z",
      );
      const head = harness.journal.head();
      await assert.rejects(
        closeJournalBoundEvidenceBundle(
          closureInput(harness, { verifiedEffects: [wrongStart] }),
        ),
        bundleError("EFFECT_OPERATION_START_NOT_JOURNAL_BOUND"),
      );
      assert.deepEqual(harness.journal.head(), head);
    },
    { effectContractApplicable: true },
  );
});
