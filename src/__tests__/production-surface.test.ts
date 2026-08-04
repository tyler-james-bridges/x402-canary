import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../", import.meta.url);

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, ROOT), "utf8");
}

test("the production function inventory is explicit and contains no ping or action surface", () => {
  const apiDirectory = new URL("api/", ROOT);
  const apiFiles = readdirSync(apiDirectory)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
  assert.deepEqual(apiFiles, [
    "evidence-status.ts",
    "health.ts",
    "preflight.ts",
    "trust.ts",
  ]);

  for (const file of apiFiles) {
    const contents = source(`api/${file}`);
    assert.doesNotMatch(
      contents,
      /agentcash|base-rpc|child_process|effect-authority|journal|payment-proxy|shadow-runner|wallet/i,
      file,
    );
    assert.doesNotMatch(
      contents,
      /\bfetch\s*\(|eth_send|personal_|wallet_|debug_|admin_/i,
      file,
    );
  }
});

test("Vercel applies a strict no-inline security policy without routing rewrites", () => {
  const configuration = JSON.parse(source("vercel.json")) as {
    headers?: Array<{
      source: string;
      headers: Array<{ key: string; value: string }>;
    }>;
    rewrites?: unknown;
  };
  assert.equal(configuration.rewrites, undefined);
  assert.equal(configuration.headers?.length, 1);
  assert.equal(configuration.headers?.[0]?.source, "/(.*)");
  const headers = new Map(
    configuration.headers?.[0]?.headers.map((entry) => [entry.key, entry.value]),
  );
  assert.match(headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /script-src 'self'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /style-src 'self'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /connect-src 'self'/);
  assert.match(headers.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.match(headers.get("Permissions-Policy") ?? "", /payment=\(\)/);
});

test("the public console uses external assets and only safe DOM/network primitives", () => {
  const html = source("public/index.html");
  const script = source("public/app.js");
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /rel="icon" href="data:,"/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/canary\.0x402\.sh\/og\.png"/,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/canary\.0x402\.sh\/og\.png"/,
  );
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<form|<input|<textarea|contenteditable/i);

  assert.doesNotMatch(script, /https?:\/\//i);
  assert.doesNotMatch(script, /aria-pressed/);
  assert.doesNotMatch(
    script,
    /innerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function|WebSocket|EventSource|sendBeacon|XMLHttpRequest/,
  );
  assert.match(script, /\/api\/health/);
  assert.match(script, /\/api\/evidence-status/);
  assert.match(
    script,
    /const STATUS_ROUTES = new Set\(\["\/api\/health", "\/api\/evidence-status"\]\)/,
  );
  assert.doesNotMatch(
    script,
    /(?:fetchJson|window\.fetch)\(["']\/api\/(?:preflight|trust)|eth_send|wallet_|payment[_-]?required/i,
  );

  const socialCard = readFileSync(new URL("public/og.png", ROOT));
  assert.equal(socialCard.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(socialCard.length > 100_000);
});
