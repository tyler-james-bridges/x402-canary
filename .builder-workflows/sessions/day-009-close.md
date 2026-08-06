# Build Session Close: 9

## Outcome

passed

## Original question

Can the production Base verifier deterministically prove whether one finalized native-USDC EIP-3009 settlement satisfies one strict x402 v2 exact PaymentRequirements intent, and expose the same honest verdict to humans and agents without adding any execution authority?

## Original success condition

A user and an agent can submit one canonical Base transaction hash plus one supported strict x402 v2 exact requirement and receive the same deterministic, hashed case report; the known production transaction yields matched for its exact observed fields, controlled field mutations yield explicit mismatch reasons, nonfinal/absent/duplicate/contradictory observations never yield matched, all existing containment guarantees remain true, the full suite passes, and the canonical production UI/API are verified live.

## Shipped

- Intent-aware x402 settlement verifier on https://canary.0x402.sh
- POST /api/x402-intent strict v0.2 public report API
- Production WAF rule covering /api/base-transaction and /api/x402-intent

## Verified

- 333/333 tests, typecheck, build, JS syntax, diff check, npm audit 0 vulnerabilities
- Independent security review PASS and independent UI/accessibility release review PASS
- Production deployment dpl_CUxM3KeVJmMsbicKbvKRPenf2FZC serves commit cd1cf9709b39983a1d250d1fd05513da9aebb3c9
- Production API exact case matched and controlled amount mutation returned AMOUNT_MISMATCH
- Production desktop/mobile browser verification passed with zero axe violations, no console/page errors, no overflow
- Production WAF returned 429 for verifier path while /api/health stayed 200

## Broke

None recorded.

## Still unproven

- The public report does not prove x402 wire exchange, requirement authenticity, resource binding, expected payer/nonce, authorization window/signature, timeout compliance, HTTP delivery, business effect, duplicate purchase, retry safety, or external consensus truth
- Vercel WAF 429 response did not include Retry-After; rate limiting still enforced with x-vercel-mitigated: deny
- Vercel runtime logs one Node url.parse deprecation warning at error level on successful POST; no 5xx/fatal observed

## Receipts

- Final deterministic and build gates (333/333 tests; typecheck; build; JS syntax; diff check; npm audit 0 vulnerabilities)
- Independent security and release QA (security PASS; UI/accessibility PASS; desktop/mobile zero blockers)
- Local intent verifier evidence (known transaction matched; amount mutation AMOUNT_MISMATCH; desktop/mobile zero axe violations and no overflow)
- Exact-commit Vercel preview (dpl_AJ74NTteFDJHNA4WCSdSt4SJwmQY · git cd1cf9709b39983a1d250d1fd05513da9aebb3c9 · match and mismatch verified)
- Production WAF published (firewall config version 2; rule_base_verifier_per_ip_limit_X1rnpX; path inc [/api/base-transaction,/api/x402-intent]; 10 requests/60s/IP; draft empty)
- Canonical production deployment (https://canary.0x402.sh · dpl_CUxM3KeVJmMsbicKbvKRPenf2FZC · git cd1cf9709b39983a1d250d1fd05513da9aebb3c9)
- Production API intent verification (known transaction -> settlement_terms_matched; amount 19484 mutation -> settlement_terms_mismatch / AMOUNT_MISMATCH; 2/2 source agreement)
- Production browser verification (desktop idle/matched/mismatch and 390px mobile idle/matched; zero axe violations; no console/page errors; no overflow; screenshots in .builder-workflows/session-009-production-*.png)
- Production WAF enforcement (verifier path returned 429 Too Many Requests with x-vercel-mitigated: deny; /api/health remained 200; Vercel WAF did not include Retry-After header)
- Production runtime evidence (15m logs: no 5xx and no fatal entries; 25 serverless requests observed (200/405 only); one Node url.parse deprecation warning logged at error level on a successful POST)

## Decisions

- Keep the verifier read-only and contract-free: caller intent is parsed as declarative evidence, never executed or fetched; only the transaction hash reaches the existing fixed-source Base collector.
- Production promotion waits for the staged WAF owner publish required by the Vercel Firewall workflow. (rule_base_verifier_per_ip_limit_X1rnpX staged for both verifier paths at 10 requests/60s/IP)

## Tests

None recorded.

## Git summary

- Start: 7ab41f9eef8bee662a27caf2a0cbd60ecd29cbf5
- End: cd1cf9709b39983a1d250d1fd05513da9aebb3c9
- Branch: codex/x402-intent-verifier-v02

### Commits
- cd1cf97 feat: add intent-aware x402 verifier

### Diff stat

```text
CLAUDE.md                                    |   24 +-
 README.md                                    |   37 +-
 api/x402-intent.ts                           |  211 ++++++
 docs/public-x402-intent-v0.2.md              |  269 +++++++
 package.json                                 |    2 +-
 public/app.js                                | 1016 +++++++++++++++++---------
 public/index.html                            |  369 +++++-----
 public/llms.txt                              |  128 +++-
 public/styles.css                            |  317 +++++++-
 src/__tests__/production-surface.test.ts     |   43 +-
 src/__tests__/public-containment.test.ts     |   87 ++-
 src/__tests__/public-evidence-status.test.ts |   75 +-
 src/__tests__/public-x402-intent.test.ts     |  430 +++++++++++
 src/__tests__/x402-intent.test.ts            |  347 +++++++++
 src/dashboard.ts                             |  129 ++++
 src/evidence/x402-intent.ts                  |  510 +++++++++++++
 src/index.ts                                 |    2 +-
 src/public-base-transaction.ts               |   16 +-
 src/public-evidence-status.ts                |  255 ++++---
 src/public-health.ts                         |   11 +-
 src/public-x402-intent.ts                    |  317 ++++++++
 vercel.json                                  |    3 +
 22 files changed, 3848 insertions(+), 750 deletions(-)
```

## Next session

- Merge PR #5 and keep canary production on commit cd1cf97 until the receipt-only commit is intentionally deployed or skipped
- Decide separately whether to address the platform url.parse deprecation warning or leave it as a Vercel/runtime warning

## Public recap inputs

- Outcome: passed
- Shipped: Intent-aware x402 settlement verifier on https://canary.0x402.sh; POST /api/x402-intent strict v0.2 public report API; Production WAF rule covering /api/base-transaction and /api/x402-intent
- Verified: 333/333 tests, typecheck, build, JS syntax, diff check, npm audit 0 vulnerabilities; Independent security review PASS and independent UI/accessibility release review PASS; Production deployment dpl_CUxM3KeVJmMsbicKbvKRPenf2FZC serves commit cd1cf9709b39983a1d250d1fd05513da9aebb3c9; Production API exact case matched and controlled amount mutation returned AMOUNT_MISMATCH; Production desktop/mobile browser verification passed with zero axe violations, no console/page errors, no overflow; Production WAF returned 429 for verifier path while /api/health stayed 200
- Broke: Nothing recorded
- Still unproven: The public report does not prove x402 wire exchange, requirement authenticity, resource binding, expected payer/nonce, authorization window/signature, timeout compliance, HTTP delivery, business effect, duplicate purchase, retry safety, or external consensus truth; Vercel WAF 429 response did not include Retry-After; rate limiting still enforced with x-vercel-mitigated: deny; Vercel runtime logs one Node url.parse deprecation warning at error level on successful POST; no 5xx/fatal observed
- Receipts: Final deterministic and build gates (333/333 tests; typecheck; build; JS syntax; diff check; npm audit 0 vulnerabilities); Independent security and release QA (security PASS; UI/accessibility PASS; desktop/mobile zero blockers); Local intent verifier evidence (known transaction matched; amount mutation AMOUNT_MISMATCH; desktop/mobile zero axe violations and no overflow); Exact-commit Vercel preview (dpl_AJ74NTteFDJHNA4WCSdSt4SJwmQY · git cd1cf9709b39983a1d250d1fd05513da9aebb3c9 · match and mismatch verified); Production WAF published (firewall config version 2; rule_base_verifier_per_ip_limit_X1rnpX; path inc [/api/base-transaction,/api/x402-intent]; 10 requests/60s/IP; draft empty); Canonical production deployment (https://canary.0x402.sh · dpl_CUxM3KeVJmMsbicKbvKRPenf2FZC · git cd1cf9709b39983a1d250d1fd05513da9aebb3c9); Production API intent verification (known transaction -> settlement_terms_matched; amount 19484 mutation -> settlement_terms_mismatch / AMOUNT_MISMATCH; 2/2 source agreement); Production browser verification (desktop idle/matched/mismatch and 390px mobile idle/matched; zero axe violations; no console/page errors; no overflow; screenshots in .builder-workflows/session-009-production-*.png); Production WAF enforcement (verifier path returned 429 Too Many Requests with x-vercel-mitigated: deny; /api/health remained 200; Vercel WAF did not include Retry-After header); Production runtime evidence (15m logs: no 5xx and no fatal entries; 25 serverless requests observed (200/405 only); one Node url.parse deprecation warning logged at error level on a successful POST)

Draft public copy from these facts only. Do not invent proof. Require explicit approval before posting.
