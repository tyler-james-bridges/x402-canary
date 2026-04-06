import type { VercelRequest, VercelResponse } from "@vercel/node";

const endpoints = [
  { name: "x402scan Merchants", url: "https://www.x402scan.com/api/x402/merchants", method: "GET", description: "Paginated list of merchants by volume", expectedPrice: "$0.01" },
  { name: "x402scan Resources", url: "https://www.x402scan.com/api/x402/resources", method: "GET", description: "All indexed x402 resources", expectedPrice: "$0.01" },
  { name: "x402scan Facilitators", url: "https://www.x402scan.com/api/x402/facilitators", method: "GET", description: "x402 facilitators with stats", expectedPrice: "$0.01" },
  { name: "StableEnrich Exa Search", url: "https://stableenrich.dev/api/exa/search", method: "POST", description: "Neural search across the web via Exa", expectedPrice: "$0.01" },
  { name: "StableEnrich Firecrawl Scrape", url: "https://stableenrich.dev/api/firecrawl/scrape", method: "POST", description: "Scrape URLs with JS rendering", expectedPrice: "$0.0126" },
  { name: "StableEnrich Apollo People", url: "https://stableenrich.dev/api/apollo/people-search", method: "POST", description: "Apollo people search API", expectedPrice: "$0.02" },
  { name: "AgentCash Send", url: "https://agentcash.dev/api/send", method: "POST", description: "Send USDC on Base/Solana", expectedPrice: "dynamic" },
  { name: "Base RPC", url: "https://mainnet.base.org", method: "POST", description: "Base L2 mainnet RPC", expectedPrice: "free" },
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

function parsePaymentRequired(header: string) {
  try {
    const decoded = atob(header);
    const data = JSON.parse(decoded) as { x402Version?: number; accepts?: Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string }> };
    const accepts = data.accepts ?? [];
    const first = accepts[0] ?? null;
    const network = first ? (NETWORK_NAMES[first.network] ?? first.network) : null;
    const assetSym = first ? (USDC_ASSETS[first.asset.toLowerCase()] ?? null) : null;
    let price: string | null = null;
    if (first && assetSym) {
      const dollars = parseInt(first.amount, 10) / 1_000_000;
      price = `$${dollars.toFixed(dollars < 0.01 ? 6 : 4).replace(/\.?0+$/, "")}`;
    } else if (first) {
      price = first.amount;
    }
    return { version: data.x402Version ?? null, price, priceRaw: first?.amount ?? null, network, networkRaw: first?.network ?? null, asset: first?.asset ?? null, assetSymbol: assetSym, payTo: first?.payTo ?? null, accepts };
  } catch {
    return { version: null, price: null, priceRaw: null, network: null, networkRaw: null, asset: null, assetSymbol: null, payTo: null, accepts: [] };
  }
}

async function checkEndpoint(url: string, method: string) {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const isPost = method.toUpperCase() === "POST";
    const res = await fetch(url, {
      method: method.toUpperCase(),
      signal: controller.signal,
      headers: { "User-Agent": "x402-canary/1.0", ...(isPost ? { "Content-Type": "application/json" } : {}) },
      ...(isPost ? { body: "{}" } : {}),
    });
    clearTimeout(timer);
    const responseTimeMs = Date.now() - start;
    if (res.status === 402) {
      const paymentHeader = res.headers.get("payment-required");
      return { status: 402, responseTimeMs, timestamp, isHealthy: true, isX402: true, x402Details: paymentHeader ? parsePaymentRequired(paymentHeader) : null, error: undefined };
    }
    return { status: res.status, responseTimeMs, timestamp, isHealthy: res.status < 500, isX402: false, x402Details: undefined, error: undefined };
  } catch (err) {
    return { status: null, responseTimeMs: Date.now() - start, timestamp, isHealthy: false, isX402: false, x402Details: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const check = await checkEndpoint(ep.url, ep.method);
      return {
        url: ep.url,
        name: ep.name,
        description: ep.description,
        expectedPrice: ep.expectedPrice,
        lastChecked: check.timestamp,
        lastStatus: check.status,
        responseTimeMs: check.responseTimeMs,
        isHealthy: check.isHealthy,
        isX402: check.isX402,
        x402Details: check.x402Details ?? null,
        error: check.error ?? null,
      };
    })
  );

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.json({ endpoints: results, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  }
}
