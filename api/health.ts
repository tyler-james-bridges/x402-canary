import type { VercelRequest, VercelResponse } from "@vercel/node";

import { PUBLIC_HEALTH_STATUS } from "../src/public-health.js";

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
      requestOutboundReadsMade: 0,
    });
  }

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  return res.status(200).json(PUBLIC_HEALTH_STATUS);
}
