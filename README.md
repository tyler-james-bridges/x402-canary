# x402-canary

Contract-defined acceptance verification for x402 paid paths, currently narrowed to Base mainnet, native USDC, x402 v2 `exact`, and EIP-3009-style requirements.

## Current safety state

This branch is in source-containment and deterministic-fixture mode:

- Public caller-selected outbound probes are disabled and return HTTP 410.
- `/api/health` returns local containment status and makes no third-party requests.
- `npm start` serves only the containment page on `127.0.0.1`; scheduled endpoint checks are disabled.
- The source Bankr manifest advertises no paid services.
- The CLI rejects `--pay` before loading a contract, and the executable AgentCash adapter is a fail-closed stub with no subprocess or wallet path.
- The evidence CLI evaluates sanitized files only; it has no RPC, wallet, signer, URL-fetch, or payment option.
- The separate `base:collect` operator CLI performs registry-pinned, read-only Base RPC collection; it exposes no wallet, signer, transaction-submission, or payment method and is not imported by a public route.
- The separate `effect:verify` CLI performs local Ed25519 verification against an out-of-band registry hash; it exposes no network, database-write, retry, wallet, signer, transaction, or payment path.
- Journal-bound bundle v0.2 persists branded Base/effect inputs and deterministic shadow results behind two adjacent journal commits; every execution flag remains false.
- Tests and CI make no production payment.

The source changes have not been deployed or independently verified on the live Vercel and Bankr surfaces. Do not describe the production service as contained until deployment, Bankr unpublish/disable, and post-deployment verification are complete.

## What is implemented

The no-spend verifier and fixtures evaluate objective predicates rather than a trust score or payment recommendation:

- `returns_402`
- `challenge_valid`
- `browser_readable`
- `preflight_valid`
- `contract_compatible`

Contract compatibility requires one unambiguous requirement matching all of:

- x402 version 2
- the contracted HTTPS resource URL
- Base mainnet (`eip155:8453`)
- native Base USDC
- `exact`
- the pinned `payTo`
- the atomic price ceiling and USD cap
- an EIP-3009-compatible token domain, with Permit2 and `upto` rejected
- a challenge timeout no greater than the configured 60-second policy ceiling

The deterministic reconciliation fixtures separately model settlement, response delivery, and business effect. They cover unresolved authorization transmission, late settlement, response loss after an effect, identical HTTP 502 shapes before and after submission, authoritative zero-settlement closure, and concurrent identical-key replay.

Evidence Kernel v0.1 adds the local evidence-producing primitives that were previously missing:

- canonical, domain-separated operation and exact EIP-3009 authorization IDs;
- a private-mode, append-only, hash-linked JSONL journal with a stable journal identity, cross-process cooperating-writer sentinel, head compare-and-set, deterministic replay, and restart/tamper/torn-write validation;
- a pure Base evaluator over injected observations that pins chain ID and native USDC, verifies canonical receipt/finality facts, and requires an adjacent `AuthorizationUsed(authorizer, nonce)` plus exact `Transfer(from, to, value)` pair;
- finalized, independently agreeing `authorizationState` snapshots for authoritative settlement absence;
- authoritative business-effect reconciliation with duplicate and contradiction detection;
- deterministic input and bundle hashes, conservative terminal states, separate same-authorization/new-authorization retry verdicts, and the one-settlement/one-effect invariant.

Base Collector v0.1 now establishes the Base observations through a hashed two-source registry, HTTPS origin and DNS policy, a pinned Base genesis checkpoint, a unanimous shared `finalized` block, EIP-1898 state reads, and an upgrade-aware native-USDC code allowlist. Its sanitized live conformance receipt is checked in.

Effect Authority v0.1 adds a separate Ed25519 verification boundary. It content-addresses operator policy, derives the operation/query/finality coordinates locally, pins canonical public keys and key lifecycles, requires a complete linearizable post-horizon marker for authoritative absence, and converts only runtime-branded verification results into authoritative observations. A synthetic signed fixture is checked in. The legacy v0.1 kernel remains deliberately separate and does not upgrade its assurance merely because either authority artifact exists.

Journal-bound bundle v0.2 now binds the unique journaled attempt start, the authorization-bound Base audit artifact, timestamped signed-effect audit artifacts, the exact derived v0.1 evaluator input, and its deterministic result into immutable artifacts and two globally adjacent journal commits. A separate non-circular receipt supports offline local-integrity replay and deterministic receipt recovery. Its assurance explicitly discloses caller-declared attempt predicates, trusted-local-writer dependence, lack of historical transport/signature reauthentication, lack of an external anti-rollback checkpoint, and disabled action/payment/transaction/retry execution.

## Run locally

Install dependencies, then run the deterministic suite:

```bash
npm test
npm run typecheck
npm run build
```

Recompute the sanitized Evidence Kernel example without making a network request:

```bash
npm run --silent evidence -- examples/evidence-kernel-v0.1.input.json
```

The output should exactly match `examples/evidence-kernel-v0.1.bundle.json`.

Run the explicit read-only Base conformance collector (this contacts the two configured RPC origins):

```bash
BASE_RPC_OFFICIAL_URL=https://mainnet.base.org \
BASE_RPC_PUBLICNODE_URL=https://base-rpc.publicnode.com \
npm run --silent base:collect -- \
  examples/base-source-registry-v0.1.json \
  examples/base-collection-request-v0.1.json
```

The output contains registry-bound public chain facts but no endpoint URL or credential. See `docs/base-collector-v0.1.md` for the exact trust boundary.

Verify the synthetic system-of-record attestation without making a network request:

```bash
npm run --silent effect:verify -- \
  sha256:f06a237ee94a3da72c52a64b6b87727dbf1c1724d94ed2f55df680d2d8029db3 \
  examples/effect-authority-registry-v0.1.json \
  examples/effect-verification-request-v0.1.json \
  examples/effect-attestation-v0.1.json
```

The expected registry hash is an out-of-band trust pin, not evidence supplied by the attestation. See `docs/effect-authority-v0.1.md` for the signature, policy, clock, and remaining operator-adapter boundary.

The packaged contract can perform a live, unpaid challenge request when run manually:

```bash
npm run verify -- contracts/bankr-lint.json
```

That command does not authorize payment, but it does contact the contracted endpoint. Do not run it against a route without operator permission. `--pay` is deliberately disabled.

The initial request preserves the contracted method and body. On a broken or misconfigured stateful route, an unpaid request could still cause a business effect, so live challenge checks are limited to operator-owned or explicitly authorized fixtures.

## Unknown outcomes and retries

If an authorization may have been transmitted and the response is lost, the settlement and business effect are `unknown`. Do not issue a new authorization based on elapsed time, an HTTP error, or an idempotency key alone.

An identical signed-request replay is safe only after the route's replay contract proves it creates no new settlement and no new effect. A new authorization is safe only after the prior authorization is provably unusable and authoritative evidence establishes both settlement absence and effect absence.

## Public routes in this branch

- `GET /api/health` — local containment status; zero outbound requests.
- `GET /api/trust` — legacy route; HTTP 410; zero outbound requests.
- `POST /api/preflight` — legacy route; HTTP 410; zero outbound requests.
- `x402/trust` — disabled paid-handler source; HTTP 410; zero outbound requests.

## Not yet production-ready

Evidence Kernel v0.1 is a deterministic local evaluator, not authorization to turn payment back on. Paid execution remains blocked until at least:

- production RPC sources or a self-validating node replace the development public-provider pair, with live Base fork, provider-independence, and native-USDC upgrade conformance;
- an operator-owned read-only system-of-record adapter emits the implemented signed effect-attestation format and its uniqueness/closure claims are validated against the real store;
- the cooperating-process sentinel is replaced or operationally wrapped with an OS advisory lock or transactional store, and receipts are anchored in external WORM/signed checkpoint storage to prevent complete rollback;
- caller-declared attempt predicates gain configured authority evidence, and offline verification receives separately pinned registries when historical signature re-verification is required;
- settlement submitter and recipient/router classification is implemented;
- Base fork/RPC conformance and upgrade-aware native-USDC event-order coverage pass for the restricted slice;
- delivery evidence is independently verified wherever delivery is a separate required outcome;
- the integrated adapters receive an external security review;
- deployed Vercel containment and separate Bankr service pause/unpublish status are verified.

Facilitator or client metadata may be retained as a provider claim, but it cannot independently satisfy Base settlement or delivery.

## Repository layout

- `api/`, `x402/`, `public/` — contained public surface.
- `src/index.ts`, `src/dashboard.ts`, `src/canary.ts` — contained loopback start path; no scheduler or generic outbound checker.
- `contracts/` — pinned acceptance contracts.
- `src/x402-challenge.ts` — exact-only challenge and no-spend predicate evaluation.
- `src/reconciliation-policy.ts` — pure terminal and retry-safety derivation.
- `src/evidence/`, `src/evidence-cli.ts`, `src/base-evidence-collect-cli.ts`, `src/effect-attestation-verify-cli.ts`, `examples/` — Evidence Kernel primitives, file-only evaluation, explicit read-only Base collection, and local signed-effect verification.
- `docs/evidence-kernel-v0.1.md` — evidence contracts, trust boundary, verdict rules, and known limits.
- `docs/base-collector-v0.1.md` — source registry, HTTPS/DNS boundary, finalized snapshot rules, and live conformance receipt.
- `docs/effect-authority-v0.1.md` — Ed25519 registry/policy boundary, signed outcomes, key lifecycle, and operator-adapter limits.
- `docs/journal-bound-bundles-v0.2.md` — artifact DAG, two journal anchors, exact replay, crash recovery, local-integrity verification, and remaining anti-rollback/authority boundaries.
- `src/__tests__/` — deterministic containment, challenge, browser, proxy, and reconciliation fixtures.

## Deployment

Production is configured at [canary.0x402.sh](https://canary.0x402.sh). This repository historically auto-deploys from `main`; verify the actual project settings before merging. A source merge alone does not prove the Bankr listing has been removed or that live legacy routes are non-charging.
