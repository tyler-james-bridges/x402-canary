# x402-canary

Read-only Base transaction evidence for native USDC, plus a private no-action x402 evidence kernel.

## Current safety state

This branch is in live read-only verification, source-containment, and no-spend mode:

- Public caller-selected outbound probes are disabled and return HTTP 410.
- `GET /api/base-transaction?transactionHash=0x…` accepts one canonical Base transaction hash and compares two code-pinned, server-owned Base RPC sources at a shared finalized anchor.
- The public verifier can report public receipt and native-USDC EIP-3009 event facts. It cannot prove intended x402 terms, HTTP delivery, business effect, or retry safety.
- `/api/health` reports the fixed verifier policy and makes no third-party requests itself.
- `npm start` serves the verifier on `127.0.0.1`; scheduled endpoint checks remain disabled.
- The source Bankr manifest advertises no paid services.
- The CLI rejects `--pay` before loading a contract, and the executable AgentCash adapter is a fail-closed stub with no subprocess or wallet path.
- The evidence CLI evaluates sanitized files only; it has no RPC, wallet, signer, URL-fetch, or payment option.
- The separate `base:collect` operator CLI performs registry-pinned, read-only Base RPC collection; it exposes no wallet, signer, transaction-submission, or payment method and is not imported by a public route.
- The separate `effect:verify` CLI performs local Ed25519 verification against an out-of-band registry hash; it exposes no network, database-write, retry, wallet, signer, transaction, or payment path.
- Journal-bound bundle v0.2 persists branded Base/effect inputs and deterministic shadow results behind two adjacent journal commits; every execution flag remains false.
- The `shadow:run` operator CLI composes those boundaries from a separately pinned manifest and an existing journaled attempt. It fetches only registry-pinned read-only Base RPC methods, never fetches the operation URL, and emits no retry or action directive beyond `none`.
- The production web console at [canary.0x402.sh](https://canary.0x402.sh) accepts only a transaction hash, calls only its same-origin verifier API, and exposes no wallet, signer, transaction submission, payment, retry, or action control. Private journals, artifacts, operation data, effect IDs, and retry verdicts remain private.
- Tests and CI make no production payment.

The Vercel console and its legacy routes are a separate surface from any historical Bankr listing. A healthy console or HTTP 410 from Vercel does not prove that Bankr has paused or removed a separately hosted service.

## What is implemented

The public Base verifier is a deliberately smaller claim than the private evidence kernel. For one transaction hash it:

- pins Base mainnet, its genesis checkpoint, native Base USDC, and exactly two server-owned HTTPS RPC origins;
- chooses the lower provider `finalized` height and requires both sources to agree on its number, hash, and timestamp;
- requires an identical canonical receipt from both sources and withholds finality when the receipt is above the shared anchor;
- classifies only adjacent native-USDC `AuthorizationUsed(address,bytes32) → Transfer(address,address,uint256)` pairs;
- returns bounded, sanitized facts with explicit limitations and an observation hash;
- never accepts an RPC URL, method, chain, asset, recipient, amount, block tag, or finality policy from the caller.

`confirmed` therefore means one qualifying finalized event pair was observed unanimously across the configured sources. It does not mean “x402 payment verified” and grants no execution or retry authority.

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

Shadow Runner v0.1 composes the collector, authority verifier, journal, artifact store, and v0.2 closure behind one private operator command. A strict manifest is content-addressed separately from trust pins; the runner binds the current journal head, attempt-open record, operation, authorization, Base registry, and every effect registry/contract/attestation before it performs a read. Fresh closure and exact replay both verify the persisted graph, while exact replay intentionally performs no new RPC request or time-sensitive signature check.

## Run locally

Install dependencies, then run the deterministic suite:

```bash
npm test
npm run typecheck
npm run build
```

Then start the loopback-only UI:

```bash
npm start
```

Open `http://127.0.0.1:3402` and submit a Base transaction hash. The lookup performs read-only requests against the fixed public registry; it does not use a wallet or submit a transaction. Public gateway availability is best-effort, so provider/configuration/deadline failures return a sanitized `503` rather than a chain verdict.

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

Hash a private shadow manifest, then close an already journaled attempt using separately prepared trust pins:

```bash
npm run --silent shadow:run -- hash private/shadow-manifest.json

npm run --silent shadow:run -- close \
  private/shadow-trust-pins.json \
  private/shadow-manifest.json \
  private/evidence-journal.jsonl \
  private/evidence-artifacts
```

`close` contacts only the HTTPS origins named by the pinned Base registry and resolved through its environment-variable names. It cannot create or transmit an authorization, sign, submit a transaction, execute the operation, retry, use a wallet, or pay. Do not place endpoint credentials, payment headers, authorization/payment signatures, private keys, or other secrets in the manifest. A public signature inside a required effect attestation is expected and is redacted from output. See `docs/shadow-runner-v0.1.md` for the schemas and operator sequence.

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

- `GET /api/base-transaction?transactionHash=0x…` — fixed-source Base receipt/finality and native-USDC event observation; the only public route allowed to perform registry-pinned outbound reads.
- `GET /api/evidence-status` — sanitized, read-only evidence-release and deployment metadata; zero outbound requests.
- `GET /api/health` — verifier policy and capability status; zero outbound requests for the health request itself.
- `GET /api/trust` — legacy route; HTTP 410; zero outbound requests.
- `POST /api/preflight` — legacy route; HTTP 410; zero outbound requests.
- `x402/trust` — disabled paid-handler source; HTTP 410; zero outbound requests.

The browser fetches `/api/health`, `/api/evidence-status`, and `/api/base-transaction` from its own origin. The evidence status distinguishes caller-selected public transaction hashes from caller-selected network targets: the former is enabled, while RPC origins, payment, wallet, signing, transaction submission, retry, action, and scheduled monitoring remain disabled. It is public chain observation, not a live view into private operator data and not permission to execute anything.

## Not yet production-ready

Evidence Kernel v0.1 is a deterministic local evaluator, not authorization to turn payment back on. Paid execution remains blocked until at least:

- provisioned production RPC sources or a self-validating node replace the best-effort public gateway pair, with live Base fork, provider-independence, quota, and native-USDC upgrade conformance;
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

- `api/`, `x402/`, `public/` — bounded public surface and read-only Base evidence console.
- `src/evidence/base-transaction.ts` and `src/public-base-transaction*.ts` — transaction-only finalized receipt/event observer and sanitized HTTP boundary.
- `src/public-evidence-status.ts` — immutable allowlisted public release DTO; no evidence-store or action imports.
- `src/index.ts`, `src/dashboard.ts`, `src/canary.ts` — contained loopback start path; no scheduler or generic outbound checker.
- `contracts/` — pinned acceptance contracts.
- `src/x402-challenge.ts` — exact-only challenge and no-spend predicate evaluation.
- `src/reconciliation-policy.ts` — pure terminal and retry-safety derivation.
- `src/evidence/`, `src/evidence-cli.ts`, `src/base-evidence-collect-cli.ts`, `src/effect-attestation-verify-cli.ts`, `examples/` — Evidence Kernel primitives, file-only evaluation, explicit read-only Base collection, and local signed-effect verification.
- `src/evidence/shadow-runner.ts`, `src/shadow-run-cli.ts` — strict private shadow orchestration and the production HTTPS-only operator entry point.
- `docs/evidence-kernel-v0.1.md` — evidence contracts, trust boundary, verdict rules, and known limits.
- `docs/base-collector-v0.1.md` — source registry, HTTPS/DNS boundary, finalized snapshot rules, and live conformance receipt.
- `docs/effect-authority-v0.1.md` — Ed25519 registry/policy boundary, signed outcomes, key lifecycle, and operator-adapter limits.
- `docs/journal-bound-bundles-v0.2.md` — artifact DAG, two journal anchors, exact replay, crash recovery, local-integrity verification, and remaining anti-rollback/authority boundaries.
- `docs/shadow-runner-v0.1.md` — manifest/pin separation, no-action orchestration, sanitized output, deterministic conformance matrix, and operator procedure.
- `src/__tests__/` — deterministic containment, challenge, browser, proxy, and reconciliation fixtures.

## Deployment

Production is configured at [canary.0x402.sh](https://canary.0x402.sh). Releases must verify the exact Git commit in `/api/evidence-status`, the security headers and static assets, both disabled legacy routes, and the absence of any undocumented public function. A source merge or successful Vercel deployment does not prove that a separate Bankr listing has been paused or removed.
