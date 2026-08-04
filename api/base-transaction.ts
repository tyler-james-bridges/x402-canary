import type { VercelRequest, VercelResponse } from "@vercel/node";

import {
  collectBaseTransactionObservation,
  type BaseTransactionObservationRequest,
  type BaseTransactionObservationV01,
} from "../src/evidence/base-transaction.js";
import {
  PUBLIC_BASE_TRANSACTION_CDN_TTL_SECONDS,
  PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  PUBLIC_BASE_TRANSACTION_TRANSIENT_CDN_TTL_SECONDS,
  createPublicBaseTransactionRpcRuntime,
} from "../src/public-base-transaction-config.js";
import {
  PublicBaseTransactionRequestError,
  parsePublicBaseTransactionRequest,
  verifyPublicBaseTransaction,
} from "../src/public-base-transaction.js";

const INVALID_REQUEST = {
  error: {
    code: "INVALID_REQUEST",
    message:
      "Provide exactly one lowercase Base transaction hash in the transactionHash query parameter and no request body.",
  },
} as const;

const METHOD_NOT_ALLOWED = {
  error: {
    code: "METHOD_NOT_ALLOWED",
    message: "Base transaction verification supports GET only.",
  },
} as const;

const VERIFICATION_UNAVAILABLE = {
  error: {
    code: "VERIFICATION_UNAVAILABLE",
    message: "Fixed-source Base verification is temporarily unavailable.",
  },
} as const;

type RuntimeCollector = (
  request: BaseTransactionObservationRequest,
  signal: AbortSignal,
) => Promise<BaseTransactionObservationV01>;

export interface BaseTransactionHandlerDependencies {
  collect: RuntimeCollector;
  now: () => Date;
}

const productionDependencies: BaseTransactionHandlerDependencies = {
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

function hasRequestBody(req: VercelRequest): boolean {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && contentLength !== "0") return true;
  if (req.headers["transfer-encoding"] !== undefined) return true;
  if (typeof req.readableLength === "number" && req.readableLength > 0) return true;
  try {
    return req.body !== undefined;
  } catch {
    return true;
  }
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

async function collectWithinDeadline(
  dependencies: BaseTransactionHandlerDependencies,
  request: BaseTransactionObservationRequest,
): Promise<BaseTransactionObservationV01> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("PUBLIC_BASE_TRANSACTION_DEADLINE")),
    PUBLIC_BASE_TRANSACTION_DEADLINE_MS,
  );
  timeout.unref?.();
  try {
    return await dependencies.collect(request, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

function setCommonHeaders(res: VercelResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function setNoStore(res: VercelResponse): void {
  res.setHeader("Cache-Control", "no-store");
}

export function createBaseTransactionHandler(
  dependencies: BaseTransactionHandlerDependencies = productionDependencies,
) {
  const inFlight = new Map<string, InFlightObservation>();

  function startOrJoinObservation(
    request: BaseTransactionObservationRequest,
  ): InFlightObservation {
    const existing = inFlight.get(request.transactionHash);
    if (existing !== undefined) return existing;
    if (inFlight.size >= MAX_IN_FLIGHT_HASHES) {
      throw new Error("PUBLIC_BASE_TRANSACTION_BUSY");
    }
    const flight: InFlightObservation = {
      checkedAt: request.checkedAt,
      promise: collectWithinDeadline(dependencies, request),
    };
    inFlight.set(request.transactionHash, flight);
    const clear = () => {
      if (inFlight.get(request.transactionHash) === flight) {
        inFlight.delete(request.transactionHash);
      }
    };
    void flight.promise.then(clear, clear);
    return flight;
  }

  return async function handler(req: VercelRequest, res: VercelResponse) {
    setCommonHeaders(res);

    try {
      if (!isAllowedRequestContext(req)) {
        setNoStore(res);
        return res.status(400).json(INVALID_REQUEST);
      }
      const httpRequest = {
        method: req.method,
        url: req.url,
        query: req.query,
        hasBody: hasRequestBody(req),
      };
      const requestedAt = dependencies.now().toISOString();
      const transactionHash = parsePublicBaseTransactionRequest(httpRequest);
      const flight = startOrJoinObservation({ transactionHash, checkedAt: requestedAt });
      const response = await verifyPublicBaseTransaction(
        httpRequest,
        (request) => {
          if (
            request.transactionHash !== transactionHash ||
            request.checkedAt !== flight.checkedAt
          ) {
            throw new Error("PUBLIC_BASE_TRANSACTION_FLIGHT_BINDING_INVALID");
          }
          return flight.promise;
        },
        flight.checkedAt,
      );
      if (response.status === "contradiction") {
        setNoStore(res);
      } else {
        const ttlSeconds =
          response.status === "pending_finality" ||
          response.status === "not_observed"
            ? PUBLIC_BASE_TRANSACTION_TRANSIENT_CDN_TTL_SECONDS
            : PUBLIC_BASE_TRANSACTION_CDN_TTL_SECONDS;
        res.setHeader(
          "Cache-Control",
          `public, max-age=0, s-maxage=${ttlSeconds}, must-revalidate`,
        );
      }
      return res.status(200).json(response);
    } catch (error) {
      setNoStore(res);
      if (error instanceof PublicBaseTransactionRequestError) {
        if (error.statusCode === 405) {
          res.setHeader("Allow", "GET");
          return res.status(405).json(METHOD_NOT_ALLOWED);
        }
        return res.status(400).json(INVALID_REQUEST);
      }
      return res.status(503).json(VERIFICATION_UNAVAILABLE);
    }
  };
}

export default createBaseTransactionHandler();
