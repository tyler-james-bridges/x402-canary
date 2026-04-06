import { endpoints } from "./endpoints.js";
import { checkEndpoint } from "./canary.js";
import { recordCheck } from "./metrics.js";
import { startDashboard } from "./dashboard.js";

const CHECK_INTERVAL_MS = 60_000;

async function runChecks(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Running checks on ${endpoints.length} endpoints...`);

  const results = await Promise.allSettled(
    endpoints.map((e) => checkEndpoint(e.url, e.method))
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const r = result.value;
      recordCheck(r);
      const indicator = r.isX402 ? "402" : r.isHealthy ? "UP" : "DOWN";
      const priceStr = r.x402Details?.price ? ` — ${r.x402Details.price} on ${r.x402Details.network}` : "";
      console.log(
        `  [${indicator}] ${r.url} — ${r.responseTimeMs}ms` +
          (r.error ? ` — ${r.error}` : ` — HTTP ${r.status}${priceStr}`)
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("x402-canary starting...");
  startDashboard();

  // Run immediately, then on interval
  await runChecks();
  setInterval(runChecks, CHECK_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
