import { readFile } from "node:fs/promises";
import type {
  HttpMethod,
  PaidPathContract,
  PaymentNetwork,
  PaymentProtocol,
  PaymentScheme,
} from "./contracts.js";
import {
  BASE_MAINNET_NETWORK,
  BASE_USDC_ASSET,
} from "./contracts.js";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PROTOCOLS = new Set<PaymentProtocol>(["x402"]);
const NETWORKS = new Set<PaymentNetwork>(["base"]);
const SCHEMES = new Set<PaymentScheme>(["exact"]);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ATOMIC_AMOUNT = /^\d+$/;
const USDC_DECIMALS = 1_000_000;
const PAYMENT_HEADERS = new Set([
  "authorization", "payment-signature", "x-payment", "x-payment-signature",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

export function parseContract(value: unknown): PaidPathContract {
  const input = record(value, "Contract");
  const request = record(input["request"], "request");
  const name = input["name"];
  const url = request["url"];
  const method = request["method"];
  const payment = record(input["payment"], "payment");
  const protocol = payment["protocol"];
  const network = payment["network"];
  const scheme = payment["scheme"];
  const networkId = payment["networkId"];
  const asset = payment["asset"];
  const payTo = payment["payTo"];
  const maxAmountAtomic = payment["maxAmountAtomic"];
  const maxAmountUsd = payment["maxAmountUsd"];

  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  if (typeof url !== "string") throw new Error("request.url is required");
  if (new URL(url).protocol !== "https:") throw new Error("request.url must use HTTPS");
  if (typeof method !== "string" || !METHODS.has(method as HttpMethod)) {
    throw new Error("request.method must be GET, POST, PUT, PATCH, or DELETE");
  }
  if (method === "GET" && request["body"] !== undefined) {
    throw new Error("GET contracts must not include a request body");
  }
  if (typeof maxAmountUsd !== "number" || !Number.isFinite(maxAmountUsd) || maxAmountUsd <= 0) {
    throw new Error("payment.maxAmountUsd must be a positive number");
  }
  if (typeof protocol !== "string" || !PROTOCOLS.has(protocol as PaymentProtocol)) {
    throw new Error("payment.protocol must be x402");
  }
  if (typeof network !== "string" || !NETWORKS.has(network as PaymentNetwork)) {
    throw new Error("payment.network must be base");
  }
  if (typeof scheme !== "string" || !SCHEMES.has(scheme as PaymentScheme)) {
    throw new Error("payment.scheme must be exact");
  }
  if (networkId !== BASE_MAINNET_NETWORK) {
    throw new Error(`payment.networkId must be ${BASE_MAINNET_NETWORK}`);
  }
  if (typeof asset !== "string" || asset.toLowerCase() !== BASE_USDC_ASSET) {
    throw new Error(`payment.asset must be native Base USDC (${BASE_USDC_ASSET})`);
  }
  if (
    typeof payTo !== "string" ||
    !EVM_ADDRESS.test(payTo) ||
    payTo.toLowerCase() === ZERO_ADDRESS
  ) {
    throw new Error("payment.payTo must be a nonzero 20-byte EVM address");
  }
  if (
    typeof maxAmountAtomic !== "string" ||
    !ATOMIC_AMOUNT.test(maxAmountAtomic) ||
    BigInt(maxAmountAtomic) <= 0n
  ) {
    throw new Error("payment.maxAmountAtomic must be a positive USDC atomic-unit string");
  }
  const usdAtomic = Math.round(maxAmountUsd * USDC_DECIMALS);
  if (
    !Number.isSafeInteger(usdAtomic) ||
    Math.abs((usdAtomic / USDC_DECIMALS) - maxAmountUsd) > Number.EPSILON ||
    BigInt(usdAtomic) !== BigInt(maxAmountAtomic)
  ) {
    throw new Error("payment.maxAmountUsd must equal payment.maxAmountAtomic at six USDC decimals");
  }

  const headers = request["headers"] === undefined
    ? undefined
    : record(request["headers"], "request.headers");
  if (headers && Object.values(headers).some((header) => typeof header !== "string")) {
    throw new Error("request.headers values must be strings");
  }
  if (headers && Object.keys(headers).some((header) => PAYMENT_HEADERS.has(header.toLowerCase()))) {
    throw new Error("request.headers must not include payment credentials");
  }
  const timeoutMs = request["timeoutMs"];
  if (timeoutMs !== undefined && (
    typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0
  )) {
    throw new Error("request.timeoutMs must be a positive number");
  }
  const delivery = record(input["delivery"], "delivery");
  const jsonPaths = strings(delivery["jsonPaths"], "delivery.jsonPaths");
  if (jsonPaths.length === 0) throw new Error("delivery.jsonPaths must not be empty");
  if (jsonPaths.some((path) => !path.trim())) {
    throw new Error("delivery.jsonPaths entries must not be empty");
  }

  const contract: PaidPathContract = {
    name,
    payment: {
      protocol: protocol as PaymentProtocol,
      network: network as PaymentNetwork,
      scheme: scheme as PaymentScheme,
      networkId: BASE_MAINNET_NETWORK,
      asset,
      payTo,
      maxAmountAtomic,
      maxAmountUsd,
    },
    delivery: { jsonPaths },
    request: {
      url,
      method: method as HttpMethod,
      headers: headers as Record<string, string> | undefined,
      body: request["body"],
      timeoutMs: timeoutMs as number | undefined,
    },
  };

  if (input["corsOrigin"] !== undefined) {
    if (typeof input["corsOrigin"] !== "string") throw new Error("corsOrigin must be a URL");
    new URL(input["corsOrigin"]);
    contract.corsOrigin = input["corsOrigin"];
  }
  if (input["poll"] !== undefined) {
    const poll = record(input["poll"], "poll");
    if (typeof poll["urlPath"] !== "string" || typeof poll["statusPath"] !== "string") {
      throw new Error("poll.urlPath and poll.statusPath are required");
    }
    for (const field of ["intervalMs", "timeoutMs"] as const) {
      const amount = poll[field];
      if (amount !== undefined && (
        typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0
      )) {
        throw new Error(`poll.${field} must be a positive number`);
      }
    }
    const allowedOrigins = poll["allowedOrigins"] === undefined
      ? undefined
      : strings(poll["allowedOrigins"], "poll.allowedOrigins");
    for (const origin of allowedOrigins ?? []) {
      if (new URL(origin).origin !== origin) {
        throw new Error("poll.allowedOrigins entries must be URL origins");
      }
    }
    const pending = strings(poll["pending"], "poll.pending");
    const success = strings(poll["success"], "poll.success");
    const failure = strings(poll["failure"], "poll.failure");
    if ([pending, success, failure].some((states) => states.length === 0)) {
      throw new Error("poll pending, success, and failure states must not be empty");
    }
    const allStates = [...pending, ...success, ...failure].map((state) => state.toLowerCase());
    if (new Set(allStates).size !== allStates.length) {
      throw new Error("poll states must not overlap");
    }
    contract.poll = {
      urlPath: poll["urlPath"],
      statusPath: poll["statusPath"],
      pending,
      success,
      failure,
      allowedOrigins,
      intervalMs: poll["intervalMs"] as number | undefined,
      timeoutMs: poll["timeoutMs"] as number | undefined,
    };
  }
  return contract;
}

export async function loadContract(filePath: string): Promise<PaidPathContract> {
  const source = await readFile(filePath, "utf8");
  return parseContract(JSON.parse(source) as unknown);
}
