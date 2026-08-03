import type { VercelRequest, VercelResponse } from "@vercel/node";

const STATUS = {
  service: "x402-canary",
  status: "contained",
  publicOutboundMonitoring: false,
  publicProbeRoutes: "disabled",
  outboundRequestsMade: 0,
} as const;

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "This status endpoint supports GET and HEAD only.",
      },
      outboundRequestsMade: 0,
    });
  }

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  return res.status(200).json(STATUS);
}
