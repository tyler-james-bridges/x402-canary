# Public x402 settlement-requirement verifier v0.2

`POST /api/x402-intent` compares one strict caller-declared x402 v2 `PaymentRequirements` object with one fixed-source Base transaction observation. It is a read-only evidence API for humans and agents. It does not create, sign, submit, pay, retry, or execute anything.

The claim is intentionally narrow: a `settlement_terms_matched` report establishes that exactly one qualifying finalized native-USDC EIP-3009 event pair was observed under the configured unanimous policy and that its recipient and atomic amount match the supported declaration. It is not proof that the complete x402 exchange or purchased operation succeeded.

The lower-level [`GET /api/base-transaction`](public-base-verifier-v0.1.md) remains available when a client needs transaction evidence without a caller-declared requirement.

## Request

```http
POST /api/x402-intent
Content-Type: application/json
```

The URL must have no query string. The JSON body must contain exactly these three top-level fields:

```json
{
  "x402Version": 2,
  "transactionHash": "0x0246829b14840ccd32eeb31476ea04f54a7c8d034ca4336d9b08f18a90b26ea7",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "19483",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "payTo": "0xe9030014f5dae217d0a152f02a043567b16c1abf",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USD Coin",
      "version": "2"
    }
  }
}
```

The example uses public onchain identifiers. Do not put private keys, wallet material, payment headers, signed authorizations, credentials, operation data, or other secrets in this request.

### Exact supported input

The public v0.2 boundary accepts only:

- `x402Version`: the number `2`;
- `scheme`: `exact`;
- `network`: Base mainnet, `eip155:8453`;
- `asset`: native Base USDC, `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`;
- `amount`: a positive canonical decimal string within `uint256`, in six-decimal USDC atomic units;
- `payTo`: a nonzero EVM address;
- `maxTimeoutSeconds`: a positive safe integer no greater than `86400`;
- `extra.name`: `USD Coin`;
- `extra.version`: `2`;
- `extra.assetTransferMethod`: omitted or `eip3009`. An omitted value is normalized to `eip3009` in the report.

Addresses and the transaction hash are normalized to lowercase. Unknown, accessor-backed, non-enumerable, unsupported, or malformed fields fail closed. `PaymentRequirements` must contain exactly its seven standard fields; `extra` may contain only the three fields listed above and must contain `name` and `version`.

The normalized canonical JSON body is limited to 6,144 bytes. The local server reads at most 8,192 raw bytes; the Vercel function rejects a declared `Content-Length` above 8,192 bytes and otherwise remains subject to Vercel's platform request limit. Unsupported semantic input is rejected before a Base RPC runtime is constructed.

Browser requests must be same-origin and receive no CORS opt-in. A server-to-server client may omit `Origin`; supplying a mismatched origin or cross-site browser context fails closed. The transaction hash is necessarily used for the fixed-source Base lookup. The `PaymentRequirements` object is evaluated locally and is not forwarded to RPC providers.

### `curl` example

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  https://canary.0x402.sh/api/x402-intent <<'JSON'
{
  "x402Version": 2,
  "transactionHash": "0x0246829b14840ccd32eeb31476ea04f54a7c8d034ca4336d9b08f18a90b26ea7",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "19483",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "payTo": "0xe9030014f5dae217d0a152f02a043567b16c1abf",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USD Coin",
      "version": "2"
    }
  }
}
JSON
```

## Successful response

Every evidence verdict returns HTTP 200, `Cache-Control: no-store`, and this exact top-level shape:

```typescript
{
  schemaVersion: "0.2";
  kind: "public_x402_requirement_verification";
  checkedAt: string;
  status:
    | "settlement_terms_matched"
    | "settlement_terms_mismatch"
    | "pending_finality"
    | "not_observed"
    | "multiple_payments_observed"
    | "contradiction";
  transactionHash: string;
  caseId: `sha256:${string}`;
  reportHash: `sha256:${string}`;
  intent: {
    x402Version: 2;
    paymentRequirements: NormalizedSupportedPaymentRequirements;
    intentHash: `sha256:${string}`;
  };
  comparisons: RequirementComparison[];
  observedPayment: ObservedPayment | null;
  baseEvidence: BaseEvidenceSummary;
  reasons: string[];
  assurance: Assurance;
  capabilities: Capabilities;
  privacy: Privacy;
  limitations: Limitations;
}
```

`intent.paymentRequirements` is the normalized supported object, including `assetTransferMethod: "eip3009"`. `intentHash` identifies that normalized declaration. `caseId` identifies the declaration and transaction-hash pair. `reportHash` is a domain-separated content identity for the exact report core. These hashes are unsigned: they are not signatures, attestations, timestamps from an external authority, or authorization to act. A fresh observation can produce a new report hash.

Each comparison is exactly:

```typescript
{
  field:
    | "scheme"
    | "network"
    | "asset"
    | "transferMethod"
    | "tokenDomain"
    | "recipient"
    | "amount"
    | "maxTimeoutSeconds";
  expected: string;
  observed: string | null;
  status: "matched" | "mismatched" | "declared_only" | "not_evaluated";
  basis:
    | "supported_requirement"
    | "fixed_source_base_observation"
    | "native_usdc_identity"
    | "eip3009_event_pair"
    | "caller_declaration";
}
```

The strict parser establishes that the declaration uses the supported scheme. The fixed observer establishes the network and native-USDC identity. A qualifying event pair supplies the observed transfer method, recipient, and atomic amount. `maxTimeoutSeconds` is always `declared_only`; the transaction receipt cannot prove x402 timeout compliance.

When exactly one qualifying finalized pair is available, `observedPayment` is:

```typescript
{
  from: `0x${string}`;
  to: `0x${string}`;
  valueAtomic: string;
  nonce: `0x${string}`;
  authorizationUsedLogIndex: number;
  transferLogIndex: number;
}
```

`from` and `nonce` are observed event facts. They are not expected values supplied by `PaymentRequirements`, so the report does not prove an expected payer or expected nonce.

`baseEvidence` contains only the sanitized lower-level summary:

```typescript
{
  status:
    | "confirmed"
    | "multiple"
    | "pending_finality"
    | "not_observed"
    | "not_eip3009_usdc"
    | "reverted"
    | "contradiction";
  observationHash: `sha256:${string}`;
  receipt: {
    transactionHash: string;
    blockHash: string;
    blockNumber: string;
    status: "success" | "reverted";
  } | null;
  finalizedAnchor: {
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
  } | null;
  sourceAgreement: {
    configured: 2;
    agreeing: 0 | 1 | 2;
    quorum: "unanimous";
  };
  confirmations: number;
  settlementCount: number;
  truncated: boolean;
}
```

Provider URLs, source labels, registry hashes, credentials, DNS/IP data, upstream errors, raw receipts, calldata, unrelated logs, signatures, and private evidence artifacts are not returned.

### Verdict semantics

- `settlement_terms_matched`: exactly one untruncated, finalized qualifying event pair was observed under unanimous configured-source policy, and its recipient and atomic amount match the normalized declaration.
- `settlement_terms_mismatch`: exactly one such pair was observed, but recipient, atomic amount, or both differ. `reasons` identifies `RECIPIENT_MISMATCH` and/or `AMOUNT_MISMATCH`.
- `pending_finality`: a receipt is present but not yet within the shared finalized anchor. No match is claimed.
- `not_observed`: the required finalized native-USDC EIP-3009 payment pair was not established. `reasons` distinguishes an absent receipt, reverted receipt, or a receipt without a qualifying pair. This is not authoritative global absence.
- `multiple_payments_observed`: more than one qualifying pair was observed. No intended-payment selection and no duplicate-purchase conclusion is inferred.
- `contradiction`: the fixed Base observation or its required exact-one shape failed an agreement, identity, canonicality, structural, or binding rule. No settlement-term match is claimed.

Only `settlement_terms_matched` is a positive match, and even that verdict is bounded by the limitations below. Transport, provider, configuration, and deadline failures are not converted into evidence verdicts.

### Fixed assurance and limitations

The report declares its requirement source as `caller_declared`, source identity as `server_pinned_origins`, finality as `shared_finalized_block_hash`, quorum as `unanimous`, and report integrity as `unsigned_sha256_content_identity`. `externalTruthProven` remains `false`.

Every execution and target-selection capability remains disabled: caller-selected targets and RPCs, resource URLs, payment execution, wallet access, signing, transaction submission, retry execution, and action execution are all `false`. The only enabled capabilities are strict requirement comparison, a caller-selected public transaction-hash lookup, and the fixed-source Base verifier.

Every report explicitly keeps these proof claims false:

```json
{
  "x402WireExchangeProven": false,
  "requirementAuthenticityProven": false,
  "resourceBindingProven": false,
  "expectedPayerProven": false,
  "expectedNonceProven": false,
  "authorizationWindowProven": false,
  "timeoutComplianceProven": false,
  "authorizationSignatureProven": false,
  "httpDeliveryProven": false,
  "businessEffectProven": false,
  "duplicatePurchaseProven": false,
  "retrySafetyProven": false
}
```

A `PaymentRequirements` object declares settlement requirements. By itself it does not prove that an x402 v2 `PaymentRequired` / `PaymentPayload` wire exchange occurred, who issued those requirements, or which resource they described. It also does not carry the payer, nonce, EIP-3009 validity window, or authorization signature needed to verify those authorization facts. A finalized transfer cannot prove HTTP delivery, offchain business effect, purchase uniqueness, or retry safety.

## Machine-client guidance

Clients should require HTTP 200, `schemaVersion === "0.2"`, the exact `kind`, a recognized status, the expected normalized `intent`, and the fixed limitations/capabilities before using a report as evidence. Preserve atomic amounts as decimal strings; never convert them through floating point. Treat every unrecognized schema, field value, status, HTTP error, parse error, timeout, or unavailable response as no match.

For a compact read-only extraction:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary @request.json \
  https://canary.0x402.sh/api/x402-intent \
  | jq '{schemaVersion, kind, status, caseId, reportHash, comparisons, reasons, limitations}'
```

Do not use `settlement_terms_matched` alone to trigger a payment, replay, retry, transaction, wallet action, operation execution, or delivery claim. Those actions require separate authority and evidence outside this API.

## Errors and privacy

- HTTP 400: malformed request, unsupported requirement, wrong content type, URL/query/context failure, or other strict input rejection;
- HTTP 405: unsupported method, with `Allow: POST`;
- HTTP 413: body limit exceeded;
- HTTP 503: bounded fixed-source verification unavailable, busy, timed out, or failed internally.

Errors are sanitized and do not expose provider details. The response is `no-store`, and the application does not persist verifier inputs or reports. The request body keeps requirements out of the URL, but ordinary browser, CDN, platform, function, and network infrastructure may still observe or log request metadata or bodies according to their own policies. The transaction hash is public onchain data and is necessarily sent to the two fixed RPC sources. Do not submit secrets.

There is no automatic polling or retry. Rechecking is an explicit new observation and does not grant operation-level retry safety.
