import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { canonicalJson, deriveOperationIdentity } from "./canonical.js";
import type { EffectObservation, OperationDescriptor } from "./types.js";

const CONTRACT_DOMAIN = "x402-canary:effect-authority-contract:v0.1";
const REGISTRY_DOMAIN = "x402-canary:effect-authority-registry:v0.1";
const QUERY_DOMAIN = "x402-canary:effect-query:v0.1";
const RESOLUTION_DOMAIN = "x402-canary:effect-query-resolution:v0.1";
const ATTESTATION_DOMAIN = "x402-canary:effect-authority-attestation:v0.1";
const ATTESTATION_HASH_DOMAIN = "x402-canary:effect-authority-envelope:v0.1";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[a-z][a-z0-9._:-]{0,127}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
const CANONICAL_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const MAX_REGISTRY_AUTHORITIES = 64;
const MAX_REGISTRY_CONTRACTS = 64;
const MAX_ALLOWED_CONTRACTS = 64;
const MAX_FINALIZATION_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_ATTESTATION_AGE_SECONDS = 24 * 60 * 60;
const MAX_OBSERVATION_TO_SIGNATURE_SECONDS = 60 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_INPUT_NODES = 100_000;
const MAX_INPUT_STRING_CODE_UNITS = 1_048_576;

const REGISTRY_FIELDS = new Set(["schemaVersion", "authorities", "contracts"]);
const AUTHORITY_FIELDS = new Set([
  "authorityId",
  "keyId",
  "algorithm",
  "usage",
  "publicKeySpkiDerBase64url",
  "validFrom",
  "validUntil",
  "revokedAt",
  "allowedContractIds",
]);
const CONTRACT_FIELDS = new Set([
  "contractId",
  "authorityId",
  "adapterId",
  "adapterVersion",
  "environment",
  "tenantIdHash",
  "effectType",
  "payloadProjectionId",
  "query",
  "cardinality",
  "finalizationDelaySeconds",
  "absence",
  "freshness",
]);
const CONTRACT_POLICY_FIELDS = new Set(
  [...CONTRACT_FIELDS].filter((field) => field !== "contractId"),
);
const QUERY_FIELDS = new Set(["kind", "name", "canonicalization"]);
const CARDINALITY_FIELDS = new Set(["maximum", "enforcement"]);
const ABSENCE_FIELDS = new Set(["kind", "markerType", "requiredConsistency"]);
const FRESHNESS_FIELDS = new Set([
  "maxObservationToSignatureSeconds",
  "maxAttestationAgeSeconds",
]);
const RESOLVE_REQUEST_FIELDS = new Set(["contractId", "operation", "operationStartedAt"]);
const ENVELOPE_FIELDS = new Set(["schemaVersion", "protected", "payload", "signature"]);
const PROTECTED_FIELDS = new Set(["algorithm", "keyId"]);
const PAYLOAD_FIELDS = new Set([
  "registryHash",
  "authorityId",
  "contractId",
  "operationId",
  "operationStartedAt",
  "adapterId",
  "adapterVersion",
  "environment",
  "tenantIdHash",
  "queryKeyHash",
  "effectType",
  "payloadProjectionId",
  "observedAt",
  "signedAt",
  "outcome",
]);
const ZERO_FIELDS = new Set(["kind", "closure"]);
const CLOSURE_FIELDS = new Set([
  "markerType",
  "markerHash",
  "consistency",
  "effectSetComplete",
  "eligibleThrough",
  "closedAt",
]);
const ONE_FIELDS = new Set(["kind", "effect"]);
const MULTIPLE_FIELDS = new Set(["kind", "minimumCount", "samples"]);
const UNKNOWN_FIELDS = new Set(["kind", "reason"]);
const EFFECT_RECORD_FIELDS = new Set(["effectIdHash", "payloadHash", "committedAt"]);
const UNKNOWN_REASONS = new Set([
  "authority_unavailable",
  "adapter_error",
  "read_not_linearizable",
  "closure_not_observed",
  "not_final",
]);

const derivedRegistries = new WeakSet<object>();
const resolvedQueries = new WeakSet<object>();
const verifiedAttestations = new WeakSet<object>();

interface RegistryInternals {
  keysById: ReadonlyMap<string, { manifest: EffectAuthorityKeyManifest; key: KeyObject }>;
  contractsById: ReadonlyMap<string, EffectAuthorityContract>;
}

interface QueryInternals {
  registry: EffectAuthorityRegistry;
  contract: EffectAuthorityContract;
}

const registryInternals = new WeakMap<EffectAuthorityRegistry, RegistryInternals>();
const queryInternals = new WeakMap<ResolvedEffectQuery, QueryInternals>();
const verifiedObservations = new WeakMap<VerifiedEffectAttestation, readonly EffectObservation[]>();
const verifiedAuditArtifacts = new WeakMap<VerifiedEffectAttestation, EffectAuthorityAuditArtifact>();

export interface EffectAuthorityContractPolicy {
  authorityId: string;
  adapterId: string;
  adapterVersion: string;
  environment: string;
  tenantIdHash: string;
  effectType: string;
  payloadProjectionId: string;
  query: {
    kind: "operation_header";
    name: "idempotency-key";
    canonicalization: "trim_outer_ows_v1";
  };
  cardinality: {
    maximum: 1;
    enforcement: "primary_transactional_unique_constraint";
  };
  finalizationDelaySeconds: number;
  absence: {
    kind: "transactional_closure_marker";
    markerType: string;
    requiredConsistency: "linearizable";
  };
  freshness: {
    maxObservationToSignatureSeconds: number;
    maxAttestationAgeSeconds: number;
  };
}

export interface EffectAuthorityContract extends EffectAuthorityContractPolicy {
  contractId: string;
}

export interface EffectAuthorityKeyManifest {
  authorityId: string;
  keyId: string;
  algorithm: "Ed25519";
  usage: "effect_attestation";
  publicKeySpkiDerBase64url: string;
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
  allowedContractIds: string[];
}

export interface EffectAuthorityRegistryManifest {
  schemaVersion: "0.1";
  authorities: EffectAuthorityKeyManifest[];
  contracts: EffectAuthorityContract[];
}

export interface EffectAuthorityRegistry {
  manifest: EffectAuthorityRegistryManifest;
  registryHash: string;
}

export interface ResolveEffectQueryRequest {
  contractId: string;
  operation: OperationDescriptor;
  operationStartedAt: string;
}

export interface ResolvedEffectQuery {
  schemaVersion: "0.1";
  registryHash: string;
  contractId: string;
  operationId: string;
  operationStartedAt: string;
  queryKeyHash: string;
  effectType: string;
  payloadProjectionId: string;
  finalAfter: string;
  resolutionHash: string;
}

export interface EffectRecordAttestation {
  effectIdHash: string;
  payloadHash: string;
  committedAt: string;
}

export type EffectAttestationOutcome =
  | {
      kind: "zero";
      closure: {
        markerType: string;
        markerHash: string;
        consistency: "linearizable";
        effectSetComplete: true;
        eligibleThrough: string;
        closedAt: string;
      };
    }
  | { kind: "one"; effect: EffectRecordAttestation }
  | {
      kind: "multiple";
      minimumCount: 2;
      samples: [EffectRecordAttestation, EffectRecordAttestation];
    }
  | {
      kind: "unknown";
      reason:
        | "authority_unavailable"
        | "adapter_error"
        | "read_not_linearizable"
        | "closure_not_observed"
        | "not_final";
    };

type EffectUnknownReason = Extract<EffectAttestationOutcome, { kind: "unknown" }>["reason"];

export interface SignedEffectAttestation {
  schemaVersion: "0.1";
  protected: {
    algorithm: "Ed25519";
    keyId: string;
  };
  payload: {
    registryHash: string;
    authorityId: string;
    contractId: string;
    operationId: string;
    operationStartedAt: string;
    adapterId: string;
    adapterVersion: string;
    environment: string;
    tenantIdHash: string;
    queryKeyHash: string;
    effectType: string;
    payloadProjectionId: string;
    observedAt: string;
    signedAt: string;
    outcome: EffectAttestationOutcome;
  };
  signature: string;
}

export interface VerifiedEffectAttestation {
  schemaVersion: "0.1";
  registryHash: string;
  contractId: string;
  resolutionHash: string;
  attestationHash: string;
  operationId: string;
  operationStartedAt: string;
  queryKeyHash: string;
  finalAfter: string;
  authorityId: string;
  keyId: string;
  adapterId: string;
  adapterVersion: string;
  outcome: EffectAttestationOutcome["kind"];
  verifiedAt: string;
  assurance: {
    authorityAuthentication: "ed25519_out_of_band_registry";
    policyBinding: "locally_derived_exact_match";
    authoritySignatureVerified: true;
    paymentExecutionEnabled: false;
  };
}

export interface EffectAuthorityAuditArtifact {
  schemaVersion: "0.1";
  registryHash: string;
  contractId: string;
  resolutionHash: string;
  attestationHash: string;
  verifiedAt: string;
  query: ResolvedEffectQuery;
  attestation: SignedEffectAttestation;
}

export class EffectAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EffectAuthorityError";
  }
}

function fail(code: string): never {
  throw new EffectAuthorityError(code);
}

function assertPlainDataGraph(
  value: unknown,
  seen = new Set<object>(),
  budget = { nodes: 0, stringCodeUnits: 0 },
  depth = 0,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_INPUT_NODES) fail("INPUT_TOO_LARGE");
  if (depth > 32) fail("INPUT_NESTING_TOO_DEEP");
  if (typeof value === "string") {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_INPUT_STRING_CODE_UNITS) fail("INPUT_TOO_LARGE");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail("INPUT_NUMBER_INVALID");
    return;
  }
  if (typeof value !== "object") fail("INPUT_NOT_JSON_DATA");
  if (seen.has(value)) fail("INPUT_CYCLE_OR_ALIAS");
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail("INPUT_ARRAY_PROTOTYPE_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) fail("INPUT_SYMBOL_FIELD");
    const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key as string))) {
      fail("INPUT_ARRAY_SHAPE_INVALID");
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail("INPUT_ACCESSOR_OR_HIDDEN_FIELD");
      }
      assertPlainDataGraph(descriptor.value, seen, budget, depth + 1);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("INPUT_OBJECT_PROTOTYPE_INVALID");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("INPUT_SYMBOL_FIELD");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("INPUT_ACCESSOR_OR_HIDDEN_FIELD");
    }
    assertPlainDataGraph(descriptor.value, seen, budget, depth + 1);
  }
  seen.delete(value);
}

function snapshot<T>(value: T): T {
  assertPlainDataGraph(value);
  try {
    return structuredClone(value);
  } catch {
    return fail("INPUT_SNAPSHOT_FAILED");
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  const object = record(value, `${label}_NOT_OBJECT`);
  const keys = Reflect.ownKeys(object);
  if (keys.some((key) => typeof key !== "string")) fail(`${label}_UNEXPECTED_FIELD`);
  for (const field of keys as string[]) {
    if (!fields.has(field)) fail(`${label}_UNEXPECTED_FIELD`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) fail(`${label}_MISSING_FIELD`);
  }
  return object;
}

function hashCanonical(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${domain}\n${canonicalJson(value)}`, "utf8")
    .digest("hex")}`;
}

function requireSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function requireToken(value: unknown, code: string): string {
  if (typeof value !== "string" || !TOKEN.test(value)) fail(code);
  return value;
}

function requireEnvironment(value: unknown, code: string): string {
  if (typeof value !== "string" || !ENVIRONMENT.test(value)) fail(code);
  return value;
}

function parseTimestamp(value: unknown, code: string): number {
  if (typeof value !== "string") fail(code);
  const match = CANONICAL_TIMESTAMP.exec(value);
  if (!match) fail(code);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millis = Number(millisText);
  if (year < 1000 || year > 9999 || hour > 23 || minute > 59 || second > 59) fail(code);
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code);
  return epoch;
}

function requireDuration(value: unknown, maximum: number, code: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0) ||
    value > maximum
  ) fail(code);
  return value;
}

function decodeBase64url(value: unknown, byteLength: number, code: string): Buffer {
  const encodedLength = Math.ceil((byteLength * 4) / 3);
  if (
    typeof value !== "string" ||
    value.length !== encodedLength ||
    !BASE64URL.test(value)
  ) fail(code);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return fail(code);
  }
  if (decoded.length !== byteLength || decoded.toString("base64url") !== value) fail(code);
  return decoded;
}

function publicKeyFromManifest(value: unknown): { encoded: string; key: KeyObject; keyId: string } {
  const der = decodeBase64url(value, 44, "AUTHORITY_PUBLIC_KEY_INVALID");
  if (!der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    fail("AUTHORITY_PUBLIC_KEY_INVALID");
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return fail("AUTHORITY_PUBLIC_KEY_INVALID");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    fail("AUTHORITY_PUBLIC_KEY_INVALID");
  }
  const exported = key.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(exported) || !exported.equals(der)) fail("AUTHORITY_PUBLIC_KEY_INVALID");
  return {
    encoded: der.toString("base64url"),
    key,
    keyId: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  };
}

function requireSortedUnique(values: unknown, code: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ALLOWED_CONTRACTS) {
    fail(code);
  }
  const normalized = values.map((value) => requireSha256(value, code));
  const sorted = [...new Set(normalized)].sort();
  if (
    sorted.length !== normalized.length ||
    sorted.some((value, index) => value !== normalized[index])
  ) fail(code);
  return normalized;
}

function validateContractPolicy(value: unknown, label: string): EffectAuthorityContractPolicy {
  const policy = exact(value, CONTRACT_POLICY_FIELDS, label);
  const query = exact(policy.query, QUERY_FIELDS, `${label}_QUERY`);
  const cardinality = exact(policy.cardinality, CARDINALITY_FIELDS, `${label}_CARDINALITY`);
  const absence = exact(policy.absence, ABSENCE_FIELDS, `${label}_ABSENCE`);
  const freshness = exact(policy.freshness, FRESHNESS_FIELDS, `${label}_FRESHNESS`);

  if (
    query.kind !== "operation_header" ||
    query.name !== "idempotency-key" ||
    query.canonicalization !== "trim_outer_ows_v1"
  ) fail(`${label}_QUERY_INVALID`);
  if (
    cardinality.maximum !== 1 ||
    cardinality.enforcement !== "primary_transactional_unique_constraint"
  ) fail(`${label}_CARDINALITY_INVALID`);
  if (
    absence.kind !== "transactional_closure_marker" ||
    absence.requiredConsistency !== "linearizable"
  ) fail(`${label}_ABSENCE_INVALID`);

  return {
    authorityId: requireToken(policy.authorityId, `${label}_AUTHORITY_ID_INVALID`),
    adapterId: requireToken(policy.adapterId, `${label}_ADAPTER_ID_INVALID`),
    adapterVersion: requireToken(policy.adapterVersion, `${label}_ADAPTER_VERSION_INVALID`),
    environment: requireEnvironment(policy.environment, `${label}_ENVIRONMENT_INVALID`),
    tenantIdHash: requireSha256(policy.tenantIdHash, `${label}_TENANT_ID_HASH_INVALID`),
    effectType: requireToken(policy.effectType, `${label}_EFFECT_TYPE_INVALID`),
    payloadProjectionId: requireSha256(
      policy.payloadProjectionId,
      `${label}_PAYLOAD_PROJECTION_ID_INVALID`,
    ),
    query: {
      kind: "operation_header",
      name: "idempotency-key",
      canonicalization: "trim_outer_ows_v1",
    },
    cardinality: {
      maximum: 1,
      enforcement: "primary_transactional_unique_constraint",
    },
    finalizationDelaySeconds: requireDuration(
      policy.finalizationDelaySeconds,
      MAX_FINALIZATION_DELAY_SECONDS,
      `${label}_FINALIZATION_DELAY_INVALID`,
    ),
    absence: {
      kind: "transactional_closure_marker",
      markerType: requireToken(absence.markerType, `${label}_MARKER_TYPE_INVALID`),
      requiredConsistency: "linearizable",
    },
    freshness: {
      maxObservationToSignatureSeconds: requireDuration(
        freshness.maxObservationToSignatureSeconds,
        MAX_OBSERVATION_TO_SIGNATURE_SECONDS,
        `${label}_OBSERVATION_SIGNATURE_AGE_INVALID`,
      ),
      maxAttestationAgeSeconds: requireDuration(
        freshness.maxAttestationAgeSeconds,
        MAX_ATTESTATION_AGE_SECONDS,
        `${label}_ATTESTATION_AGE_INVALID`,
      ),
    },
  };
}

/** Compute the content-addressed identifier for a strict v0.1 effect policy. */
export function computeEffectAuthorityContractId(input: unknown): string {
  const policy = validateContractPolicy(snapshot(input), "CONTRACT_POLICY");
  return hashCanonical(CONTRACT_DOMAIN, policy);
}

/** Compute the required key ID from a canonical Ed25519 DER-SPKI public key. */
export function computeEffectAuthorityKeyId(publicKeySpkiDerBase64url: unknown): string {
  return publicKeyFromManifest(publicKeySpkiDerBase64url).keyId;
}

/**
 * Derive and brand an operator-trusted authority registry. The returned brand is
 * intentionally process-local and cannot be reconstructed from caller JSON.
 */
export function deriveEffectAuthorityRegistry(input: unknown): EffectAuthorityRegistry {
  const manifestInput = exact(snapshot(input), REGISTRY_FIELDS, "REGISTRY");
  if (manifestInput.schemaVersion !== "0.1") fail("REGISTRY_SCHEMA_VERSION_INVALID");
  if (
    !Array.isArray(manifestInput.contracts) ||
    manifestInput.contracts.length === 0 ||
    manifestInput.contracts.length > MAX_REGISTRY_CONTRACTS
  ) fail("REGISTRY_CONTRACTS_INVALID");
  if (
    !Array.isArray(manifestInput.authorities) ||
    manifestInput.authorities.length === 0 ||
    manifestInput.authorities.length > MAX_REGISTRY_AUTHORITIES
  ) fail("REGISTRY_AUTHORITIES_INVALID");

  const contracts: EffectAuthorityContract[] = manifestInput.contracts.map((candidate, index) => {
    const entry = exact(candidate, CONTRACT_FIELDS, `CONTRACT_${index}`);
    const policyCandidate = Object.fromEntries(
      [...CONTRACT_POLICY_FIELDS].map((field) => [field, entry[field]]),
    );
    const policy = validateContractPolicy(policyCandidate, `CONTRACT_${index}`);
    const contractId = requireSha256(entry.contractId, `CONTRACT_${index}_ID_INVALID`);
    if (hashCanonical(CONTRACT_DOMAIN, policy) !== contractId) {
      fail(`CONTRACT_${index}_ID_MISMATCH`);
    }
    return { contractId, ...policy };
  });
  const contractIds = contracts.map((contract) => contract.contractId);
  if (
    new Set(contractIds).size !== contractIds.length ||
    [...contractIds].sort().some((value, index) => value !== contractIds[index])
  ) fail("REGISTRY_CONTRACTS_NOT_SORTED_UNIQUE");

  const parsedKeys = new Map<string, KeyObject>();
  const seenPublicKeys = new Set<string>();
  const authorities: EffectAuthorityKeyManifest[] = manifestInput.authorities.map(
    (candidate, index) => {
      const entry = exact(candidate, AUTHORITY_FIELDS, `AUTHORITY_${index}`);
      if (entry.algorithm !== "Ed25519" || entry.usage !== "effect_attestation") {
        fail(`AUTHORITY_${index}_PURPOSE_INVALID`);
      }
      const publicKey = publicKeyFromManifest(entry.publicKeySpkiDerBase64url);
      const keyId = requireSha256(entry.keyId, `AUTHORITY_${index}_KEY_ID_INVALID`);
      if (keyId !== publicKey.keyId) fail(`AUTHORITY_${index}_KEY_ID_MISMATCH`);
      if (parsedKeys.has(keyId) || seenPublicKeys.has(publicKey.encoded)) {
        fail("REGISTRY_DUPLICATE_AUTHORITY_KEY");
      }
      const validFrom = entry.validFrom;
      const validUntil = entry.validUntil;
      const validFromMs = parseTimestamp(validFrom, `AUTHORITY_${index}_VALID_FROM_INVALID`);
      const validUntilMs = parseTimestamp(validUntil, `AUTHORITY_${index}_VALID_UNTIL_INVALID`);
      if (validUntilMs <= validFromMs) fail(`AUTHORITY_${index}_VALIDITY_INVALID`);
      if (entry.revokedAt !== null) {
        parseTimestamp(entry.revokedAt, `AUTHORITY_${index}_REVOKED_AT_INVALID`);
      }
      const allowedContractIds = requireSortedUnique(
        entry.allowedContractIds,
        `AUTHORITY_${index}_ALLOWED_CONTRACTS_INVALID`,
      );
      parsedKeys.set(keyId, publicKey.key);
      seenPublicKeys.add(publicKey.encoded);
      return {
        authorityId: requireToken(entry.authorityId, `AUTHORITY_${index}_ID_INVALID`),
        keyId,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: publicKey.encoded,
        validFrom: validFrom as string,
        validUntil: validUntil as string,
        revokedAt: entry.revokedAt as string | null,
        allowedContractIds,
      };
    },
  );
  const authorityOrder = authorities.map((entry) => `${entry.authorityId}\u0000${entry.keyId}`);
  if (
    new Set(authorityOrder).size !== authorityOrder.length ||
    [...authorityOrder].sort().some((value, index) => value !== authorityOrder[index])
  ) fail("REGISTRY_AUTHORITIES_NOT_SORTED_UNIQUE");

  const contractsById = new Map(contracts.map((contract) => [contract.contractId, contract]));
  const keysById = new Map<
    string,
    { manifest: EffectAuthorityKeyManifest; key: KeyObject }
  >();
  for (const authority of authorities) {
    for (const contractId of authority.allowedContractIds) {
      const contract = contractsById.get(contractId);
      if (!contract || contract.authorityId !== authority.authorityId) {
        fail("AUTHORITY_CONTRACT_SCOPE_INVALID");
      }
    }
    keysById.set(authority.keyId, { manifest: authority, key: parsedKeys.get(authority.keyId)! });
  }
  for (const contract of contracts) {
    if (
      !authorities.some(
        (authority) =>
          authority.authorityId === contract.authorityId &&
          authority.allowedContractIds.includes(contract.contractId),
      )
    ) fail("CONTRACT_HAS_NO_AUTHORIZED_KEY");
  }

  const manifest: EffectAuthorityRegistryManifest = {
    schemaVersion: "0.1",
    authorities,
    contracts,
  };
  const registry: EffectAuthorityRegistry = {
    manifest,
    registryHash: hashCanonical(REGISTRY_DOMAIN, manifest),
  };
  deepFreeze(registry);
  derivedRegistries.add(registry);
  registryInternals.set(registry, { keysById, contractsById });
  return registry;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function assertDerivedRegistry(registry: EffectAuthorityRegistry): RegistryInternals {
  if (!record(registry, "REGISTRY_NOT_DERIVED") || !derivedRegistries.has(registry)) {
    fail("REGISTRY_NOT_DERIVED");
  }
  const internals = registryInternals.get(registry);
  if (!internals || hashCanonical(REGISTRY_DOMAIN, registry.manifest) !== registry.registryHash) {
    fail("REGISTRY_INTEGRITY_MISMATCH");
  }
  return internals;
}

function normalizedIdempotencyKey(operation: OperationDescriptor): string {
  const headers = operation.headers ?? {};
  const object = record(headers, "QUERY_HEADERS_INVALID");
  const matches = Object.entries(object).filter(([name]) => name.toLowerCase() === "idempotency-key");
  if (matches.length !== 1 || typeof matches[0]![1] !== "string") {
    fail("QUERY_IDEMPOTENCY_KEY_MISSING_OR_DUPLICATE");
  }
  const normalized = (matches[0]![1] as string).replace(/^[ \t]+|[ \t]+$/g, "");
  if (
    normalized.length < 16 ||
    normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[\x20-\x7e]+$/.test(normalized)
  ) fail("QUERY_IDEMPOTENCY_KEY_INVALID");
  return normalized;
}

/** Resolve the signed query coordinates entirely from trusted policy and an operation. */
export function resolveEffectQuery(
  registry: EffectAuthorityRegistry,
  input: unknown,
): ResolvedEffectQuery {
  const internals = assertDerivedRegistry(registry);
  const request = exact(snapshot(input), RESOLVE_REQUEST_FIELDS, "QUERY_REQUEST");
  const contractId = requireSha256(request.contractId, "QUERY_CONTRACT_ID_INVALID");
  const contract = internals.contractsById.get(contractId);
  if (!contract) fail("QUERY_CONTRACT_NOT_FOUND");
  const operation = request.operation as OperationDescriptor;
  let operationIdentity: ReturnType<typeof deriveOperationIdentity>;
  try {
    operationIdentity = deriveOperationIdentity(operation);
  } catch {
    return fail("QUERY_OPERATION_INVALID");
  }
  const operationStartedAtMs = parseTimestamp(
    request.operationStartedAt,
    "QUERY_OPERATION_STARTED_AT_INVALID",
  );
  const finalAfterMs = operationStartedAtMs + contract.finalizationDelaySeconds * 1_000;
  if (!Number.isSafeInteger(finalAfterMs) || finalAfterMs > 253_402_300_799_999) {
    fail("QUERY_FINAL_AFTER_OVERFLOW");
  }
  const queryKey = normalizedIdempotencyKey(operation);
  const queryKeyHash = hashCanonical(QUERY_DOMAIN, {
    contractId,
    environment: contract.environment,
    headerName: contract.query.name,
    operationId: operationIdentity.id,
    tenantIdHash: contract.tenantIdHash,
    value: queryKey,
  });
  const resolutionBody = {
    schemaVersion: "0.1" as const,
    registryHash: registry.registryHash,
    contractId,
    operationId: operationIdentity.id,
    operationStartedAt: request.operationStartedAt as string,
    queryKeyHash,
    effectType: contract.effectType,
    payloadProjectionId: contract.payloadProjectionId,
    finalAfter: new Date(finalAfterMs).toISOString(),
  };
  const resolved: ResolvedEffectQuery = {
    ...resolutionBody,
    resolutionHash: hashCanonical(RESOLUTION_DOMAIN, resolutionBody),
  };
  deepFreeze(resolved);
  resolvedQueries.add(resolved);
  queryInternals.set(resolved, { registry, contract });
  return resolved;
}

function assertResolvedQuery(
  registry: EffectAuthorityRegistry,
  query: ResolvedEffectQuery,
): QueryInternals {
  if (!record(query, "QUERY_NOT_RESOLVED") || !resolvedQueries.has(query)) {
    fail("QUERY_NOT_RESOLVED");
  }
  const internals = queryInternals.get(query);
  if (!internals || internals.registry !== registry) fail("QUERY_REGISTRY_MISMATCH");
  const { resolutionHash, ...body } = query;
  if (hashCanonical(RESOLUTION_DOMAIN, body) !== resolutionHash) {
    fail("QUERY_INTEGRITY_MISMATCH");
  }
  return internals;
}

function validateEffectRecord(value: unknown, label: string): EffectRecordAttestation {
  const effect = exact(value, EFFECT_RECORD_FIELDS, label);
  parseTimestamp(effect.committedAt, `${label}_COMMITTED_AT_INVALID`);
  return {
    effectIdHash: requireSha256(effect.effectIdHash, `${label}_ID_HASH_INVALID`),
    payloadHash: requireSha256(effect.payloadHash, `${label}_PAYLOAD_HASH_INVALID`),
    committedAt: effect.committedAt as string,
  };
}

function validateOutcome(value: unknown): EffectAttestationOutcome {
  const outcome = record(value, "ATTESTATION_OUTCOME_NOT_OBJECT");
  if (outcome.kind === "zero") {
    const exactOutcome = exact(outcome, ZERO_FIELDS, "ATTESTATION_ZERO");
    const closure = exact(exactOutcome.closure, CLOSURE_FIELDS, "ATTESTATION_CLOSURE");
    if (closure.consistency !== "linearizable" || closure.effectSetComplete !== true) {
      fail("ATTESTATION_CLOSURE_INVALID");
    }
    parseTimestamp(closure.eligibleThrough, "ATTESTATION_CLOSURE_ELIGIBLE_THROUGH_INVALID");
    parseTimestamp(closure.closedAt, "ATTESTATION_CLOSURE_CLOSED_AT_INVALID");
    return {
      kind: "zero",
      closure: {
        markerType: requireToken(closure.markerType, "ATTESTATION_CLOSURE_MARKER_TYPE_INVALID"),
        markerHash: requireSha256(closure.markerHash, "ATTESTATION_CLOSURE_MARKER_HASH_INVALID"),
        consistency: "linearizable",
        effectSetComplete: true,
        eligibleThrough: closure.eligibleThrough as string,
        closedAt: closure.closedAt as string,
      },
    };
  }
  if (outcome.kind === "one") {
    const exactOutcome = exact(outcome, ONE_FIELDS, "ATTESTATION_ONE");
    return { kind: "one", effect: validateEffectRecord(exactOutcome.effect, "ATTESTATION_EFFECT") };
  }
  if (outcome.kind === "multiple") {
    const exactOutcome = exact(outcome, MULTIPLE_FIELDS, "ATTESTATION_MULTIPLE");
    if (exactOutcome.minimumCount !== 2 || !Array.isArray(exactOutcome.samples)) {
      fail("ATTESTATION_MULTIPLE_INVALID");
    }
    if (exactOutcome.samples.length !== 2) fail("ATTESTATION_MULTIPLE_INVALID");
    const samples = exactOutcome.samples.map((sample, index) =>
      validateEffectRecord(sample, `ATTESTATION_SAMPLE_${index}`),
    ) as [EffectRecordAttestation, EffectRecordAttestation];
    const identities = samples.map((sample) => `${sample.effectIdHash}\u0000${sample.payloadHash}`);
    if (
      samples[0].effectIdHash === samples[1].effectIdHash ||
      [...identities].sort().some((identity, index) => identity !== identities[index])
    ) fail("ATTESTATION_MULTIPLE_SAMPLES_INVALID");
    return { kind: "multiple", minimumCount: 2, samples };
  }
  if (outcome.kind === "unknown") {
    const exactOutcome = exact(outcome, UNKNOWN_FIELDS, "ATTESTATION_UNKNOWN");
    if (typeof exactOutcome.reason !== "string" || !UNKNOWN_REASONS.has(exactOutcome.reason)) {
      fail("ATTESTATION_UNKNOWN_REASON_INVALID");
    }
    return { kind: "unknown", reason: exactOutcome.reason as EffectUnknownReason };
  }
  return fail("ATTESTATION_OUTCOME_KIND_INVALID");
}

function validateAttestation(input: unknown): SignedEffectAttestation {
  const envelope = exact(snapshot(input), ENVELOPE_FIELDS, "ATTESTATION");
  if (envelope.schemaVersion !== "0.1") fail("ATTESTATION_SCHEMA_VERSION_INVALID");
  const protectedHeader = exact(envelope.protected, PROTECTED_FIELDS, "ATTESTATION_PROTECTED");
  if (protectedHeader.algorithm !== "Ed25519") fail("ATTESTATION_ALGORITHM_INVALID");
  const payload = exact(envelope.payload, PAYLOAD_FIELDS, "ATTESTATION_PAYLOAD");
  parseTimestamp(payload.operationStartedAt, "ATTESTATION_OPERATION_STARTED_AT_INVALID");
  parseTimestamp(payload.observedAt, "ATTESTATION_OBSERVED_AT_INVALID");
  parseTimestamp(payload.signedAt, "ATTESTATION_SIGNED_AT_INVALID");
  const outcome = validateOutcome(payload.outcome);
  decodeBase64url(envelope.signature, 64, "ATTESTATION_SIGNATURE_ENCODING_INVALID");
  return {
    schemaVersion: "0.1",
    protected: {
      algorithm: "Ed25519",
      keyId: requireSha256(protectedHeader.keyId, "ATTESTATION_KEY_ID_INVALID"),
    },
    payload: {
      registryHash: requireSha256(payload.registryHash, "ATTESTATION_REGISTRY_HASH_INVALID"),
      authorityId: requireToken(payload.authorityId, "ATTESTATION_AUTHORITY_ID_INVALID"),
      contractId: requireSha256(payload.contractId, "ATTESTATION_CONTRACT_ID_INVALID"),
      operationId: requireSha256(payload.operationId, "ATTESTATION_OPERATION_ID_INVALID"),
      operationStartedAt: payload.operationStartedAt as string,
      adapterId: requireToken(payload.adapterId, "ATTESTATION_ADAPTER_ID_INVALID"),
      adapterVersion: requireToken(payload.adapterVersion, "ATTESTATION_ADAPTER_VERSION_INVALID"),
      environment: requireEnvironment(payload.environment, "ATTESTATION_ENVIRONMENT_INVALID"),
      tenantIdHash: requireSha256(payload.tenantIdHash, "ATTESTATION_TENANT_ID_HASH_INVALID"),
      queryKeyHash: requireSha256(payload.queryKeyHash, "ATTESTATION_QUERY_KEY_HASH_INVALID"),
      effectType: requireToken(payload.effectType, "ATTESTATION_EFFECT_TYPE_INVALID"),
      payloadProjectionId: requireSha256(
        payload.payloadProjectionId,
        "ATTESTATION_PAYLOAD_PROJECTION_ID_INVALID",
      ),
      observedAt: payload.observedAt as string,
      signedAt: payload.signedAt as string,
      outcome,
    },
    signature: envelope.signature as string,
  };
}

function assertPayloadBinding(
  registry: EffectAuthorityRegistry,
  query: ResolvedEffectQuery,
  contract: EffectAuthorityContract,
  attestation: SignedEffectAttestation,
): void {
  const payload = attestation.payload;
  if (payload.registryHash !== registry.registryHash) fail("ATTESTATION_REGISTRY_MISMATCH");
  if (payload.contractId !== query.contractId) fail("ATTESTATION_CONTRACT_MISMATCH");
  if (payload.operationId !== query.operationId) fail("ATTESTATION_OPERATION_MISMATCH");
  if (payload.operationStartedAt !== query.operationStartedAt) {
    fail("ATTESTATION_OPERATION_START_MISMATCH");
  }
  if (payload.authorityId !== contract.authorityId) fail("ATTESTATION_AUTHORITY_MISMATCH");
  if (payload.adapterId !== contract.adapterId) fail("ATTESTATION_ADAPTER_MISMATCH");
  if (payload.adapterVersion !== contract.adapterVersion) {
    fail("ATTESTATION_ADAPTER_VERSION_MISMATCH");
  }
  if (payload.environment !== contract.environment) fail("ATTESTATION_ENVIRONMENT_MISMATCH");
  if (payload.tenantIdHash !== contract.tenantIdHash) fail("ATTESTATION_TENANT_MISMATCH");
  if (payload.queryKeyHash !== query.queryKeyHash) fail("ATTESTATION_QUERY_MISMATCH");
  if (payload.effectType !== contract.effectType) fail("ATTESTATION_EFFECT_TYPE_MISMATCH");
  if (payload.payloadProjectionId !== contract.payloadProjectionId) {
    fail("ATTESTATION_PROJECTION_MISMATCH");
  }
}

function assertChronology(
  query: ResolvedEffectQuery,
  contract: EffectAuthorityContract,
  key: EffectAuthorityKeyManifest,
  attestation: SignedEffectAttestation,
  verifiedAt: string,
): void {
  const startedAtMs = parseTimestamp(query.operationStartedAt, "QUERY_OPERATION_STARTED_AT_INVALID");
  const finalAfterMs = parseTimestamp(query.finalAfter, "QUERY_FINAL_AFTER_INVALID");
  const observedAtMs = parseTimestamp(attestation.payload.observedAt, "ATTESTATION_OBSERVED_AT_INVALID");
  const signedAtMs = parseTimestamp(attestation.payload.signedAt, "ATTESTATION_SIGNED_AT_INVALID");
  const verifiedAtMs = parseTimestamp(verifiedAt, "VERIFIED_AT_INVALID");
  const validFromMs = parseTimestamp(key.validFrom, "AUTHORITY_VALID_FROM_INVALID");
  const validUntilMs = parseTimestamp(key.validUntil, "AUTHORITY_VALID_UNTIL_INVALID");

  if (key.revokedAt !== null) fail("AUTHORITY_KEY_REVOKED");
  if (
    observedAtMs < validFromMs ||
    observedAtMs >= validUntilMs ||
    signedAtMs < validFromMs ||
    signedAtMs >= validUntilMs ||
    verifiedAtMs < validFromMs ||
    verifiedAtMs >= validUntilMs
  ) fail("AUTHORITY_KEY_OUTSIDE_VALIDITY");
  if (observedAtMs < startedAtMs) fail("ATTESTATION_OBSERVED_BEFORE_OPERATION");
  if (signedAtMs < observedAtMs) fail("ATTESTATION_SIGNED_BEFORE_OBSERVATION");
  if (verifiedAtMs < signedAtMs) fail("ATTESTATION_VERIFIED_BEFORE_SIGNATURE");
  if (
    signedAtMs - observedAtMs > contract.freshness.maxObservationToSignatureSeconds * 1_000
  ) fail("ATTESTATION_SIGNATURE_DELAY_EXCEEDED");
  if (verifiedAtMs - signedAtMs > contract.freshness.maxAttestationAgeSeconds * 1_000) {
    fail("ATTESTATION_STALE");
  }

  const outcome = attestation.payload.outcome;
  if (outcome.kind === "zero") {
    const eligibleThroughMs = parseTimestamp(
      outcome.closure.eligibleThrough,
      "ATTESTATION_CLOSURE_ELIGIBLE_THROUGH_INVALID",
    );
    const closedAtMs = parseTimestamp(
      outcome.closure.closedAt,
      "ATTESTATION_CLOSURE_CLOSED_AT_INVALID",
    );
    if (outcome.closure.markerType !== contract.absence.markerType) {
      fail("ATTESTATION_CLOSURE_MARKER_MISMATCH");
    }
    if (
      observedAtMs < finalAfterMs ||
      eligibleThroughMs < finalAfterMs ||
      closedAtMs < eligibleThroughMs ||
      observedAtMs < closedAtMs
    ) fail("ATTESTATION_CLOSURE_HORIZON_INVALID");
    return;
  }
  if (outcome.kind === "one") {
    const committedAtMs = parseTimestamp(outcome.effect.committedAt, "ATTESTATION_COMMITTED_AT_INVALID");
    if (committedAtMs < startedAtMs || committedAtMs > observedAtMs) {
      fail("ATTESTATION_COMMIT_CHRONOLOGY_INVALID");
    }
    return;
  }
  if (outcome.kind === "multiple") {
    for (const sample of outcome.samples) {
      const committedAtMs = parseTimestamp(sample.committedAt, "ATTESTATION_COMMITTED_AT_INVALID");
      if (committedAtMs < startedAtMs || committedAtMs > observedAtMs) {
        fail("ATTESTATION_COMMIT_CHRONOLOGY_INVALID");
      }
    }
  }
}

function observationsFor(
  registry: EffectAuthorityRegistry,
  query: ResolvedEffectQuery,
  attestation: SignedEffectAttestation,
): readonly EffectObservation[] {
  const source = `effect-authority:${attestation.payload.authorityId}:${attestation.protected.keyId}:${registry.registryHash}`;
  const base = {
    operationId: query.operationId,
    source,
    queryKey: query.queryKeyHash,
    effectType: query.effectType,
    observedAt: attestation.payload.observedAt,
    finalAfter: query.finalAfter,
  };
  const outcome = attestation.payload.outcome;
  if (outcome.kind === "zero") {
    return deepFreeze([{ ...base, status: "absent", authoritative: true }] as EffectObservation[]);
  }
  if (outcome.kind === "one") {
    return deepFreeze([
      {
        ...base,
        status: "committed",
        authoritative: true,
        effectId: outcome.effect.effectIdHash,
        payloadHash: outcome.effect.payloadHash,
      },
    ] as EffectObservation[]);
  }
  if (outcome.kind === "multiple") {
    return deepFreeze(
      outcome.samples.map((sample) => ({
        ...base,
        status: "committed" as const,
        authoritative: true,
        effectId: sample.effectIdHash,
        payloadHash: sample.payloadHash,
      })),
    );
  }
  return deepFreeze([{ ...base, status: "unknown", authoritative: false }] as EffectObservation[]);
}

/** Verify a strict signed effect statement against a branded registry/query. */
export function verifyEffectAttestation(
  registry: EffectAuthorityRegistry,
  query: ResolvedEffectQuery,
  input: unknown,
  verifiedAt: string,
): VerifiedEffectAttestation {
  const registryState = assertDerivedRegistry(registry);
  const queryState = assertResolvedQuery(registry, query);
  parseTimestamp(verifiedAt, "VERIFIED_AT_INVALID");
  const attestation = validateAttestation(input);
  const key = registryState.keysById.get(attestation.protected.keyId);
  if (!key) fail("ATTESTATION_KEY_NOT_FOUND");
  if (
    key.manifest.authorityId !== queryState.contract.authorityId ||
    !key.manifest.allowedContractIds.includes(query.contractId)
  ) fail("ATTESTATION_KEY_NOT_AUTHORIZED");

  const signedBody = {
    schemaVersion: attestation.schemaVersion,
    protected: attestation.protected,
    payload: attestation.payload,
  };
  const message = Buffer.from(`${ATTESTATION_DOMAIN}\n${canonicalJson(signedBody)}`, "utf8");
  const signature = decodeBase64url(
    attestation.signature,
    64,
    "ATTESTATION_SIGNATURE_ENCODING_INVALID",
  );
  let signatureValid = false;
  try {
    signatureValid = verifySignature(null, message, key.key, signature);
  } catch {
    return fail("ATTESTATION_SIGNATURE_INVALID");
  }
  if (!signatureValid) fail("ATTESTATION_SIGNATURE_INVALID");

  assertPayloadBinding(registry, query, queryState.contract, attestation);
  assertChronology(query, queryState.contract, key.manifest, attestation, verifiedAt);
  const observations = observationsFor(registry, query, attestation);
  const verified: VerifiedEffectAttestation = {
    schemaVersion: "0.1",
    registryHash: registry.registryHash,
    contractId: query.contractId,
    resolutionHash: query.resolutionHash,
    attestationHash: hashCanonical(ATTESTATION_HASH_DOMAIN, attestation),
    operationId: query.operationId,
    operationStartedAt: query.operationStartedAt,
    queryKeyHash: query.queryKeyHash,
    finalAfter: query.finalAfter,
    authorityId: attestation.payload.authorityId,
    keyId: attestation.protected.keyId,
    adapterId: attestation.payload.adapterId,
    adapterVersion: attestation.payload.adapterVersion,
    outcome: attestation.payload.outcome.kind,
    verifiedAt,
    assurance: {
      authorityAuthentication: "ed25519_out_of_band_registry",
      policyBinding: "locally_derived_exact_match",
      authoritySignatureVerified: true,
      paymentExecutionEnabled: false,
    },
  };
  deepFreeze(verified);
  const auditArtifact: EffectAuthorityAuditArtifact = deepFreeze({
    schemaVersion: "0.1" as const,
    registryHash: registry.registryHash,
    contractId: query.contractId,
    resolutionHash: query.resolutionHash,
    attestationHash: verified.attestationHash,
    verifiedAt,
    query,
    attestation: structuredClone(attestation),
  });
  verifiedAttestations.add(verified);
  verifiedObservations.set(verified, observations);
  verifiedAuditArtifacts.set(verified, auditArtifact);
  return verified;
}

/**
 * Convert only a runtime-branded verification result into legacy pure
 * observations. Serialized or structurally forged objects are rejected.
 */
export function effectObservationsFromVerifiedAttestation(
  verified: VerifiedEffectAttestation,
): readonly EffectObservation[] {
  if (
    !record(verified, "ATTESTATION_NOT_VERIFIED") ||
    !verifiedAttestations.has(verified) ||
    verified.assurance.authoritySignatureVerified !== true
  ) fail("ATTESTATION_NOT_VERIFIED");
  const observations = verifiedObservations.get(verified);
  if (!observations) fail("ATTESTATION_VERIFICATION_STATE_MISSING");
  return observations;
}

/** Export a private-storage audit artifact only from a branded verification result. */
export function effectAuthorityArtifactFromVerifiedAttestation(
  verified: VerifiedEffectAttestation,
): EffectAuthorityAuditArtifact {
  if (!verifiedAttestations.has(verified)) fail("ATTESTATION_NOT_VERIFIED");
  const artifact = verifiedAuditArtifacts.get(verified);
  if (!artifact) fail("ATTESTATION_VERIFICATION_STATE_MISSING");
  return artifact;
}
