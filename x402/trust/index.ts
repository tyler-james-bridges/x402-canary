const KNOWN_USDC: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6,
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
  const dollars = raw / 1_000_000;
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
  let score = 40;
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
  return Math.min(score, 100);
}

export default async function handler(req: Request): Promise<Response> {
  const reqUrl = new URL(req.url);
  const urlParam = reqUrl.searchParams.get("url");
  const methodParam = (reqUrl.searchParams.get("method") || "GET").toUpperCase();

  if (!urlParam) {
    return Response.json({ error: "Missing required query parameter: url" }, { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400 });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return Response.json({ error: "URL must use http or https protocol" }, { status: 400 });
  }

  const start = Date.now();
  let httpStatus = 0;
  let responseTimeMs = 0;
  let headerParsed: X402Header | null = null;
  let accepts: X402Accepts[] | null = null;
  let reachable = false;

  try {
    const fetchRes = await fetch(urlParam, {
      method: methodParam,
      headers: { "Content-Type": "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(methodParam) ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    responseTimeMs = Date.now() - start;
    httpStatus = fetchRes.status;
    reachable = true;

    if (httpStatus === 402) {
      const headerRaw = fetchRes.headers.get("payment-required");
      if (headerRaw) {
        try {
          const decoded = Buffer.from(headerRaw, "base64").toString();
          headerParsed = JSON.parse(decoded) as X402Header;
          accepts = headerParsed?.accepts ?? null;
        } catch {
          // malformed header
        }
      }
    }
  } catch {
    responseTimeMs = Date.now() - start;
  }

  if (reachable && httpStatus !== 402) {
    return Response.json({
      url: urlParam,
      trustScore: 0,
      status: "not-x402",
      specGrade: "F",
      responseTimeMs,
      price: null,
      pricePosition: null,
      recommendation: "not-an-x402-endpoint",
      checkedAt: new Date().toISOString(),
    });
  }

  const specScore = scoreSpecCompliance(httpStatus, headerParsed, accepts);
  const perfScore = reachable ? responseTimeScore(responseTimeMs) : 0;
  const reachScore = reachable ? 100 : 0;
  const trustScore = Math.round(specScore * 0.6 + perfScore * 0.2 + reachScore * 0.2);

  const priceInfo = accepts ? parsePrice(accepts) : null;
  const status = trustScore >= 70 ? "healthy" : trustScore >= 40 ? "degraded" : "unhealthy";
  const recommendation = trustScore >= 80 ? "safe-to-pay" : trustScore >= 50 ? "proceed-with-caution" : "avoid";

  return Response.json({
    url: urlParam,
    trustScore,
    status,
    specGrade: scoreToGrade(specScore),
    responseTimeMs,
    price: priceInfo?.formatted ?? null,
    pricePosition: priceInfo ? pricePosition(priceInfo.dollars) : null,
    recommendation,
    checkedAt: new Date().toISOString(),
  });
}
