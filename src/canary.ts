export interface X402Accept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface X402Details {
  version: number | null;
  price: string | null;
  priceRaw: string | null;
  network: string | null;
  networkRaw: string | null;
  asset: string | null;
  assetSymbol: string | null;
  payTo: string | null;
  accepts: X402Accept[];
}

export interface CheckResult {
  url: string;
  status: number | null;
  responseTimeMs: number;
  timestamp: string;
  isHealthy: boolean;
  isX402: boolean;
  x402Details?: X402Details;
  error?: string;
}

/**
 * The old generic checker was an unbounded outbound primitive. Keep an explicit
 * failure at its former import boundary so stale callers cannot silently revive it.
 */
export async function checkEndpoint(_url: string, _method = "GET"): Promise<CheckResult> {
  throw new Error("PUBLIC_PROBE_DISABLED: generic outbound endpoint checks are contained");
}
