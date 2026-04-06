import type { VercelRequest, VercelResponse } from "@vercel/node";

const ENDPOINTS = [
  { name: "x402scan Merchants", url: "https://www.x402scan.com/api/x402/merchants", method: "GET" },
  { name: "x402scan Resources", url: "https://www.x402scan.com/api/x402/resources", method: "GET" },
  { name: "StableEnrich Exa Search", url: "https://stableenrich.dev/api/exa/search", method: "POST" },
  { name: "StableEnrich Apollo People", url: "https://stableenrich.dev/api/apollo/people-search", method: "POST" },
  { name: "AgentCash", url: "https://agentcash.dev/api/send", method: "POST" },
  { name: "Base RPC", url: "https://mainnet.base.org", method: "POST" },
];

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
          x402Details = JSON.parse(Buffer.from(header, "base64").toString());
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
