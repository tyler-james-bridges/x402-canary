import type { VercelRequest, VercelResponse } from "@vercel/node";

import { createPublicEvidenceStatus } from "../src/public-evidence-status.js";

const METHOD_ERROR = {
  error: {
    code: "METHOD_NOT_ALLOWED",
    message: "Evidence status supports GET, HEAD, and OPTIONS only.",
  },
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
    return res.status(405).json(METHOD_ERROR);
  }

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  return res.status(200).json(
    createPublicEvidenceStatus({
      environment: process.env.VERCEL_ENV,
      gitCommitSha: process.env.VERCEL_GIT_COMMIT_SHA,
      servedAt: new Date().toISOString(),
    }),
  );
}
