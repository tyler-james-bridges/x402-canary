import type { VercelRequest, VercelResponse } from "@vercel/node";
import { endpoints, checkEndpoint } from "./_lib";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const check = await checkEndpoint(ep.url, ep.method);
      return { ep, check };
    })
  );

  const x402 = results.filter((r) => r.check.isX402);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    totalEndpoints: endpoints.length,
    x402Count: x402.length,
    endpoints: x402.map(({ ep, check }) => ({
      url: ep.url,
      name: ep.name,
      x402Details: check.x402Details ?? { price: null, network: null, token: null, payTo: null, version: null },
      lastChecked: check.timestamp,
    })),
    generatedAt: new Date().toISOString(),
  });
}
