import type { PaidFetcher } from "./contracts.js";

export const PAID_EXECUTION_DISABLED =
  "PAID_EXECUTION_DISABLED: the executable payment adapter is disabled until independent Base settlement verification, observation journaling, and replay/effect gates are complete";

/**
 * Deliberately retained as the adapter boundary so callers fail closed.
 * This release contains no executable AgentCash subprocess or wallet path.
 */
export const fetchWithAgentCash: PaidFetcher = async () => {
  throw new Error(PAID_EXECUTION_DISABLED);
};
