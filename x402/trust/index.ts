const RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
} as const;

const DISABLED_RESPONSE = {
  error: {
    code: "PAID_SERVICE_DISABLED",
    message:
      "This paid service is disabled. No target request was made by the handler.",
  },
  status: "gone",
  outboundRequestsMade: 0,
} as const;

export default function handler(req: Request): Response {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: RESPONSE_HEADERS });
  }

  return Response.json(DISABLED_RESPONSE, {
    status: 410,
    headers: RESPONSE_HEADERS,
  });
}
