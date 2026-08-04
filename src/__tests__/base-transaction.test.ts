import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import {
  BASE_GENESIS_BLOCK_HASH,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  deriveBaseRpcSourceRegistry,
  type BaseReadRpcMethod,
  type BaseRpcRequester,
  type BaseRpcSourceManifest,
} from "../evidence/base-rpc.js";
import {
  BaseTransactionObservationError,
  MAX_PUBLIC_BASE_SETTLEMENTS,
  collectBaseTransactionObservation,
  extractNativeUsdcEip3009Settlements,
  normalizeBaseRpcBlock,
  normalizeBaseTransactionHash,
  normalizeBaseTransactionReceipt,
} from "../evidence/base-transaction.js";
import {
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
} from "../evidence/base-settlement.js";
import type { JsonValue } from "../evidence/types.js";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;
const HASH_D = `0x${"d".repeat(64)}`;
const IMPLEMENTATION = `0x${"1".repeat(40)}`;
const FROM = `0x${"2".repeat(40)}`;
const TO = `0x${"3".repeat(40)}`;
const PROXY_CODE = "0x6000";
const IMPLEMENTATION_CODE = "0x6001";
const CHECKED_AT = "2026-08-04T04:00:00.000Z";

function codeHash(code: string): string {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(code.slice(2), "hex"))
    .digest("hex")}`;
}

function manifest(sourceCount = 2): BaseRpcSourceManifest {
  const sources = [
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
    {
      id: "charlie",
      trustDomain: "provider-c.example",
      expectedOrigin: "https://rpc-c.example",
      endpointEnv: "BASE_RPC_CHARLIE_URL",
    },
  ].slice(0, sourceCount);
  return {
    schemaVersion: "0.1",
    networkId: BASE_MAINNET_NETWORK,
    genesisBlockHash: BASE_GENESIS_BLOCK_HASH,
    sources,
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

function quantity(value: bigint | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

function word(value: bigint | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function nonce(index: number): string {
  return word(index + 1);
}

function rawReceipt(options: {
  blockNumber?: number;
  pairCount?: number;
  status?: "0x0" | "0x1";
} = {}): Record<string, unknown> {
  const blockNumber = options.blockNumber ?? 110;
  const pairCount = options.pairCount ?? 1;
  const logs = Array.from({ length: pairCount }, (_, index) => {
    const authorizationIndex = 5 + index * 2;
    return [
      {
        address: BASE_USDC_ASSET,
        topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(FROM), nonce(index)],
        data: "0x",
        logIndex: quantity(authorizationIndex),
        transactionHash: HASH_B,
        removed: false,
      },
      {
        address: BASE_USDC_ASSET,
        topics: [ERC20_TRANSFER_TOPIC, addressTopic(FROM), addressTopic(TO)],
        data: word(1_000_000 + index),
        logIndex: quantity(authorizationIndex + 1),
        transactionHash: HASH_B,
        removed: false,
      },
    ];
  }).flat();
  return {
    transactionHash: HASH_B,
    blockHash: HASH_C,
    blockNumber: quantity(blockNumber),
    status: options.status ?? "0x1",
    logs,
  };
}

interface MockOptions {
  receipts?: Partial<Record<"alpha" | "bravo", Record<string, unknown> | null>>;
  wrongChainSource?: string;
  wrongProxySources?: string[];
  mutateReceipt?: (receipt: Record<string, any>, sourceId: string) => void;
}

class MockRpc implements BaseRpcRequester {
  readonly calls: Array<{
    sourceId: string;
    method: BaseReadRpcMethod;
    params: readonly JsonValue[];
  }> = [];

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
        return { number: "0x0", hash: BASE_GENESIS_BLOCK_HASH, timestamp: "0x0" };
      }
      if (tag === "finalized") {
        return sourceId === "alpha"
          ? { number: quantity(120), hash: HASH_A, timestamp: quantity(200) }
          : { number: quantity(125), hash: HASH_D, timestamp: quantity(205) };
      }
      if (tag === quantity(120)) {
        return { number: quantity(120), hash: HASH_A, timestamp: quantity(200) };
      }
      if (tag === quantity(110)) {
        return { number: quantity(110), hash: HASH_C, timestamp: quantity(180) };
      }
      throw new Error(`unexpected block tag: ${String(tag)}`);
    }
    if (method === "eth_getTransactionReceipt") {
      const configured = this.options.receipts?.[sourceId as "alpha" | "bravo"];
      const receipt = configured === undefined ? rawReceipt() : configured;
      if (receipt === null) return null;
      const copy = structuredClone(receipt);
      this.options.mutateReceipt?.(copy, sourceId);
      return copy;
    }
    if (method === "eth_getStorageAt") {
      return `0x${"0".repeat(24)}${IMPLEMENTATION.slice(2)}`;
    }
    if (method === "eth_getCode") {
      const address = String(params[0]).toLowerCase();
      if (address === BASE_USDC_ASSET) {
        return this.options.wrongProxySources?.includes(sourceId) ? "0x6002" : PROXY_CODE;
      }
      if (address === IMPLEMENTATION) return IMPLEMENTATION_CODE;
      throw new Error(`unexpected code address: ${address}`);
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

async function collect(mock: MockRpc) {
  return collectBaseTransactionObservation(
    deriveBaseRpcSourceRegistry(manifest()),
    mock,
    { transactionHash: HASH_B, checkedAt: CHECKED_AT },
  );
}

test("strict hash, block, and receipt normalization canonicalizes provider facts", () => {
  assert.equal(normalizeBaseTransactionHash(HASH_B.toUpperCase().replace("0X", "0x")), HASH_B);
  assert.throws(
    () => normalizeBaseTransactionHash(`${HASH_B} `),
    (error: unknown) =>
      error instanceof BaseTransactionObservationError &&
      error.code === "TRANSACTION_HASH_INVALID",
  );
  assert.deepEqual(
    normalizeBaseRpcBlock({ number: "0xa", hash: HASH_A.toUpperCase().replace("0X", "0x"), timestamp: "0xc8" }),
    { number: "10", numberHex: "0xa", hash: HASH_A, timestamp: "200" },
  );
  const normalized = normalizeBaseTransactionReceipt(rawReceipt(), HASH_B);
  assert.equal(normalized?.blockNumber, "110");
  assert.equal(normalized?.status, "success");
  assert.deepEqual(normalized?.logs.map((log) => log.logIndex), [5, 6]);
  assert.throws(
    () => normalizeBaseTransactionReceipt(rawReceipt(), HASH_A),
    (error: unknown) =>
      error instanceof BaseTransactionObservationError &&
      error.code === "RECEIPT_TRANSACTION_HASH_MISMATCH",
  );
});

test("pair extraction requires native USDC, exact topics, and adjacent log indexes", () => {
  const normalized = normalizeBaseTransactionReceipt(rawReceipt(), HASH_B)!;
  assert.deepEqual(extractNativeUsdcEip3009Settlements(normalized), {
    settlementCount: 1,
    settlements: [
      {
        from: FROM,
        to: TO,
        valueAtomic: "1000000",
        nonce: nonce(0),
        authorizationUsedLogIndex: 5,
        transferLogIndex: 6,
      },
    ],
    truncated: false,
  });

  const nonAdjacentRaw = rawReceipt() as Record<string, any>;
  nonAdjacentRaw.logs[1].logIndex = quantity(7);
  const nonAdjacent = normalizeBaseTransactionReceipt(nonAdjacentRaw, HASH_B)!;
  assert.equal(extractNativeUsdcEip3009Settlements(nonAdjacent).settlementCount, 0);

  const zeroRaw = rawReceipt() as Record<string, any>;
  zeroRaw.logs[1].data = word(0);
  const zero = normalizeBaseTransactionReceipt(zeroRaw, HASH_B)!;
  assert.equal(extractNativeUsdcEip3009Settlements(zero).settlementCount, 0);

  const zeroRecipientRaw = rawReceipt() as Record<string, any>;
  zeroRecipientRaw.logs[1].topics[2] = addressTopic(`0x${"0".repeat(40)}`);
  const zeroRecipient = normalizeBaseTransactionReceipt(zeroRecipientRaw, HASH_B)!;
  assert.equal(extractNativeUsdcEip3009Settlements(zeroRecipient).settlementCount, 0);
});

test("pair extraction returns an exact count but bounds the public list", () => {
  const pairCount = MAX_PUBLIC_BASE_SETTLEMENTS + 1;
  const normalized = normalizeBaseTransactionReceipt(rawReceipt({ pairCount }), HASH_B)!;
  const extraction = extractNativeUsdcEip3009Settlements(normalized);
  assert.equal(extraction.settlementCount, pairCount);
  assert.equal(extraction.settlements.length, MAX_PUBLIC_BASE_SETTLEMENTS);
  assert.equal(extraction.truncated, true);
});

test("collector deterministically confirms one finalized native-USDC EIP-3009 pair", async () => {
  const firstMock = new MockRpc();
  const first = await collect(firstMock);
  const second = await collect(new MockRpc());
  assert.deepEqual(first, second);
  assert.equal(first.status, "confirmed");
  assert.equal(first.confirmations, 11);
  assert.equal(first.settlementCount, 1);
  assert.deepEqual(first.sourceAgreement, {
    configured: 2,
    agreeing: 2,
    quorum: "unanimous",
  });
  assert.deepEqual(first.receipt, {
    transactionHash: HASH_B,
    blockHash: HASH_C,
    blockNumber: "110",
    status: "success",
  });
  assert.equal("logs" in (first.receipt as object), false);
  assert.deepEqual(first.reasons, [
    "FINALIZED_RECEIPT_UNANIMOUS",
    "NATIVE_USDC_EIP3009_PAIR_OBSERVED",
  ]);
  assert.match(first.observationHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.doesNotMatch(JSON.stringify(first), /validAfter|validBefore|rpc-a\.example/);

  const allowed = new Set([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getTransactionReceipt",
    "eth_getCode",
    "eth_getStorageAt",
  ]);
  assert.ok(firstMock.calls.every((call) => allowed.has(call.method)));
  assert.ok(
    firstMock.calls
      .filter((call) => call.method === "eth_getCode" || call.method === "eth_getStorageAt")
      .every((call) => {
        const block = call.params.at(-1) as Record<string, unknown>;
        return block.blockHash === HASH_A && block.requireCanonical === true;
      }),
  );
});

for (const [name, options, expected] of [
  [
    "unanimous absence remains not observed",
    { receipts: { alpha: null, bravo: null } },
    { status: "not_observed", agreeing: 2, count: 0 },
  ],
  [
    "one unfinalized receipt remains pending",
    { receipts: { alpha: rawReceipt({ blockNumber: 121 }), bravo: null } },
    { status: "pending_finality", agreeing: 1, count: 0 },
  ],
  [
    "two matching unfinalized receipts remain pending",
    {
      receipts: {
        alpha: rawReceipt({ blockNumber: 121 }),
        bravo: rawReceipt({ blockNumber: 121 }),
      },
    },
    { status: "pending_finality", agreeing: 2, count: 1 },
  ],
  [
    "a finalized present-null split is a contradiction",
    { receipts: { alpha: rawReceipt(), bravo: null } },
    { status: "contradiction", agreeing: 1, count: 0 },
  ],
  [
    "a finalized revert is explicit",
    {
      receipts: {
        alpha: rawReceipt({ status: "0x0" }),
        bravo: rawReceipt({ status: "0x0" }),
      },
    },
    { status: "reverted", agreeing: 2, count: 0 },
  ],
  [
    "a successful receipt without an EIP-3009 pair does not overclaim",
    {
      receipts: {
        alpha: rawReceipt({ pairCount: 0 }),
        bravo: rawReceipt({ pairCount: 0 }),
      },
    },
    { status: "not_eip3009_usdc", agreeing: 2, count: 0 },
  ],
  [
    "multiple distinct pairs are reported without selecting an intent",
    {
      receipts: {
        alpha: rawReceipt({ pairCount: 2 }),
        bravo: rawReceipt({ pairCount: 2 }),
      },
    },
    { status: "multiple", agreeing: 2, count: 2 },
  ],
] as const) {
  test(name, async () => {
    const result = await collect(new MockRpc(options));
    assert.equal(result.status, expected.status);
    assert.equal(result.sourceAgreement.agreeing, expected.agreeing);
    assert.equal(result.settlementCount, expected.count);
  });
}

test("different provider receipts produce a contradiction", async () => {
  const result = await collect(
    new MockRpc({
      mutateReceipt(receipt, sourceId) {
        if (sourceId === "bravo") receipt.logs[1].data = word(2_000_000);
      },
    }),
  );
  assert.equal(result.status, "contradiction");
  assert.deepEqual(result.reasons, ["RECEIPT_CONTRADICTION"]);
  assert.equal(result.receipt, null);
});

test("a removed log is never treated as canonical transaction evidence", async () => {
  const removed = rawReceipt() as Record<string, any>;
  removed.logs[0].removed = true;
  const result = await collect(
    new MockRpc({ receipts: { alpha: removed, bravo: removed } }),
  );
  assert.equal(result.status, "contradiction");
  assert.deepEqual(result.reasons, ["REMOVED_LOG_REJECTED"]);
  assert.equal(result.settlementCount, 0);
});

test("native-USDC identity disagreement and unknown code fail closed", async () => {
  const disagreement = await collect(
    new MockRpc({ wrongProxySources: ["bravo"] }),
  );
  assert.equal(disagreement.status, "contradiction");
  assert.deepEqual(disagreement.reasons, ["NATIVE_USDC_IDENTITY_CONTRADICTION"]);
  assert.equal(disagreement.settlementCount, 0);

  const unknown = await collect(
    new MockRpc({ wrongProxySources: ["alpha", "bravo"] }),
  );
  assert.equal(unknown.status, "contradiction");
  assert.deepEqual(unknown.reasons, ["NATIVE_USDC_CODE_NOT_ALLOWED"]);
  assert.equal(unknown.settlementCount, 0);
});

test("invalid request and non-two-source registry are rejected before RPC", async () => {
  const invalidRequestRpc = new MockRpc();
  await assert.rejects(
    collectBaseTransactionObservation(
      deriveBaseRpcSourceRegistry(manifest()),
      invalidRequestRpc,
      { transactionHash: HASH_B, checkedAt: CHECKED_AT, url: "https://evil.example" } as never,
    ),
    (error: unknown) =>
      error instanceof BaseTransactionObservationError &&
      error.code === "OBSERVATION_REQUEST_UNEXPECTED_FIELD",
  );
  assert.equal(invalidRequestRpc.calls.length, 0);

  const threeSourceRpc = new MockRpc();
  await assert.rejects(
    collectBaseTransactionObservation(
      deriveBaseRpcSourceRegistry(manifest(3)),
      threeSourceRpc,
      { transactionHash: HASH_B, checkedAt: CHECKED_AT },
    ),
    (error: unknown) =>
      error instanceof BaseTransactionObservationError &&
      error.code === "REGISTRY_REQUIRES_TWO_SOURCES",
  );
  assert.equal(threeSourceRpc.calls.length, 0);
});

test("a source on the wrong chain cannot produce a settlement verdict", async () => {
  const result = await collect(new MockRpc({ wrongChainSource: "bravo" }));
  assert.equal(result.status, "contradiction");
  assert.deepEqual(result.reasons, ["RPC_CHAIN_ID_MISMATCH"]);
  assert.equal(result.settlementCount, 0);
});
