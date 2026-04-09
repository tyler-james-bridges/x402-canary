import http from "http";
import fs from "fs";
import path from "path";
import { getAllMetrics, getX402Summary } from "./metrics.js";
import { endpoints } from "./endpoints.js";
import { checkEndpoint } from "./canary.js";

const PORT = 3402;
const PUBLIC_DIR = path.join(process.cwd(), "public");

const nameMap = Object.fromEntries(endpoints.map((e) => [e.url, e.name]));

function jsonResponse(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data, null, 2));
}

export function startDashboard(): void {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/api/health" && req.method === "GET") {
      const metrics = getAllMetrics(endpoints.map((e) => e.url));
      const payload = metrics.map((m) => {
        const endpoint = endpoints.find((e) => e.url === m.url);
        return {
          ...m,
          name: endpoint?.name,
          method: endpoint?.method,
          description: endpoint?.description,
          expectedPrice: endpoint?.expectedPrice,
        };
      });
      const online = payload.filter((p) => p.isHealthy).length;
      const x402Enabled = payload.filter((p) => p.isX402).length;
      jsonResponse(res, {
        timestamp: new Date().toISOString(),
        summary: { total: payload.length, online, degraded: payload.length - online, x402Enabled },
        endpoints: payload,
      });
      return;
    }

    if (url === "/api/x402-summary" && req.method === "GET") {
      const summary = getX402Summary(
        endpoints.map((e) => e.url),
        nameMap
      );
      jsonResponse(res, { ...summary, generatedAt: new Date().toISOString() });
      return;
    }

    if (url === "/api/preflight" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { url: targetUrl, method: targetMethod } = JSON.parse(body);
          if (!targetUrl) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required field: url" }));
            return;
          }
          const result = await checkEndpoint(targetUrl, targetMethod || "GET");
          // Minimal preflight response for local testing
          const isSpec = result.isX402;
          jsonResponse(res, {
            grade: isSpec ? "A" : "F",
            endpoint: targetUrl,
            checks: {
              specCompliance: {
                score: isSpec ? 93 : 0,
                grade: isSpec ? "A" : "F",
                details: {
                  returns402: result.status === 402,
                  hasPaymentRequiredHeader: !!result.x402Details,
                  headerIsValidBase64Json: !!result.x402Details,
                  hasX402Version: !!result.x402Details?.version,
                  hasAcceptsArray: (result.x402Details?.accepts?.length ?? 0) > 0,
                  acceptsNotEmpty: (result.x402Details?.accepts?.length ?? 0) > 0,
                  schemeValid: !!result.x402Details?.accepts?.[0]?.scheme,
                  networkValid: !!result.x402Details?.accepts?.[0]?.network,
                  amountPresent: !!result.x402Details?.accepts?.[0]?.amount,
                  amountFormat: true,
                  assetPresent: !!result.x402Details?.asset,
                  payToPresent: !!result.x402Details?.payTo,
                  payToIsAddress: !!result.x402Details?.payTo,
                  maxTimeoutSecondsPresent: !!result.x402Details?.accepts?.[0]?.maxTimeoutSeconds,
                  issues: isSpec ? [] : [`Expected HTTP 402, got ${result.status}`],
                },
              },
              performance: {
                responseTimeMs: result.responseTimeMs,
                benchmark: result.responseTimeMs < 200 ? "fast" : result.responseTimeMs < 500 ? "normal" : "slow",
                percentile: "local test",
              },
              pricing: result.x402Details ? {
                price: result.x402Details.price,
                priceRaw: result.x402Details.priceRaw,
                network: result.x402Details.network,
                asset: result.x402Details.assetSymbol || "USDC",
                position: "at-median",
                note: "Local test",
              } : null,
            },
            timestamp: result.timestamp,
          });
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid request body" }));
        }
      });
      return;
    }

    if (url === "/llms.txt" && req.method === "GET") {
      const txtPath = path.join(PUBLIC_DIR, "llms.txt");
      try {
        const txt = fs.readFileSync(txtPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(txt);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    if (url === "/" && req.method === "GET") {
      const htmlPath = path.join(PUBLIC_DIR, "index.html");
      try {
        const html = fs.readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Could not load dashboard");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`Dashboard:       http://localhost:${PORT}`);
    console.log(`Health API:      http://localhost:${PORT}/api/health`);
    console.log(`x402 Summary:    http://localhost:${PORT}/api/x402-summary`);
  });
}
