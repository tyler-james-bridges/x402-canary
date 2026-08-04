import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import {
  BaseEvidenceCollectionError,
  BaseRpcConfigurationError,
  BaseRpcTransportError,
  BASE_GENESIS_BLOCK_HASH,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  HttpsBaseRpcTransport,
  collectBaseEvidence,
  deriveBaseRpcSourceRegistry,
  isPublicRpcAddress,
  resolveBaseRpcSources,
  type BaseReadRpcMethod,
  type BaseRpcRequester,
  type BaseRpcSourceManifest,
} from "../evidence/base-rpc.js";
import { EIP3009_AUTHORIZATION_USED_TOPIC, ERC20_TRANSFER_TOPIC, evaluateBaseSettlement } from "../evidence/base-settlement.js";
import type { ExactAuthorizationDescriptor, JsonValue } from "../evidence/types.js";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;
const IMPLEMENTATION = `0x${"1".repeat(40)}`;
const FROM = `0x${"2".repeat(40)}`;
const TO = `0x${"3".repeat(40)}`;
const NONCE = `0x${"4".repeat(64)}`;
const PROXY_CODE = "0x6000";
const IMPLEMENTATION_CODE = "0x6001";

function codeHash(code: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex")}`;
}

function manifest(): BaseRpcSourceManifest {
  return {
    schemaVersion: "0.1",
    networkId: BASE_MAINNET_NETWORK,
    genesisBlockHash: BASE_GENESIS_BLOCK_HASH,
    sources: [
      {
        id: "alpha",
        trustDomain: "provider-a.example",
        expectedOrigin: "https://rpc-a.example",
        endpointEnv: "BASE_RPC_ALPHA_URL",
      },
      {
        id: "bravo",
        trustDomain: "provider-b.example",
        expectedOrigin: "https://rpc-b.example",
        endpointEnv: "BASE_RPC_BRAVO_URL",
      },
    ],
    nativeUsdc: {
      asset: BASE_USDC_ASSET,
      proxyImplementationSlot: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
      allowedProxyCodeSha256: [codeHash(PROXY_CODE)],
      allowedImplementationCodeSha256: [codeHash(IMPLEMENTATION_CODE)],
      expectedName: "USD Coin",
      expectedVersion: "2",
      expectedDecimals: 6,
    },
  };
}

const authorization: ExactAuthorizationDescriptor = {
  networkId: BASE_MAINNET_NETWORK,
  asset: BASE_USDC_ASSET,
  from: FROM,
  to: TO,
  valueAtomic: "1000000",
  validAfter: "1",
  validBefore: "100",
  nonce: NONCE,
};

function quantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8").toString("hex");
  const paddedLength = Math.ceil(bytes.length / 64) * 64;
  return `0x${word(32).slice(2)}${word(Buffer.byteLength(value)).slice(2)}${bytes.padEnd(paddedLength, "0")}`;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

interface MockOptions {
  wrongChainSource?: string;
  wrongGenesisSource?: string;
  finalizedHeadConflictSource?: string;
  forkSource?: string;
  wrongProxyCodeSource?: string;
  usedBySource?: Record<string, boolean>;
  receiptBySource?: Record<string, "present" | "missing">;
  receiptBlock?: number;
  receiptMutation?: (receipt: Record<string, unknown>, sourceId: string) => void;
}

class MockRpc implements BaseRpcRequester {
  readonly calls: Array<{ sourceId: string; method: BaseReadRpcMethod; params: readonly JsonValue[] }> = [];

  constructor(private readonly options: MockOptions = {}) {}

  async request(
    sourceId: string,
    method: BaseReadRpcMethod,
    params: readonly JsonValue[],
  ): Promise<unknown> {
    this.calls.push({ sourceId, method, params: structuredClone(params) });
    if (method === "eth_chainId") {
      return this.options.wrongChainSource === sourceId ? "0x1" : "0x2105";
    }
    if (method === "eth_getBlockByNumber") {
      const tag = params[0];
      if (tag === "0x0") {
        return {
          number: "0x0",
          hash: this.options.wrongGenesisSource === sourceId ? HASH_C : BASE_GENESIS_BLOCK_HASH,
          timestamp: "0x0",
        };
      }
      if (tag === "finalized") {
        return {
          number: sourceId === "alpha" ? quantity(120) : quantity(125),
          hash:
            this.options.finalizedHeadConflictSource === sourceId
              ? HASH_C
              : sourceId === "alpha"
                ? HASH_A
                : HASH_B,
          timestamp: quantity(
            this.options.finalizedHeadConflictSource === sourceId
              ? 201
              : sourceId === "alpha"
                ? 200
                : 205,
          ),
        };
      }
      if (tag === quantity(120)) {
        return {
          number: quantity(120),
          hash: this.options.forkSource === sourceId ? HASH_C : HASH_A,
          timestamp: quantity(200),
        };
      }
      if (tag === quantity(this.options.receiptBlock ?? 110)) {
        return {
          number: tag,
          hash: HASH_C,
          timestamp: quantity(180),
        };
      }
      throw new Error(`unexpected block tag ${String(tag)}`);
    }
    if (method === "eth_getCode") {
      const address = String(params[0]).toLowerCase();
      if (address === BASE_USDC_ASSET) {
        return this.options.wrongProxyCodeSource === sourceId ? "0x6002" : PROXY_CODE;
      }
      if (address === IMPLEMENTATION) return IMPLEMENTATION_CODE;
      throw new Error("unexpected code address");
    }
    if (method === "eth_getStorageAt") {
      return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`;
    }
    if (method === "eth_call") {
      const call = params[0] as Record<string, unknown>;
      const data = String(call.data);
      if (data === "0x06fdde03") return abiString("USD Coin");
      if (data === "0x54fd4d50") return abiString("2");
      if (data === "0x313ce567") return word(6);
      if (data.startsWith("0xe94a0102")) {
        return word(this.options.usedBySource?.[sourceId] ? 1 : 0);
      }
      throw new Error("unexpected eth_call data");
    }
    if (method === "eth_getTransactionReceipt") {
      if (this.options.receiptBySource?.[sourceId] !== "present") return null;
      const receipt = validRawReceipt(this.options.receiptBlock ?? 110);
      this.options.receiptMutation?.(receipt, sourceId);
      return receipt;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

function validRawReceipt(blockNumber: number): Record<string, unknown> {
  return {
    transactionHash: HASH_B,
    blockHash: HASH_C,
    blockNumber: quantity(blockNumber),
    status: "0x1",
    logs: [
      {
        address: BASE_USDC_ASSET,
        topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(FROM), NONCE],
        data: "0x",
        logIndex: "0x5",
        transactionHash: HASH_B,
        removed: false,
      },
      {
        address: BASE_USDC_ASSET,
        topics: [ERC20_TRANSFER_TOPIC, addressTopic(FROM), addressTopic(TO)],
        data: word(1_000_000),
        logIndex: "0x6",
        transactionHash: HASH_B,
        removed: false,
      },
    ],
  };
}

async function collect(mock: MockRpc, transactionHash: string | undefined = HASH_B) {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  return collectBaseEvidence(registry, mock, {
    authorization,
    collectedAt: "2026-08-04T02:00:00.000Z",
    ...(transactionHash === undefined ? {} : { transactionHash }),
  });
}

test("source registry is deterministic and binds labels to the full registry hash", () => {
  const first = deriveBaseRpcSourceRegistry(manifest());
  const second = deriveBaseRpcSourceRegistry(structuredClone(manifest()));
  assert.deepEqual(first, second);
  assert.match(first.registryHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.sourceLabels.alpha, `base-rpc:alpha:${first.registryHash}`);
  assert.throws(
    () =>
      (((first.manifest.sources[0] as unknown) as Record<string, unknown>).id = "mutated"),
    TypeError,
  );
});

for (const [name, mutate, code] of [
  [
    "HTTP origin",
    (target: Record<string, any>) => (target.sources[0].expectedOrigin = "http://rpc-a.example"),
    "SOURCE_ORIGIN_INVALID",
  ],
  [
    "duplicate trust domain",
    (target: Record<string, any>) => (target.sources[1].trustDomain = target.sources[0].trustDomain),
    "SOURCE_TRUST_DOMAIN_DUPLICATE",
  ],
  [
    "unsorted sources",
    (target: Record<string, any>) => target.sources.reverse(),
    "REGISTRY_SOURCES_NOT_SORTED",
  ],
  [
    "unknown field",
    (target: Record<string, any>) => (target.sources[0].url = "https://caller.example"),
    "SOURCE_UNEXPECTED_FIELD",
  ],
] as const) {
  test(`registry rejects ${name}`, () => {
    const target = manifest() as unknown as Record<string, any>;
    mutate(target);
    assert.throws(
      () => deriveBaseRpcSourceRegistry(target),
      (error: unknown) => error instanceof BaseRpcConfigurationError && error.code === code,
    );
  });
}

test("runtime endpoints are secret-resolved, origin-pinned, and absent from the registry hash", () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const endpoints: Record<string, string> = {
    BASE_RPC_ALPHA_URL: "https://rpc-a.example/v2/ALPHA_SECRET?key=one",
    BASE_RPC_BRAVO_URL: "https://rpc-b.example/rpc/BRAVO_SECRET",
  };
  const resolved = resolveBaseRpcSources(registry, (name) => endpoints[name]);
  assert.equal(resolved[0]?.endpoint.pathname, "/v2/ALPHA_SECRET");
  assert.ok(!JSON.stringify(registry).includes("ALPHA_SECRET"));
  assert.ok(!registry.registryHash.includes("ALPHA_SECRET"));
  assert.throws(
    () =>
      (((resolved[0] as unknown) as Record<string, unknown>).expectedOrigin =
        "https://evil.example"),
    TypeError,
  );
});

test("mutating a resolved URL cannot move a branded source to another origin", () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const resolved = resolveBaseRpcSources(registry, (name) =>
    name === "BASE_RPC_ALPHA_URL" ? "https://rpc-a.example/rpc" : "https://rpc-b.example/rpc",
  );
  resolved[0]!.endpoint.hostname = "evil.example";
  assert.throws(
    () => new HttpsBaseRpcTransport(resolved),
    (error: unknown) =>
      error instanceof BaseRpcConfigurationError &&
      error.code === "RESOLVED_SOURCE_INTEGRITY_MISMATCH",
  );
});

test("endpoint policy errors never echo a secret-bearing URL", () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const secret = "DO_NOT_ECHO_THIS_SECRET";
  assert.throws(
    () =>
      resolveBaseRpcSources(registry, (name) =>
        name === "BASE_RPC_ALPHA_URL"
          ? `https://evil.example/${secret}`
          : "https://rpc-b.example/rpc",
      ),
    (error: unknown) => error instanceof Error && !error.message.includes(secret),
  );
});

test("private, loopback, reserved, and documentation addresses are rejected", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.0.2.1", "::1", "fc00::1"] ) {
    assert.equal(isPublicRpcAddress(address), false, address);
  }
  assert.equal(isPublicRpcAddress("8.8.8.8"), true);
  assert.equal(isPublicRpcAddress("2606:4700:4700::1111"), true);
});

test("HTTPS transport emits only allowlisted JSON-RPC and validates response IDs", async () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const resolved = resolveBaseRpcSources(registry, (name) =>
    name === "BASE_RPC_ALPHA_URL" ? "https://rpc-a.example/rpc" : "https://rpc-b.example/rpc",
  );
  const transport = new HttpsBaseRpcTransport(resolved, {
    connectionExecutor: async (_source, body) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      assert.equal(request.method, "eth_chainId");
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x2105" });
    },
  });
  assert.equal(await transport.request("alpha", "eth_chainId", []), "0x2105");
  assert.equal(transport.sourceAuthentication, "test_injected");
  await assert.rejects(
    transport.request("alpha", "eth_sendRawTransaction" as BaseReadRpcMethod, ["0x00"]),
    (error: unknown) => error instanceof BaseRpcTransportError && error.code === "RPC_METHOD_NOT_ALLOWED",
  );
});

test("transport redacts provider errors and rejects oversized or mismatched envelopes", async () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const resolved = resolveBaseRpcSources(registry, (name) =>
    name === "BASE_RPC_ALPHA_URL" ? "https://rpc-a.example/rpc" : "https://rpc-b.example/rpc",
  );
  const secret = "PROVIDER_SECRET_MESSAGE";
  const providerError = new HttpsBaseRpcTransport(resolved, {
    connectionExecutor: async (_source, body) => {
      const request = JSON.parse(body) as Record<string, unknown>;
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: secret } });
    },
  });
  await assert.rejects(
    providerError.request("alpha", "eth_chainId", []),
    (error: unknown) => error instanceof BaseRpcTransportError && !error.message.includes(secret),
  );

  const wrongId = new HttpsBaseRpcTransport(resolved, {
    connectionExecutor: async () => JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x2105" }),
  });
  await assert.rejects(
    wrongId.request("alpha", "eth_chainId", []),
    (error: unknown) => error instanceof BaseRpcTransportError && error.code === "RPC_RESPONSE_ENVELOPE_INVALID",
  );

  const oversized = new HttpsBaseRpcTransport(resolved, {
    maxResponseBytes: 1024,
    connectionExecutor: async () => "x".repeat(1025),
  });
  await assert.rejects(
    oversized.request("alpha", "eth_chainId", []),
    (error: unknown) => error instanceof BaseRpcTransportError && error.code === "RPC_RESPONSE_TOO_LARGE",
  );
});

test("collector emits deterministic unanimous finalized absence observations", async () => {
  const mock = new MockRpc();
  const first = await collect(mock);
  const second = await collect(new MockRpc());
  assert.deepEqual(first, second);
  assert.equal(first.readiness, "kernel_ready");
  assert.equal(first.finalizedAnchor.blockNumber, "120");
  assert.equal(first.finalizedAnchor.blockHash, HASH_A);
  assert.equal(first.assurance.stateBinding, "eip1898_require_canonical");
  assert.equal(first.assurance.paymentExecutionEnabled, false);
  assert.equal(first.receiptObservations.length, 2);
  assert.ok(first.receiptObservations.every((observation) => observation.receipt === null));
  assert.ok(first.authorizationStateObservations.every((observation) => !observation.used));
  assert.match(first.collectionHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(first).includes("rpc-a.example"));
  assert.ok(
    mock.calls
      .filter((call) => call.method === "eth_call")
      .every((call) => (call.params[1] as Record<string, unknown>).requireCanonical === true),
  );
});

test("collector output proves finalized settlement through the existing pure evaluator", async () => {
  const collection = await collect(
    new MockRpc({
      usedBySource: { alpha: true, bravo: true },
      receiptBySource: { alpha: "present", bravo: "present" },
    }),
  );
  const evaluation = evaluateBaseSettlement(
    authorization,
    collection.receiptObservations,
    collection.authorizationStateObservations,
    10,
  );
  assert.equal(collection.readiness, "kernel_ready");
  assert.equal(evaluation.status, "confirmed");
  assert.equal(evaluation.authoritative, true);
  assert.equal(evaluation.confirmations, 11);
});

test("collector output proves post-expiry absence through two registry-bound sources", async () => {
  const collection = await collect(new MockRpc());
  const evaluation = evaluateBaseSettlement(
    authorization,
    collection.receiptObservations,
    collection.authorizationStateObservations,
    1,
  );
  assert.equal(evaluation.status, "absent");
  assert.equal(evaluation.authoritative, true);
});

for (const [name, options, code] of [
  ["wrong chain", { wrongChainSource: "bravo" }, "RPC_CHAIN_ID_MISMATCH"],
  ["wrong genesis", { wrongGenesisSource: "bravo" }, "RPC_GENESIS_HASH_MISMATCH"],
  [
    "finalized head-to-anchor continuity break",
    { finalizedHeadConflictSource: "alpha" },
    "FINALIZED_HEAD_ANCHOR_CONTRADICTION",
  ],
  ["finalized fork", { forkSource: "bravo" }, "FINALIZED_ANCHOR_CONTRADICTION"],
  ["unknown USDC code", { wrongProxyCodeSource: "bravo" }, "NATIVE_USDC_IDENTITY_CONTRADICTION"],
  [
    "authorization state disagreement",
    { usedBySource: { alpha: true, bravo: false } },
    "AUTHORIZATION_STATE_CONTRADICTION",
  ],
] as const) {
  test(`collector fails closed on ${name}`, async () => {
    await assert.rejects(
      collect(new MockRpc(options)),
      (error: unknown) => error instanceof BaseEvidenceCollectionError && error.code === code,
    );
  });
}

test("a finalized present/null receipt disagreement is a contradiction", async () => {
  await assert.rejects(
    collect(
      new MockRpc({
        receiptBySource: { alpha: "present", bravo: "missing" },
      }),
    ),
    (error: unknown) =>
      error instanceof BaseEvidenceCollectionError && error.code === "RECEIPT_PRESENCE_CONTRADICTION",
  );
});

test("a unanimous receipt beyond the shared finalized anchor remains pending and is withheld", async () => {
  const collection = await collect(
    new MockRpc({
      receiptBySource: { alpha: "present", bravo: "present" },
      receiptBlock: 121,
      usedBySource: { alpha: false, bravo: false },
    }),
  );
  assert.equal(collection.readiness, "pending_finality");
  assert.equal(collection.receiptObservations.length, 0);
  assert.ok(collection.reasons.includes("RECEIPT_PENDING_FINALITY"));
});

test("collector never invokes a write, signing, wallet, admin, or debug RPC method", async () => {
  const mock = new MockRpc();
  await collect(mock);
  const allowed = new Set([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getTransactionReceipt",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_call",
  ]);
  assert.ok(mock.calls.every((call) => allowed.has(call.method)));
});

test("collector rejects unexpected request and authorization fields before RPC", async () => {
  const registry = deriveBaseRpcSourceRegistry(manifest());
  const mock = new MockRpc();
  await assert.rejects(
    collectBaseEvidence(registry, mock, {
      authorization,
      collectedAt: "2026-08-04T02:00:00.000Z",
      callerUrl: "https://untrusted.example",
    } as never),
    (error: unknown) =>
      error instanceof BaseEvidenceCollectionError &&
      error.code === "COLLECTION_REQUEST_UNEXPECTED_FIELD",
  );
  const alteredAuthorization = { ...authorization, signature: "secret" };
  await assert.rejects(
    collectBaseEvidence(registry, mock, {
      authorization: alteredAuthorization,
      collectedAt: "2026-08-04T02:00:00.000Z",
    } as never),
    (error: unknown) =>
      error instanceof BaseEvidenceCollectionError && error.code === "AUTHORIZATION_UNEXPECTED_FIELD",
  );
  assert.equal(mock.calls.length, 0);
});

test("collector rejects a structurally plausible registry that did not pass derivation", async () => {
  const derived = deriveBaseRpcSourceRegistry(manifest());
  const forged = structuredClone(derived);
  const mock = new MockRpc();
  await assert.rejects(
    collectBaseEvidence(forged, mock, {
      authorization,
      collectedAt: "2026-08-04T02:00:00.000Z",
    }),
    (error: unknown) =>
      error instanceof BaseRpcConfigurationError && error.code === "REGISTRY_NOT_DERIVED",
  );
  assert.equal(mock.calls.length, 0);
});
