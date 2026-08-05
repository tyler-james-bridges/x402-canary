# Build Session Close: 8

## Outcome

passed

## Original question

Can the static evidence console become a useful live Base transaction verifier that cross-checks fixed server-side Base sources and renders a deterministic, honest receipt/finality verdict from only a transaction hash, without exposing arbitrary URLs or any wallet, signing, payment, retry, or action path?

## Original success condition

A user can enter a canonical Base transaction hash on the live canonical site and receive a bounded verified/pending/not-found/not-native-USDC/contradiction/unavailable result with source agreement, finality, block, parties, and human USDC amount when provable; the page shows current Base source health; malformed or extra input fails closed; browser/API tests pass; preview and canonical production are exact-commit verified.

## Shipped

- Live read-only Base USDC transaction verifier at https://canary.0x402.sh/
- Canonical Vercel WAF rate limit and V2 Git isolation

## Verified

- 321/321 tests, TypeScript build, JS syntax, and diff checks pass
- Production known transaction confirms 0.019483 USDC with 2/2 sources
- Production desktop/mobile, light/dark, loading/result, headers, cache, containment, and zero-violation accessibility checks pass

## Broke

None recorded.

## Still unproven

- Configured HTTPS source agreement is not cryptographic Base consensus and public gateways are best-effort
- Expected x402 intent, HTTP delivery, business effect, and retry safety remain outside this transaction-only verifier

## Receipts

- Full deterministic suite and build pass (321/321 tests; npm run build; node --check public/app.js; git diff --check)
- Local live Base verifier confirmation (0x0246829b14840ccd32eeb31476ea04f54a7c8d034ca4336d9b08f18a90b26ea7 -> confirmed, 0.019483 USDC, 2/2 sources)
- Independent release QA pass (desktop/mobile; idle/loading/result; light/dark; zero axe violations; concurrency 200/200)
- Canonical production deployment (https://canary.0x402.sh/ · dpl_5myGBA1VL92zWSv1iDLWtzEB5kDv · git 99ca3511ae0080d67bacddd4caca57296dbfec2d)
- Production verifier confirmation (confirmed · 0.019483 USDC · 2/2 unanimous · CDN MISS then HIT with identical observation hash)
- Production UX and containment (desktop and 390px mobile contained; idle/result zero axe violations; health/evidence verified; invalid/cross-site/method requests fail closed)
- Vercel WAF guardrail (rule_base_verifier_per_ip_limit_X1rnpX · exact path · 10 requests/60s/IP · 11th request returned 429)
- V2 isolation (x402-canary-v2 Git link null; production deployment remains dpl_8JXAxMR7QbyqiuiPf6ZJmwbk2YBx)

## Decisions

- Canonical-only release boundary (Deploy x402-canary; disconnect x402-canary-v2 Git before any push; do not delete V2 history)
- Runtime warning classified non-blocking (Production has zero 5xx/fatal logs; one DEP0169 warning accompanies successful RPC; local Node 24 trace reproduction emits no warning)

## Tests

None recorded.

## Git summary

- Start: 46b494ae231724faa7c1cb843b534dbac5fe6bea
- End: 99ca3511ae0080d67bacddd4caca57296dbfec2d
- Branch: feat/base-evidence-kernel

### Commits
- 99ca351 feat: add live Base transaction verifier

### Diff stat

```text
CLAUDE.md                                     |  12 +-
 README.md                                     |  41 +-
 api/base-transaction.ts                       | 211 +++++++
 api/health.ts                                 |  12 +-
 docs/public-base-verifier-v0.1.md             |  63 +++
 package.json                                  |   2 +-
 public/app.js                                 | 700 ++++++++++++++++++++++-
 public/index.html                             | 209 +++++--
 public/llms.txt                               | 305 ++++++----
 public/og-live-verifier.png                   | Bin 0 -> 1150520 bytes
 public/styles.css                             | 638 ++++++++++++++++++---
 src/__tests__/base-rpc.test.ts                |  32 ++
 src/__tests__/base-transaction.test.ts        | 461 +++++++++++++++
 src/__tests__/production-surface.test.ts      |  45 +-
 src/__tests__/public-base-transaction.test.ts | 552 ++++++++++++++++++
 src/__tests__/public-containment.test.ts      |  55 +-
 src/__tests__/public-evidence-status.test.ts  |  27 +-
 src/dashboard.ts                              | 148 ++++-
 src/evidence/base-rpc.ts                      |  56 +-
 src/evidence/base-transaction.ts              | 776 ++++++++++++++++++++++++++
 src/index.ts                                  |   4 +-
 src/public-base-transaction-config.ts         |  99 ++++
 src/public-base-transaction.ts                | 262 +++++++++
 src/public-evidence-status.ts                 |  36 +-
 src/public-health.ts                          |  26 +
 vercel.json                                   |   5 +
 26 files changed, 4459 insertions(+), 318 deletions(-)
```

## Next session

- Observe real WAF/provider behavior, then scope a separate read-only intent-matching case layer if useful

## Public recap inputs

- Outcome: passed
- Shipped: Live read-only Base USDC transaction verifier at https://canary.0x402.sh/; Canonical Vercel WAF rate limit and V2 Git isolation
- Verified: 321/321 tests, TypeScript build, JS syntax, and diff checks pass; Production known transaction confirms 0.019483 USDC with 2/2 sources; Production desktop/mobile, light/dark, loading/result, headers, cache, containment, and zero-violation accessibility checks pass
- Broke: Nothing recorded
- Still unproven: Configured HTTPS source agreement is not cryptographic Base consensus and public gateways are best-effort; Expected x402 intent, HTTP delivery, business effect, and retry safety remain outside this transaction-only verifier
- Receipts: Full deterministic suite and build pass (321/321 tests; npm run build; node --check public/app.js; git diff --check); Local live Base verifier confirmation (0x0246829b14840ccd32eeb31476ea04f54a7c8d034ca4336d9b08f18a90b26ea7 -> confirmed, 0.019483 USDC, 2/2 sources); Independent release QA pass (desktop/mobile; idle/loading/result; light/dark; zero axe violations; concurrency 200/200); Canonical production deployment (https://canary.0x402.sh/ · dpl_5myGBA1VL92zWSv1iDLWtzEB5kDv · git 99ca3511ae0080d67bacddd4caca57296dbfec2d); Production verifier confirmation (confirmed · 0.019483 USDC · 2/2 unanimous · CDN MISS then HIT with identical observation hash); Production UX and containment (desktop and 390px mobile contained; idle/result zero axe violations; health/evidence verified; invalid/cross-site/method requests fail closed); Vercel WAF guardrail (rule_base_verifier_per_ip_limit_X1rnpX · exact path · 10 requests/60s/IP · 11th request returned 429); V2 isolation (x402-canary-v2 Git link null; production deployment remains dpl_8JXAxMR7QbyqiuiPf6ZJmwbk2YBx)

Draft public copy from these facts only. Do not invent proof. Require explicit approval before posting.
