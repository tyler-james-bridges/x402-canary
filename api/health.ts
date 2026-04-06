import type { VercelRequest, VercelResponse } from "@vercel/node";

const ENDPOINTS = [
  { name: "x402scan Merchants", url: "https://www.x402scan.com/api/x402/merchants", method: "GET", description: "x402 merchant registry" },
  { name: "x402scan Resources", url: "https://www.x402scan.com/api/x402/resources", method: "GET", description: "x402 resource registry" },
  { name: "StableEnrich Exa Search", url: "https://stableenrich.dev/api/exa/search", method: "POST", description: "AI-powered web search" },
  { name: "StableEnrich Apollo People", url: "https://stableenrich.dev/api/apollo/people-search", method: "POST", description: "People data enrichment" },
  { name: "AgentCash", url: "https://agentcash.dev/api/send", method: "POST", description: "Agent-to-agent payments" },
  { name: "Base RPC", url: "https://mainnet.base.org", method: "POST", description: "Base L2 JSON-RPC" },
  { name: "Giga API", url: "https://stableclaude.dev/api/start", method: "POST", description: "Pay-per-run AI agent execution" },
  { name: "dTelecom x402", url: "https://x402.dtelecom.org/v1/credits/purchase", method: "POST", description: "WebRTC/STT/TTS for AI agents" },
];

function normalizeX402(raw: any): { price: string; network: string; token: string; version: string } | null {
  if (!raw) return null;
  const accept = (raw.accepts && raw.accepts[0]) || raw;
  let price = "";
  const maxAmount = accept.maxAmountRequired;
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
