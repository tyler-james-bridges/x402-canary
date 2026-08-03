# x402-canary

Contract-defined acceptance verification for x402 paid paths, currently narrowed to Base mainnet, native USDC, x402 v2 `exact`, and EIP-3009-style requirements.

## Current safety state

This branch is in source-containment and deterministic-fixture mode:

- Public caller-selected outbound probes are disabled and return HTTP 410.
- `/api/health` returns local containment status and makes no third-party requests.
- `npm start` serves only the containment page on `127.0.0.1`; scheduled endpoint checks are disabled.
- The source Bankr manifest advertises no paid services.
- The CLI rejects `--pay` before loading a contract, and the executable AgentCash adapter is a fail-closed stub with no subprocess or wallet path.
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

These are policy/decision fixtures, not a substitute for an observation journal or real Base receipt verification.

## Run locally

Install dependencies, then run the deterministic suite:

```bash
npm test
npm run typecheck
npm run build
```

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

Paid execution remains blocked until at least the following are implemented and independently reviewed:

- append-only, hash-linked observation journaling with secret redaction;
- independent Base chain ID, receipt, finality, and canonical-block verification;
- exact native-USDC `Transfer` verification from payer to the advertised recipient for the selected atomic amount;
- settlement-submitter and recipient/router classification;
- operator-authoritative business-effect reconciliation;
- persisted terminal evidence with external recomputation;
- deterministic and Base fork/RPC conformance coverage for the restricted paid slice;
- deployed Vercel verification and separate Bankr service unpublish/disable verification.

Facilitator or client metadata may be retained as a provider claim, but it cannot independently satisfy Base settlement or delivery.

## Repository layout

- `api/`, `x402/`, `public/` — contained public surface.
- `src/index.ts`, `src/dashboard.ts`, `src/canary.ts` — contained loopback start path; no scheduler or generic outbound checker.
- `contracts/` — pinned acceptance contracts.
- `src/x402-challenge.ts` — exact-only challenge and no-spend predicate evaluation.
- `src/reconciliation-policy.ts` — pure terminal and retry-safety derivation.
- `src/__tests__/` — deterministic containment, challenge, browser, proxy, and reconciliation fixtures.

## Deployment

Production is configured at [canary.0x402.sh](https://canary.0x402.sh). This repository historically auto-deploys from `main`; verify the actual project settings before merging. A source merge alone does not prove the Bankr listing has been removed or that live legacy routes are non-charging.
