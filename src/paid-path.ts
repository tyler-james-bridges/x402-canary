import type {
  AgentCashResult,
  AgentCashMetadata,
  ContractCheck,
  PaymentEvidence,
  PaidFetcher,
  PaidPathContract,
  RequestContract,
  VerificationResult,
} from "./contracts.js";
import { validatePaymentRequired } from "./x402-challenge.js";

interface VerifyOptions {
  pay: boolean;
  fetch?: typeof fetch;
  paidFetch?: PaidFetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const PAYMENT_HEADERS = new Set([
  "authorization",
  "payment-signature",
  "x-payment",
  "x-payment-signature",
]);

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function requestInit(request: RequestContract): RequestInit {
  if (Object.keys(request.headers ?? {}).some((header) => PAYMENT_HEADERS.has(header.toLowerCase()))) {
    throw new Error("Contract headers must not contain payment credentials");
  }
  const hasBody = request.method !== "GET" && request.body !== undefined;
  const headers = new Headers(request.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (request.corsOrigin) headers.set("origin", request.corsOrigin);
  return {
    method: request.method,
    headers,
    body: hasBody ? JSON.stringify(request.body) : undefined,
    signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    redirect: "manual",
  };
}

function challengeCheck(response: Response, contract: PaidPathContract): ContractCheck {
  if (response.status !== 402) {
    return {
      stage: "challenge",
      passed: false,
      detail: `Expected HTTP 402 without redirect, got HTTP ${response.status}`,
    };
  }
  const validation = validatePaymentRequired(
    response.headers.get("payment-required"),
    contract.payment,
    contract.request.url,
  );
  return {
    stage: "challenge",
    passed: validation.ok,
    detail: validation.ok
      ? "Endpoint returned a valid x402 payment challenge"
      : validation.error,
  };
}

function challengeCorsCheck(response: Response, origin: string): ContractCheck {
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  const exposed = headerTokens(response.headers.get("access-control-expose-headers"));
  const allowsOrigin = allowedOrigin === "*" || allowedOrigin === origin;
  const exposesChallenge = exposed.has("*") || exposed.has("payment-required");
  const passed = allowsOrigin && exposesChallenge;
  return {
    stage: "cors",
    passed,
    detail: passed
      ? "Challenge response exposes Payment-Required to browser clients"
      : `Challenge response CORS failed: origin ${allowedOrigin ?? "missing"}, exposed ${[...exposed].join(",") || "missing"}`,
  };
}

function paymentEvidence(metadata: AgentCashMetadata | null | undefined) {
  const payment = metadata?.payment;
  const reference = payment?.transactionHash ?? payment?.channelId;
  if (!metadata?.protocol || !metadata.network || !metadata.price || !payment?.success || !reference) {
    return undefined;
  }
  return {
    protocol: metadata.protocol,
    network: metadata.network,
    price: metadata.price,
    transactionHash: payment.transactionHash,
    channelId: payment.channelId,
  };
}

function deliveryCheck(contract: PaidPathContract, data: unknown): ContractCheck {
  const missing = contract.delivery.jsonPaths.filter(
    (path) => getPath(data, path) == null,
  );
  const hasOutput = data !== undefined && data !== null && data !== "";
  const passed = hasOutput && missing.length === 0;
  const detail = !hasOutput
    ? "Paid request returned no output"
    : missing.length > 0
      ? `Missing response fields: ${missing.join(", ")}`
      : "Paid response matched the delivery contract";
  return { stage: "delivery", passed, detail };
}

function statusValue(data: unknown, path: string): string | undefined {
  const value = getPath(data, path);
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function headerTokens(value: string | null): Set<string> {
  return new Set(
    (value ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean),
  );
}

function allowsAll(tokens: Set<string>, required: string[]): boolean {
  const normalized = required.map((value) => value.toLowerCase());
  if (tokens.has("*") && !normalized.includes("authorization")) return true;
  return normalized.every((value) => tokens.has(value));
}

async function checkCors(
  contract: PaidPathContract,
  fetchImpl: typeof fetch,
): Promise<ContractCheck | undefined> {
  if (!contract.corsOrigin) return undefined;
  const requiredHeaders = [
    "payment-signature",
    ...(contract.request.body === undefined ? [] : ["content-type"]),
    ...Object.keys(contract.request.headers ?? {})
      .map((header) => header.toLowerCase())
      .filter((header) => header !== "accept"),
  ];
  try {
    const response = await fetchImpl(contract.request.url, {
      method: "OPTIONS",
      headers: {
        Origin: contract.corsOrigin,
        "Access-Control-Request-Method": contract.request.method,
        "Access-Control-Request-Headers": [...new Set(requiredHeaders)].join(","),
      },
      signal: AbortSignal.timeout(contract.request.timeoutMs ?? 10_000),
      redirect: "manual",
    });
    const origin = response.headers.get("access-control-allow-origin");
    const methods = response.headers.get("access-control-allow-methods") ?? "";
    const headers = response.headers.get("access-control-allow-headers") ?? "";
    const allowsOrigin = origin === "*" || origin === contract.corsOrigin;
    const allowsMethod = allowsAll(headerTokens(methods), [contract.request.method]);
    const allowsHeaders = allowsAll(headerTokens(headers), requiredHeaders);
    const passed = response.ok && allowsOrigin && allowsMethod && allowsHeaders;
    return {
      stage: "cors",
      passed,
      detail: passed
        ? "CORS preflight allows the paid request"
        : `CORS preflight failed: HTTP ${response.status}, origin ${origin ?? "missing"}, methods ${methods || "missing"}, headers ${headers || "missing"}`,
    };
  } catch (error) {
    return {
      stage: "cors",
      passed: false,
      detail: `CORS preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function pollUntilTerminal(
  contract: PaidPathContract,
  initialData: unknown,
  paidFetch: PaidFetcher,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<{ check: ContractCheck; data: unknown }> {
  const poll = contract.poll!;
  const rawUrl = getPath(initialData, poll.urlPath);
  if (typeof rawUrl !== "string") {
    return {
      check: { stage: "poll", passed: false, detail: `Missing poll URL at ${poll.urlPath}` },
      data: initialData,
    };
  }

  let pollUrl: URL;
  try {
    pollUrl = new URL(rawUrl, contract.request.url);
  } catch {
    return {
      check: { stage: "poll", passed: false, detail: "Provider returned an invalid poll URL" },
      data: initialData,
    };
  }
  const allowedOrigins = poll.allowedOrigins ?? [new URL(contract.request.url).origin];
  if (pollUrl.protocol !== "https:" || !allowedOrigins.includes(pollUrl.origin)) {
    return {
      check: { stage: "poll", passed: false, detail: `Poll origin is not allowed: ${pollUrl.origin}` },
      data: initialData,
    };
  }
  const pending = poll.pending.map((value) => value.toLowerCase());
  const success = poll.success.map((value) => value.toLowerCase());
  const failure = poll.failure.map((value) => value.toLowerCase());
  const deadline = now() + (poll.timeoutMs ?? 180_000);
  let data = initialData;
  let status = statusValue(data, poll.statusPath);

  while (!status || pending.includes(status)) {
    const remainingBeforeSleep = deadline - now();
    if (remainingBeforeSleep <= 0) {
      return {
        check: { stage: "poll", passed: false, detail: "Async operation timed out" },
        data,
      };
    }
    await sleep(Math.min(poll.intervalMs ?? 2_000, remainingBeforeSleep));
    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        check: { stage: "poll", passed: false, detail: "Async operation timed out" },
        data,
      };
    }
    let result: AgentCashResult;
    try {
      result = await paidFetch(
        {
          url: pollUrl.toString(),
          method: "GET",
          timeoutMs: Math.min(contract.request.timeoutMs ?? 30_000, remaining),
          runnerTimeoutMs: remaining,
        },
        { ...contract.payment, maxAmountAtomic: "0", maxAmountUsd: 0 },
      );
    } catch (error) {
      return {
        check: {
          stage: "poll",
          passed: false,
          detail: `Async status request failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        data,
      };
    }
    if (now() > deadline) {
      return {
        check: { stage: "poll", passed: false, detail: "Async operation timed out" },
        data: result.data,
      };
    }
    if (!result.success) {
      return {
        check: {
          stage: "poll",
          passed: false,
          detail: result.error?.message ?? "Async status request failed",
        },
        data,
      };
    }
    if (result.metadata?.payment?.success) {
      return {
        check: { stage: "poll", passed: false, detail: "Status poll required another payment" },
        data: result.data,
      };
    }
    data = result.data;
    status = statusValue(data, poll.statusPath);
  }

  if (status && success.includes(status)) {
    return {
      check: { stage: "poll", passed: true, detail: `Async operation completed: ${status}` },
      data,
    };
  }
  const detail = status && failure.includes(status)
    ? `Async operation failed: ${status}`
    : `Unexpected async status: ${status ?? "missing"}`;
  return { check: { stage: "poll", passed: false, detail }, data };
}

function complete(
  contract: PaidPathContract,
  paymentStatus: VerificationResult["paymentStatus"],
  startedAt: number,
  checks: ContractCheck[],
  data?: unknown,
  payment?: PaymentEvidence,
): VerificationResult {
  return {
    name: contract.name,
    passed: checks.length > 0 && checks.every((check) => check.passed),
    paymentStatus,
    durationMs: Date.now() - startedAt,
    checks,
    payment,
    data,
  };
}

export async function verifyPaidPath(
  contract: PaidPathContract,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetch ?? fetch;
  const checks: ContractCheck[] = [];

  try {
    const response = await fetchImpl(
      contract.request.url,
      requestInit({ ...contract.request, corsOrigin: contract.corsOrigin }),
    );
    checks.push(challengeCheck(response, contract));
    if (contract.corsOrigin) checks.push(challengeCorsCheck(response, contract.corsOrigin));
  } catch (error) {
    checks.push({
      stage: "challenge",
      passed: false,
      detail: `Challenge request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const cors = await checkCors(contract, fetchImpl);
  if (cors) checks.push(cors);

  if (!options.pay) return complete(contract, "not-attempted", startedAt, checks);
  if (checks.some((check) => !check.passed)) {
    return complete(contract, "not-attempted", startedAt, checks);
  }
  if (!options.paidFetch) {
    checks.push({
      stage: "payment",
      passed: false,
      detail: "Paid verification requires an AgentCash fetcher",
    });
    return complete(contract, "not-attempted", startedAt, checks);
  }

  let result: AgentCashResult;
  try {
    result = await options.paidFetch(
      { ...contract.request, corsOrigin: contract.corsOrigin },
      contract.payment,
    );
  } catch (error) {
    checks.push({
      stage: "payment",
      passed: false,
      detail: `Payment outcome unknown after the authorization may have been transmitted; do not issue a new authorization until settlement and business-effect evidence are reconciled: ${error instanceof Error ? error.message : String(error)}`,
    });
    return complete(contract, "unknown", startedAt, checks);
  }

  checks.push({
    stage: "payment",
    passed: result.success,
    detail: result.success
      ? "AgentCash completed the paid request"
      : `Payment outcome unknown after the authorization may have been transmitted; do not issue a new authorization until settlement and business-effect evidence are reconciled: ${result.error?.message ?? "AgentCash rejected the paid request"}`,
  });
  if (!result.success) return complete(contract, "unknown", startedAt, checks, result.data);

  if (contract.corsOrigin) {
    checks.push({
      stage: "cors",
      passed: result.proxy?.paidResponseCors === true,
      detail: result.proxy?.paidResponseCors === true
        ? "Paid response exposes the payment receipt to browser clients"
        : `Paid response CORS failed: ${result.proxy?.paidResponseCorsDetail ?? "not observed"}`,
    });
  }

  const evidence = paymentEvidence(result.metadata);
  const expectedProviderClaim = evidence?.protocol === contract.payment.protocol &&
    evidence.network === contract.payment.network;
  checks.push({
    stage: "settlement",
    passed: false,
    detail: evidence && expectedProviderClaim
      ? `Provider metadata reports ${evidence.protocol} on ${evidence.network}, but independent Base receipt and USDC Transfer verification is not implemented`
      : evidence
        ? `Provider metadata reports unexpected ${evidence.protocol} on ${evidence.network}; expected ${contract.payment.protocol} on ${contract.payment.network}, and no independent settlement was verified`
        : "Paid response did not include a provider settlement claim, and no independent settlement was verified",
  });

  let data = result.data;
  if (contract.poll) {
    const polled = await pollUntilTerminal(
      contract,
      data,
      options.paidFetch,
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      options.now ?? Date.now,
    );
    checks.push(polled.check);
    data = polled.data;
  }

  checks.push(deliveryCheck(contract, data));
  return complete(
    contract,
    "unknown",
    startedAt,
    checks,
    data,
    evidence,
  );
}
