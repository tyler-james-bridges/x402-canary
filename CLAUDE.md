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
- `src/evidence/base-rpc.ts`: strict registry-bound, read-only Base collector with HTTPS/DNS, finality, checkpoint, and native-USDC identity checks
- `src/base-evidence-collect-cli.ts`: explicit operator-only Base collection CLI; never import it into a public handler
- `src/evidence/effect-authority.ts`: strict local Ed25519 authority/policy verification; only branded verified results may create authoritative effect observations
- `src/evidence/artifact-store.ts` and `src/evidence/journal-bundle.ts`: immutable v0.2 evidence artifacts, journal-head CAS closure, shadow-only bundles, offline integrity replay, and receipt recovery
- `src/evidence/shadow-runner.ts`: strict, branded composition of an existing journaled attempt, registry-pinned Base collection, signed effects, v0.2 closure, exact replay, and sanitized no-action results
- `src/shadow-run-cli.ts`: private operator entry point; production mode resolves only pinned HTTPS Base RPC sources and never fetches the operation URL
- `src/effect-attestation-verify-cli.ts`: file-only signed-effect verifier with an out-of-band registry hash pin; never import it into a public handler
- `examples/evidence-kernel-v0.1.*.json`: sanitized input and exact expected bundle
- `examples/base-*.json`: secret-free Base registry/request and historical live conformance receipt
- `src/verify.ts`: CLI with the paid-execution kill switch
- `src/__tests__/public-containment.test.ts`: executable containment assertions
- `README.md`: user-facing status and remaining gates

## Remaining gates before paid execution

The local v0.1 kernel now implements canonical request/authorization IDs, an append-only hash-linked journal, strict injected Base native-USDC receipt/authorization-state evaluation, effect reconciliation, deterministic bundles, and concurrency/restart fixtures. This does not make the paid path production-ready.

Do not enable paid execution until, at minimum:

1. Production Base sources must be distinct reviewed failure domains rather than a development public-RPC pair, and their fork/upgrade behavior must pass live conformance.
2. An operator-owned read-only system-of-record adapter emits the implemented signed-effect format, and its real uniqueness/linearizable-closure claims pass integration review.
3. The v0.2 cooperating-process sentinel is replaced or wrapped by an OS advisory/transactional lock, and journal receipts are externally checkpointed against complete rollback.
4. Caller-declared attempt predicates gain configured authority evidence; offline signature re-verification receives separately pinned registries where required.
5. Settlement submitter/router classification and independent delivery evidence are implemented where applicable.
6. The integrated adapters receive an external security review.

Never promote a caller-supplied source label or `authoritative: true` flag into trusted evidence without the corresponding configured adapter.

Evidence Kernel v0.1 intentionally remains a legacy prevalidated-input schema with `externalAuthorityProven: false`. Do not widen it. Journal-bound v0.2 accepts runtime-branded Base/effect results, derives the legacy input, and binds it to controlled journal timestamps, but it remains shadow-only and grants no execution authority.

Shadow Runner v0.1 is the only composed operator path. It requires a separately pinned manifest and an existing journal, creates all runtime authority brands in process, and emits a sanitized result with `actionDirective: "none"`. Do not add operation execution, authorization creation/signing/transmission, retry, arbitrary RPC URLs, wallet access, payment, public routes, scheduling, or deployment behavior to this path.
