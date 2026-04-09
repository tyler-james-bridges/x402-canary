import type { VercelRequest, VercelResponse } from "@vercel/node";

const ENDPOINTS = [
  // Bankr x402 Cloud
  { name: "Bankr x402 Lint", url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint", method: "POST", description: "x402 compliance linter via Bankr Cloud" },
  { name: "Bankr x402 Health", url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/health", method: "POST", description: "Quick x402 health check via Bankr Cloud" },
  { name: "LITCOIN Chat", url: "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/chat", method: "POST", description: "OpenAI-compatible LLM inference via x402" },
  { name: "LITCOIN Compute", url: "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/compute", method: "POST", description: "AI inference with pay-per-request, no API keys" },
  { name: "DeFi Yield Compare", url: "https://x402.bankr.bot/0xfa04c7d627ba707a1ad17e72e094b45150665593/yield-compare", method: "GET", description: "Best DeFi yields across 51 protocols ranked by APY" },
  { name: "Trending Base Coins", url: "https://x402.bankr.bot/0xf47535adb19c8905f9384e423063708651ac2805/trending-base-coins", method: "GET", description: "Trending tokens on Base with price and volume data" },
  { name: "Regen Oracle", url: "https://x402.bankr.bot/0x538aa4800ae2bd8e90556899514376ab96113a8e/regen-oracle", method: "POST", description: "Live ecological credit data from Regen Ledger" },
  // x402scan
  { name: "x402scan Merchants", url: "https://www.x402scan.com/api/x402/merchants", method: "GET", description: "Paginated list of merchants by volume" },
  { name: "x402scan Resources", url: "https://www.x402scan.com/api/x402/resources", method: "GET", description: "All indexed x402 resources" },
  { name: "x402scan Facilitators", url: "https://www.x402scan.com/api/x402/facilitators", method: "GET", description: "x402 facilitators with stats" },
  // StableEnrich
  { name: "StableEnrich Exa Search", url: "https://stableenrich.dev/api/exa/search", method: "POST", description: "Neural search across the web via Exa" },
  { name: "StableEnrich Firecrawl Scrape", url: "https://stableenrich.dev/api/firecrawl/scrape", method: "POST", description: "Scrape URLs with JS rendering" },
  { name: "StableEnrich Apollo People", url: "https://stableenrich.dev/api/apollo/people-search", method: "POST", description: "Apollo people search API" },
  // Other
  { name: "AgentCash Send", url: "https://agentcash.dev/api/send", method: "POST", description: "Send USDC on Base/Solana" },
  { name: "Base RPC", url: "https://mainnet.base.org", method: "POST", description: "Base L2 mainnet RPC" },
  { name: "Giga API", url: "https://stableclaude.dev/api/start", method: "POST", description: "Pay-per-run AI agent execution" },
  { name: "dTelecom x402", url: "https://x402.dtelecom.org/v1/credits/purchase", method: "POST", description: "WebRTC/STT/TTS for AI agents" },
];

function normalizeX402(raw: any): { price: string; network: string; token: string; version: string } | null {
  if (!raw) return null;
  const accept = (raw.accepts && raw.accepts[0]) || raw;
  let price = "";
  const maxAmount = accept.amount ?? accept.maxAmountRequired;
  if (maxAmount != null) {
    const n = Number(maxAmount);
    if (!isNaN(n)) {
      price = "$" + (n / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") + " USDC";
    }
  }
  return {
    price,
    network: String(accept.network || ""),
    token: "USDC",
    version: accept.scheme || "x402",
  };
}

async function checkEndpoint(ep: typeof ENDPOINTS[0]) {
  const start = Date.now();
  try {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: { "Content-Type": "application/json" },
      body: ep.method === "POST" ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const elapsed = Date.now() - start;
    let x402Details = null;
    if (res.status === 402) {
      try {
        const header = res.headers.get("payment-required");
        if (header) {
          const decoded = JSON.parse(Buffer.from(header, "base64").toString());
          x402Details = normalizeX402(decoded);
        }
      } catch {}
    }
    return {
      name: ep.name,
      url: ep.url,
      method: ep.method,
      status: res.status,
      responseTimeMs: elapsed,
      isHealthy: res.status < 500,
      isX402: res.status === 402,
      x402Details,
      timestamp: new Date().toISOString(),
    };
  } catch (err: any) {
    return {
      name: ep.name,
      url: ep.url,
      method: ep.method,
      status: 0,
      responseTimeMs: Date.now() - start,
      isHealthy: false,
      isX402: false,
      x402Details: null,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const results = await Promise.all(ENDPOINTS.map(checkEndpoint));
  const online = results.filter((r) => r.isHealthy).length;
  const x402Enabled = results.filter((r) => r.isX402).length;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30");
  return res.json({
    timestamp: new Date().toISOString(),
    summary: { total: results.length, online, degraded: results.length - online, x402Enabled },
    endpoints: results,
  });
}
