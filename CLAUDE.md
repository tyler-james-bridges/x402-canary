# x402 Canary Maintainer Notes

## Current safety state

This repository is in source-containment and no-spend mode.

- `npm start` serves a static local dashboard on `127.0.0.1` only.
- The local server and public API handlers do not fetch caller-selected URLs or fan out to third-party endpoints.
- Public probe, trust, and paid-service routes return containment errors.
- `src/endpoints.ts` intentionally contains no targets.
- Do not restore a scheduler, target list, or arbitrary-URL proxy without an approved bounded policy, operator-owned fixtures, and explicit authorization.

Source containment does not prove that any previously deployed Vercel or Bankr configuration has been unpublished. Deployment changes require a separate, explicit release action and verification.

## Payment constraints

The deterministic challenge gate accepts only:

- Base mainnet (`eip155:8453`)
- the native Base USDC contract
- the x402 `exact` scheme
- EIP-3009 domain values `USD Coin` / `2`
- a nonzero contracted recipient
- a resource URL matching the contracted request URL
- amounts within equal atomic and USD caps

The paid CLI path and executable AgentCash adapter are disabled. Provider metadata is only a provider claim and must never be presented as independent settlement confirmation. Never retry after an unknown result merely because time elapsed; reconcile settlement and effect evidence first.

## Verification

Run all of these before proposing a release:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

`npm run build` cleans and recreates generated `dist/` output so stale executable artifacts cannot survive a source-layout change.

## Important files

- `src/index.ts` and `src/dashboard.ts`: contained loopback-only startup path
- `src/canary.ts`: disabled legacy probe entry point
- `src/endpoints.ts`: intentionally empty target registry
- `src/contracts.ts` and `src/load-contract.ts`: exact-only Base contract schema and validation
- `src/x402-challenge.ts`: deterministic no-spend challenge predicates
- `src/reconciliation-policy.ts`: conservative fact-to-verdict retry policy
- `src/evidence/`: canonical IDs, durable journal, Base/effect evaluators, and deterministic bundle kernel
- `src/evidence-cli.ts`: file-only evidence recomputation; no RPC, wallet, signer, URL fetch, or payment path
- `examples/evidence-kernel-v0.1.*.json`: sanitized input and exact expected bundle
- `src/verify.ts`: CLI with the paid-execution kill switch
- `src/__tests__/public-containment.test.ts`: executable containment assertions
- `README.md`: user-facing status and remaining gates

## Remaining gates before paid execution

The local v0.1 kernel now implements canonical request/authorization IDs, an append-only hash-linked journal, strict injected Base native-USDC receipt/authorization-state evaluation, effect reconciliation, deterministic bundles, and concurrency/restart fixtures. This does not make the paid path production-ready.

Do not enable paid execution until, at minimum:

1. Independently configured Base RPC adapters collect and cross-check the receipt, canonical-head, finality, and `authorizationState` observations consumed by the pure evaluator.
2. An operator-owned system-of-record adapter defines and produces authoritative effect evidence.
3. The verified journal head is bound into persisted terminal bundles, with a documented cross-process single-writer model.
4. Settlement submitter/router classification and independent delivery evidence are implemented where applicable.
5. Base fork/RPC conformance and native-USDC upgrade/event-order coverage pass.
6. The integrated adapters receive an external security review.

Never promote a caller-supplied source label or `authoritative: true` flag into trusted evidence without the corresponding configured adapter.
