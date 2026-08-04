import { createHash } from "node:crypto";

import {
  collectBaseEvidence,
  deriveBaseRpcSourceRegistry,
  type BaseEvidenceCollection,
  type BaseRpcRequester,
  type BaseRpcSourceManifest,
  type BaseRpcSourceRegistry,
} from "./base-rpc.js";
import { canonicalJson, deriveAuthorizationIdentity, deriveOperationIdentity } from "./canonical.js";
import {
  computeEffectAttestationHash,
  deriveEffectAuthorityRegistry,
  resolveEffectQuery,
  verifyEffectAttestation,
  type EffectAuthorityRegistry,
  type EffectAuthorityRegistryManifest,
  type SignedEffectAttestation,
  type VerifiedEffectAttestation,
} from "./effect-authority.js";
import { type ArtifactReferenceInput, EvidenceArtifactStore } from "./artifact-store.js";
import { EvidenceJournal, type JournalHead } from "./journal.js";
import {
  auditJournalBoundBundleRecovery,
  closeJournalBoundEvidenceBundle,
  recoverJournalBoundClosureReceipt,
  verifyJournalBoundBundleIntegrity,
  type JournalBoundClosureReceiptV02,
  type JournalBoundCommitResult,
  type JournalBoundEvidenceBundleV02,
  type JournalBoundKernelInputV02,
} from "./journal-bundle.js";
import type {
  ExactAuthorizationDescriptor,
  JournalRecord,
  OperationDescriptor,
} from "./types.js";
import type { Predicate } from "../reconciliation-policy.js";

const MANIFEST_DOMAIN = "x402-canary:shadow-run-manifest:v0.1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TRANSACTION_HASH = /^0x[0-9a-f]{64}$/;
const MAX_EFFECTS = 32;
const MAX_GRAPH_NODES = 100_000;
const MAX_STRING_CODE_UNITS = 2 * 1024 * 1024;
const ALLOWED_OPERATION_HEADERS = new Set(["accept", "content-type", "idempotency-key"]);
const PREDICATES = new Set<Predicate>(["pass", "fail", "unknown", "not_applicable"]);
const derivedIntents = new WeakSet<object>();
const verifiedRunResults = new WeakSet<object>();

const FORBIDDEN_OPERATION_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "bearertoken",
  "clientsecret",
  "credential",
  "mnemonic",
  "password",
  "payment",
  "paymentauthorization",
  "paymentcredential",
  "privatekey",
  "rawsignedtransaction",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seed",
  "seedphrase",
  "signature",
  "signedauthorization",
  "token",
  "wallet",
  "x402payment",
  "xpayment",
]);

export interface ShadowRunEffectPinV01 {
  registryHash: string;
  contractId: string;
  attestationHash: string;
}

export interface ShadowRunTrustPinsV01 {
  schemaVersion: "0.1";
  kind: "journal_bound_shadow_run_pins";
  manifestHash: string;
  journal: {
    expectedHead: JournalHead;
    attemptOpenedRecordHash: string;
    operationId: string;
    authorizationId: string;
  };
  baseRegistryHash: string;
  effects: ShadowRunEffectPinV01[];
}

export interface ShadowRunDeclaredAttemptV01 {
  preflightPassed: boolean;
  policyRejectedBeforeAuthorization: boolean;
  signingRejected: boolean;
  deliveryContractApplicable: boolean;
  delivery: Predicate;
}

export interface ShadowRunEffectProofV01 {
  registry: EffectAuthorityRegistryManifest;
  contractId: string;
  attestation: SignedEffectAttestation;
}

export type ShadowRunEffectsV01 =
  | { mode: "not_applicable" }
  | { mode: "required"; proofs: ShadowRunEffectProofV01[] };

export interface ShadowRunManifestV01 {
  schemaVersion: "0.1";
  kind: "journal_bound_shadow_run";
  mode: "shadow_no_action";
  baseRegistry: BaseRpcSourceManifest;
  operation: OperationDescriptor;
  authorization: ExactAuthorizationDescriptor;
  transactionHash: string | null;
  declaredAttempt: ShadowRunDeclaredAttemptV01;
  minimumConfirmations: number;
  effects: ShadowRunEffectsV01;
}

export interface DerivedShadowRunIntentV01 {
  schemaVersion: "0.1";
  kind: "derived_journal_bound_shadow_run";
  mode: "shadow_no_action";
  manifestHash: string;
  operationId: string;
  authorizationId: string;
  expectedHead: JournalHead;
  baseRegistryHash: string;
  effectPins: ShadowRunEffectPinV01[];
}

interface IntentInternals {
  pins: ShadowRunTrustPinsV01;
  manifest: ShadowRunManifestV01;
  baseRegistry: BaseRpcSourceRegistry;
  effects: Array<{
    registry: EffectAuthorityRegistry;
    contractId: string;
    attestation: SignedEffectAttestation;
    pin: ShadowRunEffectPinV01;
  }>;
}

const intentInternals = new WeakMap<DerivedShadowRunIntentV01, IntentInternals>();

export interface ShadowRunClock {
  now(): string;
}

export interface JournalBoundShadowRunDependencies {
  journal: EvidenceJournal;
  artifactStore: EvidenceArtifactStore;
  clock: ShadowRunClock;
  createBaseRequester(registry: BaseRpcSourceRegistry): BaseRpcRequester;
  requiredBaseTransportAuthentication: "https_web_pki" | "test_injected";
}

export interface JournalBoundShadowRunResult {
  schemaVersion: "0.1";
  kind: "journal_bound_shadow_run_internal_result";
  mode: "shadow_no_action";
  disposition: "committed" | "exact_replay";
  manifestHash: string;
  baseRegistryHash: string;
  baseCollectionHash: string;
  effectAttestationHashes: string[];
  closure: JournalBoundCommitResult;
}

export interface PublicShadowRunResultV01 {
  schemaVersion: "0.1";
  kind: "journal_bound_shadow_run_result";
  mode: "shadow_no_action";
  disposition: "committed" | "exact_replay";
  manifestHash: string;
  integrityVerified: true;
  actionDirective: "none";
  operationId: string;
  authorizationId: string;
  journalId: string;
  evaluatedAt: string;
  bundleHash: string;
  evidence: {
    baseRegistryHash: string;
    baseCollectionHash: string;
    effectAttestationHashes: string[];
  };
  verdict: {
    terminalState: string;
    settlement: {
      status: string;
      authoritative: boolean;
      settlementCount: number;
      confirmations: number;
      reasons: string[];
    };
    effect: {
      status: string;
      authoritative: boolean;
      effectCount: number;
      reasons: string[];
    };
    invariant: JournalBoundEvidenceBundleV02["evaluation"]["invariant"];
  };
  closure: JournalBoundClosureReceiptV02;
  assurance: JournalBoundEvidenceBundleV02["assurance"];
  execution: {
    actionExecutionEnabled: false;
    paymentExecutionEnabled: false;
    transactionSubmissionEnabled: false;
    retryExecutionEnabled: false;
  };
}

export class ShadowRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ShadowRunError";
  }
}

function fail(code: string): never {
  throw new ShadowRunError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainDataGraph(
  value: unknown,
  path = "input",
  ancestors = new Set<object>(),
  budget = { nodes: 0, stringCodeUnits: 0 },
  depth = 0,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_GRAPH_NODES) fail("SHADOW_INPUT_TOO_LARGE");
  if (depth > 32) fail("SHADOW_INPUT_TOO_DEEP");
  if (typeof value === "string") {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_STRING_CODE_UNITS) fail("SHADOW_INPUT_TOO_LARGE");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("SHADOW_INPUT_NOT_JSON");
    return;
  }
  if (typeof value !== "object") fail("SHADOW_INPUT_NOT_JSON");
  if (ancestors.has(value)) fail("SHADOW_INPUT_CYCLE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const elementKeys = keys.filter((key) => key !== "length");
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
        ) ||
        value.length > MAX_GRAPH_NODES ||
        elementKeys.length !== value.length
      ) fail("SHADOW_INPUT_ARRAY_INVALID");
      value.forEach((entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail("SHADOW_INPUT_ACCESSOR_OR_DESCRIPTOR");
        }
        assertPlainDataGraph(entry, `${path}[${index}]`, ancestors, budget, depth + 1);
      });
      return;
    }
    if (!isRecord(value)) fail("SHADOW_INPUT_PROTOTYPE_INVALID");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail("SHADOW_INPUT_SYMBOL_INVALID");
      budget.stringCodeUnits += key.length;
      if (budget.stringCodeUnits > MAX_STRING_CODE_UNITS) fail("SHADOW_INPUT_TOO_LARGE");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("SHADOW_INPUT_ACCESSOR_OR_DESCRIPTOR");
      }
      assertPlainDataGraph(descriptor.value, `${path}.${key}`, ancestors, budget, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function clonePlain<T>(value: T): T {
  assertPlainDataGraph(value);
  try {
    const cloned = structuredClone(value);
    canonicalJson(cloned);
    return cloned;
  } catch (error) {
    if (error instanceof ShadowRunError) throw error;
    return fail("SHADOW_INPUT_NOT_CANONICAL_JSON");
  }
}

function exact(value: unknown, fields: ReadonlySet<string>, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${code}_NOT_OBJECT`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.size ||
    keys.some((key) => typeof key !== "string" || !fields.has(key)) ||
    [...fields].some((field) => !Object.prototype.hasOwnProperty.call(value, field))
  ) fail(`${code}_FIELDS_INVALID`);
  return value;
}

function hashCanonical(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

function requireHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function requireTimestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenOperationKey(value: string): boolean {
  const normalized = normalizeKey(value);
  return (
    FORBIDDEN_OPERATION_KEYS.has(normalized) ||
    [...FORBIDDEN_OPERATION_KEYS].some(
      (forbidden) => forbidden.length >= 4 && normalized.endsWith(forbidden),
    )
  );
}

function assertNoForbiddenOperationKeys(value: unknown, path = "operation.body"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenOperationKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenOperationKey(key)) fail("SHADOW_OPERATION_SECRET_KEY_FORBIDDEN");
    assertNoForbiddenOperationKeys(nested, `${path}.${key}`);
  }
}

function validateOperationStorageBoundary(operation: OperationDescriptor): void {
  if (!isRecord(operation) || !isRecord(operation.headers)) {
    fail("SHADOW_OPERATION_INVALID");
  }
  for (const header of Object.keys(operation.headers)) {
    if (header !== header.toLowerCase() || !ALLOWED_OPERATION_HEADERS.has(header)) {
      fail("SHADOW_OPERATION_HEADER_NOT_ALLOWED");
    }
  }
  let url: URL;
  try {
    url = new URL(operation.url);
  } catch {
    return fail("SHADOW_OPERATION_URL_INVALID");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    fail("SHADOW_OPERATION_URL_CREDENTIAL_OR_FRAGMENT_FORBIDDEN");
  }
  for (const key of url.searchParams.keys()) {
    if (isForbiddenOperationKey(key)) {
      fail("SHADOW_OPERATION_QUERY_SECRET_KEY_FORBIDDEN");
    }
  }
  assertNoForbiddenOperationKeys(operation.body);
}

function parseHead(value: unknown, code: string): JournalHead {
  const head = exact(value, new Set(["journalId", "sequence", "recordHash"]), code);
  if (
    typeof head.sequence !== "number" ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1
  ) fail(`${code}_SEQUENCE_INVALID`);
  return {
    journalId: requireHash(head.journalId, `${code}_JOURNAL_ID_INVALID`),
    sequence: head.sequence,
    recordHash: requireHash(head.recordHash, `${code}_RECORD_HASH_INVALID`),
  };
}

function parseEffectPin(value: unknown, index: number): ShadowRunEffectPinV01 {
  const pin = exact(
    value,
    new Set(["registryHash", "contractId", "attestationHash"]),
    `SHADOW_EFFECT_PIN_${index}`,
  );
  return {
    registryHash: requireHash(pin.registryHash, "SHADOW_EFFECT_REGISTRY_PIN_INVALID"),
    contractId: requireHash(pin.contractId, "SHADOW_EFFECT_CONTRACT_PIN_INVALID"),
    attestationHash: requireHash(pin.attestationHash, "SHADOW_EFFECT_ATTESTATION_PIN_INVALID"),
  };
}

function parsePins(value: unknown): ShadowRunTrustPinsV01 {
  const pins = exact(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "manifestHash",
      "journal",
      "baseRegistryHash",
      "effects",
    ]),
    "SHADOW_PINS",
  );
  if (pins.schemaVersion !== "0.1" || pins.kind !== "journal_bound_shadow_run_pins") {
    fail("SHADOW_PINS_SCHEMA_INVALID");
  }
  const journal = exact(
    pins.journal,
    new Set([
      "expectedHead",
      "attemptOpenedRecordHash",
      "operationId",
      "authorizationId",
    ]),
    "SHADOW_JOURNAL_PIN",
  );
  if (!Array.isArray(pins.effects) || pins.effects.length > MAX_EFFECTS) {
    fail("SHADOW_EFFECT_PINS_INVALID");
  }
  const effects = pins.effects.map(parseEffectPin);
  const hashes = effects.map((entry) => entry.attestationHash);
  if (
    new Set(hashes).size !== hashes.length ||
    canonicalJson(hashes) !== canonicalJson([...hashes].sort())
  ) fail("SHADOW_EFFECT_PINS_NOT_SORTED_UNIQUE");
  return {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run_pins",
    manifestHash: requireHash(pins.manifestHash, "SHADOW_MANIFEST_PIN_INVALID"),
    journal: {
      expectedHead: parseHead(journal.expectedHead, "SHADOW_EXPECTED_HEAD"),
      attemptOpenedRecordHash: requireHash(
        journal.attemptOpenedRecordHash,
        "SHADOW_ATTEMPT_OPEN_PIN_INVALID",
      ),
      operationId: requireHash(journal.operationId, "SHADOW_OPERATION_PIN_INVALID"),
      authorizationId: requireHash(
        journal.authorizationId,
        "SHADOW_AUTHORIZATION_PIN_INVALID",
      ),
    },
    baseRegistryHash: requireHash(
      pins.baseRegistryHash,
      "SHADOW_BASE_REGISTRY_PIN_INVALID",
    ),
    effects,
  };
}

function parseDeclaredAttempt(value: unknown): ShadowRunDeclaredAttemptV01 {
  const attempt = exact(
    value,
    new Set([
      "preflightPassed",
      "policyRejectedBeforeAuthorization",
      "signingRejected",
      "deliveryContractApplicable",
      "delivery",
    ]),
    "SHADOW_DECLARED_ATTEMPT",
  );
  for (const field of [
    "preflightPassed",
    "policyRejectedBeforeAuthorization",
    "signingRejected",
    "deliveryContractApplicable",
  ] as const) {
    if (typeof attempt[field] !== "boolean") fail("SHADOW_DECLARED_ATTEMPT_INVALID");
  }
  if (typeof attempt.delivery !== "string" || !PREDICATES.has(attempt.delivery as Predicate)) {
    fail("SHADOW_DECLARED_DELIVERY_INVALID");
  }
  if (
    (attempt.deliveryContractApplicable === true) ===
    (attempt.delivery === "not_applicable")
  ) fail("SHADOW_DECLARED_DELIVERY_APPLICABILITY_INVALID");
  return attempt as unknown as ShadowRunDeclaredAttemptV01;
}

function parseEffectProof(value: unknown, index: number): ShadowRunEffectProofV01 {
  const proof = exact(
    value,
    new Set(["registry", "contractId", "attestation"]),
    `SHADOW_EFFECT_PROOF_${index}`,
  );
  if (!isRecord(proof.registry) || !isRecord(proof.attestation)) {
    fail("SHADOW_EFFECT_PROOF_INVALID");
  }
  return {
    registry: proof.registry as unknown as EffectAuthorityRegistryManifest,
    contractId: requireHash(proof.contractId, "SHADOW_EFFECT_CONTRACT_ID_INVALID"),
    attestation: proof.attestation as unknown as SignedEffectAttestation,
  };
}

function parseEffects(value: unknown): ShadowRunEffectsV01 {
  if (!isRecord(value) || typeof value.mode !== "string") fail("SHADOW_EFFECTS_INVALID");
  if (value.mode === "not_applicable") {
    exact(value, new Set(["mode"]), "SHADOW_EFFECTS_NOT_APPLICABLE");
    return { mode: "not_applicable" };
  }
  if (value.mode !== "required") fail("SHADOW_EFFECTS_MODE_INVALID");
  const required = exact(value, new Set(["mode", "proofs"]), "SHADOW_EFFECTS_REQUIRED");
  if (
    !Array.isArray(required.proofs) ||
    required.proofs.length < 1 ||
    required.proofs.length > MAX_EFFECTS
  ) fail("SHADOW_EFFECT_PROOFS_INVALID");
  return { mode: "required", proofs: required.proofs.map(parseEffectProof) };
}

function parseManifest(value: unknown): ShadowRunManifestV01 {
  const manifest = exact(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "mode",
      "baseRegistry",
      "operation",
      "authorization",
      "transactionHash",
      "declaredAttempt",
      "minimumConfirmations",
      "effects",
    ]),
    "SHADOW_MANIFEST",
  );
  if (
    manifest.schemaVersion !== "0.1" ||
    manifest.kind !== "journal_bound_shadow_run" ||
    manifest.mode !== "shadow_no_action"
  ) fail("SHADOW_MANIFEST_SCHEMA_INVALID");
  if (!isRecord(manifest.baseRegistry) || !isRecord(manifest.operation) || !isRecord(manifest.authorization)) {
    fail("SHADOW_MANIFEST_IDENTITY_INPUT_INVALID");
  }
  if (
    typeof manifest.minimumConfirmations !== "number" ||
    !Number.isSafeInteger(manifest.minimumConfirmations) ||
    manifest.minimumConfirmations < 1 ||
    manifest.minimumConfirmations > 1_000_000
  ) fail("SHADOW_MINIMUM_CONFIRMATIONS_INVALID");
  let transactionHash: string | null;
  if (manifest.transactionHash === null) transactionHash = null;
  else if (typeof manifest.transactionHash === "string" && TRANSACTION_HASH.test(manifest.transactionHash)) {
    transactionHash = manifest.transactionHash;
  } else fail("SHADOW_TRANSACTION_HASH_INVALID");
  const operation = manifest.operation as unknown as OperationDescriptor;
  validateOperationStorageBoundary(operation);
  return {
    schemaVersion: "0.1",
    kind: "journal_bound_shadow_run",
    mode: "shadow_no_action",
    baseRegistry: manifest.baseRegistry as unknown as BaseRpcSourceManifest,
    operation,
    authorization: manifest.authorization as unknown as ExactAuthorizationDescriptor,
    transactionHash,
    declaredAttempt: parseDeclaredAttempt(manifest.declaredAttempt),
    minimumConfirmations: manifest.minimumConfirmations,
    effects: parseEffects(manifest.effects),
  };
}

interface ValidatedManifestAuthorities {
  operationId: string;
  authorizationId: string;
  baseRegistry: BaseRpcSourceRegistry;
  effects: Array<{
    registry: EffectAuthorityRegistry;
    contractId: string;
    attestation: SignedEffectAttestation;
    attestationHash: string;
  }>;
}

function validateManifestAuthorities(
  manifest: ShadowRunManifestV01,
): ValidatedManifestAuthorities {
  let operationId: string;
  let authorizationId: string;
  try {
    operationId = deriveOperationIdentity(manifest.operation).id;
    authorizationId = deriveAuthorizationIdentity(manifest.authorization).id;
  } catch {
    return fail("SHADOW_IDENTITY_DERIVATION_FAILED");
  }

  const baseRegistry = deriveBaseRpcSourceRegistry(manifest.baseRegistry);
  if (canonicalJson(manifest.baseRegistry) !== canonicalJson(baseRegistry.manifest)) {
    fail("SHADOW_BASE_REGISTRY_NOT_CANONICAL");
  }

  const proofs = manifest.effects.mode === "required" ? manifest.effects.proofs : [];
  const effects = proofs.map((proof) => {
    const registry = deriveEffectAuthorityRegistry(proof.registry);
    if (canonicalJson(proof.registry) !== canonicalJson(registry.manifest)) {
      fail("SHADOW_EFFECT_REGISTRY_NOT_CANONICAL");
    }
    if (!registry.manifest.contracts.some((entry) => entry.contractId === proof.contractId)) {
      fail("SHADOW_EFFECT_CONTRACT_NOT_IN_REGISTRY");
    }
    return {
      registry,
      contractId: proof.contractId,
      attestation: proof.attestation,
      attestationHash: computeEffectAttestationHash(proof.attestation),
    };
  });
  const attestationHashes = effects.map((entry) => entry.attestationHash);
  if (
    new Set(attestationHashes).size !== attestationHashes.length ||
    canonicalJson(attestationHashes) !== canonicalJson([...attestationHashes].sort())
  ) fail("SHADOW_EFFECT_PROOFS_NOT_SORTED_UNIQUE");
  return { operationId, authorizationId, baseRegistry, effects };
}

export function computeShadowRunManifestHash(input: unknown): string {
  const manifest = parseManifest(clonePlain(input));
  validateManifestAuthorities(manifest);
  return hashCanonical(MANIFEST_DOMAIN, manifest);
}

export function deriveShadowRunIntent(
  pinsInput: unknown,
  manifestInput: unknown,
): DerivedShadowRunIntentV01 {
  const pins = parsePins(clonePlain(pinsInput));
  const manifest = parseManifest(clonePlain(manifestInput));
  const manifestHash = hashCanonical(MANIFEST_DOMAIN, manifest);
  if (pins.manifestHash !== manifestHash) fail("SHADOW_MANIFEST_PIN_MISMATCH");
  const validated = validateManifestAuthorities(manifest);
  const { operationId, authorizationId, baseRegistry } = validated;
  if (operationId !== pins.journal.operationId) fail("SHADOW_OPERATION_PIN_MISMATCH");
  if (authorizationId !== pins.journal.authorizationId) {
    fail("SHADOW_AUTHORIZATION_PIN_MISMATCH");
  }

  if (baseRegistry.registryHash !== pins.baseRegistryHash) {
    fail("SHADOW_BASE_REGISTRY_PIN_MISMATCH");
  }

  if (validated.effects.length !== pins.effects.length) {
    fail("SHADOW_EFFECT_PIN_COUNT_MISMATCH");
  }
  const effects = validated.effects.map((proof, index) => {
    const { registry } = proof;
    const pin = pins.effects[index]!;
    if (registry.registryHash !== pin.registryHash) fail("SHADOW_EFFECT_REGISTRY_PIN_MISMATCH");
    if (proof.contractId !== pin.contractId) fail("SHADOW_EFFECT_CONTRACT_PIN_MISMATCH");
    if (proof.attestationHash !== pin.attestationHash) {
      fail("SHADOW_EFFECT_ATTESTATION_PIN_MISMATCH");
    }
    return { registry, contractId: proof.contractId, attestation: proof.attestation, pin };
  });

  const intent: DerivedShadowRunIntentV01 = {
    schemaVersion: "0.1",
    kind: "derived_journal_bound_shadow_run",
    mode: "shadow_no_action",
    manifestHash,
    operationId,
    authorizationId,
    expectedHead: pins.journal.expectedHead,
    baseRegistryHash: baseRegistry.registryHash,
    effectPins: pins.effects,
  };
  deepFreeze(intent);
  derivedIntents.add(intent);
  intentInternals.set(intent, { pins, manifest, baseRegistry, effects });
  return intent;
}

function assertDerivedIntent(intent: DerivedShadowRunIntentV01): IntentInternals {
  if (!isRecord(intent) || !derivedIntents.has(intent)) fail("SHADOW_INTENT_NOT_DERIVED");
  const internals = intentInternals.get(intent);
  if (!internals) fail("SHADOW_INTENT_STATE_MISSING");
  return internals;
}

function sameHead(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journalId === right.journalId &&
    left.sequence === right.sequence &&
    left.recordHash === right.recordHash
  );
}

interface ControlledLifecycle {
  opened: JournalRecord;
  attempt: JournalBoundKernelInputV02["attempt"];
  latestLifecycleTimeMs: number;
}

function controlledLifecycle(
  records: readonly JournalRecord[],
  internals: IntentInternals,
): ControlledLifecycle {
  const { pins, manifest } = internals;
  const expectedHead = pins.journal.expectedHead;
  if (expectedHead.journalId !== records[0]?.journalId) fail("SHADOW_JOURNAL_ID_MISMATCH");
  const sourceRecord = records[expectedHead.sequence - 1];
  if (!sourceRecord || sourceRecord.recordHash !== expectedHead.recordHash) {
    fail("SHADOW_EXPECTED_HEAD_NOT_IN_JOURNAL");
  }
  const prefix = records.slice(0, expectedHead.sequence);
  const operationRecords = prefix.filter(
    (record) => record.operationId === pins.journal.operationId,
  );
  const opens = operationRecords.filter((record) => record.kind === "attempt_opened");
  if (
    opens.length !== 1 ||
    opens[0]!.recordHash !== pins.journal.attemptOpenedRecordHash
  ) fail("SHADOW_ATTEMPT_OPEN_PIN_MISMATCH");
  const opened = opens[0]!;
  if (
    opened.authorizationId !== undefined &&
    opened.authorizationId !== pins.journal.authorizationId
  ) fail("SHADOW_ATTEMPT_OPEN_AUTHORIZATION_MISMATCH");
  if (
    operationRecords.some(
      (record) =>
        record.kind === "attempt_closed" ||
        record.kind === "kernel_input_committed" ||
        record.kind === "kernel_bundle_committed",
    )
  ) fail("SHADOW_SOURCE_PREFIX_ALREADY_CLOSED");

  const authorizationRecords = operationRecords.filter(
    (record) =>
      record.kind === "authorization_recorded" ||
      record.kind === "authorization_transmitted",
  );
  if (
    authorizationRecords.some(
      (record) => record.authorizationId !== pins.journal.authorizationId,
    )
  ) fail("SHADOW_JOURNAL_AUTHORIZATION_MISMATCH");
  const recorded = authorizationRecords.filter(
    (record) => record.kind === "authorization_recorded",
  );
  const transmitted = authorizationRecords.filter(
    (record) => record.kind === "authorization_transmitted",
  );
  if (recorded.length !== 1 || transmitted.length > 1) {
    fail("SHADOW_AUTHORIZATION_LIFECYCLE_COUNT_INVALID");
  }
  if (manifest.declaredAttempt.policyRejectedBeforeAuthorization) {
    fail("SHADOW_DECLARED_POLICY_REJECTION_CONTRADICTS_RECORDED_AUTHORIZATION");
  }
  const openedAt = Date.parse(requireTimestamp(opened.occurredAt, "SHADOW_OPEN_TIME_INVALID"));
  const recordedAt = Date.parse(
    requireTimestamp(recorded[0]!.occurredAt, "SHADOW_RECORDED_TIME_INVALID"),
  );
  if (recorded[0]!.sequence <= opened.sequence || recordedAt < openedAt) {
    fail("SHADOW_AUTHORIZATION_LIFECYCLE_ORDER_INVALID");
  }
  if (transmitted.length === 1) {
    const transmittedAt = Date.parse(
      requireTimestamp(transmitted[0]!.occurredAt, "SHADOW_TRANSMITTED_TIME_INVALID"),
    );
    if (
      transmitted[0]!.sequence <= recorded[0]!.sequence ||
      transmittedAt < recordedAt
    ) fail("SHADOW_AUTHORIZATION_LIFECYCLE_ORDER_INVALID");
    if (!manifest.declaredAttempt.preflightPassed) {
      fail("SHADOW_DECLARED_PREFLIGHT_CONTRADICTS_TRANSMISSION");
    }
    if (manifest.declaredAttempt.signingRejected) {
      fail("SHADOW_DECLARED_SIGNING_REJECTION_CONTRADICTS_TRANSMISSION");
    }
  }
  return {
    opened,
    latestLifecycleTimeMs:
      transmitted.length === 1
        ? Date.parse(transmitted[0]!.occurredAt)
        : recordedAt,
    attempt: {
      authorizationCreated: true,
      preflightPassed: manifest.declaredAttempt.preflightPassed,
      policyRejectedBeforeAuthorization:
        manifest.declaredAttempt.policyRejectedBeforeAuthorization,
      authorizationTransmitted: transmitted.length === 1 ? "pass" : "unknown",
      signingRejected: manifest.declaredAttempt.signingRejected,
      deliveryContractApplicable: manifest.declaredAttempt.deliveryContractApplicable,
      delivery: manifest.declaredAttempt.delivery,
      effectContractApplicable: internals.effects.length > 0,
    },
  };
}

function isReplayPair(
  records: readonly JournalRecord[],
  intent: DerivedShadowRunIntentV01,
): { input: JournalRecord; bundle: JournalRecord } | null {
  const input = records[intent.expectedHead.sequence];
  if (!input) return null;
  if (
    input.kind !== "kernel_input_committed" ||
    input.previousHash !== intent.expectedHead.recordHash ||
    input.operationId !== intent.operationId ||
    input.authorizationId !== intent.authorizationId
  ) fail("SHADOW_JOURNAL_ADVANCED_OUTSIDE_EXACT_REPLAY");
  const bundle = records[intent.expectedHead.sequence + 1];
  if (!bundle) fail("SHADOW_PENDING_INPUT_REQUIRES_OPERATOR_RECOVERY");
  if (
    bundle.kind !== "kernel_bundle_committed" ||
    bundle.previousHash !== input.recordHash ||
    bundle.operationId !== intent.operationId ||
    bundle.authorizationId !== intent.authorizationId
  ) fail("SHADOW_REPLAY_COMMIT_PAIR_INVALID");
  return { input, bundle };
}

function asArtifactReference(value: unknown, code: string): ArtifactReferenceInput {
  const reference = exact(
    value,
    new Set(["namespace", "artifactHash", "byteLength"]),
    code,
  );
  if (
    typeof reference.namespace !== "string" ||
    typeof reference.byteLength !== "number" ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength <= 0
  ) fail(`${code}_INVALID`);
  return {
    namespace: reference.namespace,
    artifactHash: requireHash(reference.artifactHash, `${code}_HASH_INVALID`),
    byteLength: reference.byteLength,
  };
}

function recordEvidence(record: JournalRecord, code: string): Record<string, unknown> {
  if (!isRecord(record.evidence)) fail(code);
  return record.evidence;
}

async function assertClosureMatchesIntent(
  intent: DerivedShadowRunIntentV01,
  internals: IntentInternals,
  lifecycle: ControlledLifecycle,
  dependencies: JournalBoundShadowRunDependencies,
  closure: JournalBoundCommitResult,
): Promise<{ baseCollectionHash: string; effectAttestationHashes: string[] }> {
  const { receipt, bundle } = closure;
  if (
    bundle.operationId !== intent.operationId ||
    bundle.authorizationId !== intent.authorizationId ||
    !sameHead(
      {
        journalId: bundle.inputCommit.journalId,
        sequence: bundle.inputCommit.sequence - 1,
        recordHash: bundle.inputCommit.previousHash,
      },
      intent.expectedHead,
    )
  ) fail("SHADOW_CLOSURE_INTENT_BINDING_MISMATCH");
  if (
    bundle.assurance.baseCollection.transportAuthentication !==
    dependencies.requiredBaseTransportAuthentication
  ) fail("SHADOW_BASE_TRANSPORT_ASSURANCE_MISMATCH");

  const records = dependencies.journal.readAll();
  const inputRecord = records[receipt.inputCommit.sequence - 1];
  if (!inputRecord) fail("SHADOW_INPUT_COMMIT_MISSING");
  const evidence = recordEvidence(inputRecord, "SHADOW_INPUT_COMMIT_EVIDENCE_INVALID");
  if (evidence.baseRegistryHash !== intent.baseRegistryHash) {
    fail("SHADOW_CLOSURE_BASE_REGISTRY_MISMATCH");
  }
  const baseCollectionHash = requireHash(
    evidence.baseCollectionHash,
    "SHADOW_CLOSURE_BASE_COLLECTION_HASH_INVALID",
  );
  if (!Array.isArray(evidence.effectAttestationHashes)) {
    fail("SHADOW_CLOSURE_EFFECT_HASHES_INVALID");
  }
  const effectAttestationHashes = evidence.effectAttestationHashes.map((entry) =>
    requireHash(entry, "SHADOW_CLOSURE_EFFECT_HASH_INVALID"),
  );
  if (
    canonicalJson(effectAttestationHashes) !==
    canonicalJson(internals.pins.effects.map((entry) => entry.attestationHash))
  ) fail("SHADOW_CLOSURE_EFFECT_PIN_MISMATCH");

  const inputManifest = await dependencies.artifactStore.getByReference(receipt.inputManifest);
  if (!isRecord(inputManifest) || !isRecord(inputManifest.artifacts)) {
    fail("SHADOW_PERSISTED_INPUT_MANIFEST_INVALID");
  }
  const baseReference = asArtifactReference(
    inputManifest.artifacts.base,
    "SHADOW_PERSISTED_BASE_REFERENCE",
  );
  const evaluatorReference = asArtifactReference(
    inputManifest.artifacts.evaluatorInput,
    "SHADOW_PERSISTED_EVALUATOR_REFERENCE",
  );
  if (!Array.isArray(inputManifest.artifacts.effects)) {
    fail("SHADOW_PERSISTED_EFFECT_REFERENCES_INVALID");
  }
  const effectReferences = inputManifest.artifacts.effects.map((entry, index) =>
    asArtifactReference(entry, `SHADOW_PERSISTED_EFFECT_REFERENCE_${index}`),
  );
  const baseArtifact = await dependencies.artifactStore.getByReference(baseReference);
  if (!isRecord(baseArtifact) || !isRecord(baseArtifact.collection)) {
    fail("SHADOW_PERSISTED_BASE_ARTIFACT_INVALID");
  }
  if (baseArtifact.collection.readiness !== "kernel_ready") {
    fail("SHADOW_PERSISTED_BASE_NOT_KERNEL_READY");
  }
  if (baseArtifact.requestedTransactionHash !== internals.manifest.transactionHash) {
    fail("SHADOW_PERSISTED_TRANSACTION_HASH_MISMATCH");
  }
  const evaluator = await dependencies.artifactStore.getByReference(evaluatorReference);
  if (!isRecord(evaluator)) fail("SHADOW_PERSISTED_EVALUATOR_INVALID");
  if (
    canonicalJson(evaluator.operation) !== canonicalJson(internals.manifest.operation) ||
    canonicalJson(evaluator.authorization) !== canonicalJson(internals.manifest.authorization) ||
    canonicalJson(evaluator.attempt) !== canonicalJson(lifecycle.attempt) ||
    evaluator.minimumConfirmations !== internals.manifest.minimumConfirmations
  ) fail("SHADOW_PERSISTED_EVALUATOR_INTENT_MISMATCH");

  const persistedEffectPins: ShadowRunEffectPinV01[] = [];
  for (const reference of effectReferences) {
    const artifact = await dependencies.artifactStore.getByReference(reference);
    if (!isRecord(artifact) || !isRecord(artifact.attestation)) {
      fail("SHADOW_PERSISTED_EFFECT_ARTIFACT_INVALID");
    }
    const attestationHash = requireHash(
      artifact.attestationHash,
      "SHADOW_PERSISTED_EFFECT_ATTESTATION_INVALID",
    );
    if (computeEffectAttestationHash(artifact.attestation) !== attestationHash) {
      fail("SHADOW_PERSISTED_EFFECT_ATTESTATION_HASH_MISMATCH");
    }
    persistedEffectPins.push({
      registryHash: requireHash(
        artifact.registryHash,
        "SHADOW_PERSISTED_EFFECT_REGISTRY_INVALID",
      ),
      contractId: requireHash(
        artifact.contractId,
        "SHADOW_PERSISTED_EFFECT_CONTRACT_INVALID",
      ),
      attestationHash,
    });
  }
  persistedEffectPins.sort((left, right) =>
    left.attestationHash.localeCompare(right.attestationHash),
  );
  if (canonicalJson(persistedEffectPins) !== canonicalJson(internals.pins.effects)) {
    fail("SHADOW_PERSISTED_EFFECT_PINS_MISMATCH");
  }
  return { baseCollectionHash, effectAttestationHashes };
}

function result(
  intent: DerivedShadowRunIntentV01,
  disposition: "committed" | "exact_replay",
  closure: JournalBoundCommitResult,
  evidence: { baseCollectionHash: string; effectAttestationHashes: string[] },
): JournalBoundShadowRunResult {
  const verified = {
    schemaVersion: "0.1" as const,
    kind: "journal_bound_shadow_run_internal_result" as const,
    mode: "shadow_no_action" as const,
    disposition,
    manifestHash: intent.manifestHash,
    baseRegistryHash: intent.baseRegistryHash,
    baseCollectionHash: evidence.baseCollectionHash,
    effectAttestationHashes: [...evidence.effectAttestationHashes],
    closure,
  };
  const frozen = deepFreeze(verified);
  verifiedRunResults.add(frozen);
  return frozen;
}

export async function runJournalBoundShadow(
  intent: DerivedShadowRunIntentV01,
  dependencies: JournalBoundShadowRunDependencies,
): Promise<JournalBoundShadowRunResult> {
  const internals = assertDerivedIntent(intent);
  if (dependencies.journal.journalId !== intent.expectedHead.journalId) {
    fail("SHADOW_JOURNAL_ID_MISMATCH");
  }
  const records = dependencies.journal.readAll();
  const lifecycle = controlledLifecycle(records, internals);
  const replayPair = isReplayPair(records, intent);
  if (replayPair) {
    const receipt = await recoverJournalBoundClosureReceipt(
      dependencies.journal,
      dependencies.artifactStore,
      replayPair.bundle.sequence,
    );
    const bundle = await verifyJournalBoundBundleIntegrity(
      dependencies.journal,
      dependencies.artifactStore,
      receipt,
    );
    const closure = { bundle, receipt };
    const evidence = await assertClosureMatchesIntent(
      intent,
      internals,
      lifecycle,
      dependencies,
      closure,
    );
    const audit = await auditJournalBoundBundleRecovery(
      dependencies.journal,
      dependencies.artifactStore,
    );
    if (audit.status !== "clean") fail("SHADOW_RECOVERY_AUDIT_NOT_CLEAN");
    return result(intent, "exact_replay", closure, evidence);
  }
  if (!sameHead(dependencies.journal.head(), intent.expectedHead)) {
    fail("SHADOW_JOURNAL_HEAD_MISMATCH");
  }
  const initialAudit = await auditJournalBoundBundleRecovery(
    dependencies.journal,
    dependencies.artifactStore,
  );
  if (initialAudit.status !== "clean") fail("SHADOW_RECOVERY_AUDIT_NOT_CLEAN");

  const runAt = requireTimestamp(dependencies.clock.now(), "SHADOW_CLOCK_INVALID");
  if (Date.parse(runAt) < lifecycle.latestLifecycleTimeMs) {
    fail("SHADOW_CLOCK_PRECEDES_JOURNALED_LIFECYCLE");
  }
  const verifiedEffects: VerifiedEffectAttestation[] = [];
  for (const entry of internals.effects) {
    const query = resolveEffectQuery(entry.registry, {
      contractId: entry.contractId,
      operation: internals.manifest.operation,
      operationStartedAt: lifecycle.opened.occurredAt,
    });
    const verified = verifyEffectAttestation(
      entry.registry,
      query,
      entry.attestation,
      runAt,
    );
    if (verified.attestationHash !== entry.pin.attestationHash) {
      fail("SHADOW_EFFECT_ATTESTATION_PIN_MISMATCH");
    }
    verifiedEffects.push(verified);
  }

  const requester = dependencies.createBaseRequester(internals.baseRegistry);
  const baseCollection: BaseEvidenceCollection = await collectBaseEvidence(
    internals.baseRegistry,
    requester,
    {
      authorization: internals.manifest.authorization,
      collectedAt: runAt,
      ...(internals.manifest.transactionHash === null
        ? {}
        : { transactionHash: internals.manifest.transactionHash }),
    },
  );
  if (baseCollection.readiness !== "kernel_ready") {
    fail("SHADOW_BASE_COLLECTION_NOT_KERNEL_READY");
  }
  if (
    baseCollection.assurance.transportAuthentication !==
    dependencies.requiredBaseTransportAuthentication
  ) fail("SHADOW_BASE_TRANSPORT_ASSURANCE_MISMATCH");

  const core: JournalBoundKernelInputV02 = {
    schemaVersion: "0.2",
    evaluatedAt: runAt,
    operation: internals.manifest.operation,
    authorization: internals.manifest.authorization,
    attempt: lifecycle.attempt,
    minimumConfirmations: internals.manifest.minimumConfirmations,
  };
  const closure = await closeJournalBoundEvidenceBundle({
    journal: dependencies.journal,
    artifactStore: dependencies.artifactStore,
    expectedHead: intent.expectedHead,
    core,
    baseRegistry: internals.baseRegistry,
    baseCollection,
    verifiedEffects,
  });
  await verifyJournalBoundBundleIntegrity(
    dependencies.journal,
    dependencies.artifactStore,
    closure.receipt,
  );
  const evidence = await assertClosureMatchesIntent(
    intent,
    internals,
    lifecycle,
    dependencies,
    closure,
  );
  const audit = await auditJournalBoundBundleRecovery(
    dependencies.journal,
    dependencies.artifactStore,
  );
  if (audit.status !== "clean") fail("SHADOW_RECOVERY_AUDIT_NOT_CLEAN");
  return result(intent, "committed", closure, evidence);
}

export function publicShadowRunResult(
  run: JournalBoundShadowRunResult,
): PublicShadowRunResultV01 {
  if (
    !isRecord(run) ||
    !verifiedRunResults.has(run) ||
    run.mode !== "shadow_no_action"
  ) fail("SHADOW_RESULT_INVALID");
  const { bundle, receipt } = run.closure;
  const execution = bundle.assurance.execution;
  if (
    execution.actionExecutionEnabled !== false ||
    execution.paymentExecutionEnabled !== false ||
    execution.transactionSubmissionEnabled !== false ||
    execution.retryExecutionEnabled !== false
  ) fail("SHADOW_RESULT_EXECUTION_NOT_DISABLED");
  return deepFreeze({
    schemaVersion: "0.1" as const,
    kind: "journal_bound_shadow_run_result" as const,
    mode: "shadow_no_action" as const,
    disposition: run.disposition,
    manifestHash: run.manifestHash,
    integrityVerified: true as const,
    actionDirective: "none" as const,
    operationId: bundle.operationId,
    authorizationId: bundle.authorizationId,
    journalId: receipt.journalId,
    evaluatedAt: bundle.evaluatedAt,
    bundleHash: bundle.bundleHash,
    evidence: {
      baseRegistryHash: run.baseRegistryHash,
      baseCollectionHash: run.baseCollectionHash,
      effectAttestationHashes: [...run.effectAttestationHashes],
    },
    verdict: {
      terminalState: bundle.evaluation.terminalState,
      settlement: {
        status: bundle.evaluation.settlement.status,
        authoritative: bundle.evaluation.settlement.authoritative,
        settlementCount: bundle.evaluation.settlement.settlementCount,
        confirmations: bundle.evaluation.settlement.confirmations,
        reasons: [...bundle.evaluation.settlement.reasons],
      },
      effect: {
        status: bundle.evaluation.effect.status,
        authoritative: bundle.evaluation.effect.authoritative,
        effectCount: bundle.evaluation.effect.effectCount,
        reasons: [...bundle.evaluation.effect.reasons],
      },
      invariant: structuredClone(bundle.evaluation.invariant),
    },
    closure: structuredClone(receipt),
    assurance: structuredClone(bundle.assurance),
    execution: {
      actionExecutionEnabled: false as const,
      paymentExecutionEnabled: false as const,
      transactionSubmissionEnabled: false as const,
      retryExecutionEnabled: false as const,
    },
  });
}
