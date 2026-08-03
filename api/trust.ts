import type { VercelRequest, VercelResponse } from "@vercel/node";

const DISABLED_RESPONSE = {
  error: {
    code: "PUBLIC_PROBE_DISABLED",
    message:
      "Caller-selected outbound checks are disabled. No target request was made.",
  },
  status: "gone",
  outboundRequestsMade: 0,
} as const;

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return res.status(410).json(DISABLED_RESPONSE);
}
