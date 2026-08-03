import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const DEFAULT_PORT = 3402;
const DASHBOARD_HOST = "127.0.0.1";
const PUBLIC_DIR = path.join(process.cwd(), "public");

const CONTAINMENT_STATUS = {
  service: "x402-canary",
  status: "contained",
  publicOutboundMonitoring: false,
  publicProbeRoutes: "disabled",
  outboundRequestsMade: 0,
} as const;

const DISABLED_RESPONSE = {
  error: {
    code: "PUBLIC_PROBE_DISABLED",
    message: "Caller-selected outbound checks are disabled. No target request was made.",
  },
  status: "gone",
  outboundRequestsMade: 0,
} as const;

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveFile(
  res: http.ServerResponse,
  fileName: "index.html" | "llms.txt",
  contentType: string,
): void {
  try {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, fileName), "utf8");
    res.writeHead(200, { "Content-Type": contentType });
    res.end(source);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Could not load local containment page");
  }
}

export function createDashboardServer(): http.Server {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = requestUrl.pathname;

    if (route === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Cache-Control": "no-store" });
        res.end();
      } else {
        jsonResponse(res, 200, CONTAINMENT_STATUS);
      }
      return;
    }

    if (
      (route === "/api/preflight" || route === "/api/trust" || route === "/api/x402-summary") &&
      req.method === "OPTIONS"
    ) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    if (route === "/llms.txt" && req.method === "GET") {
      serveFile(res, "llms.txt", "text/plain; charset=utf-8");
      return;
    }

    if (route === "/" && req.method === "GET") {
      serveFile(res, "index.html", "text/html; charset=utf-8");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
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
