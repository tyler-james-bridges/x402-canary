import { startDashboard } from "./dashboard.js";

function main(): void {
  console.log(
    "x402-canary starting in live read-only mode; fixed-source Base verification is enabled and all execution paths remain disabled",
  );
  startDashboard();
}

try {
  main();
} catch (error) {
  console.error("Fatal:", error);
  process.exitCode = 1;
}
