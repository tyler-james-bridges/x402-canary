import type { PaymentContract } from "../../contracts.js";
import type { NoSpendResponseShape } from "../../x402-challenge.js";

export const BUYER_ORIGIN = "https://buyer.fixture.invalid";
export const FIXTURE_RESOURCE_URL = "https://fixture.invalid/lint";

export const baseExactPayment = {
  protocol: "x402",
  network: "base",
  scheme: "exact",
  networkId: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
  maxAmountAtomic: "10000",
  maxAmountUsd: 0.01,
} satisfies PaymentContract;

export function exactEip3009Requirement(): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
}

export function encodeChallenge(accepts: unknown[]): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: {
      url: FIXTURE_RESOURCE_URL,
      description: "sanitized deterministic fixture",
      mimeType: "application/json",
    },
    accepts,
  })).toString("base64");
}

export function passingNoSpendShape(): NoSpendResponseShape {
  return {
    challenge: {
      status: 402,
      headers: {
        "Payment-Required": encodeChallenge([exactEip3009Requirement()]),
        "Access-Control-Allow-Origin": BUYER_ORIGIN,
        "Access-Control-Expose-Headers": "Content-Type, Payment-Required, Payment-Response",
      },
    },
    browser: {
      origin: BUYER_ORIGIN,
      requestMethod: "POST",
      requestHeaders: ["content-type", "payment-signature"],
      preflight: {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": BUYER_ORIGIN,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Payment-Signature",
        },
      },
    },
  };
}

/**
 * Sanitized regression shape based on the no-spend #3020 observation. It keeps
 * only the incompatible wire characteristics; it does not name or call a host.
 */
export function issue3020NoSpendShape(): NoSpendResponseShape {
  return {
    challenge: {
      status: 402,
      headers: {
        "payment-required": `payment ${encodeChallenge([exactEip3009Requirement()])}`,
        "x-payment-version": "1",
        "access-control-allow-origin": BUYER_ORIGIN,
        "access-control-expose-headers": "content-type, payment-response",
      },
    },
    browser: {
      origin: BUYER_ORIGIN,
      requestMethod: "POST",
      requestHeaders: ["content-type", "payment-signature"],
      preflight: { status: 501, headers: {} },
    },
  };
}
