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
  price: string | null;       // human-readable, e.g. "$0.01"
  priceRaw: string | null;    // raw amount string from payload
  network: string | null;     // human-readable, e.g. "Base"
  networkRaw: string | null;  // e.g. "eip155:8453"
  asset: string | null;       // token contract or mint address
  assetSymbol: string | null; // e.g. "USDC"
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

// Known USDC assets (6 decimals)
const USDC_ASSETS: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",   // Base
  "0x84a71ccd554cc1b02749b35d22f684cc8ec987e1": "USDC",      // Abstract (Bridged USDC Stargate)
  "epjfwdd5aufqssqem2qn1xzybapC8G4wEGGkZwyTDt1v": "USDC", // Solana
};

const NETWORK_NAMES: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:1": "Ethereum",
  "eip155:2741": "Abstract",
  "eip155:11124": "Abstract Testnet",
  "eip155:84532": "Base Sepolia",
};

function humanizeNetwork(raw: string): string {
  return NETWORK_NAMES[raw] ?? raw;
}

function humanizePrice(amount: string, asset: string): string {
  const sym = USDC_ASSETS[asset.toLowerCase()];
  if (sym) {
    const dollars = parseInt(amount, 10) / 1_000_000;
    return `$${dollars.toFixed(dollars < 0.01 ? 6 : 4).replace(/\.?0+$/, "")}`;
  }
  return amount;
}

function parsePaymentRequired(header: string): X402Details {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const data = JSON.parse(decoded) as {
      x402Version?: number;
      accepts?: X402Accept[];
    };

    const accepts: X402Accept[] = data.accepts ?? [];
    const first = accepts[0] ?? null;

    return {
      version: data.x402Version ?? null,
      priceRaw: first?.amount ?? null,
      price: first ? humanizePrice(first.amount, first.asset) : null,
      networkRaw: first?.network ?? null,
      network: first ? humanizeNetwork(first.network) : null,
      asset: first?.asset ?? null,
      assetSymbol: first ? (USDC_ASSETS[first.asset.toLowerCase()] ?? null) : null,
      payTo: first?.payTo ?? null,
      accepts,
    };
  } catch {
    return {
      version: null,
      price: null,
      priceRaw: null,
      network: null,
      networkRaw: null,
      asset: null,
      assetSymbol: null,
      payTo: null,
      accepts: [],
    };
  }
}

export async function checkEndpoint(url: string, method = "GET"): Promise<CheckResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const isPost = method.toUpperCase() === "POST";
    const res = await fetch(url, {
      method: method.toUpperCase(),
      signal: controller.signal,
      headers: {
        "User-Agent": "x402-canary/1.0",
        ...(isPost ? { "Content-Type": "application/json" } : {}),
      },
      ...(isPost ? { body: "{}" } : {}),
    });

    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;

    if (res.status === 402) {
      const paymentHeader = res.headers.get("payment-required");
      const x402Details = paymentHeader
        ? parsePaymentRequired(paymentHeader)
        : {
            version: null,
            price: null,
            priceRaw: null,
            network: null,
            networkRaw: null,
            asset: null,
            assetSymbol: null,
            payTo: null,
            accepts: [],
          };

      return {
        url,
        status: 402,
        responseTimeMs,
        timestamp,
        isHealthy: true,
        isX402: true,
        x402Details,
      };
    }

    return {
      url,
      status: res.status,
      responseTimeMs,
      timestamp,
      isHealthy: res.status < 500,
      isX402: false,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);

    return {
      url,
      status: null,
      responseTimeMs,
      timestamp,
      isHealthy: false,
      isX402: false,
      error,
    };
  }
}
