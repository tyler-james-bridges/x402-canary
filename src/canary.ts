export interface CheckResult {
  url: string;
  status: number | null;
  responseTimeMs: number;
  timestamp: string;
  isHealthy: boolean;
  error?: string;
}

export async function checkEndpoint(url: string): Promise<CheckResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "x402-canary/1.0" },
    });

    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;

    return {
      url,
      status: res.status,
      responseTimeMs,
      timestamp,
      isHealthy: res.status < 500,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);

    return {
      url,
      status: null,
      responseTimeMs,
      timestamp,
      isHealthy: false,
      error,
    };
  }
}
