# Build Session Close: 2

## Outcome

passed

## Original question

Can independently configured HTTPS Base RPC sources produce registry-bound finalized native-USDC evidence for the kernel without exposing credentials or enabling writes?

## Original success condition

Two distinct trust domains agreeing on Base chain ID, a shared finalized block, allowed native-USDC code identity, receipt facts, and authorizationState produce deterministic registry-bound observations; malformed/config-drifted/redirecting/HTTP/wrong-chain/forked/token-mismatched/timeout/oversized responses fail closed; all prior tests and containment gates pass.

## Shipped

- Strict hashed Base source registry, immutable secret-resolved endpoints, and DNS/TLS-hardened read-only JSON-RPC transport.
- Unanimous shared-finalized collector with Base genesis checkpoint, EIP-1898 state binding, receipt normalization, and upgrade-aware native-USDC proxy/implementation allowlist.
- Operator CLI, deterministic adversarial suite, source documentation, and a sanitized live two-provider conformance receipt.

## Verified

- 203/203 tests, typecheck, clean build, diff check, live receipt parity, and public no-spend containment pass.
- Official Base RPC and PublicNode agreed at finalized block 49509847 on genesis, canonical hash, native-USDC code identity/metadata, and the sanitized authorizationState read.
- Independent threat modeling and adversarial review drove genesis pinning, EIP-1898 binding, DNS controls, immutable registry snapshots, and the resolved-source mutation fix.

## Broke

- Independent review found mutable resolved source metadata could redirect a branded source if endpoint and expectedOrigin were changed together; objects are now frozen and transport revalidates a copied URL against immutable origin, with regression coverage. (src/__tests__/base-rpc.test.ts)

## Still unproven

- The two development endpoints are operator-declared failure domains, not provider-signed proofs or a production SLA; production should use contracted diverse providers or a self-validating node.
- The v0.1 kernel does not yet verify the collection digest, and the source registry has no external signature, anti-rollback publication, or revocation service.

## Receipts

- Live read-only conformance passed against the official Base RPC and PublicNode at one unanimous finalized anchor, including genesis, USDC proxy/implementation, metadata, and EIP-1898 authorizationState. (examples/base-collection-v0.1.live.json)
- Frozen Session 2 gates passed: 203 tests, TypeScript typecheck, clean build, diff check, and live receipt byte parity. (npm test && npm run typecheck && npm run build && git diff --check)
- Deterministic adversarial collector tests cover registry drift, endpoint mutation, private/reserved DNS, JSON-RPC envelopes, wrong chain/genesis/fork/code/state, finalized receipt disagreement, pending finality, and read-only method containment. (src/__tests__/base-rpc.test.ts)

## Decisions

- Collector requires unanimity across sorted registry sources with distinct declared trust domains; no majority vote can suppress a contradiction. (src/evidence/base-rpc.ts)
- Authoritative state and code reads are bound to one shared Base finalized block hash using EIP-1898 requireCanonical, with chain ID plus genesis checkpoint verification. (docs/base-collector-v0.1.md)
- Unknown native-USDC proxy or implementation bytecode opens the circuit until the allowlist and Circle event-order assumptions are reviewed. (examples/base-source-registry-v0.1.json)

## Tests

None recorded.

## Git summary

- Start: c69e3c0c28ce6cebccc24d3daec9e01791ad2bf3
- End: c69e3c0c28ce6cebccc24d3daec9e01791ad2bf3
- Branch: feat/base-evidence-kernel

### Commits
None recorded.

### Diff stat

```text
CLAUDE.md                    |  9 ++++++---
 README.md                    | 20 +++++++++++++++++---
 docs/evidence-kernel-v0.1.md |  2 +-
 package.json                 |  1 +
 src/evidence/index.ts        |  1 +
 5 files changed, 26 insertions(+), 7 deletions(-)
```

## Next session

- Build the signed operator effect-authority contract/registry and authority-bound evaluator.
- Create the v0.2 wrapper that verifies Base collection and effect attestations before upgrading assurance.
- Bind v0.2 inputs and bundles to durable journal heads, then add the no-action shadow runner.

## Public recap inputs

- Outcome: passed
- Shipped: Strict hashed Base source registry, immutable secret-resolved endpoints, and DNS/TLS-hardened read-only JSON-RPC transport.; Unanimous shared-finalized collector with Base genesis checkpoint, EIP-1898 state binding, receipt normalization, and upgrade-aware native-USDC proxy/implementation allowlist.; Operator CLI, deterministic adversarial suite, source documentation, and a sanitized live two-provider conformance receipt.
- Verified: 203/203 tests, typecheck, clean build, diff check, live receipt parity, and public no-spend containment pass.; Official Base RPC and PublicNode agreed at finalized block 49509847 on genesis, canonical hash, native-USDC code identity/metadata, and the sanitized authorizationState read.; Independent threat modeling and adversarial review drove genesis pinning, EIP-1898 binding, DNS controls, immutable registry snapshots, and the resolved-source mutation fix.
- Broke: Independent review found mutable resolved source metadata could redirect a branded source if endpoint and expectedOrigin were changed together; objects are now frozen and transport revalidates a copied URL against immutable origin, with regression coverage. (src/__tests__/base-rpc.test.ts)
- Still unproven: The two development endpoints are operator-declared failure domains, not provider-signed proofs or a production SLA; production should use contracted diverse providers or a self-validating node.; The v0.1 kernel does not yet verify the collection digest, and the source registry has no external signature, anti-rollback publication, or revocation service.
- Receipts: Live read-only conformance passed against the official Base RPC and PublicNode at one unanimous finalized anchor, including genesis, USDC proxy/implementation, metadata, and EIP-1898 authorizationState. (examples/base-collection-v0.1.live.json); Frozen Session 2 gates passed: 203 tests, TypeScript typecheck, clean build, diff check, and live receipt byte parity. (npm test && npm run typecheck && npm run build && git diff --check); Deterministic adversarial collector tests cover registry drift, endpoint mutation, private/reserved DNS, JSON-RPC envelopes, wrong chain/genesis/fork/code/state, finalized receipt disagreement, pending finality, and read-only method containment. (src/__tests__/base-rpc.test.ts)

Draft public copy from these facts only. Do not invent proof. Require explicit approval before posting.
