# x402 Canary Maintainer Notes

## Current safety state

This repository is in live read-only verification and no-spend mode.

- `npm start` serves the local dashboard on `127.0.0.1` only.
- `/api/x402-intent` accepts one strict x402 v2 `PaymentRequirements` object and one Base transaction hash, then returns a read-only settlement-term report over the same fixed observer. The requirement is caller-declared evidence, not execution authority.
- `/api/base-transaction` accepts one Base transaction hash and reads exactly two code-pinned, server-owned Base RPC origins. The hash is the only caller-selected lookup value.
- The local server and public API handlers do not fetch caller-selected URLs, accept RPC origins or methods, or fan out beyond the fixed verifier registry. The transaction hash is necessarily used for fixed-source RPC lookup; `PaymentRequirements` is evaluated locally and is not forwarded to RPC providers.
- Public probe, trust, and paid-service routes return containment errors.
- `src/endpoints.ts` intentionally contains no targets.
- Do not restore a scheduler, target list, or arbitrary-URL proxy without an approved bounded policy, operator-owned fixtures, and explicit authorization.

Source containment does not prove that any previously deployed Vercel or Bankr configuration has been unpublished. Deployment changes require a separate, explicit release action and verification.

## Payment constraints

The public requirement verifier accepts only:

- x402 version `2`
- the `exact` scheme
- Base mainnet (`eip155:8453`)
- native Base USDC
- the EIP-3009 `USD Coin` / `2` token domain
- a positive canonical atomic amount
- a nonzero `payTo`
- a positive declared `maxTimeoutSeconds` no greater than 86,400

It fails closed before constructing an RPC runtime for every other shape. `settlement_terms_matched` is limited to the supported settlement slice: one untruncated finalized EIP-3009 event pair whose recipient and atomic amount match the normalized caller declaration. Timeout remains `declared_only`. Never describe this verdict as proof of requirement authenticity, resource binding, an expected payer or nonce, authorization-window or signature validity, timeout compliance, HTTP delivery, business effect, duplicate purchase, or retry safety.

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
- `src/evidence/x402-intent.ts`, `src/public-x402-intent.ts`, and `api/x402-intent.ts`: strict supported-requirement normalization, pure comparison, sanitized v0.2 report, and POST-only public boundary
- `src/public-base-transaction*.ts` and `api/base-transaction.ts`: lower-level public fixed-source Base RPC path; strict transaction-hash-only input, shared deadline, sanitized DTO, and no execution authority
- `src/public-evidence-status.ts` and `api/evidence-status.ts`: immutable, sanitized release status; never import journals, artifacts, collectors, action modules, or environment data beyond the two allowlisted Vercel fields
- `public/index.html`, `public/styles.css`, and `public/app.js`: read-only production verifier; same-origin API requests, bounded transaction-hash and `PaymentRequirements` inputs, no caller-selected network target, payment prompt, wallet, or unsafe HTML sink
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
- `docs/public-x402-intent-v0.2.md`: exact public request/response, verdict, privacy, containment, and limitation contract
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

The public verifier is not an operator-result viewer. Private journals, artifacts, operation data, effect identifiers, retry verdicts, registry material, signatures, raw receipts, and provider errors stay off the public network. The intent route accepts only a canonical Base transaction hash and the strictly supported caller-declared `PaymentRequirements`; it accepts no resource URL, RPC target, provider, origin, method, block tag, finality choice, payment header, or signature. Only the transaction hash reaches the fixed-source lookup. Network, asset, providers, origins, methods, finality, and policy remain server-owned. Keep every execution-capability flag false and keep the legacy trust/preflight functions at HTTP 410.

Treat Vercel and Bankr as independent deployment surfaces. Verification of `canary.0x402.sh` does not establish the state of a separately hosted Bankr listing, and the local empty Bankr manifest must not be used as proof of remote removal.

Evidence Kernel v0.1 intentionally remains a legacy prevalidated-input schema with `externalAuthorityProven: false`. Do not widen it. Journal-bound v0.2 accepts runtime-branded Base/effect results, derives the legacy input, and binds it to controlled journal timestamps, but it remains shadow-only and grants no execution authority.

Shadow Runner v0.1 is the only composed operator path. It requires a separately pinned manifest and an existing journal, creates all runtime authority brands in process, and emits a sanitized result with `actionDirective: "none"`. Do not add operation execution, authorization creation/signing/transmission, retry, arbitrary RPC URLs, wallet access, payment, public routes, scheduling, or deployment behavior to this path.
