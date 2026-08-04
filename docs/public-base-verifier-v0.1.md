# Public Base transaction verifier v0.1

The public verifier turns one Base transaction hash into a bounded observation of finalized receipt and native-USDC event facts. It does not evaluate an expected x402 authorization, an HTTP response, a business effect, or retry safety.

## Request

```http
GET /api/base-transaction?transactionHash=0x<64 hex characters>
```

The raw query must contain exactly one `transactionHash` key and no body. Duplicate keys, arrays, whitespace, unknown fields, malformed hashes, cross-site browser requests, and unsupported methods fail before any RPC request. The hash is normalized to lowercase.

The caller cannot select the network, asset, source, origin, RPC method, block tag, finality policy, expected recipient, or expected amount.

## Fixed observation policy

- Network: Base mainnet, `eip155:8453` / chain ID `8453`
- Genesis: a code-pinned Base genesis hash
- Asset: native Base USDC at `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Sources: exactly two code-pinned HTTPS origins in separately declared trust domains
- Quorum: unanimous
- Finality: the lower provider `finalized` height, with both sources required to agree on the exact anchor block
- Transport: public DNS only, TLS 1.2+, Web PKI, no redirects or compression, fixed headers, strict JSON-RPC envelopes, read-method allowlist
- Budget: one shared eight-second deadline, short per-request timeouts, bounded responses, no retry or fallback

The initial public gateways are dRPC and Tenderly. They are independent configured observations, not cryptographic consensus and not a production SLA. A quota, timeout, configuration problem, or provider failure produces a sanitized `503`; it is never converted into a transaction verdict.

## Verdicts

- `confirmed`: exactly one qualifying finalized event pair was observed unanimously.
- `multiple`: more than one qualifying pair was observed; no expected intent is inferred.
- `pending_finality`: a receipt is observed above the shared finalized anchor.
- `not_observed`: both configured sources currently return no receipt. This is not authoritative absence.
- `not_eip3009_usdc`: a successful finalized receipt has no qualifying native-USDC pair.
- `reverted`: the finalized receipt reports failed execution.
- `contradiction`: configured observations fail a fixed source-agreement, network identity, code identity, canonicality, or structural evidence rule.

Transport/configuration errors are not part of this enum.

## Native-USDC pair rule

A qualifying pair is two adjacent logs in the same successful canonical receipt:

1. native-USDC `AuthorizationUsed(address,bytes32)` with exactly the indexed authorizer and nonce shape; then
2. native-USDC `Transfer(address,address,uint256)` at the next log index, from the same authorizer, to a nonzero recipient, with a nonzero uint256 amount.

Removed, malformed, duplicate-index, wrong-asset, non-adjacent, mint/burn, zero-value, or ambiguous pairs never become a `confirmed` result. At most 32 decoded pairs are returned, with an explicit truncation flag and the exact observed count.

## Public response boundary

The response may contain the canonical lookup hash, observation time, policy version, shared finalized anchor, normalized receipt block/status, unanimous-source counts, bounded decoded pair facts, reason codes, limitations, disabled execution capabilities, and a deterministic observation hash.

It never contains provider URLs, source names, credentials, DNS/IP data, upstream errors, raw receipts, calldata, unrelated logs, signatures, private evidence artifacts, stacks, or environment values.

The required limitation remains visible for every verdict:

> Transaction-only observation. Expected x402 intent, recipient, amount, business effect, and external consensus truth were not evaluated.

## Operational boundary

The browser uses a same-origin GET and does not persist the hash in local storage. Transaction hashes are public lookup keys and can appear in ordinary platform request logs. Finalized non-contradictory responses may be cached for five seconds; pending or unobserved results may be cached for one second; contradictions and failures are not cached. There is no automatic retry—users can explicitly check again.

The legacy `/api/trust` and `/api/preflight` routes remain HTTP 410. No public route can access a wallet, sign, create an authorization, submit a transaction, pay, retry an operation, or execute an action.
