# Base Collector v0.1

Status: authenticated read-only collector and live conformance receipt. Payment execution remains disabled.

## Boundary

The collector is a private operator tool, not a public RPC proxy. It accepts a strict, secret-free registry and resolves endpoint URLs only through named environment variables. Source labels are derived from the full registry hash; a request cannot supply its own source name or endpoint.

The production transport uses HTTPS with Web PKI, TLS 1.2 or newer, exact origin and port 443, no redirects, no compression, bounded responses, stable redacted errors, and a DNS policy that rejects non-public addresses. The JSON-RPC method union contains reads only. No wallet, signer, transaction-submission, debug, admin, or payment method is representable.

TLS proves collection from the configured endpoint. It does not make a provider a cryptographic proof of Base truth. The collector therefore requires unanimous facts from distinct operator-declared trust domains and preserves every disagreement as a hard failure.

## Base and finality binding

Each run verifies:

- chain ID `8453` and the pinned Base genesis block hash;
- a block returned through the `finalized` tag;
- unanimous number, hash, and timestamp for the shared finalized anchor;
- EIP-1898 `{ blockHash, requireCanonical: true }` binding for state and code reads;
- the official native Base USDC address;
- the Circle proxy implementation slot and an explicit proxy/implementation bytecode allowlist;
- token name `USD Coin`, version `2`, decimals `6`, and callable `authorizationState(address,bytes32)`.

An unknown Circle implementation opens the circuit until the allowlist and event-order assumptions are reviewed. A receipt later than the shared finalized anchor is withheld as pending. RPC errors, timeouts, unsupported methods, or a `present`/`null` disagreement never become absence evidence.

Base documents the `safe` and `finalized` block tags in its [RPC reference](https://docs.base.org/base-chain/api-reference/rpc-overview). Circle publishes the native Base USDC address in its [contract-address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses).

## Live conformance receipt

On 2026-08-04, the official Base RPC and PublicNode unanimously returned finalized block `49509847`, hash `0xf19330c1458bad249de029ff9c8c26ffeaece6bb98d7d5e37945319340602934`. They agreed on the pinned genesis checkpoint, native-USDC proxy hash, implementation `0x2ce6311ddae708829bc0784c967b7d77d19fd779`, implementation hash, metadata, and an EIP-1898 unused-state read for the sanitized test nonce.

The complete secret-free receipt is `examples/base-collection-v0.1.live.json`. It proves collector conformance at that historical anchor, not continued provider availability or a settlement for the synthetic authorization.

## Run manually

```bash
BASE_RPC_OFFICIAL_URL=https://mainnet.base.org \
BASE_RPC_PUBLICNODE_URL=https://base-rpc.publicnode.com \
npm run --silent base:collect -- \
  examples/base-source-registry-v0.1.json \
  examples/base-collection-request-v0.1.json
```

Endpoint values may contain provider credentials in production. They are never included in the registry hash, output, journal, or raw error text.
