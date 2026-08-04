import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { collectBaseTransactionObservation } from "./evidence/base-transaction.js";
import {
  PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  createPublicBaseTransactionRpcRuntime,
} from "./public-base-transaction-config.js";
import {
  PublicBaseTransactionRequestError,
  verifyPublicBaseTransaction,
} from "./public-base-transaction.js";
import { createPublicEvidenceStatus } from "./public-evidence-status.js";
import { PUBLIC_HEALTH_STATUS } from "./public-health.js";

const DEFAULT_PORT = 3402;
const DASHBOARD_HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(process.cwd(), "public");

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const PUBLIC_ASSETS = new Map<
  string,
  readonly [
    | "index.html"
    | "llms.txt"
    | "styles.css"
    | "app.js"
    | "og.png"
    | "og-live-verifier.png",
    string,
  ]
>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/llms.txt", ["llms.txt", "text/plain; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/og.png", ["og.png", "image/png"]],
  ["/og-live-verifier.png", ["og-live-verifier.png", "image/png"]],
]);

const DISABLED_RESPONSE = {
  error: {
    code: "PUBLIC_PROBE_DISABLED",
    message: "Caller-selected outbound checks are disabled. No target request was made.",
  },
  status: "gone",
  outboundRequestsMade: 0,
} as const;

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  head = false,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(head ? undefined : JSON.stringify(data, null, 2));
}

function sameOriginJsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveFile(
  res: http.ServerResponse,
  fileName:
    | "index.html"
    | "llms.txt"
    | "styles.css"
    | "app.js"
    | "og.png"
    | "og-live-verifier.png",
  contentType: string,
  head = false,
): void {
  try {
    const source = fs.readFileSync(
      path.join(PUBLIC_DIR, fileName),
      fileName === "og.png" || fileName === "og-live-verifier.png" ? undefined : "utf8",
    );
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    res.end(head ? undefined : source);
  } catch {
    res.writeHead(500, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Could not load local containment page");
  }
}

function localQuery(requestUrl: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of requestUrl.searchParams) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return query;
}

function localRequestHasBody(req: http.IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  return (
    (contentLength !== undefined && contentLength !== "0") ||
    req.headers["transfer-encoding"] !== undefined
  );
}

function localRequestContextAllowed(req: http.IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return typeof req.headers.host === "string" && origin === `http://${req.headers.host}`;
}

async function handleLocalBaseTransaction(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (!localRequestContextAllowed(req)) {
    sameOriginJsonResponse(res, 400, {
      error: { code: "INVALID_REQUEST", message: "Invalid verifier request." },
    });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("PUBLIC_BASE_TRANSACTION_DEADLINE")),
    PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  );
  timeout.unref?.();
  const abort = () => controller.abort(new Error("CLIENT_ABORTED"));
  req.once("aborted", abort);
  try {
    const result = await verifyPublicBaseTransaction(
      {
        method: req.method,
        url: req.url,
        query: localQuery(requestUrl),
        hasBody: localRequestHasBody(req),
      },
      async (request) => {
        const runtime = createPublicBaseTransactionRpcRuntime(controller.signal);
        return collectBaseTransactionObservation(
          runtime.registry,
          runtime.requester,
          request,
        );
      },
      new Date().toISOString(),
    );
    sameOriginJsonResponse(res, 200, result);
  } catch (error) {
    if (error instanceof PublicBaseTransactionRequestError) {
      if (error.statusCode === 405) res.setHeader("Allow", "GET");
      sameOriginJsonResponse(res, error.statusCode, {
        error: {
          code: error.statusCode === 405 ? "METHOD_NOT_ALLOWED" : "INVALID_REQUEST",
          message:
            error.statusCode === 405
              ? "Base transaction verification supports GET only."
              : "Provide exactly one lowercase Base transaction hash and no request body.",
        },
      });
      return;
    }
    sameOriginJsonResponse(res, 503, {
      error: {
        code: "VERIFICATION_UNAVAILABLE",
        message: "Fixed-source Base verification is temporarily unavailable.",
      },
    });
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abort);
  }
}

export function createDashboardServer(): http.Server {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = requestUrl.pathname;

    if (route === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
      jsonResponse(res, 200, PUBLIC_HEALTH_STATUS, req.method === "HEAD");
      return;
    }

    if (route === "/api/health" && req.method === "OPTIONS") {
      res.writeHead(204, {
        ...SECURITY_HEADERS,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (route === "/api/health") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      jsonResponse(res, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "This status endpoint supports GET and HEAD only.",
        },
        outboundRequestsMade: 0,
      });
      return;
    }

    if (
      route === "/api/evidence-status" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {
      jsonResponse(
        res,
        200,
        createPublicEvidenceStatus({
          environment: "local",
          gitCommitSha: null,
          servedAt: new Date().toISOString(),
        }),
        req.method === "HEAD",
      );
      return;
    }

    if (
      route === "/api/evidence-status" &&
      req.method === "OPTIONS"
    ) {
      res.writeHead(204, {
        ...SECURITY_HEADERS,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (route === "/api/evidence-status") {
      res.setHeader("Allow", "GET, HEAD, OPTIONS");
      jsonResponse(res, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "This evidence status endpoint supports GET and HEAD only.",
        },
      });
      return;
    }

    if (route === "/api/base-transaction") {
      void handleLocalBaseTransaction(req, res, requestUrl);
      return;
    }

    if (
      (route === "/api/preflight" ||
        route === "/api/trust" ||
        route === "/api/x402-summary") &&
      req.method === "OPTIONS"
    ) {
      res.writeHead(204, {
        ...SECURITY_HEADERS,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    if (route === "/api/preflight" || route === "/api/trust" || route === "/api/x402-summary") {
      jsonResponse(res, 410, DISABLED_RESPONSE);
      return;
    }

    const asset = PUBLIC_ASSETS.get(route);
    if (asset && (req.method === "GET" || req.method === "HEAD")) {
      serveFile(res, asset[0], asset[1], req.method === "HEAD");
      return;
    }

    res.writeHead(404, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Not found");
  });
}

export interface StartDashboardOptions {
  port?: number;
  log?: boolean;
}

export function startDashboard(options: StartDashboardOptions = {}): http.Server {
  const server = createDashboardServer();
  const port = options.port ?? DEFAULT_PORT;
  server.listen(port, DASHBOARD_HOST, () => {
    if (options.log === false) return;
    const address = server.address() as AddressInfo;
    console.log(`Contained dashboard: http://${DASHBOARD_HOST}:${address.port}`);
  });
  return server;
}
