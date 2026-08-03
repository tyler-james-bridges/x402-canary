import { startDashboard } from "./dashboard.js";

function main(): void {
  console.log("x402-canary starting in containment mode; scheduled outbound checks are disabled");
  startDashboard();
}

try {
  main();
} catch (error) {
  console.error("Fatal:", error);
  process.exitCode = 1;
}
