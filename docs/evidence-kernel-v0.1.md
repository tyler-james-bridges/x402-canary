# Evidence Kernel v0.1

Status: deterministic local evaluator and journal primitives. Payment execution remains disabled.

## Purpose

The kernel answers a narrow question: given a bounded operation, one exact Base-USDC authorization, sanitized Base observations, and operator effect observations, what is independently recomputable—and what is still unknown?

It produces canonical operation and authorization IDs, settlement/effect verdicts, a terminal state, two separate retry decisions, an at-most-one invariant, and deterministic input/bundle hashes.

## Trust boundary

The kernel validates structure, domain binding, internal consistency, finality claims, and evidence relationships. It performs no RPC, HTTP, wallet, signer, or payment work.

It does **not** authenticate a `source` string or prove that an observation came from a real Base node or operator database. In v0.1, `authoritative` means “authoritative if this observation was produced by the separately configured trusted adapter.” Untrusted callers must not be allowed to submit arbitrary observations and then treat the resulting bundle as external proof.

Every bundle carries this boundary in machine-readable form: `sourceAuthentication` is `not_performed`, `externalAuthorityProven` is `false`, and `paymentExecutionEnabled` is `false`.

The production boundary therefore has four parts:

1. A Base collector authenticates configured RPC endpoints and records canonical receipt/head and `authorizationState` facts.
2. An operator adapter queries the system of record under a documented effect contract.
3. The pure kernel recomputes the decision from those pre-validated facts.
4. A persistence layer binds the resulting bundle to the verified journal head.

Part 3 and the underlying journal primitive are implemented here; the collectors, operator adapter, and bundle-to-journal binding are not.

## Canonical identities

The operation ID binds the HTTPS URL, method, normalized non-payment headers, and canonical JSON body presence/value. Payment credential headers and unknown descriptor fields are rejected.

The authorization ID binds Base mainnet (`eip155:8453`), native Base USDC, payer, recipient, atomic value, `validAfter`, `validBefore`, and nonce. Signatures are deliberately excluded and must never be journaled.

Both IDs use domain-separated SHA-256 preimages and the `sha256:<lowercase hex>` representation.

## Settlement presence

A confirmed settlement requires all of the following:

- Base mainnet and native Base USDC;
- a successful receipt with a canonical block hash and the required confirmations;
- one native-USDC `AuthorizationUsed(authorizer, nonce)` event;
- one exact native-USDC `Transfer(from, to, value)` event;
- the `AuthorizationUsed` event immediately followed by its `Transfer`, matching Circle USDC’s EIP-3009 execution order;
- agreement across any independent receipt observations and any same-height `authorizationState` snapshot.

Wrong chain, token, payer, recipient, value, nonce, log shape, receipt status, block hash, pairing, or finality fails closed. Multiple matching transfers or effects trip the operation invariant.

Circle’s implementation marks the authorization used immediately before executing the transfer: [EIP3009.sol](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol).

## Settlement absence

Elapsed wall time and a missing receipt are insufficient. Authoritative absence requires at least two distinct trusted-source observations that:

- agree on the same canonical block number, hash, and timestamp;
- show the exact payer/nonce `authorizationState` is unused;
- occur after `validBefore`; and
- independently meet the configured confirmation threshold.

Any used state without a receipt remains unknown because USDC uses the same state bit for used or canceled authorizations.

## Business effect

Effect observations bind the operation ID, system query key, effect type, effect ID, and payload hash. An authoritative commit proves one effect. An authoritative absence is accepted only after the effect contract’s `finalAfter`. Conflicting commits, commit/absence disagreement, or multiple effect IDs fail closed.

The evaluator cannot decide whether a database is authoritative. That must be established by the operator adapter and deployment policy.

## Retry verdicts

The kernel never collapses retries into one boolean:

- Reusing the same signed authorization is safe only when the idempotency contract and both no-new-settlement/no-new-effect assertions are explicitly verified.
- Issuing a new authorization is safe only when the old authorization is expired/unusable and both settlement absence and effect absence are authoritative.

Unknown evidence makes both verdicts false.

## Journal

`EvidenceJournal` writes canonical JSONL records with sequence numbers, previous-record hashes, record hashes, private file modes, fsync, torn-write detection, tamper validation, duplicate-event rejection, recursive secret-key rejection, and serialized in-process appends.

The current lock is process-local. Deployments must enforce a single writer or add cross-process locking before treating the journal as a production ledger. The bundle is not yet cryptographically bound to a verified journal head.

## Recompute the example

```bash
npm run --silent evidence -- examples/evidence-kernel-v0.1.input.json
```

The result must exactly match `examples/evidence-kernel-v0.1.bundle.json`. The example is synthetic and sanitized; its source names are not claims about real infrastructure.
