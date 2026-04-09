import type { VercelRequest, VercelResponse } from "@vercel/node";

const VALID_NETWORKS = [
  "eip155:8453",
  "eip155:1",
  "eip155:2741",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
];

const KNOWN_USDC: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "Base",
  epjfwdd5aufqssqem2qn1xzybapC8G4wEGGkZwyTDt1v: "Solana",
};

const NETWORK_NAMES: Record<string, string> = {
  "eip155:8453": "Base",
  "eip155:1": "Ethereum",
  "eip155:2741": "Abstract",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
};

interface CheckDetails {
  returns402: boolean;
  hasPaymentRequiredHeader: boolean;
  headerIsValidBase64Json: boolean;
  hasX402Version: boolean;
  hasAcceptsArray: boolean;
  acceptsNotEmpty: boolean;
  schemeValid: boolean;
  networkValid: boolean;
  amountPresent: boolean;
  amountFormat: boolean;
  assetPresent: boolean;
  payToPresent: boolean;
  payToIsAddress: boolean;
  maxTimeoutSecondsPresent: boolean;
  issues: string[];
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

function benchmarkResponse(ms: number): string {
  if (ms < 200) return "fast";
  if (ms <= 500) return "normal";
  if (ms <= 1000) return "slow";
  return "very-slow";
}

function isAddress(value: string): boolean {
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return true;
  return false;
}

interface X402Headers {
  price: string | null;
  currency: string | null;
  network: string | null;
  payee: string | null;
}

function runChecks(
  status: number,
  headerRaw: string | null,
  x402Headers?: X402Headers
): { details: CheckDetails; decoded: any | null } {
  const issues: string[] = [];
  const details: CheckDetails = {
    returns402: false,
    hasPaymentRequiredHeader: false,
    headerIsValidBase64Json: false,
    hasX402Version: false,
    hasAcceptsArray: false,
    acceptsNotEmpty: false,
    schemeValid: false,
    networkValid: false,
    amountPresent: false,
    amountFormat: false,
    assetPresent: false,
    payToPresent: false,
    payToIsAddress: false,
    maxTimeoutSecondsPresent: false,
    issues,
  };

  details.returns402 = status === 402;
  if (!details.returns402) {
    issues.push(`Expected HTTP 402, got ${status}`);
    return { details, decoded: null };
  }

  details.hasPaymentRequiredHeader = headerRaw !== null;
  if (!details.hasPaymentRequiredHeader) {
    if (x402Headers?.price) {
      issues.push("Missing base64 payment-required header (X-402-* headers present as fallback)");
    } else {
      issues.push("Missing payment-required header");
      return { details, decoded: null };
    }
  }

  let decoded: any = null;
  try {
    decoded = JSON.parse(Buffer.from(headerRaw!, "base64").toString());
    details.headerIsValidBase64Json = true;
  } catch {
    issues.push("payment-required header is not valid base64-encoded JSON");
    return { details, decoded: null };
  }

  details.hasX402Version =
    decoded.x402Version !== undefined && typeof decoded.x402Version === "number";
  if (!details.hasX402Version) {
    issues.push("Missing or invalid x402Version (expected number)");
  }

  details.hasAcceptsArray = Array.isArray(decoded.accepts);
  if (!details.hasAcceptsArray) {
    issues.push("Missing or invalid accepts (expected array)");
    return { details, decoded };
  }

  details.acceptsNotEmpty = decoded.accepts.length > 0;
  if (!details.acceptsNotEmpty) {
    issues.push("accepts array is empty");
    return { details, decoded };
  }

  const first = decoded.accepts[0];

  details.schemeValid =
    typeof first.scheme === "string" && first.scheme.length > 0;
  if (!details.schemeValid) {
    issues.push("Missing or empty scheme in accepts[0]");
  }

  details.networkValid =
    typeof first.network === "string" &&
    VALID_NETWORKS.includes(first.network);
  if (!details.networkValid) {
    issues.push(
      `Invalid or unrecognized network: ${first.network || "(missing)"}`
    );
  }

  details.amountPresent = first.amount !== undefined;
  if (!details.amountPresent) {
    issues.push("Missing amount");
  }

  details.amountFormat =
    typeof first.amount === "string" &&
    /^\d+$/.test(first.amount);
  if (details.amountPresent && !details.amountFormat) {
    issues.push(
      "amount should be a string of digits (atomic units)"
    );
  }

  details.assetPresent =
    typeof first.asset === "string" && first.asset.length > 0;
  if (!details.assetPresent) {
    issues.push("Missing asset address");
  }

  details.payToPresent =
    typeof first.payTo === "string" && first.payTo.length > 0;
  if (!details.payToPresent) {
    issues.push("Missing payTo address");
  }

  details.payToIsAddress =
    details.payToPresent && isAddress(first.payTo);
  if (details.payToPresent && !details.payToIsAddress) {
    issues.push("payTo does not look like a valid address");
  }

  details.maxTimeoutSecondsPresent =
    typeof first.maxTimeoutSeconds === "number" &&
    first.maxTimeoutSeconds > 0;
  if (!details.maxTimeoutSecondsPresent) {
    issues.push("Missing or invalid maxTimeoutSeconds (expected positive number)");
  }

  return { details, decoded };
}

function computeScore(details: CheckDetails): number {
  const checks = [
    details.returns402,
    details.hasPaymentRequiredHeader,
    details.headerIsValidBase64Json,
    details.hasX402Version,
    details.hasAcceptsArray,
    details.acceptsNotEmpty,
    details.schemeValid,
    details.networkValid,
    details.amountPresent,
    details.amountFormat,
    details.assetPresent,
    details.payToPresent,
    details.payToIsAddress,
    details.maxTimeoutSecondsPresent,
  ];
  const passing = checks.filter(Boolean).length;
  return Math.round((passing / checks.length) * 100);
}

function buildPricing(decoded: any | null): {
  price: string;
  priceRaw: string;
  network: string;
  asset: string;
  position: string;
  note: string;
} | null {
  if (!decoded?.accepts?.[0]) return null;
  const first = decoded.accepts[0];
  const raw = first.amount;
  if (!raw || !/^\d+$/.test(String(raw))) return null;

  const atomicUnits = BigInt(raw);
  const dollars = Number(atomicUnits) / 1_000_000;
  const priceStr = "$" + dollars.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

  const networkName = NETWORK_NAMES[first.network] || first.network || "Unknown";
  const assetKey = (first.asset || "").toLowerCase();
  const assetName = KNOWN_USDC[assetKey] ? "USDC" : first.asset || "Unknown";

  const median = 0.01;
  let position: string;
  let note: string;
  if (dollars < median) {
    position = "below-median";
    note = "Competitively priced";
  } else if (dollars === median) {
    position = "at-median";
    note = "At market median";
  } else {
    position = "above-median";
    note = "Premium pricing";
  }

  return {
    price: priceStr,
    priceRaw: String(raw),
    network: networkName,
    asset: assetName,
    position,
    note,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { url, method: reqMethod } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing required field: url" });
  }

  if (!/^https?:\/\/.+/.test(url)) {
    return res
      .status(400)
      .json({ error: "Invalid url. Must start with http:// or https://" });
  }

  const httpMethod = typeof reqMethod === "string" ? reqMethod.toUpperCase() : "GET";

  let status = 0;
  let headerRaw: string | null = null;
  let x402Headers: X402Headers = { price: null, currency: null, network: null, payee: null };
  let responseTimeMs = 0;
  let fetchError: string | null = null;

  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: httpMethod,
      headers: { "Content-Type": "application/json" },
      body: httpMethod === "GET" || httpMethod === "HEAD" ? undefined : JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    responseTimeMs = Date.now() - start;
    status = response.status;
    headerRaw = response.headers.get("payment-required");
    x402Headers = {
      price: response.headers.get("x-402-price"),
      currency: response.headers.get("x-402-currency"),
      network: response.headers.get("x-402-network"),
      payee: response.headers.get("x-402-payee"),
    };
  } catch (err: any) {
    responseTimeMs = Date.now() - start;
    fetchError = err.name === "TimeoutError" ? "Request timed out (10s)" : err.message;
  }

  if (fetchError) {
    return res.status(200).json({
      grade: "F",
      endpoint: url,
      error: fetchError,
      checks: {
        specCompliance: {
          score: 0,
          grade: "F",
          details: {
            returns402: false,
            hasPaymentRequiredHeader: false,
            headerIsValidBase64Json: false,
            hasX402Version: false,
            hasAcceptsArray: false,
            acceptsNotEmpty: false,
            schemeValid: false,
            networkValid: false,
            amountPresent: false,
            amountFormat: false,
            assetPresent: false,
            payToPresent: false,
            payToIsAddress: false,
            maxTimeoutSecondsPresent: false,
            issues: [fetchError],
          },
        },
        performance: {
          responseTimeMs,
          benchmark: "unreachable",
          percentile: "n/a",
        },
        pricing: null,
      },
      timestamp: new Date().toISOString(),
    });
  }

  const { details, decoded } = runChecks(status, headerRaw, x402Headers);
  const score = computeScore(details);
  const grade = scoreToGrade(score);
  const benchmark = benchmarkResponse(responseTimeMs);

  let percentile = "p50 for this category";
  if (responseTimeMs < 100) percentile = "p25 for this category";
  else if (responseTimeMs < 200) percentile = "p50 for this category";
  else if (responseTimeMs < 500) percentile = "p75 for this category";
  else percentile = "p95 for this category";

  const pricing = buildPricing(decoded);

  res.setHeader("Cache-Control", "s-maxage=10");
  return res.status(200).json({
    grade,
    endpoint: url,
    checks: {
      specCompliance: {
        score,
        grade,
        details,
      },
      performance: {
        responseTimeMs,
        benchmark,
        percentile,
      },
      pricing,
    },
    timestamp: new Date().toISOString(),
  });
}
