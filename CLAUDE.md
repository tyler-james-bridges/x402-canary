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
- `src/verify.ts`: CLI with the paid-execution kill switch
- `src/__tests__/public-containment.test.ts`: executable containment assertions
- `README.md`: user-facing status and remaining gates

## Remaining gates before paid execution

Do not enable paid execution until the implementation includes and tests, at minimum:

1. A durable attempt journal and canonical authorization identity.
2. Independent Base transaction-receipt and native-USDC `Transfer` verification.
3. Authoritative settlement-absence and effect-absence reconciliation.
4. Method, URL, headers, and body semantics bound into the authorization policy.
5. Concurrency and crash-recovery tests proving at most one settlement and one effect.

The reconciliation fixtures currently exercise policy logic only; they are not proof that these evidence-producing components exist.
