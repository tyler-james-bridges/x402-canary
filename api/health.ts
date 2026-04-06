import type { VercelRequest, VercelResponse } from "@vercel/node";
import { endpoints, checkEndpoint } from "./_lib";

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
