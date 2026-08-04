import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
} from "../evidence/base-settlement.js";
import {
  canonicalJson,
  deriveAuthorizationIdentity,
  deriveOperationIdentity,
} from "../evidence/canonical.js";
import {
  EffectAuthorityError,
  computeEffectAttestationHash,
  computeEffectAuthorityContractId,
  computeEffectAuthorityKeyId,
  deriveEffectAuthorityRegistry,
  resolveEffectQuery,
  type EffectAttestationOutcome,
  type EffectAuthorityContractPolicy,
  type EffectAuthorityRegistryManifest,
  type SignedEffectAttestation,
} from "../evidence/effect-authority.js";
import {
  auditJournalBoundBundleRecovery,
  verifyJournalBoundBundleIntegrity,
} from "../evidence/journal-bundle.js";
import { EvidenceJournal } from "../evidence/journal.js";
import {
  ShadowRunError,
  computeShadowRunManifestHash,
  deriveShadowRunIntent,
  publicShadowRunResult,
  runJournalBoundShadow,
  type DerivedShadowRunIntentV01,
  type JournalBoundShadowRunDependencies,
  type JournalBoundShadowRunResult,
  type ShadowRunEffectPinV01,
  type ShadowRunManifestV01,
  type ShadowRunTrustPinsV01,
} from "../evidence/shadow-runner.js";
import type {
  ExactAuthorizationDescriptor,
  JsonValue,
  OperationDescriptor,
} from "../evidence/types.js";

const OPENED_AT = "2026-08-04T02:00:00.000Z";
const RECORDED_AT = "2026-08-04T02:00:01.000Z";
const TRANSMITTED_AT = "2026-08-04T02:00:02.000Z";
const COMMITTED_AT = "2026-08-04T02:01:00.000Z";
const FINAL_AFTER = "2026-08-04T02:05:00.000Z";
const FINALIZED_AT = "2026-08-04T02:05:30.000Z";
const OBSERVED_AT = "2026-08-04T02:06:00.000Z";
const SIGNED_AT = "2026-08-04T02:06:01.000Z";
const RUN_AT = "2026-08-04T02:06:02.000Z";

const FINALIZED_BLOCK = 120;
const RECEIPT_BLOCK = 110;
const BEYOND_ANCHOR_BLOCK = 121;
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;
const EFFECT_HASH_A = `sha256:${"1".repeat(64)}`;
const EFFECT_HASH_B = `sha256:${"2".repeat(64)}`;
const EFFECT_HASH_C = `sha256:${"3".repeat(64)}`;
const EFFECT_HASH_D = `sha256:${"4".repeat(64)}`;
const IMPLEMENTATION = `0x${"1".repeat(40)}`;
const FROM = `0x${"2".repeat(40)}`;
const TO = `0x${"3".repeat(40)}`;
const NONCE = `0x${"4".repeat(64)}`;
const PROXY_CODE = "0x6000";
const IMPLEMENTATION_CODE = "0x6001";
const TRANSACTION_HASH = HASH_B;
const MALICIOUS_OPERATION_URL = "https://169.254.169.254/latest/meta-data";
const IDEMPOTENCY_KEY = "shadow-fixture-0001";

const EFFECT_SIGNATURE_DOMAIN = "x402-canary:effect-authority-attestation:v0.1";
const EFFECT_ENVELOPE_DOMAIN = "x402-canary:effect-authority-envelope:v0.1";
const SHADOW_MANIFEST_DOMAIN = "x402-canary:shadow-run-manifest:v0.1";
const FIXED_ED25519_SEED = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);
const FIXED_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    FIXED_ED25519_SEED,
  ]),
  format: "der",
  type: "pkcs8",
});
const FIXED_PUBLIC_KEY = createPublicKey(FIXED_PRIVATE_KEY);
const FIXED_PUBLIC_KEY_SPKI = (
  FIXED_PUBLIC_KEY.export({ format: "der", type: "spki" }) as Buffer
).toString("base64url");
const FIXED_KEY_ID = computeEffectAuthorityKeyId(FIXED_PUBLIC_KEY_SPKI);

const operation: OperationDescriptor = {
  url: MALICIOUS_OPERATION_URL,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": IDEMPOTENCY_KEY,
  },
  body: { orderId: "shadow-fixture-0001" },
};

const authorization: ExactAuthorizationDescriptor = {
  networkId: BASE_MAINNET_NETWORK,
  asset: BASE_USDC_ASSET,
  from: FROM,
  to: TO,
  valueAtomic: "1000000",
  validAfter: String(Math.floor(Date.parse(OPENED_AT) / 1_000) - 60),
  validBefore: String(Math.floor(Date.parse(FINAL_AFTER) / 1_000)),
  nonce: NONCE,
};

function canonicalHash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

function codeHash(code: string): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(code.slice(2), "hex"))
    .digest("hex")}`;
}

function quantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8").toString("hex");
  const paddedLength = Math.ceil(bytes.length / 64) * 64;
  return `0x${word(32).slice(2)}${word(Buffer.byteLength(value)).slice(2)}${bytes.padEnd(paddedLength, "0")}`;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
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

type BaseScenario =
  | "confirmed"
  | "absent"
  | "contradiction"
  | "duplicate"
  | "beyond_anchor";

class ScenarioBaseRpc implements BaseRpcRequester {
  readonly calls: Array<{
    sourceId: string;
    method: BaseReadRpcMethod;
    params: readonly JsonValue[];
  }> = [];

  constructor(readonly scenario: BaseScenario) {}

  async request(
    sourceId: string,
    method: BaseReadRpcMethod,
    params: readonly JsonValue[],
  ): Promise<unknown> {
    this.calls.push({ sourceId, method, params: structuredClone(params) });
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      if (tag === "0x0") {
        return { number: "0x0", hash: BASE_GENESIS_BLOCK_HASH, timestamp: "0x0" };
      }
      if (tag === "finalized" || tag === quantity(FINALIZED_BLOCK)) {
        return {
          number: quantity(FINALIZED_BLOCK),
          hash: HASH_A,
          timestamp: quantity(Math.floor(Date.parse(FINALIZED_AT) / 1_000)),
        };
      }
      if (tag === quantity(RECEIPT_BLOCK)) {
        return {
          number: quantity(RECEIPT_BLOCK),
          hash: HASH_C,
          timestamp: quantity(Math.floor(Date.parse(COMMITTED_AT) / 1_000)),
        };
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
      if (data.startsWith("0xe94a0102")) {
        return word(
          this.scenario === "absent" ||
            this.scenario === "contradiction" ||
            this.scenario === "beyond_anchor"
            ? 0
            : 1,
        );
      }
      throw new Error(`unexpected eth_call: ${data}`);
    }
    if (method === "eth_getTransactionReceipt") {
      if (this.scenario === "absent") return null;
      return rawReceipt(
        this.scenario === "beyond_anchor" ? BEYOND_ANCHOR_BLOCK : RECEIPT_BLOCK,
        this.scenario === "duplicate",
      );
    }
    throw new Error(`unexpected RPC method: ${method}`);
  }
}

function rawReceipt(blockNumber: number, duplicate: boolean): Record<string, unknown> {
  const logs: Record<string, unknown>[] = [
    {
      address: BASE_USDC_ASSET,
      topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(FROM), NONCE],
      data: "0x",
      logIndex: "0x0",
      transactionHash: TRANSACTION_HASH,
      removed: false,
    },
    {
      address: BASE_USDC_ASSET,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(FROM), addressTopic(TO)],
      data: word(1_000_000),
      logIndex: "0x1",
      transactionHash: TRANSACTION_HASH,
      removed: false,
    },
  ];
  if (duplicate) {
    logs.push({ ...structuredClone(logs[1]!), logIndex: "0x2" });
  }
  return {
    transactionHash: TRANSACTION_HASH,
    blockHash: HASH_C,
    blockNumber: quantity(blockNumber),
    status: "0x1",
    logs,
  };
}

function effectPolicy(): EffectAuthorityContractPolicy {
  return {
    authorityId: "primary-sor",
    adapterId: "shadow-read-adapter",
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

type EffectScenario = "committed" | "absent" | "unknown" | "duplicate" | "contradiction";

interface EffectMaterial {
  proofs: Array<{
    registry: EffectAuthorityRegistryManifest;
    contractId: string;
    attestation: SignedEffectAttestation;
  }>;
  pins: ShadowRunEffectPinV01[];
}

function effectMaterial(
  scenario: EffectScenario,
  options: { corruptSignature?: boolean } = {},
): EffectMaterial {
  const policy = effectPolicy();
  const contractId = computeEffectAuthorityContractId(policy);
  const registryManifest: EffectAuthorityRegistryManifest = {
    schemaVersion: "0.1",
    authorities: [
      {
        authorityId: policy.authorityId,
        keyId: FIXED_KEY_ID,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: FIXED_PUBLIC_KEY_SPKI,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        allowedContractIds: [contractId],
      },
    ],
    contracts: [{ contractId, ...policy }],
  };
  const registry = deriveEffectAuthorityRegistry(registryManifest);
  const query = resolveEffectQuery(registry, {
    contractId,
    operation,
    operationStartedAt: OPENED_AT,
  });
  assert.equal(query.finalAfter, FINAL_AFTER);

  const committed = (payloadHash = EFFECT_HASH_B): EffectAttestationOutcome => ({
    kind: "one",
    effect: {
      effectIdHash: EFFECT_HASH_C,
      payloadHash,
      committedAt: COMMITTED_AT,
    },
  });
  const outcomes: EffectAttestationOutcome[] =
    scenario === "committed"
      ? [committed()]
      : scenario === "absent"
        ? [
            {
              kind: "zero",
              closure: {
                markerType: "outbox-watermark",
                markerHash: EFFECT_HASH_D,
                consistency: "linearizable",
                effectSetComplete: true,
                eligibleThrough: FINAL_AFTER,
                closedAt: FINAL_AFTER,
              },
            },
          ]
        : scenario === "unknown"
          ? [{ kind: "unknown", reason: "adapter_error" }]
          : scenario === "duplicate"
            ? [
                {
                  kind: "multiple",
                  minimumCount: 2,
                  samples: [
                    {
                      effectIdHash: EFFECT_HASH_A,
                      payloadHash: EFFECT_HASH_A,
                      committedAt: COMMITTED_AT,
                    },
                    {
                      effectIdHash: EFFECT_HASH_B,
                      payloadHash: EFFECT_HASH_B,
                      committedAt: COMMITTED_AT,
                    },
                  ],
                },
              ]
            : [committed(EFFECT_HASH_A), committed(EFFECT_HASH_B)];

  const pairs = outcomes.map((outcome) => {
    const payload: SignedEffectAttestation["payload"] = {
      registryHash: registry.registryHash,
      authorityId: policy.authorityId,
      contractId,
      operationId: query.operationId,
      operationStartedAt: OPENED_AT,
      adapterId: policy.adapterId,
      adapterVersion: policy.adapterVersion,
      environment: policy.environment,
      tenantIdHash: policy.tenantIdHash,
      queryKeyHash: query.queryKeyHash,
      effectType: policy.effectType,
      payloadProjectionId: policy.payloadProjectionId,
      observedAt: OBSERVED_AT,
      signedAt: SIGNED_AT,
      outcome,
    };
    const signedBody = {
      schemaVersion: "0.1" as const,
      protected: { algorithm: "Ed25519" as const, keyId: FIXED_KEY_ID },
      payload,
    };
    const attestation: SignedEffectAttestation = {
      ...signedBody,
      signature: sign(
        null,
        Buffer.from(`${EFFECT_SIGNATURE_DOMAIN}\n${canonicalJson(signedBody)}`, "utf8"),
        FIXED_PRIVATE_KEY,
      ).toString("base64url"),
    };
    if (options.corruptSignature) {
      attestation.signature = `${attestation.signature[0] === "A" ? "B" : "A"}${attestation.signature.slice(1)}`;
    }
    const pin: ShadowRunEffectPinV01 = {
      registryHash: registry.registryHash,
      contractId,
      attestationHash: canonicalHash(EFFECT_ENVELOPE_DOMAIN, attestation),
    };
    return {
      proof: {
        registry: structuredClone(registryManifest),
        contractId,
        attestation,
      },
      pin,
    };
  });
  pairs.sort((left, right) =>
    left.pin.attestationHash.localeCompare(right.pin.attestationHash),
  );
  return {
    proofs: pairs.map((entry) => entry.proof),
    pins: pairs.map((entry) => entry.pin),
  };
}

class CountingClock {
  calls = 0;

  now(): string {
    this.calls += 1;
    return RUN_AT;
  }
}

interface Harness {
  root: string;
  journal: EvidenceJournal;
  artifactStore: EvidenceArtifactStore;
  manifest: ShadowRunManifestV01;
  pins: ShadowRunTrustPinsV01;
  intent: DerivedShadowRunIntentV01;
  dependencies: JournalBoundShadowRunDependencies;
  requester: ScenarioBaseRpc;
  clock: CountingClock;
  factoryCalls: () => number;
}

async function createHarness(
  root: string,
  name: string,
  options: {
    base: BaseScenario;
    effect: EffectScenario;
    minimumConfirmations: number;
    corruptSignature?: boolean;
  },
): Promise<Harness> {
  const selectedOperation = structuredClone(operation);
  const selectedAuthorization = structuredClone(authorization);
  const operationId = deriveOperationIdentity(selectedOperation).id;
  const authorizationId = deriveAuthorizationIdentity(selectedAuthorization).id;
  const journal = await EvidenceJournal.open(join(root, name, "events.jsonl"));
  const opened = await journal.append({
    eventId: `attempt-open-${name}`,
    operationId,
    kind: "attempt_opened",
    occurredAt: OPENED_AT,
  });
  await journal.append({
    eventId: `authorization-recorded-${name}`,
    operationId,
    authorizationId,
    kind: "authorization_recorded",
    occurredAt: RECORDED_AT,
  });
  await journal.append({
    eventId: `authorization-transmitted-${name}`,
    operationId,
    authorizationId,
    kind: "authorization_transmitted",
    occurredAt: TRANSMITTED_AT,
  });
  const expectedHead = journal.head();
  assert.ok(expectedHead.recordHash);
  const material = effectMaterial(options.effect, {
    corruptSignature: options.corruptSignature,
  });
  const manifest: ShadowRunManifestV01 = {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run",
    mode: "shadow_no_action",
    baseRegistry: baseManifest(),
    operation: selectedOperation,
    authorization: selectedAuthorization,
    transactionHash: TRANSACTION_HASH,
    declaredAttempt: {
      preflightPassed: true,
      policyRejectedBeforeAuthorization: false,
      signingRejected: false,
      deliveryContractApplicable: false,
      delivery: "not_applicable",
    },
    minimumConfirmations: options.minimumConfirmations,
    effects: { mode: "required", proofs: material.proofs },
  };
  const baseRegistry = deriveBaseRpcSourceRegistry(manifest.baseRegistry);
  const pins: ShadowRunTrustPinsV01 = {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run_pins",
    manifestHash: computeShadowRunManifestHash(manifest),
    journal: {
      expectedHead,
      attemptOpenedRecordHash: opened.recordHash,
      operationId,
      authorizationId,
    },
    baseRegistryHash: baseRegistry.registryHash,
    effects: material.pins,
  };
  const intent = deriveShadowRunIntent(pins, manifest);
  const artifactStore = await EvidenceArtifactStore.open(join(root, name, "artifacts"));
  const requester = new ScenarioBaseRpc(options.base);
  const clock = new CountingClock();
  let factoryCalls = 0;
  const dependencies: JournalBoundShadowRunDependencies = {
    journal,
    artifactStore,
    clock,
    createBaseRequester(registry) {
      factoryCalls += 1;
      assert.equal(registry.registryHash, pins.baseRegistryHash);
      return requester;
    },
    requiredBaseTransportAuthentication: "test_injected",
  };
  return {
    root,
    journal,
    artifactStore,
    manifest,
    pins,
    intent,
    dependencies,
    requester,
    clock,
    factoryCalls: () => factoryCalls,
  };
}

async function withHarness(
  name: string,
  options: Parameters<typeof createHarness>[2],
  callback: (harness: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "x402-shadow-runner-"));
  let harness: Harness | undefined;
  try {
    harness = await createHarness(root, name, options);
    await callback(harness);
  } finally {
    await harness?.journal.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function shadowError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ShadowRunError && error.code === code;
}

function assertReadLedger(requester: ScenarioBaseRpc): void {
  const allowed = new Set<BaseReadRpcMethod>([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getTransactionReceipt",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_call",
  ]);
  assert.ok(requester.calls.length > 0);
  assert.ok(requester.calls.every((call) => allowed.has(call.method)));
  assert.equal(JSON.stringify(requester.calls).includes(MALICIOUS_OPERATION_URL), false);
}

function assertNoCommit(harness: Harness): Promise<void> {
  assert.deepEqual(
    harness.journal.readAll().map((record) => record.kind),
    ["attempt_opened", "authorization_recorded", "authorization_transmitted"],
  );
  return harness.artifactStore.inspect().then((inspection) => {
    assert.equal(inspection.artifacts.length, 0);
    assert.deepEqual(inspection.temporaryFiles, []);
  });
}

interface MatrixRow {
  name: string;
  base: BaseScenario;
  effect: EffectScenario;
  minimumConfirmations: number;
  settlement: string;
  settlementAuthoritative: boolean;
  settlementCount: number;
  confirmations: number;
  effectStatus: string;
  effectAuthoritative: boolean;
  effectCount: number;
  terminalState: string;
  retry: [sameAuthorization: boolean, newAuthorization: boolean];
  invariantPassed: boolean;
  integrityFailure: boolean;
}

const matrix: MatrixRow[] = [
  {
    name: "confirmed-committed",
    base: "confirmed",
    effect: "committed",
    minimumConfirmations: 10,
    settlement: "confirmed",
    settlementAuthoritative: true,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "committed",
    effectAuthoritative: true,
    effectCount: 1,
    terminalState: "settled_delivered",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: false,
  },
  {
    name: "absent-absent",
    base: "absent",
    effect: "absent",
    minimumConfirmations: 1,
    settlement: "absent",
    settlementAuthoritative: true,
    settlementCount: 0,
    confirmations: 1,
    effectStatus: "absent",
    effectAuthoritative: true,
    effectCount: 0,
    terminalState: "settlement_failed",
    retry: [false, true],
    invariantPassed: true,
    integrityFailure: false,
  },
  {
    name: "pending-confirmations",
    base: "confirmed",
    effect: "committed",
    minimumConfirmations: 12,
    settlement: "pending_finality",
    settlementAuthoritative: false,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "committed",
    effectAuthoritative: true,
    effectCount: 1,
    terminalState: "settled_pending_finality",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: false,
  },
  {
    name: "base-contradiction",
    base: "contradiction",
    effect: "committed",
    minimumConfirmations: 10,
    settlement: "contradiction",
    settlementAuthoritative: false,
    settlementCount: 1,
    confirmations: 0,
    effectStatus: "committed",
    effectAuthoritative: true,
    effectCount: 1,
    terminalState: "evidence_contradiction",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: true,
  },
  {
    name: "duplicate-settlement",
    base: "duplicate",
    effect: "committed",
    minimumConfirmations: 10,
    settlement: "duplicate",
    settlementAuthoritative: false,
    settlementCount: 2,
    confirmations: 11,
    effectStatus: "committed",
    effectAuthoritative: true,
    effectCount: 1,
    terminalState: "duplicate_settlement",
    retry: [false, false],
    invariantPassed: false,
    integrityFailure: true,
  },
  {
    name: "confirmed-effect-absent",
    base: "confirmed",
    effect: "absent",
    minimumConfirmations: 10,
    settlement: "confirmed",
    settlementAuthoritative: true,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "absent",
    effectAuthoritative: true,
    effectCount: 0,
    terminalState: "settled_delivery_failed",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: false,
  },
  {
    name: "confirmed-effect-unknown",
    base: "confirmed",
    effect: "unknown",
    minimumConfirmations: 10,
    settlement: "confirmed",
    settlementAuthoritative: true,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "unknown",
    effectAuthoritative: false,
    effectCount: 0,
    terminalState: "settled_delivery_unverified",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: false,
  },
  {
    name: "confirmed-effect-duplicate",
    base: "confirmed",
    effect: "duplicate",
    minimumConfirmations: 10,
    settlement: "confirmed",
    settlementAuthoritative: true,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "duplicate",
    effectAuthoritative: true,
    effectCount: 2,
    terminalState: "settled_delivery_failed",
    retry: [false, false],
    invariantPassed: false,
    integrityFailure: true,
  },
  {
    name: "confirmed-effect-contradiction",
    base: "confirmed",
    effect: "contradiction",
    minimumConfirmations: 10,
    settlement: "confirmed",
    settlementAuthoritative: true,
    settlementCount: 1,
    confirmations: 11,
    effectStatus: "contradiction",
    effectAuthoritative: false,
    effectCount: 1,
    terminalState: "evidence_contradiction",
    retry: [false, false],
    invariantPassed: true,
    integrityFailure: true,
  },
];

test("the no-action runner closes the orthogonal settlement/effect matrix", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("operation URL must never be fetched");
  }) as typeof fetch;
  try {
    for (const row of matrix) {
      await t.test(row.name, async () => {
        await withHarness(
          row.name,
          {
            base: row.base,
            effect: row.effect,
            minimumConfirmations: row.minimumConfirmations,
          },
          async (harness) => {
            const run = await runJournalBoundShadow(harness.intent, harness.dependencies);
            assert.equal(run.disposition, "committed");
            assert.equal(harness.clock.calls, 1);
            assert.equal(harness.factoryCalls(), 1);
            assertReadLedger(harness.requester);

            const evaluation = run.closure.bundle.evaluation;
            assert.deepEqual(
              {
                status: evaluation.settlement.status,
                authoritative: evaluation.settlement.authoritative,
                settlementCount: evaluation.settlement.settlementCount,
                confirmations: evaluation.settlement.confirmations,
              },
              {
                status: row.settlement,
                authoritative: row.settlementAuthoritative,
                settlementCount: row.settlementCount,
                confirmations: row.confirmations,
              },
            );
            assert.deepEqual(
              {
                status: evaluation.effect.status,
                authoritative: evaluation.effect.authoritative,
                effectCount: evaluation.effect.effectCount,
              },
              {
                status: row.effectStatus,
                authoritative: row.effectAuthoritative,
                effectCount: row.effectCount,
              },
            );
            assert.equal(evaluation.terminalState, row.terminalState);
            assert.deepEqual(
              [
                evaluation.retry.sameAuthorizationReplaySafe,
                evaluation.retry.newAuthorizationSafe,
              ],
              row.retry,
            );
            assert.equal(evaluation.invariant.settlementCount, row.settlementCount);
            assert.equal(evaluation.invariant.effectCount, row.effectCount);
            assert.equal(evaluation.invariant.passed, row.invariantPassed);
            assert.equal(
              evaluation.retry.reasons.includes(
                "RETRY_BLOCKED_BY_EVIDENCE_INTEGRITY_FAILURE",
              ),
              row.integrityFailure,
            );

            assert.deepEqual(run.closure.bundle.assurance.execution, {
              paymentExecutionEnabled: false,
              transactionSubmissionEnabled: false,
              retryExecutionEnabled: false,
              actionExecutionEnabled: false,
            });
            assert.equal(run.closure.bundle.assurance.externalTruthProven, false);
            assert.equal(
              run.closure.bundle.assurance.baseCollection.transportAuthentication,
              "test_injected",
            );
            assert.equal(
              run.closure.bundle.assurance.effectAuthority.runtimeSignatureVerification,
              "verified",
            );

            const offline = await verifyJournalBoundBundleIntegrity(
              harness.journal,
              harness.artifactStore,
              run.closure.receipt,
            );
            assert.deepEqual(offline, run.closure.bundle);
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
            assert.deepEqual(
              harness.journal.readAll().slice(-2).map((record) => record.kind),
              ["kernel_input_committed", "kernel_bundle_committed"],
            );

            const publicResult = publicShadowRunResult(run);
            assert.equal(publicResult.actionDirective, "none");
            assert.equal(publicResult.integrityVerified, true);
            assert.equal(publicResult.verdict.terminalState, row.terminalState);
            assert.equal(Object.prototype.hasOwnProperty.call(publicResult, "retry"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(publicResult.verdict, "retry"), false);
            assert.deepEqual(publicResult.execution, {
              actionExecutionEnabled: false,
              paymentExecutionEnabled: false,
              transactionSubmissionEnabled: false,
              retryExecutionEnabled: false,
            });
            assert.equal(Object.isFrozen(publicResult), true);
            const serialized = JSON.stringify(publicResult);
            assert.equal(serialized.includes(MALICIOUS_OPERATION_URL), false);
            assert.equal(serialized.includes(IDEMPOTENCY_KEY), false);
            assert.equal(serialized.includes(FIXED_PUBLIC_KEY_SPKI), false);
            assert.equal(serialized.includes("rpc-a.example"), false);
            if (harness.manifest.effects.mode === "required") {
              for (const proof of harness.manifest.effects.proofs) {
                assert.equal(serialized.includes(proof.attestation.signature), false);
              }
            }

            if (row.name === "confirmed-committed") {
              const replay = await runJournalBoundShadow(harness.intent, {
                journal: harness.journal,
                artifactStore: harness.artifactStore,
                clock: {
                  now(): string {
                    throw new Error("exact replay consulted the clock");
                  },
                },
                createBaseRequester() {
                  throw new Error("exact replay created a requester");
                },
                requiredBaseTransportAuthentication: "test_injected",
              });
              assert.equal(replay.disposition, "exact_replay");
              assert.deepEqual(replay.closure, run.closure);
              assert.equal(harness.clock.calls, 1);
              assert.equal(harness.factoryCalls(), 1);
              assert.equal(publicShadowRunResult(replay).disposition, "exact_replay");
            }
          },
        );
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("a beyond-anchor receipt is rejected before artifacts or kernel commits", async () => {
  await withHarness(
    "beyond-anchor",
    { base: "beyond_anchor", effect: "committed", minimumConfirmations: 1 },
    async (harness) => {
      await assert.rejects(
        runJournalBoundShadow(harness.intent, harness.dependencies),
        shadowError("SHADOW_BASE_COLLECTION_NOT_KERNEL_READY"),
      );
      assert.equal(harness.clock.calls, 1);
      assert.equal(harness.factoryCalls(), 1);
      assertReadLedger(harness.requester);
      await assertNoCommit(harness);
    },
  );
});

test("bad signatures and effect pins produce no collection, artifact, or commit", async (t) => {
  await t.test("bad signature", async () => {
    await withHarness(
      "bad-signature",
      {
        base: "confirmed",
        effect: "committed",
        minimumConfirmations: 10,
        corruptSignature: true,
      },
      async (harness) => {
        await assert.rejects(
          runJournalBoundShadow(harness.intent, harness.dependencies),
          (error: unknown) =>
            error instanceof EffectAuthorityError &&
            error.code === "ATTESTATION_SIGNATURE_INVALID",
        );
        assert.equal(harness.clock.calls, 1);
        assert.equal(harness.factoryCalls(), 0);
        assert.equal(harness.requester.calls.length, 0);
        await assertNoCommit(harness);
      },
    );
  });

  await t.test("bad attestation pin", async () => {
    await withHarness(
      "bad-pin",
      { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
      async (harness) => {
        const pins = structuredClone(harness.pins);
        pins.effects[0]!.attestationHash = `sha256:${"f".repeat(64)}`;
        assert.throws(
          () => deriveShadowRunIntent(pins, harness.manifest),
          shadowError("SHADOW_EFFECT_ATTESTATION_PIN_MISMATCH"),
        );
        assert.equal(harness.clock.calls, 0);
        assert.equal(harness.factoryCalls(), 0);
        assert.equal(harness.requester.calls.length, 0);
        await assertNoCommit(harness);
      },
    );
  });
});

test("journaled authorization lifecycle rejects contradictory declared attempt facts", async (t) => {
  const cases = [
    {
      name: "policy rejection after a recorded authorization",
      mutate(manifest: ShadowRunManifestV01): void {
        manifest.declaredAttempt.policyRejectedBeforeAuthorization = true;
      },
      code: "SHADOW_DECLARED_POLICY_REJECTION_CONTRADICTS_RECORDED_AUTHORIZATION",
    },
    {
      name: "failed preflight despite a transmitted authorization",
      mutate(manifest: ShadowRunManifestV01): void {
        manifest.declaredAttempt.preflightPassed = false;
      },
      code: "SHADOW_DECLARED_PREFLIGHT_CONTRADICTS_TRANSMISSION",
    },
    {
      name: "signing rejection despite a transmitted authorization",
      mutate(manifest: ShadowRunManifestV01): void {
        manifest.declaredAttempt.signingRejected = true;
      },
      code: "SHADOW_DECLARED_SIGNING_REJECTION_CONTRADICTS_TRANSMISSION",
    },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      await withHarness(
        `lifecycle-${index}`,
        { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
        async (harness) => {
          const manifest = structuredClone(harness.manifest);
          scenario.mutate(manifest);
          const pins = structuredClone(harness.pins);
          pins.manifestHash = computeShadowRunManifestHash(manifest);
          const intent = deriveShadowRunIntent(pins, manifest);

          await assert.rejects(
            runJournalBoundShadow(intent, harness.dependencies),
            shadowError(scenario.code),
          );
          assert.equal(harness.clock.calls, 0);
          assert.equal(harness.factoryCalls(), 0);
          assert.equal(harness.requester.calls.length, 0);
          await assertNoCommit(harness);
        },
      );
    });
  }
});

test("operation secret-key suffixes and sparse manifest arrays fail closed", async () => {
  await withHarness(
    "storage-boundaries",
    { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
    async (harness) => {
      const querySecret = structuredClone(harness.manifest);
      querySecret.operation.url = `${MALICIOUS_OPERATION_URL}?customer_api_key=not-stored`;
      assert.throws(
        () => computeShadowRunManifestHash(querySecret),
        shadowError("SHADOW_OPERATION_QUERY_SECRET_KEY_FORBIDDEN"),
      );

      const bodySecret = structuredClone(harness.manifest);
      bodySecret.operation.body = {
        orderId: "shadow-fixture-0001",
        customer_api_key: "not-stored",
      };
      assert.throws(
        () => computeShadowRunManifestHash(bodySecret),
        shadowError("SHADOW_OPERATION_SECRET_KEY_FORBIDDEN"),
      );

      const sparse = structuredClone(harness.manifest) as ShadowRunManifestV01;
      if (sparse.effects.mode !== "required") throw new Error("fixture effects must be required");
      sparse.effects.proofs = new Array(2) as typeof sparse.effects.proofs;
      sparse.effects.proofs[1] = structuredClone(
        (harness.manifest.effects as Extract<ShadowRunManifestV01["effects"], { mode: "required" }>).proofs[0]!,
      );
      assert.throws(
        () => computeShadowRunManifestHash(sparse),
        shadowError("SHADOW_INPUT_ARRAY_INVALID"),
      );

      assert.equal(harness.clock.calls, 0);
      assert.equal(harness.factoryCalls(), 0);
      assert.equal(harness.requester.calls.length, 0);
      await assertNoCommit(harness);
    },
  );
});

test("semantically equivalent noncanonical Base registries cannot create replay labels", async () => {
  await withHarness(
    "noncanonical-base-registry",
    { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
    async (harness) => {
      const manifest = structuredClone(harness.manifest);
      manifest.baseRegistry.genesisBlockHash =
        manifest.baseRegistry.genesisBlockHash.toUpperCase().replace(/^0X/, "0x");
      assert.notEqual(
        manifest.baseRegistry.genesisBlockHash,
        harness.manifest.baseRegistry.genesisBlockHash,
      );

      assert.throws(
        () => computeShadowRunManifestHash(manifest),
        shadowError("SHADOW_BASE_REGISTRY_NOT_CANONICAL"),
      );

      const rawPins = structuredClone(harness.pins);
      rawPins.manifestHash = canonicalHash(SHADOW_MANIFEST_DOMAIN, manifest);
      assert.throws(
        () => deriveShadowRunIntent(rawPins, manifest),
        shadowError("SHADOW_BASE_REGISTRY_NOT_CANONICAL"),
      );

      assert.equal(harness.clock.calls, 0);
      assert.equal(harness.factoryCalls(), 0);
      assert.equal(harness.requester.calls.length, 0);
      await assertNoCommit(harness);
    },
  );
});

test("manifest hashing cannot bless duplicate or unsorted signed effect proofs", async () => {
  await withHarness(
    "duplicate-effect-proofs",
    { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
    async (harness) => {
      const manifest = structuredClone(harness.manifest);
      if (manifest.effects.mode !== "required") {
        throw new Error("fixture effects must be required");
      }
      const proof = structuredClone(manifest.effects.proofs[0]!);
      manifest.effects.proofs = [structuredClone(proof), structuredClone(proof)];

      assert.throws(
        () => computeShadowRunManifestHash(manifest),
        shadowError("SHADOW_EFFECT_PROOFS_NOT_SORTED_UNIQUE"),
      );
      assert.equal(harness.clock.calls, 0);
      assert.equal(harness.factoryCalls(), 0);
      assert.equal(harness.requester.calls.length, 0);
      await assertNoCommit(harness);
    },
  );

  await withHarness(
    "unsorted-effect-proofs",
    { base: "confirmed", effect: "contradiction", minimumConfirmations: 10 },
    async (harness) => {
      const manifest = structuredClone(harness.manifest);
      if (manifest.effects.mode !== "required") {
        throw new Error("fixture effects must be required");
      }
      assert.equal(manifest.effects.proofs.length, 2);
      const sortedHashes = manifest.effects.proofs.map((proof) =>
        computeEffectAttestationHash(proof.attestation),
      );
      assert.equal(new Set(sortedHashes).size, 2);
      assert.deepEqual(sortedHashes, [...sortedHashes].sort());
      manifest.effects.proofs.reverse();

      assert.throws(
        () => computeShadowRunManifestHash(manifest),
        shadowError("SHADOW_EFFECT_PROOFS_NOT_SORTED_UNIQUE"),
      );
      assert.equal(harness.clock.calls, 0);
      assert.equal(harness.factoryCalls(), 0);
      assert.equal(harness.requester.calls.length, 0);
      await assertNoCommit(harness);
    },
  );
});

test("malformed manifests and unbranded intents fail before clock or I/O", async () => {
  await withHarness(
    "malformed-intent",
    { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
    async (harness) => {
      const malformed = {
        ...structuredClone(harness.manifest),
        paymentExecutionEnabled: true,
      };
      assert.throws(
        () => computeShadowRunManifestHash(malformed),
        shadowError("SHADOW_MANIFEST_FIELDS_INVALID"),
      );
      await assert.rejects(
        runJournalBoundShadow(structuredClone(harness.intent), harness.dependencies),
        shadowError("SHADOW_INTENT_NOT_DERIVED"),
      );
      assert.equal(harness.clock.calls, 0);
      assert.equal(harness.factoryCalls(), 0);
      assert.equal(harness.requester.calls.length, 0);
      await assertNoCommit(harness);
    },
  );
});

test("only a runtime-branded run can be formatted as integrity-verified public output", async () => {
  await withHarness(
    "public-result-brand",
    { base: "confirmed", effect: "committed", minimumConfirmations: 10 },
    async (harness) => {
      const run = await runJournalBoundShadow(harness.intent, harness.dependencies);
      assert.doesNotThrow(() => publicShadowRunResult(run));
      assert.throws(
        () =>
          publicShadowRunResult(
            structuredClone(run) as unknown as JournalBoundShadowRunResult,
          ),
        shadowError("SHADOW_RESULT_INVALID"),
      );
      assert.throws(
        () =>
          publicShadowRunResult({
            ...structuredClone(run),
            disposition: "committed",
          } as unknown as JournalBoundShadowRunResult),
        shadowError("SHADOW_RESULT_INVALID"),
      );
    },
  );
});
