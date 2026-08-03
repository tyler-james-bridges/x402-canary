export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PaymentProtocol = "x402";
export type PaymentNetwork = "base";
export type PaymentScheme = "exact";
export type BaseNetworkId = "eip155:8453";

export const BASE_MAINNET_NETWORK: BaseNetworkId = "eip155:8453";
export const BASE_USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export interface PaymentContract {
  protocol: PaymentProtocol;
  network: PaymentNetwork;
  scheme: PaymentScheme;
  /** Pins Base mainnet rather than relying on a broad chain label. */
  networkId: BaseNetworkId;
  /** Must be native Base USDC in the first slice. */
  asset: string;
  /** Binds the advertised protocol recipient. */
  payTo: string;
  /** USDC amount in six-decimal atomic units. */
  maxAmountAtomic: string;
  maxAmountUsd: number;
}

export interface RequestContract {
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  runnerTimeoutMs?: number;
  corsOrigin?: string;
}

export interface DeliveryContract {
  jsonPaths: string[];
}

export interface PollContract {
  urlPath: string;
  statusPath: string;
  pending: string[];
  success: string[];
  failure: string[];
  allowedOrigins?: string[];
  intervalMs?: number;
  timeoutMs?: number;
}

export interface PaidPathContract {
  name: string;
  request: RequestContract;
  payment: PaymentContract;
  corsOrigin?: string;
  delivery: DeliveryContract;
  poll?: PollContract;
}

export type CheckStage =
  | "challenge"
  | "cors"
  | "payment"
  | "settlement"
  | "delivery"
  | "poll";

export interface ContractCheck {
  stage: CheckStage;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  name: string;
  passed: boolean;
  paymentStatus: "not-attempted" | "attempted" | "confirmed" | "unknown";
  durationMs: number;
  checks: ContractCheck[];
  payment?: PaymentEvidence;
  data?: unknown;
}

export interface PaymentEvidence {
  protocol: string;
  network: string;
  price: string;
  transactionHash?: string;
  channelId?: string;
}

export interface AgentCashResult {
  success: boolean;
  data?: unknown;
  metadata?: AgentCashMetadata | null;
  error?: { message?: string };
  proxy?: {
    paidResponseCors?: boolean;
    paidResponseCorsDetail?: string;
    redirectBlocked?: boolean;
  };
}

export interface AgentCashMetadata {
  protocol?: string;
  network?: string;
  price?: string;
  payment?: {
    success?: boolean;
    transactionHash?: string;
    channelId?: string;
  } | null;
}

export type PaidFetcher = (
  request: RequestContract,
  payment: PaymentContract,
) => Promise<AgentCashResult>;
