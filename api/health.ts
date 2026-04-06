import type { VercelRequest, VercelResponse } from "@vercel/node";

interface Endpoint {
  name: string;
  url: string;
  method: string;
  description: string;
  expectedPrice?: string;
}

const endpoints: Endpoint[] = [
  {
    name: "x402scan Merchants",
    url: "https://www.x402scan.com/api/x402/merchants",
    method: "GET",
    description: "Paginated list of merchants by volume",
    expectedPrice: "$0.01",
  },
  {
    name: "x402scan Resources",
    url: "https://www.x402scan.com/api/x402/resources",
    method: "GET",
    description: "All indexed x402 resources",
    expectedPrice: "$0.01",
  },
  {
    name: "x402scan Facilitators",
    url: "https://www.x402scan.com/api/x402/facilitators",
    method: "GET",
    description: "x402 facilitators with stats",
    expectedPrice: "$0.01",
  },
  {
    name: "StableEnrich Exa Search",
    url: "https://stableenrich.dev/api/exa/search",
    method: "POST",
    description: "Neural search across the web via Exa",
    expectedPrice: "$0.01",
  },
  {
    name: "StableEnrich Firecrawl Scrape",
    url: "https://stableenrich.dev/api/firecrawl/scrape",
    method: "POST",
    description: "Scrape URLs with JS rendering",
    expectedPrice: "$0.0126",
  },
  {
    name: "StableEnrich Apollo People",
    url: "https://stableenrich.dev/api/apollo/people-search",
    method: "POST",
    description: "Apollo people search API",
    expectedPrice: "$0.02",
  },
  {
    name: "AgentCash Send",
    url: "https://agentcash.dev/api/send",
    method: "POST",
    description: "Send USDC on Base/Solana",
    expectedPrice: "dynamic",
  },
  {
    name: "Base RPC",
    url: "https://mainnet.base.org",
    method: "POST",
    description: "Base L2 mainnet RPC",
    expectedPrice: "free",
  },
];

const USDC_ASSETS: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "epjfwdd5aufqssqem2qn1xzybapC8G4wEGGkZwyTDt1v": "USDC",
};

const NETWORK_NAMES: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:1": "Ethereum",
  "eip155:2741": "Abstract",
  "eip155:11124": "Abstract Testnet",
  "eip155:84532": "Base Sepolia",
};

interface X402Accept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

interface X402Details {
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

interface CheckResult {
  url: string;
  status: number | null;
  responseTimeMs: number;
  timestamp: string;
  isHealthy: boolean;
  isX402: boolean;
  x402Details?: X402Details;
  error?: string;
}

const EMPTY_X402: X402Details = {
  version: null, price: null, priceRaw: null,
  network: null, networkRaw: null, asset: null,
  assetSymbol: null, payTo: null, accepts: [],
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
    const data = JSON.parse(decoded) as { x402Version?: number; accepts?: X402Accept[] };
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
    return EMPTY_X402;
  }
}

async function checkEndpoint(url: string, method = "GET"): Promise<CheckResult> {
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
      return {
        url, status: 402, responseTimeMs, timestamp,
        isHealthy: true, isX402: true,
        x402Details: paymentHeader ? parsePaymentRequired(paymentHeader) : EMPTY_X402,
      };
    }
    return { url, status: res.status, responseTimeMs, timestamp, isHealthy: res.status < 500, isX402: false };
  } catch (err) {
    return {
      url, status: null, responseTimeMs: Date.now() - start, timestamp,
      isHealthy: false, isX402: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const check = await checkEndpoint(ep.url, ep.method);
      return {
        url: ep.url,
        name: ep.name,
        description: ep.description,
        expectedPrice: ep.expectedPrice,
        checks: [check],
        uptimePct: check.isHealthy ? 100 : 0,
        avgResponseTimeMs: check.responseTimeMs,
        p95ResponseTimeMs: check.responseTimeMs,
        lastChecked: check.timestamp,
        lastStatus: check.status,
        isHealthy: check.isHealthy,
        isX402: check.isX402,
        x402Details: check.x402Details,
        error: check.error,
      };
    })
  );

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ endpoints: results, generatedAt: new Date().toISOString() });
}
