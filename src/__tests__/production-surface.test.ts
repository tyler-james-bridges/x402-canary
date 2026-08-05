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
    "base-transaction.ts",
    "evidence-status.ts",
    "health.ts",
    "preflight.ts",
    "trust.ts",
    "x402-intent.ts",
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
    functions?: Record<string, { maxDuration?: number }>;
    headers?: Array<{
      source: string;
      headers: Array<{ key: string; value: string }>;
    }>;
    rewrites?: unknown;
  };
  assert.deepEqual(configuration.functions, {
    "api/base-transaction.ts": { maxDuration: 10 },
    "api/x402-intent.ts": { maxDuration: 10 },
  });
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

test("the public console uses one strict two-input case form and only safe DOM/network primitives", () => {
  const html = source("public/index.html");
  const script = source("public/app.js");
  const styles = source("public/styles.css");
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /rel="icon" href="data:,"/);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.equal((html.match(/<form\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<input\b/gi) ?? []).length, 1);
  assert.equal((html.match(/<textarea\b/gi) ?? []).length, 1);
  assert.match(html, /<form[^>]+id="verify-form"[^>]*novalidate/i);
  assert.match(
    html,
    /<input[\s\S]*?name="transactionHash"[\s\S]*?maxlength="66"[\s\S]*?>/i,
  );
  assert.match(
    html,
    /<textarea[\s\S]*?name="paymentRequirements"[\s\S]*?maxlength="4096"[\s\S]*?>[\s\S]*?<\/textarea>/i,
  );
  assert.doesNotMatch(html, /contenteditable|type="(?:url|password|file)"/i);
  assert.match(
    html,
    /<button[^>]+id="copy-report"[^>]+type="button"[^>]*>Copy JSON report<\/button>/i,
  );
  assert.match(
    html,
    /<button[^>]+id="download-report"[^>]+type="button"[^>]*>Download \.json<\/button>/i,
  );

  assert.doesNotMatch(script, /https?:\/\//i);
  assert.doesNotMatch(script, /aria-pressed/);
  assert.doesNotMatch(
    script,
    /innerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function|WebSocket|EventSource|sendBeacon|XMLHttpRequest/,
  );
  assert.match(script, /\/api\/health/);
  assert.match(script, /\/api\/evidence-status/);
  assert.match(script, /const X402_INTENT_ROUTE = "\/api\/x402-intent"/);
  assert.match(
    script,
    /const STATUS_ROUTES = new Set\(\["\/api\/health", "\/api\/evidence-status"\]\)/,
  );
  const fetchTargets = [...script.matchAll(/window\.fetch\(\s*([^,\n]+)/g)].map(
    (match) => match[1]?.trim(),
  );
  assert.deepEqual(fetchTargets, ["path", "X402_INTENT_ROUTE"]);
  assert.match(
    script,
    /window\.fetch\(X402_INTENT_ROUTE,\s*\{[\s\S]*?method: "POST"[\s\S]*?"Content-Type": "application\/json"[\s\S]*?body: JSON\.stringify\(\{[\s\S]*?x402Version: 2,[\s\S]*?transactionHash: request\.transactionHash,[\s\S]*?paymentRequirements: request\.paymentRequirements,[\s\S]*?\}\)[\s\S]*?credentials: "same-origin"[\s\S]*?redirect: "error"/,
  );
  assert.doesNotMatch(
    script,
    /(?:fetchJson|window\.fetch)\(["']\/api\/(?:preflight|trust)|eth_send|eth_sign|personal_sign|wallet_|window\.ethereum|ethereum\.request|writeContract|sendTransaction|signTypedData|payment[_-]?required/i,
  );
  assert.doesNotMatch(
    script,
    /window\.open|window\.location|location\.(?:assign|replace)|WebSocket|EventSource|sendBeacon|XMLHttpRequest/,
  );
  assert.match(
    script,
    /navigator\.clipboard\.writeText\(JSON\.stringify\(lastReport, null, 2\)\)/,
  );
  assert.match(script, /new Blob\([\s\S]*?type: "application\/json"/);
  assert.match(script, /URL\.createObjectURL\(blob\)/);
  assert.match(script, /URL\.revokeObjectURL\(url\)/);
  assert.match(script, /link\.download = `x402-case-\$\{lastReport\.caseId\.slice\(-12\)\}\.json`/);
  assert.match(script, /label\.textContent = loading \? "Verifying…"/);
  assert.match(script, /button\.setAttribute\("aria-busy", loading \? "true" : "false"\)/);
  assert.doesNotMatch(
    styles,
    /verify-form\[data-state="loading"\][^{]*\.button-label\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    styles,
    /verify-form\[data-state="loading"\][^{]*\.button-progress\s*\{[^}]*display:\s*inline-block/s,
  );

  assert.match(
    html,
    /property="og:image" content="https:\/\/canary\.0x402\.sh\/og-live-verifier\.png"/,
  );
  assert.match(
    html,
    /name="twitter:image" content="https:\/\/canary\.0x402\.sh\/og-live-verifier\.png"/,
  );

  const socialCard = readFileSync(new URL("public/og-live-verifier.png", ROOT));
  assert.equal(socialCard.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok(socialCard.length > 100_000);
});
