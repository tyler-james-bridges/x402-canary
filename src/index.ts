import { startDashboard } from "./dashboard.js";

function main(): void {
  console.log(
    "x402-canary starting in intent-aware read-only mode; x402 requirement comparison and fixed-source Base verification are enabled while every execution path remains disabled",
  );
  startDashboard();
}

try {
  main();
} catch (error) {
  console.error("Fatal:", error);
  process.exitCode = 1;
}
