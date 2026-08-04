# Shadow Runner v0.1

Status: private, read-only Base/effect orchestration with journal-bound local integrity. It has no operation, retry, wallet, signing, transaction-submission, or payment path.

## Purpose

The runner composes the previously separate evidence boundaries for one already journaled authorization attempt:

```text
separately reviewed manifest + out-of-band trust pins
                         |
                         v
existing journal prefix and exact expected head
                         |
              +----------+----------+
              |                     |
              v                     v
  pinned read-only Base RPC   local signed-effect checks
              |                     |
              +----------+----------+
                         v
             journal-bound bundle v0.2
                         |
                         v
          sanitized result; actionDirective: none
```

It does not create an attempt, authorization, signature, or transmission record. It requires those lifecycle facts to exist before the run and writes only immutable evidence artifacts plus the two adjacent kernel closure records.

## Split authority inputs

The manifest and trust pins are separate documents on purpose. The manifest describes what to evaluate. The pins say which exact manifest, journal prefix, identities, Base registry, and signed-effect inputs the operator trusts.

Do not derive trust merely by accepting pins delivered alongside an untrusted manifest. Review or provision the pins through an independent operator-controlled path.

The manifest has this exact outer shape. The placeholders below are deliberately non-runnable:

```json
{
  "schemaVersion": "0.1",
  "kind": "journal_bound_shadow_run",
  "mode": "shadow_no_action",
  "baseRegistry": { "schemaVersion": "0.1", "networkId": "eip155:8453" },
  "operation": {
    "url": "https://merchant.example/private-operation",
    "method": "POST",
    "headers": {
      "content-type": "application/json",
      "idempotency-key": "operator-controlled-value"
    },
    "body": { "orderId": "private-business-value" }
  },
  "authorization": {
    "networkId": "eip155:8453",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "from": "0x0000000000000000000000000000000000000000",
    "to": "0x0000000000000000000000000000000000000000",
    "valueAtomic": "0",
    "validAfter": "0",
    "validBefore": "0",
    "nonce": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "transactionHash": null,
  "declaredAttempt": {
    "preflightPassed": true,
    "policyRejectedBeforeAuthorization": false,
    "signingRejected": false,
    "deliveryContractApplicable": false,
    "delivery": "not_applicable"
  },
  "minimumConfirmations": 12,
  "effects": { "mode": "not_applicable" }
}
```

The abbreviated `baseRegistry` above is illustrative, not runnable. A real manifest must contain the complete canonical Base Collector v0.1 registry. When business effects are required, `effects` instead contains one or more `{ registry, contractId, attestation }` proofs. Proofs and their pins are ordered by unique attestation hash.

The trust-pin document has this exact shape:

```json
{
  "schemaVersion": "0.1",
  "kind": "journal_bound_shadow_run_pins",
  "manifestHash": "sha256:<64 lowercase hex>",
  "journal": {
    "expectedHead": {
      "journalId": "sha256:<64 lowercase hex>",
      "sequence": 2,
      "recordHash": "sha256:<64 lowercase hex>"
    },
    "attemptOpenedRecordHash": "sha256:<64 lowercase hex>",
    "operationId": "sha256:<64 lowercase hex>",
    "authorizationId": "sha256:<64 lowercase hex>"
  },
  "baseRegistryHash": "sha256:<64 lowercase hex>",
  "effects": [
    {
      "registryHash": "sha256:<64 lowercase hex>",
      "contractId": "sha256:<64 lowercase hex>",
      "attestationHash": "sha256:<64 lowercase hex>"
    }
  ]
}
```

`effects` must be empty when the effect contract is not applicable. Otherwise each pin must correspond by index to a manifest proof, and attestation hashes must be sorted and unique.

## Strict manifest boundary

Before any clock or RPC use, the runner:

- rejects unknown, missing, accessor-backed, cyclic, sparse, over-depth, or oversized input data;
- derives the operation and exact authorization IDs locally;
- requires the raw Base and effect registries to equal their derived canonical representations;
- validates every effect contract membership and content-addresses every strict attestation envelope;
- matches all independently supplied hashes and journal coordinates;
- permits only lowercase `accept`, `content-type`, and `idempotency-key` operation headers;
- rejects URL userinfo, fragments, and secret-like query/body keys; and
- treats the operation URL only as identity data. It is never a network destination.

The secret-key filter is defense in depth, not a data-loss-prevention system. The manifest, journal, and artifact directory are private operator data. Never place endpoint credentials, authorization/payment signatures, private keys, recovery material, or secret values under innocuous field names in them. A signed effect attestation's public verification signature is allowed but is omitted from public output.

## Required journal lifecycle

The expected-head prefix must contain exactly one pinned `attempt_opened` and exactly one matching `authorization_recorded`, followed by at most one matching `authorization_transmitted`. Counts, operation and authorization IDs, sequence order, and canonical timestamps are checked.

Because a recorded authorization already exists, `policyRejectedBeforeAuthorization: true` is rejected. If transmission exists, failed preflight or signing rejection declarations are also rejected. The runner derives creation and transmission facts from the journal; the remaining preflight, signing, and delivery fields are still explicitly marked `caller_declared_unverified` in assurance.

The source prefix must not already contain an attempt close or kernel closure. The actual head must equal the pin for a fresh run. The journal is opened with an exclusive cooperating-writer sentinel and head compare-and-set, so a concurrent append cannot be silently incorporated.

## Fresh close

For a fresh close, the runner:

1. audits the existing journal/artifact state and requires it to be clean;
2. reads its injected clock exactly once and rejects a time before the controlled lifecycle;
3. derives each effect query from the journaled attempt time and verifies its Ed25519 signature, key lifecycle, policy, context, freshness, and out-of-band hash pin;
4. creates a requester from the already derived Base registry;
5. collects only the read-method allowlist through the production HTTPS/Web-PKI transport;
6. requires a `kernel_ready` Base collection and the expected transport assurance;
7. derives the v0.2 evaluator input without accepting raw observations or retry assertions;
8. writes immutable artifacts and two adjacent journal commits;
9. performs offline local-integrity verification plus a clean recovery audit; and
10. brands the verified in-process result before it can cross the public redaction boundary.

A receipt later than the shared finalized Base anchor is not converted into usable absence. The run fails with `SHADOW_BASE_COLLECTION_NOT_KERNEL_READY` before any evidence artifact or kernel commit is written.

## Exact replay and recovery

If the exact input and bundle commits immediately follow the pinned source head, the runner recovers the closure receipt and verifies the persisted graph. It recomputes the current manifest's identities, canonical registries, and raw attestation hashes and compares every execution-relevant field with the persisted closure.

Replay intentionally creates no Base requester, makes no RPC call, and does not consult the clock. It therefore does not claim current Base truth, current key validity, historical HTTPS reauthentication, or a fresh signature verification. Its claim is narrower: the supplied canonical manifest is semantically identical to the locally verified, journal-bound closure, and that retained graph still passes local integrity checks.

A lone input commit is an operator-recovery condition, not permission to interleave or guess. Complete adjacent commits can regenerate a lost receipt. Recovery inspection never deletes an orphan, temporary file, or journal record.

## Operator commands

Hashing is local and performs no network request:

```bash
npm run --silent shadow:run -- hash private/shadow-manifest.json
```

The hash command fully validates identities, canonical registries, effect contract membership, attestation structure, and the operation-data persistence boundary. Treat its output as a candidate to review and pin independently; it does not establish trust by itself.

Close or exactly replay an existing attempt:

```bash
npm run --silent shadow:run -- close \
  private/shadow-trust-pins.json \
  private/shadow-manifest.json \
  private/evidence-journal.jsonl \
  private/evidence-artifacts
```

`close` refuses to create a missing journal, metadata sidecar, or parent directory. The artifact store may create its selected private directory after the manifest and pins validate and the journal opens structurally; pinned head and lifecycle checks still occur before clock use, network access, or artifact payload writes. Production Base endpoints come from the environment-variable names in the pinned registry and must match its canonical HTTPS origins. There is no CLI option for a URL, wallet, signer, transaction, action, retry, output destination, or payment.

On success, stdout contains only the sanitized JSON result. On failure, stdout is empty and stderr contains one stable uppercase code. If output delivery itself is lost after a commit, rerun the same pinned close command to obtain an exact replay receipt.

## Public result and no-action guarantee

The public result includes IDs and content hashes, the settlement/effect/invariant verdict, closure receipt, explicit assurance caveats, and these fixed controls:

```json
{
  "integrityVerified": true,
  "actionDirective": "none",
  "execution": {
    "actionExecutionEnabled": false,
    "paymentExecutionEnabled": false,
    "transactionSubmissionEnabled": false,
    "retryExecutionEnabled": false
  }
}
```

It omits the operation URL/body, raw idempotency key, endpoint environment values, RPC origins, transaction/block details, effect query and IDs, public keys, signatures, filesystem paths, and both retry verdict booleans. The public converter accepts only the exact process-branded result produced after closure verification and recovery audit; fabricated objects and serialized clones are rejected.

## Deterministic conformance matrix

The injected end-to-end suite exercises real collector and Ed25519 verification code without network access:

| Base evidence | Effect evidence | Terminal state | Internal same/new authorization retry | Invariant |
| --- | --- | --- | --- | --- |
| confirmed | committed | `settled_delivered` | false / false | pass |
| absent | absent | `settlement_failed` | false / true | pass |
| confirmed, below configured finality | committed | `settled_pending_finality` | false / false | pass |
| contradiction | committed | `evidence_contradiction` | false / false | integrity failure |
| duplicate settlement | committed | `duplicate_settlement` | false / false | fail |
| confirmed | absent | `settled_delivery_failed` | false / false | pass |
| confirmed | unknown | `settled_delivery_unverified` | false / false | pass |
| confirmed | duplicate effect | `settled_delivery_failed` | false / false | fail |
| confirmed | contradictory effect | `evidence_contradiction` | false / false | integrity failure |

The internal retry derivation is retained in the private bundle for audit only. It is not emitted by the operator result and is never executed. The authoritative absent/absent row can establish that a new authorization would be safe under the pure policy, but this shadow runner still returns only `actionDirective: "none"`.

Additional adversarial cases cover malformed/pin/signature failures, lifecycle contradictions, a finalized-anchor readiness gap, malicious operation URLs, forbidden write methods, public-output redaction, forged result objects, exact replay without clock/RPC, offline integrity replay, and clean crash-recovery auditing.

## What remains unproven

This runner raises composition assurance but does not turn local evidence into payment authority:

- HTTPS authenticates configured RPC endpoints, not Base consensus truth. The current two-provider setup is still an operator-declared trust model.
- A valid effect signature does not independently prove that the authority queried the intended primary database or that its uniqueness/closure claims are truthful.
- Non-lifecycle attempt predicates remain caller-declared.
- Offline replay does not repeat historical transport or signature authentication.
- The journal depends on a trusted local writer and cooperating lock discipline.
- A local hash chain cannot prevent complete rollback of the journal, artifacts, and all retained receipts. An external signed/WORM checkpoint is still required.
- No delivery authority, settlement submitter/router classification, public service, scheduler, deployment, wallet, signer, transaction submission, payment, or retry executor is included.

Payment execution remains disabled until those separate production gates are satisfied and explicitly authorized.

## Verification

Run the repository gates:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

These gates use deterministic injected transports and synthetic signing keys. They do not make a production request, payment, transaction, or deployment.
