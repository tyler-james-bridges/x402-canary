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
- a private-mode, append-only, hash-linked JSONL journal with restart/tamper/torn-write validation and serialized in-process appends;
- a pure Base evaluator over injected observations that pins chain ID and native USDC, verifies canonical receipt/finality facts, and requires an adjacent `AuthorizationUsed(authorizer, nonce)` plus exact `Transfer(from, to, value)` pair;
- finalized, independently agreeing `authorizationState` snapshots for authoritative settlement absence;
- authoritative business-effect reconciliation with duplicate and contradiction detection;
- deterministic input and bundle hashes, conservative terminal states, separate same-authorization/new-authorization retry verdicts, and the one-settlement/one-effect invariant.

The evaluators do not collect evidence themselves. An RPC adapter must establish the Base observations, and an operator-owned system-of-record adapter must establish effect authority. A caller-supplied source label or `authoritative: true` flag is not independently trustworthy by itself.

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

- independently configured Base RPC collectors produce and cross-check the injected receipt, canonical-head, and `authorizationState` facts;
- an operator-owned system-of-record adapter produces effect observations and establishes what `authoritative` means for each effect type;
- journal records and their verified head are bound to persisted terminal bundles, with a documented single-writer or cross-process locking model;
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
- `src/evidence/`, `src/evidence-cli.ts`, `examples/` — Evidence Kernel v0.1 primitives, CLI, and sanitized recomputation pair.
- `docs/evidence-kernel-v0.1.md` — evidence contracts, trust boundary, verdict rules, and known limits.
- `src/__tests__/` — deterministic containment, challenge, browser, proxy, and reconciliation fixtures.

## Deployment

Production is configured at [canary.0x402.sh](https://canary.0x402.sh). This repository historically auto-deploys from `main`; verify the actual project settings before merging. A source merge alone does not prove the Bankr listing has been removed or that live legacy routes are non-charging.
