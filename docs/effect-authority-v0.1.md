# Effect Authority v0.1

Status: local Ed25519 verification boundary and synthetic conformance fixture. No live system-of-record adapter or action path exists.

## Purpose and trust boundary

This module turns a signed system-of-record statement into business-effect observations without trusting a caller-supplied `authoritative` flag. It is intentionally separate from Evidence Kernel v0.1, whose input remains a legacy prevalidated-observation format and whose bundle continues to report `externalAuthorityProven: false`.

Authority comes from three inputs with different owners:

1. An operator-controlled registry pins the exact Ed25519 public key and a content-addressed effect contract.
2. A controlled operation context supplies the semantic request and the journaled operation-start time.
3. The configured system-of-record authority signs the exact query coordinates and outcome.

The registry must be provisioned out of band. The CLI additionally requires its expected `sha256:` registry hash as a separate pin; accepting a registry hash from the signed envelope itself would let an attacker introduce a new trust root.

The verifier is local and synchronous. It imports only the existing canonical identity code and `node:crypto`. It has no HTTP, RPC, database-write, callback, retry, wallet, signer, transaction-submission, or payment interface.

## Policy and query binding

Each contract ID is the domain-separated hash of every trusted policy field, including:

- authority, adapter ID/version, environment, and hashed tenant;
- effect type and content-addressed payload projection;
- the `Idempotency-Key` query rule;
- a maximum of one effect backed by a primary transactional unique constraint;
- the finalization delay;
- the required linearizable closure-marker type; and
- observation/signature freshness limits.

The verifier derives the operation ID locally. It trims only outer HTTP optional whitespace from the idempotency key, requires a bounded printable value, and emits only a domain-separated query-key hash. The raw key is never retained in the resolved query, verified result, observations, errors, or example output.

`finalAfter` is computed as the controlled `operationStartedAt` plus the contract delay. It is not accepted from the signed wire object. Until the journal-binding layer is complete, callers must treat both `operationStartedAt` and `verifiedAt` as controlled inputs rather than arbitrary request data.

## Signature and key rules

The signed bytes are:

```text
x402-canary:effect-authority-attestation:v0.1\n
<canonical JSON of schemaVersion, protected header, and payload>
```

Verification is deliberately narrow:

- algorithm is exactly Ed25519;
- public keys are canonical unpadded base64url DER-SPKI, exactly 44 bytes, with the RFC 8410 Ed25519 prefix and a byte-for-byte export round trip;
- the key ID is the SHA-256 fingerprint of that exact DER value;
- signatures are canonical unpadded base64url and exactly 64 bytes;
- Node verifies the un-prehashed domain-separated bytes with `verify(null, ...)`;
- key windows are half-open, and both signing and verification time must fall inside them; and
- any non-null revocation blocks all new verification. A signer-controlled historical timestamp cannot defeat revocation.

The signed statement binds the registry, authority/key, contract, operation/start time, adapter/version, environment, tenant, query hash, effect type, payload projection, observation/signature times, and exact outcome. A valid signature in the wrong context is still rejected.

## Outcomes

- `one` contains hashed effect identity, projected payload hash, and commit time. It becomes one authoritative committed observation.
- `multiple` contains exactly two sorted, distinct committed samples and proves a duplicate lower bound.
- `zero` becomes authoritative absence only when the signed closure is complete, linearizable, uses the contract marker type, covers at least `finalAfter`, and closes no later than the observation.
- `unknown` uses a bounded reason enum and always becomes a non-authoritative unknown observation.

Malformed configuration, invalid signatures, stale evidence, revoked keys, context replay, incomplete closure, and any other verification failure produce no observation at all. They are not silently downgraded to operational `unknown`.

Verified results and their observation conversion are branded with process-local `WeakSet` state and deeply frozen. A serialized clone or structurally similar `{ authoritative: true }` object cannot cross the conversion boundary; persisted evidence must be reverified.

## Verify the synthetic fixture

```bash
npm run --silent effect:verify -- \
  sha256:f06a237ee94a3da72c52a64b6b87727dbf1c1724d94ed2f55df680d2d8029db3 \
  examples/effect-authority-registry-v0.1.json \
  examples/effect-verification-request-v0.1.json \
  examples/effect-attestation-v0.1.json
```

The fixture key is synthetic; only its public key and a precomputed signature are checked in. The output contains the registry, resolution, and attestation hashes plus an authoritative absence observation. It contains neither the signature, public key, nor raw idempotency key.

## Remaining production work

This verifier proves that the configured authority signed a policy-matching statement. It does not prove that an adapter actually queried the intended primary system of record, that the declared uniqueness constraint exists, or that a closure marker is truthful. Those properties require an operator-owned read-only adapter, credential-level write denial, deployment review, and independent integration testing.

The next wrapper must accept signed envelopes or runtime-branded verified results—not raw `EffectObservation[]`—and bind the registry, resolution, attestation, Base collection, and journal heads into a new bundle schema. Evidence Kernel v0.1 must not be relabeled as externally authoritative.
