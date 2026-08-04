# Build Session Close: 4

## Outcome

passed

## Original question

Can effect authority be derived exclusively from a trusted out-of-band policy and a valid Ed25519 authority signature, never from caller-supplied booleans?

## Original success condition

Only a valid non-revoked authorized signature over exact operation, policy, query, outcome, timestamps, and payload can produce authoritative effect evidence; zero requires a complete linearizable closure after the policy horizon; all malformed, stale, replayed, contradictory, unknown, or caller-elevated inputs fail closed.

## Shipped

- Strict Ed25519 effect-authority registry, policy/query resolver, signed outcome verifier, branded observation conversion, file-only CLI, and synthetic conformance fixture

## Verified

- 220 full tests plus targeted lifecycle/replay/closure/schema cases, typecheck, build, diff check, fixture CLI parity, and independent correctness review passed

## Broke

None recorded.

## Still unproven

- No real operator system-of-record adapter is connected; operationStartedAt and verifiedAt must be bound to controlled journal records; signature proves the configured authority signed a claim, not that the declared database constraint or closure marker is truthful

## Receipts

- Adversarial signed-effect authority matrix passes: valid one/zero/multiple/unknown outcomes, signature and encoding mutations, cross-context replay, key lifecycle/revocation, closure horizon, structural cloning, exact schemas, and no-action imports (src/__tests__/effect-authority.test.ts; 220 full tests passed)
- Independent correctness review PASS: signature binding, process-local brands, chronology/freshness, outcome conversion, and malformed-input handling are coherent and fail closed (effect_quick_qa; 220 tests passed)

## Decisions

None recorded.

## Tests

- npm test: passed
- npm run typecheck: passed
- npm run build: passed
- git diff --check: passed

## Git summary

- Start: a2960d516a8b3e2b28d85e7f84dcfc521d4965be
- End: a2960d516a8b3e2b28d85e7f84dcfc521d4965be
- Branch: feat/base-evidence-kernel

### Commits
None recorded.

### Diff stat

```text
CLAUDE.md                    |  6 +++++-
 README.md                    | 22 +++++++++++++++++++---
 docs/evidence-kernel-v0.1.md |  4 ++--
 package.json                 |  1 +
 src/evidence/index.ts        |  1 +
 5 files changed, 28 insertions(+), 6 deletions(-)
```

## Next session

- Bind controlled journal inputs, authenticated Base collection, signed effect evidence, and deterministic v0.2 bundle/closure receipts

## Public recap inputs

- Outcome: passed
- Shipped: Strict Ed25519 effect-authority registry, policy/query resolver, signed outcome verifier, branded observation conversion, file-only CLI, and synthetic conformance fixture
- Verified: 220 full tests plus targeted lifecycle/replay/closure/schema cases, typecheck, build, diff check, fixture CLI parity, and independent correctness review passed
- Broke: Nothing recorded
- Still unproven: No real operator system-of-record adapter is connected; operationStartedAt and verifiedAt must be bound to controlled journal records; signature proves the configured authority signed a claim, not that the declared database constraint or closure marker is truthful
- Receipts: Adversarial signed-effect authority matrix passes: valid one/zero/multiple/unknown outcomes, signature and encoding mutations, cross-context replay, key lifecycle/revocation, closure horizon, structural cloning, exact schemas, and no-action imports (src/__tests__/effect-authority.test.ts; 220 full tests passed); Independent correctness review PASS: signature binding, process-local brands, chronology/freshness, outcome conversion, and malformed-input handling are coherent and fail closed (effect_quick_qa; 220 tests passed)

Draft public copy from these facts only. Do not invent proof. Require explicit approval before posting.
