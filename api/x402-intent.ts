import type { VercelRequest, VercelResponse } from "@vercel/node";

import {
  collectBaseTransactionObservation,
  type BaseTransactionObservationRequest,
  type BaseTransactionObservationV01,
} from "../src/evidence/base-transaction.js";
import {
  PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  createPublicBaseTransactionRpcRuntime,
} from "../src/public-base-transaction-config.js";
import { createPublicBaseTransactionResponse } from "../src/public-base-transaction.js";
import {
  PUBLIC_X402_INTENT_MAX_WIRE_BODY_BYTES,
  PublicX402IntentRequestError,
  createPublicX402IntentResponse,
  evaluatePublicX402Intent,
  parsePublicX402IntentRequest,
} from "../src/public-x402-intent.js";

const METHOD_NOT_ALLOWED = {
  error: {
    code: "METHOD_NOT_ALLOWED",
    message: "x402 requirement verification supports POST only.",
  },
  status: "invalid",
} as const;

const VERIFICATION_UNAVAILABLE = {
  error: {
    code: "VERIFICATION_UNAVAILABLE",
    message: "Fixed-source Base verification is temporarily unavailable.",
  },
  status: "unavailable",
} as const;

type RuntimeCollector = (
  request: BaseTransactionObservationRequest,
  signal: AbortSignal,
) => Promise<BaseTransactionObservationV01>;

export interface X402IntentHandlerDependencies {
  collect: RuntimeCollector;
  now: () => Date;
}

const productionDependencies: X402IntentHandlerDependencies = {
  collect: async (request, signal) => {
    const runtime = createPublicBaseTransactionRpcRuntime(signal);
    return collectBaseTransactionObservation(
      runtime.registry,
      runtime.requester,
      request,
    );
  },
  now: () => new Date(),
};

const MAX_IN_FLIGHT_HASHES = 64;

interface InFlightObservation {
  checkedAt: string;
  promise: Promise<BaseTransactionObservationV01>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAllowedRequestContext(req: VercelRequest): boolean {
  const fetchSite = singleHeader(req.headers["sec-fetch-site"]);
  if (fetchSite === "cross-site") return false;
  const origin = singleHeader(req.headers.origin);
  if (origin === undefined) return true;
  const host =
    singleHeader(req.headers["x-forwarded-host"]) ?? singleHeader(req.headers.host);
  const protocol = singleHeader(req.headers["x-forwarded-proto"]) ?? "https";
  if (host === undefined || (protocol !== "https" && protocol !== "http")) return false;
  return origin === `${protocol}://${host}`;
}

function hasJsonContentType(req: VercelRequest): boolean {
  const contentType = singleHeader(req.headers["content-type"]);
  return (
    contentType !== undefined &&
    /^application\/json(?:\s*;\s*charset=(?:utf-8|UTF-8))?$/.test(contentType)
  );
}

function wireBodyWithinLimit(req: VercelRequest): boolean {
  const contentLength = singleHeader(req.headers["content-length"]);
  if (contentLength === undefined) return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) return false;
  const length = Number(contentLength);
  return Number.isSafeInteger(length) && length <= PUBLIC_X402_INTENT_MAX_WIRE_BODY_BYTES;
}

async function collectWithinDeadline(
  dependencies: X402IntentHandlerDependencies,
  request: BaseTransactionObservationRequest,
): Promise<BaseTransactionObservationV01> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("PUBLIC_X402_INTENT_DEADLINE")),
    PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  );
  timeout.unref?.();
  try {
    return await dependencies.collect(request, controller.signal);
  } finally {
    clearTimeout(timeout);
    if (!controller.signal.aborted) {
      controller.abort(new Error("PUBLIC_X402_INTENT_COLLECTION_COMPLETE"));
    }
  }
}

function setCommonHeaders(res: VercelResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function invalidResponse(error: PublicX402IntentRequestError) {
  const intentError =
    error.code.startsWith("PAYMENT_REQUIREMENTS_") ||
    error.code === "X402_VERSION_UNSUPPORTED";
  return {
    error: {
      code: intentError ? "INVALID_INTENT" : "INVALID_REQUEST",
      reason: error.code,
      message: intentError
        ? "Provide one supported x402 v2 exact Base native-USDC EIP-3009 PaymentRequirements object."
        : "Provide one bounded JSON request with x402Version, transactionHash, and paymentRequirements.",
    },
    status: "invalid",
  } as const;
}

export function createX402IntentHandler(
  dependencies: X402IntentHandlerDependencies = productionDependencies,
) {
  const inFlight = new Map<string, InFlightObservation>();

  function startOrJoinObservation(
    transactionHash: string,
    requestedAt: string,
  ): InFlightObservation {
    const existing = inFlight.get(transactionHash);
    if (existing !== undefined) return existing;
    if (inFlight.size >= MAX_IN_FLIGHT_HASHES) {
      throw new Error("PUBLIC_X402_INTENT_BUSY");
    }
    const request = { transactionHash, checkedAt: requestedAt };
    const flight: InFlightObservation = {
      checkedAt: requestedAt,
      promise: collectWithinDeadline(dependencies, request),
    };
    inFlight.set(transactionHash, flight);
    const clear = () => {
      if (inFlight.get(transactionHash) === flight) inFlight.delete(transactionHash);
    };
    void flight.promise.then(clear, clear);
    return flight;
  }

  return async function handler(req: VercelRequest, res: VercelResponse) {
    setCommonHeaders(res);
    try {
      if (!isAllowedRequestContext(req)) {
        throw new PublicX402IntentRequestError("REQUEST_CONTEXT_INVALID", 400);
      }
      if (req.method === "POST" && !hasJsonContentType(req)) {
        throw new PublicX402IntentRequestError("CONTENT_TYPE_INVALID", 400);
      }
      if (!wireBodyWithinLimit(req)) {
        throw new PublicX402IntentRequestError("REQUEST_BODY_TOO_LARGE", 413);
      }

      const parsed = parsePublicX402IntentRequest({
        method: req.method,
        url: req.url,
        query: req.query,
        body: req.body,
      });
      const requestedAt = dependencies.now().toISOString();
      const flight = startOrJoinObservation(parsed.transactionHash, requestedAt);
      const observation = await flight.promise;
      const base = createPublicBaseTransactionResponse(
        observation,
        parsed.transactionHash,
        flight.checkedAt,
      );
      const evaluation = evaluatePublicX402Intent(parsed, observation);
      const response = createPublicX402IntentResponse(parsed, base, evaluation);
      return res.status(200).json(response);
    } catch (error) {
      if (error instanceof PublicX402IntentRequestError) {
        if (error.statusCode === 405) {
          res.setHeader("Allow", "POST");
          return res.status(405).json(METHOD_NOT_ALLOWED);
        }
        return res.status(error.statusCode).json(invalidResponse(error));
      }
      return res.status(503).json(VERIFICATION_UNAVAILABLE);
    }
  };
}

export default createX402IntentHandler();
