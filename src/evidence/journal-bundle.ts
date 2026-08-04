import { createHash } from "node:crypto";

import {
  assertCollectedBaseEvidence,
  baseEvidenceArtifactFromCollection,
  type BaseEvidenceCollection,
  type BaseRpcSourceRegistry,
} from "./base-rpc.js";
import { canonicalJson, deriveAuthorizationIdentity, deriveOperationIdentity } from "./canonical.js";
import {
  effectAuthorityArtifactFromVerifiedAttestation,
  effectObservationsFromVerifiedAttestation,
  type VerifiedEffectAttestation,
} from "./effect-authority.js";
import { type ArtifactReceipt, EvidenceArtifactStore } from "./artifact-store.js";
import { EvidenceJournal, type JournalHead } from "./journal.js";
import { evaluateEvidenceKernel } from "./kernel.js";
import type {
  EvidenceBundle,
  EvidenceKernelInput,
  ExactAuthorizationDescriptor,
  JournalEventInput,
  JournalRecord,
  JsonValue,
  OperationDescriptor,
} from "./types.js";

const BUNDLE_DOMAIN = "x402-canary:journal-bound-evidence-bundle:v0.2";
const RECEIPT_DOMAIN = "x402-canary:journal-bound-evidence-receipt:v0.2";
const HASH = /^sha256:[0-9a-f]{64}$/;
const CORE_FIELDS = new Set([
  "schemaVersion",
  "evaluatedAt",
  "operation",
  "authorization",
  "attempt",
  "minimumConfirmations",
]);

export interface JournalBoundKernelInputV02 {
  schemaVersion: "0.2";
  evaluatedAt: string;
  operation: OperationDescriptor;
  authorization: ExactAuthorizationDescriptor;
  attempt: EvidenceKernelInput["attempt"];
  minimumConfirmations: number;
}

export interface ArtifactReference {
  namespace: string;
  artifactHash: string;
  byteLength: number;
}

export interface JournalCommitPointer {
  journalId: string;
  sequence: number;
  previousHash: string | null;
  recordHash: string;
  eventId: string;
  occurredAt: string;
}

export interface JournalBoundInputManifestV02 {
  schemaVersion: "0.2";
  kind: "kernel_input_manifest";
  operationId: string;
  authorizationId: string;
  attemptOpenedAt: string;
  sourceHead: JournalHead;
  artifacts: {
    attempt: ArtifactReference;
    base: ArtifactReference;
    effects: ArtifactReference[];
    evaluatorInput: ArtifactReference;
  };
}

export interface JournalBoundEvidenceBundleV02 {
  schemaVersion: "0.2";
  kind: "journal_bound_evidence_bundle";
  mode: "shadow_no_action";
  operationId: string;
  authorizationId: string;
  evaluatedAt: string;
  inputManifest: ArtifactReference;
  inputCommit: JournalCommitPointer;
  evaluation: EvidenceBundle;
  assurance: {
    scope: "journal_bound_base_effect_with_declared_attempt_facts";
    attemptFacts: {
      authorizationLifecycle: "journal_count_order_and_time_bound";
      remainingPredicates: "caller_declared_unverified";
    };
    baseCollection: {
      provenance: "runtime_branded_collector";
      transportAuthentication: "https_web_pki" | "test_injected";
      truthModel: "unanimous_operator_declared_rpc_trust_domains";
      historicalTransportOfflineReplay: false;
    };
    effectAuthority: {
      authentication: "ed25519_out_of_band_registry";
      policyBinding: "journal_attempt_time_and_locally_derived_query";
      runtimeSignatureVerification: "verified" | "not_applicable";
      offlineSignatureReverification: false;
      operatorDatabaseTruthIndependentlyProven: false;
    };
    persistence: {
      contentAddressedArtifacts: true;
      journalHashChainBound: true;
      writerModel: "cooperating_process_exclusive_sentinel_and_head_cas";
      crashStaleLockRequiresManualRecovery: true;
      trustedLocalWriterRequired: true;
      externalAntiRollbackCheckpoint: false;
    };
    execution: {
      paymentExecutionEnabled: false;
      transactionSubmissionEnabled: false;
      retryExecutionEnabled: false;
      actionExecutionEnabled: false;
    };
    externalTruthProven: false;
  };
  bundleHash: string;
}

export interface JournalBoundClosureReceiptV02 {
  schemaVersion: "0.2";
  kind: "journal_bound_bundle_closure";
  journalId: string;
  operationId: string;
  authorizationId: string;
  inputManifest: ArtifactReference;
  inputCommit: JournalCommitPointer;
  bundle: ArtifactReference;
  bundleCommit: JournalCommitPointer;
  closedAt: string;
  receiptHash: string;
}

export interface JournalBoundCommitResult {
  bundle: JournalBoundEvidenceBundleV02;
  receipt: JournalBoundClosureReceiptV02;
}

export interface JournalBundleRecoveryAudit {
  status: "clean" | "incomplete" | "invalid";
  pendingInputRecords: number[];
  orphanArtifactHashes: string[];
  issues: string[];
  temporaryFiles: string[];
}

export class JournalBundleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JournalBundleError";
  }
}

function fail(code: string): never {
  throw new JournalBundleError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, fields: ReadonlySet<string>, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${code}_NOT_OBJECT`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== fields.size ||
    (keys as string[]).some((key) => !fields.has(key)) ||
    [...fields].some((field) => !Object.prototype.hasOwnProperty.call(value, field))
  ) fail(`${code}_FIELDS_INVALID`);
  return value;
}

function clone<T>(value: T): T {
  try {
    const copy = structuredClone(value);
    canonicalJson(copy);
    return copy;
  } catch {
    return fail("BUNDLE_INPUT_NOT_CANONICAL_JSON");
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function hashCanonical(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

function requireHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(code);
  return value;
}

function canonicalTimestamp(value: unknown, code: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(code);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return time;
}

function reference(receipt: ArtifactReceipt): ArtifactReference {
  return {
    namespace: receipt.namespace,
    artifactHash: receipt.artifactHash,
    byteLength: receipt.byteLength,
  };
}

async function requirePersistedArtifact(
  store: EvidenceArtifactStore,
  artifactReference: ArtifactReference,
  expected: unknown,
  code: string,
): Promise<JsonValue> {
  const persisted = await store.getByReference(artifactReference);
  if (canonicalJson(persisted) !== canonicalJson(expected)) fail(code);
  return persisted;
}

function pointer(record: JournalRecord): JournalCommitPointer {
  return {
    journalId: record.journalId,
    sequence: record.sequence,
    previousHash: record.previousHash,
    recordHash: record.recordHash,
    eventId: record.eventId,
    occurredAt: record.occurredAt,
  };
}

function sameHead(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journalId === right.journalId &&
    left.sequence === right.sequence &&
    left.recordHash === right.recordHash
  );
}

function sourceHead(input: unknown): JournalHead {
  const value = exact(
    clone(input),
    new Set(["journalId", "sequence", "recordHash"]),
    "SOURCE_JOURNAL_HEAD",
  );
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0
  ) fail("SOURCE_JOURNAL_HEAD_SEQUENCE_INVALID");
  const recordHash =
    value.recordHash === null
      ? null
      : requireHash(value.recordHash, "SOURCE_JOURNAL_HEAD_HASH_INVALID");
  if ((value.sequence === 0) !== (recordHash === null)) {
    fail("SOURCE_JOURNAL_HEAD_SHAPE_INVALID");
  }
  return {
    journalId: requireHash(value.journalId, "SOURCE_JOURNAL_ID_INVALID"),
    sequence: value.sequence,
    recordHash,
  };
}

function assertSourceHeadOrExactReplay(
  records: readonly JournalRecord[],
  current: JournalHead,
  expected: JournalHead,
  operationId: string,
  authorizationId: string,
): void {
  if (expected.journalId !== current.journalId || expected.sequence > records.length) {
    fail("SOURCE_JOURNAL_HEAD_MISMATCH");
  }
  const expectedRecord = expected.sequence === 0 ? undefined : records[expected.sequence - 1];
  if ((expectedRecord?.recordHash ?? null) !== expected.recordHash) {
    fail("SOURCE_JOURNAL_HEAD_MISMATCH");
  }
  if (sameHead(expected, current)) return;
  const replayInput = records[expected.sequence];
  if (
    !replayInput ||
    replayInput.kind !== "kernel_input_committed" ||
    replayInput.previousHash !== expected.recordHash ||
    replayInput.operationId !== operationId ||
    replayInput.authorizationId !== authorizationId
  ) fail("SOURCE_JOURNAL_HEAD_MISMATCH");
}

function coreInput(input: unknown): JournalBoundKernelInputV02 {
  const value = exact(clone(input), CORE_FIELDS, "BOUND_CORE_INPUT");
  if (value.schemaVersion !== "0.2") fail("BOUND_CORE_SCHEMA_INVALID");
  canonicalTimestamp(value.evaluatedAt, "BOUND_CORE_EVALUATED_AT_INVALID");
  return value as unknown as JournalBoundKernelInputV02;
}

function controlledAttempt(
  records: readonly JournalRecord[],
  operationId: string,
  authorizationId: string,
  input: JournalBoundKernelInputV02,
): JournalRecord {
  const operationRecords = records.filter((record) => record.operationId === operationId);
  const opens = operationRecords.filter((record) => record.kind === "attempt_opened");
  if (opens.length !== 1) fail("ATTEMPT_OPEN_RECORD_COUNT_INVALID");
  if (
    operationRecords.some(
      (record) => record.kind === "attempt_closed",
    )
  ) fail("ATTEMPT_ALREADY_CLOSED");
  const opened = opens[0]!;
  if (
    opened.authorizationId !== undefined &&
    opened.authorizationId !== authorizationId
  ) fail("ATTEMPT_OPEN_AUTHORIZATION_ID_CONFLICT");
  const openedAt = canonicalTimestamp(opened.occurredAt, "ATTEMPT_OPEN_TIME_INVALID");
  const evaluatedAt = canonicalTimestamp(
    input.evaluatedAt,
    "BOUND_CORE_EVALUATED_AT_INVALID",
  );
  if (openedAt > evaluatedAt) {
    fail("ATTEMPT_OPEN_AFTER_EVALUATION");
  }

  const authorizationRecords = operationRecords.filter(
    (record) =>
      record.kind === "authorization_recorded" || record.kind === "authorization_transmitted",
  );
  if (
    authorizationRecords.some(
      (record) => record.authorizationId !== authorizationId,
    )
  ) fail("ATTEMPT_AUTHORIZATION_ID_CONFLICT");
  for (const record of authorizationRecords) {
    const occurredAt = canonicalTimestamp(record.occurredAt, "ATTEMPT_AUTHORIZATION_TIME_INVALID");
    if (record.sequence <= opened.sequence || occurredAt < openedAt || occurredAt > evaluatedAt) {
      fail("ATTEMPT_AUTHORIZATION_EVENT_ORDER_OR_TIME_INVALID");
    }
  }
  const recorded = authorizationRecords.filter(
    (record) => record.kind === "authorization_recorded",
  );
  const transmitted = authorizationRecords.filter(
    (record) => record.kind === "authorization_transmitted",
  );
  if (recorded.length !== (input.attempt.authorizationCreated ? 1 : 0)) {
    fail("ATTEMPT_AUTHORIZATION_CREATED_NOT_JOURNALED");
  }
  if (transmitted.length !== (input.attempt.authorizationTransmitted === "pass" ? 1 : 0)) {
    fail("ATTEMPT_AUTHORIZATION_TRANSMISSION_NOT_JOURNALED");
  }
  if (
    recorded.length === 1 &&
    transmitted.length === 1 &&
    (transmitted[0]!.sequence <= recorded[0]!.sequence ||
      canonicalTimestamp(transmitted[0]!.occurredAt, "ATTEMPT_TRANSMITTED_TIME_INVALID") <
        canonicalTimestamp(recorded[0]!.occurredAt, "ATTEMPT_RECORDED_TIME_INVALID"))
  ) fail("ATTEMPT_AUTHORIZATION_TRANSMITTED_BEFORE_RECORDED");
  return opened;
}

function inputEventEvidence(
  manifest: ArtifactReference,
  sourceHead: JournalHead,
  baseRegistryHash: string,
  baseCollectionHash: string,
  effectAttestationHashes: string[],
): JsonValue {
  return {
    schemaVersion: "0.2",
    inputManifestArtifactHash: manifest.artifactHash,
    sourceHead: {
      journalId: sourceHead.journalId,
      sequence: sourceHead.sequence,
      recordHash: sourceHead.recordHash,
    },
    baseRegistryHash,
    baseCollectionHash,
    effectAttestationHashes,
  };
}

function bundleEventEvidence(
  inputCommit: JournalRecord,
  inputManifest: ArtifactReference,
  bundle: JournalBoundEvidenceBundleV02,
  bundleArtifact: ArtifactReference,
): JsonValue {
  return {
    schemaVersion: "0.2",
    inputCommitRecordHash: inputCommit.recordHash,
    inputManifestArtifactHash: inputManifest.artifactHash,
    bundleHash: bundle.bundleHash,
    bundleArtifactHash: bundleArtifact.artifactHash,
  };
}

function deterministicEventId(prefix: string, hash: string): string {
  return `${prefix}:${hash.slice("sha256:".length)}`;
}

/**
 * Close one shadow evaluation through a content-addressed input commit, bundle
 * commit, and separate non-circular closure receipt.
 */
export async function closeJournalBoundEvidenceBundle(input: {
  journal: EvidenceJournal;
  artifactStore: EvidenceArtifactStore;
  expectedHead: JournalHead;
  core: unknown;
  baseRegistry: BaseRpcSourceRegistry;
  baseCollection: BaseEvidenceCollection;
  verifiedEffects: readonly VerifiedEffectAttestation[];
}): Promise<JournalBoundCommitResult> {
  const core = coreInput(input.core);
  const operation = deriveOperationIdentity(core.operation);
  const authorization = deriveAuthorizationIdentity(core.authorization);
  const expectedHead = sourceHead(input.expectedHead);
  const journalRecords = input.journal.readAll();
  assertSourceHeadOrExactReplay(
    journalRecords,
    input.journal.head(),
    expectedHead,
    operation.id,
    authorization.id,
  );
  const opened = controlledAttempt(
    journalRecords,
    operation.id,
    authorization.id,
    core,
  );

  assertCollectedBaseEvidence(input.baseRegistry, input.baseCollection);
  const baseArtifact = baseEvidenceArtifactFromCollection(
    input.baseRegistry,
    input.baseCollection,
  );
  if (baseArtifact.authorizationId !== authorization.id) {
    fail("BASE_COLLECTION_AUTHORIZATION_MISMATCH");
  }
  const evaluatedAtMs = canonicalTimestamp(core.evaluatedAt, "BOUND_CORE_EVALUATED_AT_INVALID");
  if (
    canonicalTimestamp(input.baseCollection.collectedAt, "BASE_COLLECTION_TIME_INVALID") >
    evaluatedAtMs
  ) fail("BASE_COLLECTION_AFTER_EVALUATION");

  if (!Array.isArray(input.verifiedEffects) || input.verifiedEffects.length > 32) {
    fail("VERIFIED_EFFECTS_INVALID");
  }
  if (core.attempt.effectContractApplicable !== (input.verifiedEffects.length > 0)) {
    fail("EFFECT_AUTHORITY_APPLICABILITY_MISMATCH");
  }
  const verifiedEffects = [...input.verifiedEffects];
  const effectArtifacts = verifiedEffects.map((verified) => {
    const artifact = effectAuthorityArtifactFromVerifiedAttestation(verified);
    if (verified.operationId !== operation.id) fail("EFFECT_OPERATION_MISMATCH");
    if (verified.operationStartedAt !== opened.occurredAt) {
      fail("EFFECT_OPERATION_START_NOT_JOURNAL_BOUND");
    }
    if (canonicalTimestamp(verified.verifiedAt, "EFFECT_VERIFIED_AT_INVALID") > evaluatedAtMs) {
      fail("EFFECT_VERIFIED_AFTER_EVALUATION");
    }
    return { verified, artifact };
  });
  effectArtifacts.sort((left, right) =>
    left.verified.attestationHash.localeCompare(right.verified.attestationHash),
  );
  const attestationHashes = effectArtifacts.map((entry) => entry.verified.attestationHash);
  if (new Set(attestationHashes).size !== attestationHashes.length) {
    fail("DUPLICATE_EFFECT_ATTESTATION");
  }

  const effectObservations = effectArtifacts.flatMap((entry) =>
    [...effectObservationsFromVerifiedAttestation(entry.verified)],
  );
  const evaluatorInput: EvidenceKernelInput = {
    schemaVersion: "0.1",
    evaluatedAt: core.evaluatedAt,
    operation: core.operation,
    authorization: core.authorization,
    attempt: core.attempt,
    minimumConfirmations: core.minimumConfirmations,
    receiptObservations: input.baseCollection.receiptObservations,
    authorizationStateObservations: input.baseCollection.authorizationStateObservations,
    effectObservations,
  };
  // Validate everything before the first journal commit. Retry assertions are
  // deliberately absent from v0.2 until they have their own authority proof.
  evaluateEvidenceKernel(evaluatorInput);

  const attemptArtifact = {
    schemaVersion: "0.2" as const,
    kind: "operation_attempt" as const,
    operationId: operation.id,
    authorizationId: authorization.id,
    opened: pointer(opened),
    operation: core.operation,
    authorization: core.authorization,
    attempt: core.attempt,
    minimumConfirmations: core.minimumConfirmations,
    evaluatedAt: core.evaluatedAt,
  };
  const attemptReceipt = await input.artifactStore.put("operation-attempt", attemptArtifact);
  const baseReceipt = await input.artifactStore.put("base-collection", baseArtifact);
  const effectReceipts: ArtifactReceipt[] = [];
  for (const entry of effectArtifacts) {
    effectReceipts.push(
      await input.artifactStore.put("effect-attestation", entry.artifact),
    );
  }
  const evaluatorReceipt = await input.artifactStore.put("kernel-evaluator-input", evaluatorInput);
  const manifest: JournalBoundInputManifestV02 = {
    schemaVersion: "0.2",
    kind: "kernel_input_manifest",
    operationId: operation.id,
    authorizationId: authorization.id,
    attemptOpenedAt: opened.occurredAt,
    sourceHead: clone(expectedHead),
    artifacts: {
      attempt: reference(attemptReceipt),
      base: reference(baseReceipt),
      effects: effectReceipts.map(reference),
      evaluatorInput: reference(evaluatorReceipt),
    },
  };
  const manifestReceipt = await input.artifactStore.put("kernel-input-manifest", manifest);
  const manifestReference = reference(manifestReceipt);
  await requirePersistedArtifact(
    input.artifactStore,
    reference(attemptReceipt),
    attemptArtifact,
    "PERSISTED_ATTEMPT_ARTIFACT_MISMATCH",
  );
  await requirePersistedArtifact(
    input.artifactStore,
    reference(baseReceipt),
    baseArtifact,
    "PERSISTED_BASE_ARTIFACT_MISMATCH",
  );
  for (const [index, entry] of effectArtifacts.entries()) {
    await requirePersistedArtifact(
      input.artifactStore,
      reference(effectReceipts[index]!),
      entry.artifact,
      "PERSISTED_EFFECT_ARTIFACT_MISMATCH",
    );
  }
  await requirePersistedArtifact(
    input.artifactStore,
    reference(evaluatorReceipt),
    evaluatorInput,
    "PERSISTED_EVALUATOR_ARTIFACT_MISMATCH",
  );
  await requirePersistedArtifact(
    input.artifactStore,
    manifestReference,
    manifest,
    "PERSISTED_MANIFEST_ARTIFACT_MISMATCH",
  );
  const inputEvent: JournalEventInput = {
    eventId: deterministicEventId("kernel-input", manifestReceipt.artifactHash),
    operationId: operation.id,
    authorizationId: authorization.id,
    kind: "kernel_input_committed",
    occurredAt: core.evaluatedAt,
    evidence: inputEventEvidence(
      manifestReference,
      expectedHead,
      input.baseRegistry.registryHash,
      input.baseCollection.collectionHash,
      attestationHashes,
    ),
  };
  const inputCommitResult = await input.journal.appendOnceAtHead(expectedHead, inputEvent);
  const inputCommit = inputCommitResult.record;

  const persistedEvaluatorInput = await input.artifactStore.getByReference(
    reference(evaluatorReceipt),
  );
  const evaluation = evaluateEvidenceKernel(persistedEvaluatorInput);
  const unsignedBundle = {
    schemaVersion: "0.2" as const,
    kind: "journal_bound_evidence_bundle" as const,
    mode: "shadow_no_action" as const,
    operationId: operation.id,
    authorizationId: authorization.id,
    evaluatedAt: core.evaluatedAt,
    inputManifest: manifestReference,
    inputCommit: pointer(inputCommit),
    evaluation,
    assurance: {
      scope: "journal_bound_base_effect_with_declared_attempt_facts" as const,
      attemptFacts: {
        authorizationLifecycle: "journal_count_order_and_time_bound" as const,
        remainingPredicates: "caller_declared_unverified" as const,
      },
      baseCollection: {
        provenance: "runtime_branded_collector" as const,
        transportAuthentication: input.baseCollection.assurance.transportAuthentication,
        truthModel: "unanimous_operator_declared_rpc_trust_domains" as const,
        historicalTransportOfflineReplay: false as const,
      },
      effectAuthority: {
        authentication: "ed25519_out_of_band_registry" as const,
        policyBinding: "journal_attempt_time_and_locally_derived_query" as const,
        runtimeSignatureVerification: core.attempt.effectContractApplicable
          ? ("verified" as const)
          : ("not_applicable" as const),
        offlineSignatureReverification: false as const,
        operatorDatabaseTruthIndependentlyProven: false as const,
      },
      persistence: {
        contentAddressedArtifacts: true as const,
        journalHashChainBound: true as const,
        writerModel: "cooperating_process_exclusive_sentinel_and_head_cas" as const,
        crashStaleLockRequiresManualRecovery: true as const,
        trustedLocalWriterRequired: true as const,
        externalAntiRollbackCheckpoint: false as const,
      },
      execution: {
        paymentExecutionEnabled: false as const,
        transactionSubmissionEnabled: false as const,
        retryExecutionEnabled: false as const,
        actionExecutionEnabled: false as const,
      },
      externalTruthProven: false as const,
    },
  };
  const bundle: JournalBoundEvidenceBundleV02 = {
    ...unsignedBundle,
    bundleHash: hashCanonical(BUNDLE_DOMAIN, unsignedBundle),
  };
  const bundleReceipt = await input.artifactStore.put("kernel-bundle", bundle);
  const bundleReference = reference(bundleReceipt);
  await requirePersistedArtifact(
    input.artifactStore,
    bundleReference,
    bundle,
    "PERSISTED_BUNDLE_ARTIFACT_MISMATCH",
  );
  const inputHead: JournalHead = {
    journalId: inputCommit.journalId,
    sequence: inputCommit.sequence,
    recordHash: inputCommit.recordHash,
  };
  const bundleEvent: JournalEventInput = {
    eventId: deterministicEventId("kernel-bundle", bundle.bundleHash),
    operationId: operation.id,
    authorizationId: authorization.id,
    kind: "kernel_bundle_committed",
    occurredAt: core.evaluatedAt,
    evidence: bundleEventEvidence(inputCommit, manifestReference, bundle, bundleReference),
  };
  const bundleCommitResult = await input.journal.appendOnceAtHead(inputHead, bundleEvent);
  const bundleCommit = bundleCommitResult.record;
  const unsignedReceipt = {
    schemaVersion: "0.2" as const,
    kind: "journal_bound_bundle_closure" as const,
    journalId: input.journal.journalId,
    operationId: operation.id,
    authorizationId: authorization.id,
    inputManifest: manifestReference,
    inputCommit: pointer(inputCommit),
    bundle: bundleReference,
    bundleCommit: pointer(bundleCommit),
    closedAt: bundleCommit.occurredAt,
  };
  const receipt: JournalBoundClosureReceiptV02 = {
    ...unsignedReceipt,
    receiptHash: hashCanonical(RECEIPT_DOMAIN, unsignedReceipt),
  };
  const verifiedBundle = await verifyJournalBoundBundleIntegrity(
    input.journal,
    input.artifactStore,
    receipt,
  );
  return deepFreeze({ bundle: verifiedBundle, receipt });
}

function requireReference(
  value: unknown,
  code: string,
  expectedNamespace?: string,
): ArtifactReference {
  const record = exact(value, new Set(["namespace", "artifactHash", "byteLength"]), code);
  if (
    typeof record.namespace !== "string" ||
    typeof record.byteLength !== "number" ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength <= 0
  ) fail(`${code}_INVALID`);
  if (expectedNamespace !== undefined && record.namespace !== expectedNamespace) {
    fail(`${code}_NAMESPACE_INVALID`);
  }
  return {
    namespace: record.namespace,
    artifactHash: requireHash(record.artifactHash, `${code}_HASH_INVALID`),
    byteLength: record.byteLength,
  };
}

function requirePointer(value: unknown, code: string): JournalCommitPointer {
  const record = exact(
    value,
    new Set([
      "journalId",
      "sequence",
      "previousHash",
      "recordHash",
      "eventId",
      "occurredAt",
    ]),
    code,
  );
  if (
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.eventId !== "string"
  ) fail(`${code}_INVALID`);
  if (record.previousHash !== null) requireHash(record.previousHash, `${code}_PREVIOUS_HASH_INVALID`);
  canonicalTimestamp(record.occurredAt, `${code}_TIME_INVALID`);
  return {
    journalId: requireHash(record.journalId, `${code}_JOURNAL_ID_INVALID`),
    sequence: record.sequence,
    previousHash: record.previousHash as string | null,
    recordHash: requireHash(record.recordHash, `${code}_RECORD_HASH_INVALID`),
    eventId: record.eventId,
    occurredAt: record.occurredAt as string,
  };
}

function requireInputManifest(value: unknown): JournalBoundInputManifestV02 {
  const manifest = exact(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "operationId",
      "authorizationId",
      "attemptOpenedAt",
      "sourceHead",
      "artifacts",
    ]),
    "INPUT_MANIFEST",
  );
  if (manifest.schemaVersion !== "0.2" || manifest.kind !== "kernel_input_manifest") {
    fail("INPUT_MANIFEST_SCHEMA_INVALID");
  }
  canonicalTimestamp(manifest.attemptOpenedAt, "INPUT_MANIFEST_ATTEMPT_TIME_INVALID");
  const artifacts = exact(
    manifest.artifacts,
    new Set(["attempt", "base", "effects", "evaluatorInput"]),
    "INPUT_MANIFEST_ARTIFACTS",
  );
  if (!Array.isArray(artifacts.effects) || artifacts.effects.length > 32) {
    fail("INPUT_MANIFEST_EFFECTS_INVALID");
  }
  return {
    schemaVersion: "0.2",
    kind: "kernel_input_manifest",
    operationId: requireHash(manifest.operationId, "INPUT_MANIFEST_OPERATION_ID_INVALID"),
    authorizationId: requireHash(
      manifest.authorizationId,
      "INPUT_MANIFEST_AUTHORIZATION_ID_INVALID",
    ),
    attemptOpenedAt: manifest.attemptOpenedAt as string,
    sourceHead: sourceHead(manifest.sourceHead),
    artifacts: {
      attempt: requireReference(
        artifacts.attempt,
        "INPUT_MANIFEST_ATTEMPT",
        "operation-attempt",
      ),
      base: requireReference(artifacts.base, "INPUT_MANIFEST_BASE", "base-collection"),
      effects: artifacts.effects.map((entry, index) =>
        requireReference(
          entry,
          `INPUT_MANIFEST_EFFECT_${index}`,
          "effect-attestation",
        ),
      ),
      evaluatorInput: requireReference(
        artifacts.evaluatorInput,
        "INPUT_MANIFEST_EVALUATOR",
        "kernel-evaluator-input",
      ),
    },
  };
}

function parseReceipt(input: unknown): JournalBoundClosureReceiptV02 {
  const value = exact(
    clone(input),
    new Set([
      "schemaVersion",
      "kind",
      "journalId",
      "operationId",
      "authorizationId",
      "inputManifest",
      "inputCommit",
      "bundle",
      "bundleCommit",
      "closedAt",
      "receiptHash",
    ]),
    "CLOSURE_RECEIPT",
  );
  if (value.schemaVersion !== "0.2" || value.kind !== "journal_bound_bundle_closure") {
    fail("CLOSURE_RECEIPT_SCHEMA_INVALID");
  }
  const receipt: JournalBoundClosureReceiptV02 = {
    schemaVersion: "0.2",
    kind: "journal_bound_bundle_closure",
    journalId: requireHash(value.journalId, "CLOSURE_JOURNAL_ID_INVALID"),
    operationId: requireHash(value.operationId, "CLOSURE_OPERATION_ID_INVALID"),
    authorizationId: requireHash(value.authorizationId, "CLOSURE_AUTHORIZATION_ID_INVALID"),
    inputManifest: requireReference(
      value.inputManifest,
      "CLOSURE_INPUT_MANIFEST",
      "kernel-input-manifest",
    ),
    inputCommit: requirePointer(value.inputCommit, "CLOSURE_INPUT_COMMIT"),
    bundle: requireReference(value.bundle, "CLOSURE_BUNDLE", "kernel-bundle"),
    bundleCommit: requirePointer(value.bundleCommit, "CLOSURE_BUNDLE_COMMIT"),
    closedAt: value.closedAt as string,
    receiptHash: requireHash(value.receiptHash, "CLOSURE_RECEIPT_HASH_INVALID"),
  };
  canonicalTimestamp(receipt.closedAt, "CLOSURE_CLOSED_AT_INVALID");
  const { receiptHash, ...unsigned } = receipt;
  if (hashCanonical(RECEIPT_DOMAIN, unsigned) !== receiptHash) {
    fail("CLOSURE_RECEIPT_INTEGRITY_MISMATCH");
  }
  return receipt;
}

function evidenceRecord(record: JournalRecord): Record<string, unknown> {
  if (!isRecord(record.evidence)) fail("JOURNAL_COMMIT_EVIDENCE_INVALID");
  return record.evidence;
}

/** Recompute the complete local integrity closure; this grants no runtime brand. */
export async function verifyJournalBoundBundleIntegrity(
  journal: EvidenceJournal,
  artifactStore: EvidenceArtifactStore,
  receiptInput: unknown,
): Promise<JournalBoundEvidenceBundleV02> {
  const receipt = parseReceipt(receiptInput);
  if (receipt.journalId !== journal.journalId) fail("CLOSURE_JOURNAL_MISMATCH");
  const records = journal.readAll();
  const inputRecord = records[receipt.inputCommit.sequence - 1];
  const bundleRecord = records[receipt.bundleCommit.sequence - 1];
  if (
    !inputRecord ||
    inputRecord.kind !== "kernel_input_committed" ||
    canonicalJson(pointer(inputRecord)) !== canonicalJson(receipt.inputCommit)
  ) fail("CLOSURE_INPUT_COMMIT_MISMATCH");
  if (
    !bundleRecord ||
    bundleRecord.kind !== "kernel_bundle_committed" ||
    canonicalJson(pointer(bundleRecord)) !== canonicalJson(receipt.bundleCommit) ||
    bundleRecord.previousHash !== inputRecord.recordHash ||
    bundleRecord.sequence !== inputRecord.sequence + 1
  ) fail("CLOSURE_BUNDLE_COMMIT_MISMATCH");
  if (
    inputRecord.operationId !== receipt.operationId ||
    bundleRecord.operationId !== receipt.operationId ||
    inputRecord.authorizationId !== receipt.authorizationId ||
    bundleRecord.authorizationId !== receipt.authorizationId ||
    receipt.closedAt !== bundleRecord.occurredAt
  ) fail("CLOSURE_OPERATION_BINDING_MISMATCH");

  const inputEvidence = exact(
    evidenceRecord(inputRecord),
    new Set([
      "schemaVersion",
      "inputManifestArtifactHash",
      "sourceHead",
      "baseRegistryHash",
      "baseCollectionHash",
      "effectAttestationHashes",
    ]),
    "CLOSURE_INPUT_COMMIT_EVIDENCE",
  );
  const bundleEvidence = exact(
    evidenceRecord(bundleRecord),
    new Set([
      "schemaVersion",
      "inputCommitRecordHash",
      "inputManifestArtifactHash",
      "bundleHash",
      "bundleArtifactHash",
    ]),
    "CLOSURE_BUNDLE_COMMIT_EVIDENCE",
  );
  if (inputEvidence.schemaVersion !== "0.2" || bundleEvidence.schemaVersion !== "0.2") {
    fail("CLOSURE_JOURNAL_EVIDENCE_SCHEMA_INVALID");
  }
  if (
    inputEvidence.inputManifestArtifactHash !== receipt.inputManifest.artifactHash ||
    bundleEvidence.inputManifestArtifactHash !== receipt.inputManifest.artifactHash ||
    bundleEvidence.inputCommitRecordHash !== inputRecord.recordHash ||
    bundleEvidence.bundleArtifactHash !== receipt.bundle.artifactHash
  ) fail("CLOSURE_JOURNAL_ARTIFACT_REFERENCE_MISMATCH");

  const rawBundle = exact(
    await artifactStore.getByReference(receipt.bundle),
    new Set([
      "schemaVersion",
      "kind",
      "mode",
      "operationId",
      "authorizationId",
      "evaluatedAt",
      "inputManifest",
      "inputCommit",
      "evaluation",
      "assurance",
      "bundleHash",
    ]),
    "CLOSURE_BUNDLE_ARTIFACT",
  );
  if (
    rawBundle.schemaVersion !== "0.2" ||
    rawBundle.kind !== "journal_bound_evidence_bundle" ||
    rawBundle.mode !== "shadow_no_action"
  ) fail("CLOSURE_BUNDLE_SCHEMA_INVALID");
  canonicalTimestamp(rawBundle.evaluatedAt, "CLOSURE_BUNDLE_EVALUATED_AT_INVALID");
  const bundleHash = requireHash(rawBundle.bundleHash, "CLOSURE_BUNDLE_HASH_INVALID");
  const { bundleHash: ignored, ...unsignedBundle } = rawBundle;
  void ignored;
  if (
    hashCanonical(BUNDLE_DOMAIN, unsignedBundle) !== bundleHash ||
    bundleEvidence.bundleHash !== bundleHash
  ) fail("CLOSURE_BUNDLE_INTEGRITY_MISMATCH");
  if (
    rawBundle.operationId !== receipt.operationId ||
    rawBundle.authorizationId !== receipt.authorizationId ||
    canonicalJson(rawBundle.inputCommit) !== canonicalJson(receipt.inputCommit) ||
    canonicalJson(rawBundle.inputManifest) !== canonicalJson(receipt.inputManifest)
  ) fail("CLOSURE_BUNDLE_BINDING_MISMATCH");

  const manifest = requireInputManifest(
    await artifactStore.getByReference(receipt.inputManifest),
  );
  const expectedSourceHead: JournalHead = {
    journalId: receipt.journalId,
    sequence: inputRecord.sequence - 1,
    recordHash: inputRecord.previousHash,
  };
  const committedSourceHead = sourceHead(inputEvidence.sourceHead);
  if (
    manifest.operationId !== receipt.operationId ||
    manifest.authorizationId !== receipt.authorizationId ||
    !sameHead(manifest.sourceHead, expectedSourceHead) ||
    !sameHead(committedSourceHead, expectedSourceHead) ||
    inputRecord.occurredAt !== rawBundle.evaluatedAt ||
    bundleRecord.occurredAt !== rawBundle.evaluatedAt
  ) fail("CLOSURE_INPUT_MANIFEST_BINDING_MISMATCH");

  const persistedEvaluator = exact(
    await artifactStore.getByReference(manifest.artifacts.evaluatorInput),
    new Set([
      "schemaVersion",
      "evaluatedAt",
      "operation",
      "authorization",
      "attempt",
      "minimumConfirmations",
      "receiptObservations",
      "authorizationStateObservations",
      "effectObservations",
    ]),
    "CLOSURE_EVALUATOR_INPUT",
  );
  const recomputedEvaluation = evaluateEvidenceKernel(persistedEvaluator);
  if (canonicalJson(recomputedEvaluation) !== canonicalJson(rawBundle.evaluation)) {
    fail("CLOSURE_EVALUATION_MISMATCH");
  }

  let evaluatorOperationId: string;
  let evaluatorAuthorizationId: string;
  try {
    evaluatorOperationId = deriveOperationIdentity(
      persistedEvaluator.operation as OperationDescriptor,
    ).id;
    evaluatorAuthorizationId = deriveAuthorizationIdentity(
      persistedEvaluator.authorization as ExactAuthorizationDescriptor,
    ).id;
  } catch {
    return fail("CLOSURE_EVALUATOR_IDENTITY_INVALID");
  }
  if (
    persistedEvaluator.schemaVersion !== "0.1" ||
    persistedEvaluator.evaluatedAt !== rawBundle.evaluatedAt ||
    evaluatorOperationId !== receipt.operationId ||
    evaluatorAuthorizationId !== receipt.authorizationId
  ) fail("CLOSURE_EVALUATOR_BINDING_MISMATCH");

  const attemptArtifact = exact(
    await artifactStore.getByReference(manifest.artifacts.attempt),
    new Set([
      "schemaVersion",
      "kind",
      "operationId",
      "authorizationId",
      "opened",
      "operation",
      "authorization",
      "attempt",
      "minimumConfirmations",
      "evaluatedAt",
    ]),
    "CLOSURE_ATTEMPT_ARTIFACT",
  );
  const openedPointer = requirePointer(attemptArtifact.opened, "CLOSURE_ATTEMPT_OPENED");
  const openedRecord = records[openedPointer.sequence - 1];
  if (
    attemptArtifact.schemaVersion !== "0.2" ||
    attemptArtifact.kind !== "operation_attempt" ||
    attemptArtifact.operationId !== receipt.operationId ||
    attemptArtifact.authorizationId !== receipt.authorizationId ||
    attemptArtifact.evaluatedAt !== rawBundle.evaluatedAt ||
    manifest.attemptOpenedAt !== openedPointer.occurredAt ||
    !openedRecord ||
    openedRecord.kind !== "attempt_opened" ||
    openedRecord.operationId !== receipt.operationId ||
    canonicalJson(pointer(openedRecord)) !== canonicalJson(openedPointer) ||
    canonicalJson(attemptArtifact.operation) !== canonicalJson(persistedEvaluator.operation) ||
    canonicalJson(attemptArtifact.authorization) !==
      canonicalJson(persistedEvaluator.authorization) ||
    canonicalJson(attemptArtifact.attempt) !== canonicalJson(persistedEvaluator.attempt) ||
    attemptArtifact.minimumConfirmations !== persistedEvaluator.minimumConfirmations
  ) fail("CLOSURE_ATTEMPT_ARTIFACT_BINDING_MISMATCH");

  const baseArtifact = exact(
    await artifactStore.getByReference(manifest.artifacts.base),
    new Set([
      "schemaVersion",
      "registryHash",
      "collectionHash",
      "observationHash",
      "authorizationId",
      "requestedTransactionHash",
      "collection",
    ]),
    "CLOSURE_BASE_ARTIFACT",
  );
  if (
    !isRecord(baseArtifact.collection) ||
    !isRecord(baseArtifact.collection.assurance)
  ) fail("CLOSURE_BASE_COLLECTION_INVALID");
  requireHash(baseArtifact.registryHash, "CLOSURE_BASE_REGISTRY_HASH_INVALID");
  requireHash(baseArtifact.collectionHash, "CLOSURE_BASE_COLLECTION_HASH_INVALID");
  requireHash(baseArtifact.observationHash, "CLOSURE_BASE_OBSERVATION_HASH_INVALID");
  const baseTransportAuthentication = baseArtifact.collection.assurance.transportAuthentication;
  if (
    baseTransportAuthentication !== "https_web_pki" &&
    baseTransportAuthentication !== "test_injected"
  ) fail("CLOSURE_BASE_TRANSPORT_ASSURANCE_INVALID");
  if (
    baseArtifact.schemaVersion !== "0.1" ||
    baseArtifact.authorizationId !== receipt.authorizationId ||
    baseArtifact.registryHash !== inputEvidence.baseRegistryHash ||
    baseArtifact.collectionHash !== inputEvidence.baseCollectionHash ||
    baseArtifact.collection.registryHash !== baseArtifact.registryHash ||
    baseArtifact.collection.collectionHash !== baseArtifact.collectionHash ||
    baseArtifact.collection.observationHash !== baseArtifact.observationHash ||
    canonicalTimestamp(
      baseArtifact.collection.collectedAt,
      "CLOSURE_BASE_COLLECTION_TIME_INVALID",
    ) > canonicalTimestamp(rawBundle.evaluatedAt, "CLOSURE_BUNDLE_EVALUATED_AT_INVALID") ||
    canonicalJson(baseArtifact.collection.receiptObservations) !==
      canonicalJson(persistedEvaluator.receiptObservations) ||
    canonicalJson(baseArtifact.collection.authorizationStateObservations) !==
      canonicalJson(persistedEvaluator.authorizationStateObservations)
  ) fail("CLOSURE_BASE_ARTIFACT_BINDING_MISMATCH");

  if (!Array.isArray(inputEvidence.effectAttestationHashes)) {
    fail("CLOSURE_EFFECT_HASHES_INVALID");
  }
  const effectHashes: string[] = [];
  for (const [index, effectReference] of manifest.artifacts.effects.entries()) {
    const effectArtifact = exact(
      await artifactStore.getByReference(effectReference),
      new Set([
        "schemaVersion",
        "registryHash",
        "contractId",
        "resolutionHash",
        "attestationHash",
        "verifiedAt",
        "query",
        "attestation",
      ]),
      `CLOSURE_EFFECT_ARTIFACT_${index}`,
    );
    if (!isRecord(effectArtifact.query) || !isRecord(effectArtifact.attestation)) {
      fail("CLOSURE_EFFECT_ARTIFACT_INVALID");
    }
    canonicalTimestamp(effectArtifact.verifiedAt, "CLOSURE_EFFECT_VERIFIED_AT_INVALID");
    const attestationHash = requireHash(
      effectArtifact.attestationHash,
      "CLOSURE_EFFECT_ATTESTATION_HASH_INVALID",
    );
    if (
      effectArtifact.schemaVersion !== "0.1" ||
      effectArtifact.query.operationId !== receipt.operationId ||
      effectArtifact.query.operationStartedAt !== manifest.attemptOpenedAt ||
      canonicalTimestamp(effectArtifact.verifiedAt, "CLOSURE_EFFECT_VERIFIED_AT_INVALID") >
        canonicalTimestamp(rawBundle.evaluatedAt, "CLOSURE_BUNDLE_EVALUATED_AT_INVALID")
    ) fail("CLOSURE_EFFECT_ARTIFACT_BINDING_MISMATCH");
    effectHashes.push(attestationHash);
  }
  if (
    new Set(effectHashes).size !== effectHashes.length ||
    canonicalJson(effectHashes) !== canonicalJson([...effectHashes].sort()) ||
    canonicalJson(effectHashes) !== canonicalJson(inputEvidence.effectAttestationHashes) ||
    (persistedEvaluator.attempt as Record<string, unknown>).effectContractApplicable !==
      (effectHashes.length > 0)
  ) fail("CLOSURE_EFFECT_SET_BINDING_MISMATCH");

  const expectedAssurance = {
    scope: "journal_bound_base_effect_with_declared_attempt_facts",
    attemptFacts: {
      authorizationLifecycle: "journal_count_order_and_time_bound",
      remainingPredicates: "caller_declared_unverified",
    },
    baseCollection: {
      provenance: "runtime_branded_collector",
      transportAuthentication: baseTransportAuthentication,
      truthModel: "unanimous_operator_declared_rpc_trust_domains",
      historicalTransportOfflineReplay: false,
    },
    effectAuthority: {
      authentication: "ed25519_out_of_band_registry",
      policyBinding: "journal_attempt_time_and_locally_derived_query",
      runtimeSignatureVerification: effectHashes.length > 0 ? "verified" : "not_applicable",
      offlineSignatureReverification: false,
      operatorDatabaseTruthIndependentlyProven: false,
    },
    persistence: {
      contentAddressedArtifacts: true,
      journalHashChainBound: true,
      writerModel: "cooperating_process_exclusive_sentinel_and_head_cas",
      crashStaleLockRequiresManualRecovery: true,
      trustedLocalWriterRequired: true,
      externalAntiRollbackCheckpoint: false,
    },
    execution: {
      paymentExecutionEnabled: false,
      transactionSubmissionEnabled: false,
      retryExecutionEnabled: false,
      actionExecutionEnabled: false,
    },
    externalTruthProven: false,
  };
  if (canonicalJson(rawBundle.assurance) !== canonicalJson(expectedAssurance)) {
    fail("CLOSURE_ASSURANCE_MISMATCH");
  }
  return deepFreeze(clone(rawBundle as unknown as JournalBoundEvidenceBundleV02));
}

async function referenceFromInspection(
  artifactStore: EvidenceArtifactStore,
  namespace: string,
  artifactHash: string,
  code: string,
): Promise<ArtifactReference> {
  const inspection = await artifactStore.inspect();
  const matches = inspection.artifacts.filter(
    (artifact) =>
      artifact.namespace === namespace && artifact.artifactHash === artifactHash,
  );
  if (matches.length !== 1) fail(code);
  return reference(matches[0]!);
}

/**
 * Regenerate a lost non-circular closure receipt from an already committed
 * adjacent journal pair. Complete local integrity is reverified first.
 */
export async function recoverJournalBoundClosureReceipt(
  journal: EvidenceJournal,
  artifactStore: EvidenceArtifactStore,
  bundleCommitSequence: number,
): Promise<JournalBoundClosureReceiptV02> {
  if (
    !Number.isSafeInteger(bundleCommitSequence) ||
    bundleCommitSequence < 2
  ) fail("RECOVERY_BUNDLE_SEQUENCE_INVALID");
  const records = journal.readAll();
  const bundleRecord = records[bundleCommitSequence - 1];
  const inputRecord = records[bundleCommitSequence - 2];
  if (
    !inputRecord ||
    !bundleRecord ||
    inputRecord.kind !== "kernel_input_committed" ||
    bundleRecord.kind !== "kernel_bundle_committed" ||
    bundleRecord.previousHash !== inputRecord.recordHash ||
    bundleRecord.operationId !== inputRecord.operationId ||
    bundleRecord.authorizationId === undefined ||
    bundleRecord.authorizationId !== inputRecord.authorizationId
  ) fail("RECOVERY_COMMIT_PAIR_INVALID");
  const inputEvidence = exact(
    evidenceRecord(inputRecord),
    new Set([
      "schemaVersion",
      "inputManifestArtifactHash",
      "sourceHead",
      "baseRegistryHash",
      "baseCollectionHash",
      "effectAttestationHashes",
    ]),
    "RECOVERY_INPUT_EVIDENCE",
  );
  const bundleEvidence = exact(
    evidenceRecord(bundleRecord),
    new Set([
      "schemaVersion",
      "inputCommitRecordHash",
      "inputManifestArtifactHash",
      "bundleHash",
      "bundleArtifactHash",
    ]),
    "RECOVERY_BUNDLE_EVIDENCE",
  );
  if (inputEvidence.schemaVersion !== "0.2" || bundleEvidence.schemaVersion !== "0.2") {
    fail("RECOVERY_COMMIT_SCHEMA_INVALID");
  }
  const manifestHash = requireHash(
    inputEvidence.inputManifestArtifactHash,
    "RECOVERY_MANIFEST_HASH_INVALID",
  );
  if (bundleEvidence.inputManifestArtifactHash !== manifestHash) {
    fail("RECOVERY_MANIFEST_BINDING_MISMATCH");
  }
  const bundleArtifactHash = requireHash(
    bundleEvidence.bundleArtifactHash,
    "RECOVERY_BUNDLE_ARTIFACT_HASH_INVALID",
  );
  const inputManifest = await referenceFromInspection(
    artifactStore,
    "kernel-input-manifest",
    manifestHash,
    "RECOVERY_MANIFEST_ARTIFACT_NOT_FOUND",
  );
  const bundle = await referenceFromInspection(
    artifactStore,
    "kernel-bundle",
    bundleArtifactHash,
    "RECOVERY_BUNDLE_ARTIFACT_NOT_FOUND",
  );
  const unsignedReceipt = {
    schemaVersion: "0.2" as const,
    kind: "journal_bound_bundle_closure" as const,
    journalId: journal.journalId,
    operationId: bundleRecord.operationId,
    authorizationId: bundleRecord.authorizationId,
    inputManifest,
    inputCommit: pointer(inputRecord),
    bundle,
    bundleCommit: pointer(bundleRecord),
    closedAt: bundleRecord.occurredAt,
  };
  const receipt: JournalBoundClosureReceiptV02 = {
    ...unsignedReceipt,
    receiptHash: hashCanonical(RECEIPT_DOMAIN, unsignedReceipt),
  };
  await verifyJournalBoundBundleIntegrity(journal, artifactStore, receipt);
  return deepFreeze(receipt);
}

/** Report incomplete two-phase commits and content-addressed artifact orphans. */
export async function auditJournalBoundBundleRecovery(
  journal: EvidenceJournal,
  artifactStore: EvidenceArtifactStore,
): Promise<JournalBundleRecoveryAudit> {
  const records = journal.readAll();
  const inspection = await artifactStore.inspect();
  const pendingInputRecords: number[] = [];
  const issues = [...inspection.errors];
  const referenced = new Set<string>();

  for (const record of records) {
    if (record.kind !== "kernel_input_committed") continue;
    const next = records[record.sequence];
    if (
      !next ||
      next.kind !== "kernel_bundle_committed" ||
      next.operationId !== record.operationId ||
      next.previousHash !== record.recordHash
    ) pendingInputRecords.push(record.sequence);
    try {
      const evidence = evidenceRecord(record);
      const manifestHash = requireHash(
        evidence.inputManifestArtifactHash,
        "RECOVERY_INPUT_MANIFEST_HASH_INVALID",
      );
      referenced.add(manifestHash);
      const manifest = requireInputManifest(
        await artifactStore.get("kernel-input-manifest", manifestHash),
      );
      if (
        manifest.operationId !== record.operationId ||
        manifest.authorizationId !== record.authorizationId ||
        !sameHead(manifest.sourceHead, {
          journalId: record.journalId,
          sequence: record.sequence - 1,
          recordHash: record.previousHash,
        })
      ) fail("RECOVERY_MANIFEST_BINDING_MISMATCH");
      for (const key of ["attempt", "base", "evaluatorInput"] as const) {
        const ref = manifest.artifacts[key];
        referenced.add(ref.artifactHash);
        await artifactStore.getByReference(ref);
      }
      for (const ref of manifest.artifacts.effects) {
        referenced.add(ref.artifactHash);
        await artifactStore.getByReference(ref);
      }
    } catch (error) {
      issues.push(
        `${error instanceof JournalBundleError ? error.code : "RECOVERY_INPUT_READ_FAILED"}:${record.sequence}`,
      );
    }
  }
  for (const record of records) {
    if (record.kind !== "kernel_bundle_committed") continue;
    try {
      const evidence = evidenceRecord(record);
      const hash = requireHash(
        evidence.bundleArtifactHash,
        "RECOVERY_BUNDLE_ARTIFACT_HASH_INVALID",
      );
      referenced.add(hash);
      await artifactStore.get("kernel-bundle", hash);
      await recoverJournalBoundClosureReceipt(journal, artifactStore, record.sequence);
    } catch (error) {
      issues.push(
        `${error instanceof JournalBundleError ? error.code : "RECOVERY_BUNDLE_READ_FAILED"}:${record.sequence}`,
      );
    }
  }
  const orphanArtifactHashes = inspection.artifacts
    .map((artifact) => artifact.artifactHash)
    .filter((hash) => !referenced.has(hash))
    .sort();
  const invalid = issues.length > 0 || inspection.unexpectedFiles.length > 0;
  const incomplete =
    pendingInputRecords.length > 0 ||
    orphanArtifactHashes.length > 0 ||
    inspection.temporaryFiles.length > 0;
  return {
    status: invalid ? "invalid" : incomplete ? "incomplete" : "clean",
    pendingInputRecords,
    orphanArtifactHashes,
    issues: [
      ...issues,
      ...inspection.unexpectedFiles.map((name) => `UNEXPECTED_ARTIFACT_FILE:${name}`),
    ].sort(),
    temporaryFiles: [...inspection.temporaryFiles],
  };
}
