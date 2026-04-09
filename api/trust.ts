import type { VercelRequest, VercelResponse } from "@vercel/node";

const KNOWN_USDC: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // Base
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // Solana
};

const NETWORK_NAMES: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:1": "Ethereum",
  "eip155:2741": "Abstract",
};

interface X402Accepts {
  scheme?: string;
  network?: string;
  amount?: string | number;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
}

interface X402Header {
  x402Version?: number;
  accepts?: X402Accepts[];
}

interface TrustResult {
  url: string;
  trustScore: number;
  status: string;
  specGrade: string;
  responseTimeMs: number;
  price: string | null;
  pricePosition: string | null;
  recommendation: string;
  checkedAt: string;
}

function scoreToGrade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
}

function responseTimeScore(ms: number): number {
  if (ms < 200) return 100;
  if (ms < 500) return 80;
  if (ms < 1000) return 50;
  return 20;
}

function parsePrice(accepts: X402Accepts[]): { dollars: number; formatted: string } | null {
  const first = accepts[0];
  if (!first?.amount) return null;
  const raw = Number(first.amount);
  if (isNaN(raw) || raw <= 0) return null;
  const assetKey = first.asset ? first.asset.toLowerCase() : "";
  const decimals = Object.keys(KNOWN_USDC).find(k => k.toLowerCase() === assetKey) ? 6 : 6;
  const dollars = raw / Math.pow(10, decimals);
  const formatted = "$" + dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return { dollars, formatted };
}

function pricePosition(dollars: number): string {
  if (dollars < 0.005) return "cheap";
  if (dollars <= 0.02) return "fair";
  return "expensive";
}

function scoreSpecCompliance(status: number, parsed: X402Header | null, accepts: X402Accepts[] | null): number {
  if (status !== 402) return 0;
  let score = 40; // got a 402
  if (!parsed) return score;
  if (typeof parsed.x402Version === "number") score += 10;
  if (accepts && accepts.length > 0) {
    score += 15;
    const a = accepts[0];
    if (a.scheme) score += 5;
    if (a.network) score += 5;
    if (a.amount) score += 5;
    if (a.asset) score += 5;
    if (a.payTo) score += 5;
    if (a.maxTimeoutSeconds) score += 5;
  }
  // Cap at 100
  return Math.min(score, 100);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const rawUrl = req.query["url"];
  const urlParam = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
  const methodParam = (Array.isArray(req.query["method"]) ? req.query["method"][0] : req.query["method"]) || "GET";

  if (!urlParam) {
    return res.status(400).json({ error: "Missing required query parameter: url" });
  }

  let parsed: URL;
  try {
    parsed = new URL(urlParam);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "URL must use http or https protocol" });
  }

  const method = methodParam.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return res.status(400).json({ error: "Invalid method. Allowed: GET, POST, PUT, PATCH, DELETE" });
  }

  const start = Date.now();
  let httpStatus = 0;
  let responseTimeMs = 0;
  let headerParsed: X402Header | null = null;
  let accepts: X402Accepts[] | null = null;
  let reachable = false;

  try {
    const fetchRes = await fetch(urlParam, {
      method,
      headers: { "Content-Type": "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    responseTimeMs = Date.now() - start;
    httpStatus = fetchRes.status;
    reachable = true;

    if (httpStatus === 402) {
      const headerRaw = fetchRes.headers.get("payment-required");
      if (headerRaw) {
        try {
          headerParsed = JSON.parse(Buffer.from(headerRaw, "base64").toString()) as X402Header;
          accepts = headerParsed?.accepts ?? null;
        } catch {
          // malformed header, headerParsed stays null
        }
      }
    }
  } catch {
    responseTimeMs = Date.now() - start;
  }

  // Not an x402 endpoint
  if (reachable && httpStatus !== 402) {
    const result: TrustResult = {
      url: urlParam,
      trustScore: 0,
      status: "not-x402",
      specGrade: "F",
      responseTimeMs,
      price: null,
      pricePosition: null,
      recommendation: "not-an-x402-endpoint",
      checkedAt: new Date().toISOString(),
    };
    res.setHeader("Cache-Control", "s-maxage=30");
    return res.json(result);
  }

  // Calculate component scores
  const specScore = scoreSpecCompliance(httpStatus, headerParsed, accepts);
  const perfScore = reachable ? responseTimeScore(responseTimeMs) : 0;
  const reachScore = reachable ? 100 : 0;

  // Weighted trust score
  const trustScore = Math.round(specScore * 0.6 + perfScore * 0.2 + reachScore * 0.2);

  const priceInfo = accepts ? parsePrice(accepts) : null;

  const status = trustScore >= 70 ? "healthy" : trustScore >= 40 ? "degraded" : "unhealthy";
  const recommendation =
    trustScore >= 80 ? "safe-to-pay" : trustScore >= 50 ? "proceed-with-caution" : "avoid";

  const result: TrustResult = {
    url: urlParam,
    trustScore,
    status,
    specGrade: scoreToGrade(specScore),
    responseTimeMs,
    price: priceInfo?.formatted ?? null,
    pricePosition: priceInfo ? pricePosition(priceInfo.dollars) : null,
    recommendation,
    checkedAt: new Date().toISOString(),
  };

  res.setHeader("Cache-Control", "s-maxage=30");
  return res.json(result);
}
