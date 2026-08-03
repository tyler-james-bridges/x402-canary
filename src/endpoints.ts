export interface Endpoint {
  name: string;
  url: string;
  method: string;
  description: string;
  expectedPrice?: string;
}

/**
 * Historical scheduled targets are intentionally removed during containment.
 * Restoring a target requires an operator-owned fixture and an approved bounded
 * outbound policy; production side-effect routes must never be listed here.
 */
export const endpoints: readonly Endpoint[] = [];
