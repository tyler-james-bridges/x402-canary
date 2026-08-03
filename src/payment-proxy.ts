import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PaymentContract, RequestContract } from "./contracts.js";
import {
  hasSiwxExtension,
  singleRequirementHeader,
  validatePaymentRequired,
} from "./x402-challenge.js";

export interface ProxyObservations {
  paidResponseCors?: boolean;
  paidResponseCorsDetail?: string;
  redirectBlocked?: boolean;
}

export interface PaymentProxy {
  url: string;
  observations: ProxyObservations;
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection", "content-length", "host", "keep-alive", "transfer-encoding", "upgrade",
]);

function expectedBody(request: RequestContract): string | undefined {
  return request.method === "GET" || request.body === undefined
    ? undefined
    : JSON.stringify(request.body);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body exceeds 2MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function jsonError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

function targetHeaders(incoming: IncomingMessage, request: RequestContract): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (HOP_BY_HOP.has(name) || name === "accept-encoding" || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (expectedBody(request) !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (request.corsOrigin) headers.set("origin", request.corsOrigin);
  return headers;
}

function copyHeaders(upstream: Response, response: ServerResponse): void {
  upstream.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name) || name === "content-encoding") return;
    response.setHeader(name, value);
  });
}

function checkPaidCors(upstream: Response, origin: string): { passed: boolean; detail: string } {
  const allowedOrigin = upstream.headers.get("access-control-allow-origin");
  const exposed = new Set(
    (upstream.headers.get("access-control-expose-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean),
  );
  const allowsOrigin = allowedOrigin === "*" || allowedOrigin === origin;
  const exposesReceipt = exposed.has("*") || exposed.has("payment-response");
  return {
    passed: allowsOrigin && exposesReceipt,
    detail: `origin ${allowedOrigin ?? "missing"}, exposed ${[...exposed].join(",") || "missing"}`,
  };
}

async function proxyRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  request: RequestContract,
  payment: PaymentContract,
  observations: ProxyObservations,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (incoming.method !== request.method) {
    jsonError(response, 405, `Expected ${request.method}, received ${incoming.method ?? "unknown"}`);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(incoming);
  } catch (error) {
    jsonError(response, 413, error instanceof Error ? error.message : String(error));
    return;
  }
  const contractedBody = expectedBody(request);
  if (body.toString("utf8") !== (contractedBody ?? "")) {
    jsonError(response, 400, "AgentCash changed the contracted request body");
    return;
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(request.url, {
      method: request.method,
      headers: targetHeaders(incoming, request),
      body: contractedBody,
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
    });
  } catch (error) {
    jsonError(response, 502, error instanceof Error ? error.message : String(error));
    return;
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    observations.redirectBlocked = true;
    jsonError(response, 502, `Target attempted HTTP ${upstream.status} redirect`);
    return;
  }

  const paymentRequired = upstream.headers.get("payment-required");
  let filteredPaymentRequired: string | undefined;
  if (upstream.status === 402 && paymentRequired) {
    const sentSiwx = Boolean(incoming.headers["sign-in-with-x"]);
    if (!sentSiwx && hasSiwxExtension(paymentRequired)) {
      filteredPaymentRequired = paymentRequired;
    } else {
      const validation = validatePaymentRequired(paymentRequired, payment, request.url);
      if (!validation.ok) {
        jsonError(response, 409, validation.error);
        return;
      }
      filteredPaymentRequired = singleRequirementHeader(validation);
    }
  }

  const sentPayment = Boolean(
    incoming.headers["payment-signature"] ||
    incoming.headers["x-payment"] ||
    incoming.headers["x-payment-signature"],
  );
  if (sentPayment && request.corsOrigin && upstream.status !== 402) {
    const cors = checkPaidCors(upstream, request.corsOrigin);
    observations.paidResponseCors = cors.passed;
    observations.paidResponseCorsDetail = cors.detail;
  }
  copyHeaders(upstream, response);
  if (filteredPaymentRequired) {
    response.setHeader("payment-required", filteredPaymentRequired);
  }
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status);
  response.end(responseBody);
}

export async function startPaymentProxy(
  request: RequestContract,
  payment: PaymentContract,
  fetchImpl: typeof fetch,
): Promise<PaymentProxy> {
  const observations: ProxyObservations = {};
  const server = http.createServer((incoming, response) => {
    void proxyRequest(incoming, response, request, payment, observations, fetchImpl)
      .catch((error) => jsonError(
        response,
        500,
        error instanceof Error ? error.message : String(error),
      ));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    observations,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
