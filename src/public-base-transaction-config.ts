import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "./contracts.js";
import {
  BASE_GENESIS_BLOCK_HASH,
  CIRCLE_PROXY_IMPLEMENTATION_SLOT,
  HttpsBaseRpcTransport,
  deriveBaseRpcSourceRegistry,
  resolveBaseRpcSources,
  type BaseRpcRequester,
  type BaseRpcSourceRegistry,
  type BaseRpcSourceManifest,
} from "./evidence/base-rpc.js";

export const PUBLIC_BASE_TRANSACTION_RPC_TIMEOUT_MS = 2_500;
export const PUBLIC_BASE_TRANSACTION_MAX_RPC_RESPONSE_BYTES = 512 * 1024;
export const PUBLIC_BASE_TRANSACTION_DEADLINE_MS = 8_000;
export const PUBLIC_BASE_TRANSACTION_CDN_TTL_SECONDS = 5;
export const PUBLIC_BASE_TRANSACTION_TRANSIENT_CDN_TTL_SECONDS = 1;

export const PUBLIC_BASE_TRANSACTION_DRPC_ENV = "BASE_RPC_DRPC_URL";
export const PUBLIC_BASE_TRANSACTION_TENDERLY_ENV = "BASE_RPC_TENDERLY_URL";
export const PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN = "https://base.drpc.org";
export const PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN =
  "https://base.gateway.tenderly.co";

const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = Object.freeze({
  [PUBLIC_BASE_TRANSACTION_DRPC_ENV]: `${PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN}/`,
  [PUBLIC_BASE_TRANSACTION_TENDERLY_ENV]:
    `${PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN}/`,
});

const SOURCE_MANIFEST: BaseRpcSourceManifest = {
  schemaVersion: "0.1",
  networkId: BASE_MAINNET_NETWORK,
  genesisBlockHash: BASE_GENESIS_BLOCK_HASH,
  sources: [
    {
      id: "drpc",
      trustDomain: "drpc.org",
      expectedOrigin: PUBLIC_BASE_TRANSACTION_DRPC_ORIGIN,
      endpointEnv: PUBLIC_BASE_TRANSACTION_DRPC_ENV,
    },
    {
      id: "tenderly",
      trustDomain: "tenderly.co",
      expectedOrigin: PUBLIC_BASE_TRANSACTION_TENDERLY_ORIGIN,
      endpointEnv: PUBLIC_BASE_TRANSACTION_TENDERLY_ENV,
    },
  ],
  nativeUsdc: {
    asset: BASE_USDC_ASSET,
    proxyImplementationSlot: CIRCLE_PROXY_IMPLEMENTATION_SLOT,
    allowedProxyCodeSha256: [
      "sha256:98d785fcb1bf847f287adc2310759fd94cc13e754b974bc72131382e8266f607",
    ],
    allowedImplementationCodeSha256: [
      "sha256:dcb3b7ca28662970d0a7cdad420e529fb837d7bf8a246b1a680c20e153db79e8",
    ],
    expectedName: "USD Coin",
    expectedVersion: "2",
    expectedDecimals: 6,
  },
};

export const PUBLIC_BASE_TRANSACTION_REGISTRY =
  deriveBaseRpcSourceRegistry(SOURCE_MANIFEST);

export interface PublicBaseTransactionRpcRuntime {
  registry: BaseRpcSourceRegistry;
  requester: BaseRpcRequester;
}

export type PublicBaseTransactionEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * Resolve only the two code-pinned Base RPC origins. An optional environment
 * value may add a provider-owned path or query credential, but the underlying
 * registry rejects any origin, port, userinfo, fragment, or scheme change.
 */
export function createPublicBaseTransactionRpcRuntime(
  signal: AbortSignal,
  environment: PublicBaseTransactionEnvironment = process.env,
): PublicBaseTransactionRpcRuntime {
  const sources = resolveBaseRpcSources(
    PUBLIC_BASE_TRANSACTION_REGISTRY,
    (environmentName) =>
      environment[environmentName] ?? DEFAULT_ENDPOINTS[environmentName],
  );

  return Object.freeze({
    registry: PUBLIC_BASE_TRANSACTION_REGISTRY,
    requester: new HttpsBaseRpcTransport(sources, {
      timeoutMs: PUBLIC_BASE_TRANSACTION_RPC_TIMEOUT_MS,
      maxResponseBytes: PUBLIC_BASE_TRANSACTION_MAX_RPC_RESPONSE_BYTES,
      signal,
    }),
  });
}
