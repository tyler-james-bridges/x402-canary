import assert from "node:assert/strict";
import test from "node:test";

import { BASE_USDC_ASSET } from "../contracts.js";
import {
  canonicalJson,
  deriveAuthorizationIdentity,
  deriveOperationIdentity,
} from "../evidence/canonical.js";
import type { ExactAuthorizationDescriptor, OperationDescriptor } from "../evidence/types.js";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0";
const NONCE = `0x${"ab".repeat(32)}`;

function authorization(
  overrides: Partial<ExactAuthorizationDescriptor> = {},
): ExactAuthorizationDescriptor {
  return {
    networkId: "eip155:8453",
    asset: BASE_USDC_ASSET,
    from: FROM,
    to: TO,
    valueAtomic: "10000",
    validAfter: "0",
    validBefore: "1785776400",
    nonce: NONCE,
    ...overrides,
  };
}

test("canonicalJson recursively sorts keys while preserving array order", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: null }, list: [{ d: 4, c: 3 }, 2] }),
    '{"a":{"b":null,"y":true},"list":[{"c":3,"d":4},2],"z":1}',
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  assert.throws(
    () => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer range/,
  );
});

test("operation identity normalizes URL, method, headers, and canonical body ordering", () => {
  const first = deriveOperationIdentity({
    url: "HTTPS://EXAMPLE.COM:443/jobs/../charge?b=2&a=1",
    method: "post" as OperationDescriptor["method"],
    headers: {
      "X-Trace": "  alpha beta  ",
      "Content-Type": " application/json ",
    },
    body: { z: 2, nested: { y: true, a: "value" } },
  });
  const second = deriveOperationIdentity({
    url: "https://example.com/charge?b=2&a=1",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trace": "alpha beta",
    },
    body: { nested: { a: "value", y: true }, z: 2 },
  });

  assert.equal(first.id, second.id);
  assert.equal(first.canonical, second.canonical);
  assert.match(first.id, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.canonical, /^x402-canary:operation:v0\.1\n/);
  assert.match(first.canonical, /https:\/\/example\.com\/charge\?b=2&a=1/);
});

test("operation identity rejects payment credential headers instead of creating collisions", () => {
  const baseline: OperationDescriptor = {
    url: "https://example.com/charge",
    method: "POST",
    body: { amount: 1 },
  };

  for (const name of ["Authorization", "X-Payment", "x402-payment", "payment-signature"]) {
    assert.throws(
      () => deriveOperationIdentity({ ...baseline, headers: { [name]: "secret-credential" } }),
      /Payment credential header/,
      name,
    );
  }
});

test("operation identity preserves semantic request differences", () => {
  const baseline: OperationDescriptor = {
    url: "https://example.com/charge?a=1&b=2",
    method: "POST",
    headers: { "content-type": "application/json", "x-mode": "create" },
    body: { amount: 1 },
  };
  const id = deriveOperationIdentity(baseline).id;

  assert.notEqual(deriveOperationIdentity({ ...baseline, method: "PUT" }).id, id);
  assert.notEqual(deriveOperationIdentity({ ...baseline, body: { amount: 2 } }).id, id);
  assert.notEqual(
    deriveOperationIdentity({ ...baseline, headers: { ...baseline.headers, "x-mode": "delete" } }).id,
    id,
  );
  assert.notEqual(
    deriveOperationIdentity({ ...baseline, headers: { ...baseline.headers, "x-mode": "create  now" } }).id,
    deriveOperationIdentity({ ...baseline, headers: { ...baseline.headers, "x-mode": "create now" } }).id,
  );
  assert.notEqual(deriveOperationIdentity({ ...baseline, url: "https://example.com/charge?b=2&a=1" }).id, id);
  assert.notEqual(deriveOperationIdentity({ ...baseline, body: undefined }).id, id);
  assert.notEqual(deriveOperationIdentity({ ...baseline, body: null }).id, id);

  assert.throws(
    () => deriveOperationIdentity({ ...baseline, url: "http://example.com/charge" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      deriveOperationIdentity({
        ...baseline,
        headers: { "X-Mode": "one", "x-mode": "two" },
      }),
    /Duplicate HTTP header/,
  );
  assert.throws(
    () =>
      deriveOperationIdentity({
        ...baseline,
        timeoutMs: 5_000,
      } as OperationDescriptor),
    /Unexpected operation field: timeoutMs/,
  );
});

test("authorization identity binds normalized Base native-USDC EIP-3009 fields without signature", () => {
  const first = deriveAuthorizationIdentity(authorization());
  const second = deriveAuthorizationIdentity(
    authorization({ asset: BASE_USDC_ASSET.toUpperCase().replace("0X", "0x"), to: TO.toLowerCase() }),
  );

  assert.equal(first.id, second.id);
  assert.match(first.id, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.canonical, /^x402-canary:authorization:v0\.1\n/);
  assert.match(first.canonical, new RegExp(BASE_USDC_ASSET));
  assert.doesNotMatch(first.canonical, /signature/i);

  assert.notEqual(
    deriveAuthorizationIdentity(authorization({ nonce: `0x${"cd".repeat(32)}` })).id,
    first.id,
  );
  assert.notEqual(deriveAuthorizationIdentity(authorization({ valueAtomic: "10001" })).id, first.id);
});

test("authorization identity rejects malformed, ambiguous, and out-of-domain values", () => {
  const invalid: Array<[string, () => unknown, RegExp]> = [
    ["network", () => deriveAuthorizationIdentity(authorization({ networkId: "eip155:1" as "eip155:8453" })), /Base mainnet/],
    ["asset", () => deriveAuthorizationIdentity(authorization({ asset: FROM })), /native Base USDC/],
    ["from", () => deriveAuthorizationIdentity(authorization({ from: "0x1234" })), /20-byte/],
    ["zero to", () => deriveAuthorizationIdentity(authorization({ to: `0x${"0".repeat(40)}` })), /zero address/],
    ["leading zero", () => deriveAuthorizationIdentity(authorization({ valueAtomic: "010000" })), /canonical unsigned decimal/],
    ["zero value", () => deriveAuthorizationIdentity(authorization({ valueAtomic: "0" })), /greater than zero/],
    ["negative time", () => deriveAuthorizationIdentity(authorization({ validAfter: "-1" })), /canonical unsigned decimal/],
    ["time ordering", () => deriveAuthorizationIdentity(authorization({ validAfter: "10", validBefore: "10" })), /greater than validAfter/],
    ["nonce", () => deriveAuthorizationIdentity(authorization({ nonce: "0x1234" })), /32-byte/],
    [
      "uint256 overflow",
      () => deriveAuthorizationIdentity(authorization({ valueAtomic: (1n << 256n).toString() })),
      /exceeds uint256/,
    ],
    [
      "signature",
      () => deriveAuthorizationIdentity({ ...authorization(), signature: "0xsecret" } as ExactAuthorizationDescriptor),
      /Unexpected authorization field/,
    ],
  ];

  for (const [name, invoke, expected] of invalid) {
    assert.throws(invoke, expected, name);
  }
});
