import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../evidence/canonical.js";
import {
  EffectAuthorityError,
  computeEffectAuthorityContractId,
  computeEffectAuthorityKeyId,
  deriveEffectAuthorityRegistry,
  effectObservationsFromVerifiedAttestation,
  resolveEffectQuery,
  verifyEffectAttestation,
  type EffectAttestationOutcome,
  type EffectAuthorityContractPolicy,
  type EffectAuthorityRegistry,
  type ResolvedEffectQuery,
  type SignedEffectAttestation,
} from "../evidence/effect-authority.js";
import { evaluateEffectEvidence } from "../evidence/effect.js";
import type { OperationDescriptor } from "../evidence/types.js";

const ATTESTATION_DOMAIN = "x402-canary:effect-authority-attestation:v0.1";
const STARTED_AT = "2026-08-03T12:00:00.000Z";
const FINAL_AFTER = "2026-08-03T12:05:00.000Z";
const OBSERVED_AT = "2026-08-03T12:06:00.000Z";
const SIGNED_AT = "2026-08-03T12:06:01.000Z";
const VERIFIED_AT = "2026-08-03T12:06:02.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const keys = generateKeyPairSync("ed25519");
const alternateKeys = generateKeyPairSync("ed25519");
const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString(
  "base64url",
);
const keyId = computeEffectAuthorityKeyId(publicKey);

const operation: OperationDescriptor = {
  url: "https://effects.example/v1/send",
  method: "POST" as const,
  headers: {
    "content-type": "application/json",
    "Idempotency-Key": " 01J4AIFI8DQ5F4V3T73Z9M6Y2X ",
  },
  body: { message: "hello" },
};

function policy(overrides: Partial<EffectAuthorityContractPolicy> = {}): EffectAuthorityContractPolicy {
  return {
    authorityId: "primary-sor",
    adapterId: "effects-read-adapter",
    adapterVersion: "v1.0.0",
    environment: "production",
    tenantIdHash: HASH_A,
    effectType: "message.delivery",
    payloadProjectionId: HASH_B,
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
    ...overrides,
  };
}

interface Runtime {
  registry: EffectAuthorityRegistry;
  query: ResolvedEffectQuery;
  contract: EffectAuthorityContractPolicy & { contractId: string };
}

function runtime(options: {
  policy?: EffectAuthorityContractPolicy;
  validFrom?: string;
  validUntil?: string;
  revokedAt?: string | null;
  publicKey?: string;
  keyId?: string;
  operation?: OperationDescriptor;
} = {}): Runtime {
  const contractPolicy = options.policy ?? policy();
  const contractId = computeEffectAuthorityContractId(contractPolicy);
  const selectedPublicKey = options.publicKey ?? publicKey;
  const selectedKeyId = options.keyId ?? computeEffectAuthorityKeyId(selectedPublicKey);
  const registry = deriveEffectAuthorityRegistry({
    schemaVersion: "0.1",
    authorities: [
      {
        authorityId: contractPolicy.authorityId,
        keyId: selectedKeyId,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: selectedPublicKey,
        validFrom: options.validFrom ?? "2026-01-01T00:00:00.000Z",
        validUntil: options.validUntil ?? "2027-01-01T00:00:00.000Z",
        revokedAt: options.revokedAt ?? null,
        allowedContractIds: [contractId],
      },
    ],
    contracts: [{ contractId, ...contractPolicy }],
  });
  const query = resolveEffectQuery(registry, {
    contractId,
    operation: options.operation ?? operation,
    operationStartedAt: STARTED_AT,
  });
  return { registry, query, contract: { contractId, ...contractPolicy } };
}

function oneOutcome(overrides: Record<string, unknown> = {}): EffectAttestationOutcome {
  return {
    kind: "one",
    effect: {
      effectIdHash: HASH_A,
      payloadHash: HASH_B,
      committedAt: "2026-08-03T12:01:00.000Z",
      ...overrides,
    },
  } as EffectAttestationOutcome;
}

function zeroOutcome(overrides: Record<string, unknown> = {}): EffectAttestationOutcome {
  return {
    kind: "zero",
    closure: {
      markerType: "outbox-watermark",
      markerHash: HASH_C,
      consistency: "linearizable",
      effectSetComplete: true,
      eligibleThrough: FINAL_AFTER,
      closedAt: FINAL_AFTER,
      ...overrides,
    },
  } as EffectAttestationOutcome;
}

function makeAttestation(
  context: Runtime,
  outcome: EffectAttestationOutcome = oneOutcome(),
  payloadOverrides: Record<string, unknown> = {},
  signingKey = keys.privateKey,
): SignedEffectAttestation {
  const payload = {
    registryHash: context.registry.registryHash,
    authorityId: context.contract.authorityId,
    contractId: context.contract.contractId,
    operationId: context.query.operationId,
    operationStartedAt: context.query.operationStartedAt,
    adapterId: context.contract.adapterId,
    adapterVersion: context.contract.adapterVersion,
    environment: context.contract.environment,
    tenantIdHash: context.contract.tenantIdHash,
    queryKeyHash: context.query.queryKeyHash,
    effectType: context.contract.effectType,
    payloadProjectionId: context.contract.payloadProjectionId,
    observedAt: OBSERVED_AT,
    signedAt: SIGNED_AT,
    outcome,
    ...payloadOverrides,
  } as SignedEffectAttestation["payload"];
  const signedBody = {
    schemaVersion: "0.1" as const,
    protected: { algorithm: "Ed25519" as const, keyId },
    payload,
  };
  return {
    ...signedBody,
    signature: sign(
      null,
      Buffer.from(`${ATTESTATION_DOMAIN}\n${canonicalJson(signedBody)}`, "utf8"),
      signingKey,
    ).toString("base64url"),
  };
}

function resign(
  input: SignedEffectAttestation,
  signingKey = keys.privateKey,
): SignedEffectAttestation {
  const envelope = structuredClone(input);
  const signedBody = {
    schemaVersion: envelope.schemaVersion,
    protected: envelope.protected,
    payload: envelope.payload,
  };
  envelope.signature = sign(
    null,
    Buffer.from(`${ATTESTATION_DOMAIN}\n${canonicalJson(signedBody)}`, "utf8"),
    signingKey,
  ).toString("base64url");
  return envelope;
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof EffectAuthorityError && error.code === code;
}

function assertDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, seen);
  }
}

test("registry IDs are content-addressed, deterministic, branded, and deeply frozen", () => {
  const sourcePolicy = policy();
  const expectedContractId = computeEffectAuthorityContractId(sourcePolicy);
  const first = runtime();
  const second = runtime();
  assert.equal(first.contract.contractId, expectedContractId);
  assert.equal(first.registry.registryHash, second.registry.registryHash);
  assert.equal(keyId, computeEffectAuthorityKeyId(publicKey));
  assertDeepFrozen(first.registry);

  sourcePolicy.effectType = "changed.after.derivation";
  assert.equal(first.registry.manifest.contracts[0]!.effectType, "message.delivery");
  const forged = structuredClone(first.registry);
  assert.throws(
    () => resolveEffectQuery(forged, {
      contractId: first.contract.contractId,
      operation,
      operationStartedAt: STARTED_AT,
    }),
    errorCode("REGISTRY_NOT_DERIVED"),
  );
});

test("query coordinates are locally derived without retaining the raw idempotency key", () => {
  const first = runtime();
  const equivalent = runtime({
    operation: {
      ...operation,
      headers: {
        "IDEMPOTENCY-KEY": "01J4AIFI8DQ5F4V3T73Z9M6Y2X",
        "content-type": "application/json",
      },
    },
  });
  assert.equal(first.query.operationId, equivalent.query.operationId);
  assert.equal(first.query.queryKeyHash, equivalent.query.queryKeyHash);
  assert.equal(first.query.finalAfter, FINAL_AFTER);
  assert.equal(JSON.stringify(first.query).includes("01J4AIFI"), false);
  assertDeepFrozen(first.query);

  const changed = runtime({
    operation: {
      ...operation,
      headers: {
        ...operation.headers,
        "Idempotency-Key": "01J4AIFI8DQ5F4V3T73Z9M6Y2Y",
      },
    },
  });
  assert.notEqual(first.query.queryKeyHash, changed.query.queryKeyHash);
  assert.throws(
    () => runtime({ operation: { ...operation, headers: { "idempotency-key": "short" } } }),
    errorCode("QUERY_IDEMPOTENCY_KEY_INVALID"),
  );
});

test("a valid signed one outcome becomes one authoritative committed effect", () => {
  const context = runtime();
  const verified = verifyEffectAttestation(
    context.registry,
    context.query,
    makeAttestation(context),
    VERIFIED_AT,
  );
  const observations = effectObservationsFromVerifiedAttestation(verified);
  assert.equal(verified.assurance.authoritySignatureVerified, true);
  assert.equal(verified.assurance.paymentExecutionEnabled, false);
  assertDeepFrozen(verified);
  assertDeepFrozen(observations);
  assert.deepEqual(evaluateEffectEvidence(context.query.operationId, observations), {
    status: "committed",
    authoritative: true,
    effectCount: 1,
    effectIds: [HASH_A],
    reasons: [],
  });
});

test("a signed zero is authoritative only with complete linearizable post-horizon closure", () => {
  const context = runtime();
  const verified = verifyEffectAttestation(
    context.registry,
    context.query,
    makeAttestation(context, zeroOutcome()),
    VERIFIED_AT,
  );
  assert.deepEqual(
    evaluateEffectEvidence(
      context.query.operationId,
      effectObservationsFromVerifiedAttestation(verified),
    ),
    {
      status: "absent",
      authoritative: true,
      effectCount: 0,
      effectIds: [],
      reasons: [],
    },
  );
});

test("signed multiple proves duplicate while signed unknown remains non-authoritative", () => {
  const context = runtime();
  const multiple = makeAttestation(context, {
    kind: "multiple",
    minimumCount: 2,
    samples: [
      { effectIdHash: HASH_A, payloadHash: HASH_A, committedAt: OBSERVED_AT },
      { effectIdHash: HASH_B, payloadHash: HASH_B, committedAt: OBSERVED_AT },
    ],
  });
  const multipleEvidence = effectObservationsFromVerifiedAttestation(
    verifyEffectAttestation(context.registry, context.query, multiple, VERIFIED_AT),
  );
  assert.equal(evaluateEffectEvidence(context.query.operationId, multipleEvidence).status, "duplicate");

  const unknown = makeAttestation(context, { kind: "unknown", reason: "adapter_error" });
  const unknownEvidence = effectObservationsFromVerifiedAttestation(
    verifyEffectAttestation(context.registry, context.query, unknown, VERIFIED_AT),
  );
  assert.equal(unknownEvidence[0]!.authoritative, false);
  assert.equal(evaluateEffectEvidence(context.query.operationId, unknownEvidence).status, "unknown");
});

test("structural clones and caller-authored authority claims cannot cross the brand boundary", () => {
  const context = runtime();
  const verified = verifyEffectAttestation(
    context.registry,
    context.query,
    makeAttestation(context),
    VERIFIED_AT,
  );
  assert.throws(
    () => effectObservationsFromVerifiedAttestation(structuredClone(verified)),
    errorCode("ATTESTATION_NOT_VERIFIED"),
  );
  assert.throws(
    () => effectObservationsFromVerifiedAttestation({
      ...verified,
      assurance: { ...verified.assurance, authoritySignatureVerified: true },
    }),
    errorCode("ATTESTATION_NOT_VERIFIED"),
  );
});

test("signature mutations and non-canonical encodings produce no evidence", () => {
  const context = runtime();
  const valid = makeAttestation(context);
  const bytes = Buffer.from(valid.signature, "base64url");
  bytes[0] ^= 1;
  const cases = [
    bytes.toString("base64url"),
    "",
    `${valid.signature}=`,
    ` ${valid.signature}`,
    Buffer.alloc(63).toString("base64url"),
    Buffer.alloc(65).toString("base64url"),
    "+".repeat(86),
  ];
  for (const signature of cases) {
    const candidate = { ...valid, signature };
    assert.throws(
      () => verifyEffectAttestation(context.registry, context.query, candidate, VERIFIED_AT),
      (error) =>
        error instanceof EffectAuthorityError &&
        ["ATTESTATION_SIGNATURE_INVALID", "ATTESTATION_SIGNATURE_ENCODING_INVALID"].includes(
          error.code,
        ),
    );
  }

  const wrongSigner = makeAttestation(context, oneOutcome(), {}, alternateKeys.privateKey);
  assert.throws(
    () => verifyEffectAttestation(context.registry, context.query, wrongSigner, VERIFIED_AT),
    errorCode("ATTESTATION_SIGNATURE_INVALID"),
  );
});

test("every signed context coordinate is checked against locally derived policy", () => {
  const context = runtime();
  const mutations: Array<[string, unknown, string]> = [
    ["registryHash", HASH_C, "ATTESTATION_REGISTRY_MISMATCH"],
    ["contractId", HASH_C, "ATTESTATION_CONTRACT_MISMATCH"],
    ["operationId", HASH_C, "ATTESTATION_OPERATION_MISMATCH"],
    ["operationStartedAt", "2026-08-03T12:00:01.000Z", "ATTESTATION_OPERATION_START_MISMATCH"],
    ["authorityId", "foreign-authority", "ATTESTATION_AUTHORITY_MISMATCH"],
    ["adapterId", "foreign-adapter", "ATTESTATION_ADAPTER_MISMATCH"],
    ["adapterVersion", "v9.9.9", "ATTESTATION_ADAPTER_VERSION_MISMATCH"],
    ["environment", "staging", "ATTESTATION_ENVIRONMENT_MISMATCH"],
    ["tenantIdHash", HASH_C, "ATTESTATION_TENANT_MISMATCH"],
    ["queryKeyHash", HASH_C, "ATTESTATION_QUERY_MISMATCH"],
    ["effectType", "foreign.effect", "ATTESTATION_EFFECT_TYPE_MISMATCH"],
    ["payloadProjectionId", HASH_C, "ATTESTATION_PROJECTION_MISMATCH"],
  ];
  for (const [field, value, code] of mutations) {
    const candidate = makeAttestation(context);
    (candidate.payload as unknown as Record<string, unknown>)[field] = value;
    assert.throws(
      () => verifyEffectAttestation(context.registry, context.query, resign(candidate), VERIFIED_AT),
      errorCode(code),
      field,
    );
  }
});

test("key validity is half-open and any revocation blocks fresh verification", () => {
  const validAtStart = runtime({ validFrom: OBSERVED_AT });
  assert.doesNotThrow(() =>
    verifyEffectAttestation(
      validAtStart.registry,
      validAtStart.query,
      makeAttestation(validAtStart),
      VERIFIED_AT,
    ),
  );

  const notYetValid = runtime({ validFrom: VERIFIED_AT });
  assert.throws(
    () => verifyEffectAttestation(
      notYetValid.registry,
      notYetValid.query,
      makeAttestation(notYetValid),
      VERIFIED_AT,
    ),
    errorCode("AUTHORITY_KEY_OUTSIDE_VALIDITY"),
  );
  const expired = runtime({ validUntil: VERIFIED_AT });
  assert.throws(
    () => verifyEffectAttestation(expired.registry, expired.query, makeAttestation(expired), VERIFIED_AT),
    errorCode("AUTHORITY_KEY_OUTSIDE_VALIDITY"),
  );
  const revoked = runtime({ revokedAt: "2026-08-03T12:06:02.000Z" });
  assert.throws(
    () => verifyEffectAttestation(revoked.registry, revoked.query, makeAttestation(revoked), VERIFIED_AT),
    errorCode("AUTHORITY_KEY_REVOKED"),
  );
});

test("freshness and chronology use the explicit trusted verification time", () => {
  const context = runtime();
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ observedAt: "2026-08-03T11:59:59.999Z" }, VERIFIED_AT, "ATTESTATION_OBSERVED_BEFORE_OPERATION"],
    [{ signedAt: "2026-08-03T12:05:59.999Z" }, VERIFIED_AT, "ATTESTATION_SIGNED_BEFORE_OBSERVATION"],
    [{}, "2026-08-03T12:06:00.999Z", "ATTESTATION_VERIFIED_BEFORE_SIGNATURE"],
    [{ signedAt: "2026-08-03T12:07:00.001Z" }, "2026-08-03T12:07:00.001Z", "ATTESTATION_SIGNATURE_DELAY_EXCEEDED"],
    [{}, "2026-08-03T12:16:01.001Z", "ATTESTATION_STALE"],
  ];
  for (const [overrides, verifiedAt, code] of cases) {
    assert.throws(
      () => verifyEffectAttestation(
        context.registry,
        context.query,
        makeAttestation(context, oneOutcome(), overrides),
        verifiedAt,
      ),
      errorCode(code),
    );
  }
});

test("zero closure rejects every incomplete, weak, premature, or mismatched boundary", () => {
  const context = runtime();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ effectSetComplete: false }, "ATTESTATION_CLOSURE_INVALID"],
    [{ consistency: "eventual" }, "ATTESTATION_CLOSURE_INVALID"],
    [{ markerType: "foreign-watermark" }, "ATTESTATION_CLOSURE_MARKER_MISMATCH"],
    [{ eligibleThrough: "2026-08-03T12:04:59.999Z" }, "ATTESTATION_CLOSURE_HORIZON_INVALID"],
    [{ closedAt: "2026-08-03T12:04:59.999Z" }, "ATTESTATION_CLOSURE_HORIZON_INVALID"],
    [{ closedAt: "2026-08-03T12:06:00.001Z" }, "ATTESTATION_CLOSURE_HORIZON_INVALID"],
  ];
  for (const [override, code] of cases) {
    assert.throws(
      () => verifyEffectAttestation(
        context.registry,
        context.query,
        makeAttestation(context, zeroOutcome(override)),
        VERIFIED_AT,
      ),
      errorCode(code),
    );
  }

  assert.throws(
    () => verifyEffectAttestation(
      context.registry,
      context.query,
      makeAttestation(context, zeroOutcome(), {
        observedAt: "2026-08-03T12:04:59.999Z",
        signedAt: "2026-08-03T12:05:00.000Z",
      }),
      VERIFIED_AT,
    ),
    errorCode("ATTESTATION_CLOSURE_HORIZON_INVALID"),
  );
});

test("multiple requires two sorted distinct effect samples", () => {
  const context = runtime();
  type Sample = { effectIdHash: string; payloadHash: string; committedAt: string };
  const one: Sample = { effectIdHash: HASH_A, payloadHash: HASH_A, committedAt: OBSERVED_AT };
  const base = {
    kind: "multiple" as const,
    minimumCount: 2 as const,
    samples: [
      { effectIdHash: HASH_A, payloadHash: HASH_A, committedAt: OBSERVED_AT },
      { effectIdHash: HASH_B, payloadHash: HASH_B, committedAt: OBSERVED_AT },
    ] as [Sample, Sample],
  };
  const duplicate = structuredClone(base) as unknown as Record<string, unknown>;
  (duplicate.samples as Sample[])[1] = { ...one };
  assert.throws(
    () => verifyEffectAttestation(
      context.registry,
      context.query,
      makeAttestation(context, duplicate as unknown as EffectAttestationOutcome),
      VERIFIED_AT,
    ),
    errorCode("ATTESTATION_MULTIPLE_SAMPLES_INVALID"),
  );
  const reversed = structuredClone(base) as unknown as { samples: Sample[] };
  reversed.samples.reverse();
  assert.throws(
    () => verifyEffectAttestation(
      context.registry,
      context.query,
      makeAttestation(context, reversed as unknown as EffectAttestationOutcome),
      VERIFIED_AT,
    ),
    errorCode("ATTESTATION_MULTIPLE_SAMPLES_INVALID"),
  );
});

test("strict data schemas reject unknown fields, accessors, malformed keys, and registry ambiguity", () => {
  const context = runtime();
  const withExtra = makeAttestation(context) as unknown as Record<string, unknown>;
  withExtra.authoritative = true;
  assert.throws(
    () => verifyEffectAttestation(context.registry, context.query, withExtra, VERIFIED_AT),
    errorCode("ATTESTATION_UNEXPECTED_FIELD"),
  );

  let getterReads = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "schemaVersion", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "0.1";
    },
  });
  assert.throws(
    () => deriveEffectAuthorityRegistry(accessor),
    errorCode("INPUT_ACCESSOR_OR_HIDDEN_FIELD"),
  );
  assert.equal(getterReads, 0);

  assert.throws(
    () => computeEffectAuthorityKeyId(`${publicKey}A`),
    errorCode("AUTHORITY_PUBLIC_KEY_INVALID"),
  );
  assert.throws(
    () => computeEffectAuthorityKeyId(`${publicKey}=`),
    errorCode("AUTHORITY_PUBLIC_KEY_INVALID"),
  );

  const contractPolicy = policy();
  const contractId = computeEffectAuthorityContractId(contractPolicy);
  const duplicateKeyRegistry = {
    schemaVersion: "0.1",
    authorities: [
      {
        authorityId: "primary-sor",
        keyId,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        allowedContractIds: [contractId],
      },
      {
        authorityId: "primary-sor",
        keyId,
        algorithm: "Ed25519",
        usage: "effect_attestation",
        publicKeySpkiDerBase64url: publicKey,
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        allowedContractIds: [contractId],
      },
    ],
    contracts: [{ contractId, ...contractPolicy }],
  };
  assert.throws(
    () => deriveEffectAuthorityRegistry(duplicateKeyRegistry),
    errorCode("REGISTRY_DUPLICATE_AUTHORITY_KEY"),
  );
});

test("verification never consults ambient time or imports an action/network capability", async () => {
  const context = runtime();
  const originalNow = Date.now;
  Date.now = () => {
    throw new Error("ambient clock used");
  };
  try {
    assert.doesNotThrow(() =>
      verifyEffectAttestation(
        context.registry,
        context.query,
        makeAttestation(context),
        VERIFIED_AT,
      ),
    );
  } finally {
    Date.now = originalNow;
  }

  const source = await readFile(new URL("../evidence/effect-authority.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /from\s+["']node:(?:http|https|net|tls|dns)["']|\bfetch\s*\(|sendRawTransaction|wallet|signer/i,
  );
});
