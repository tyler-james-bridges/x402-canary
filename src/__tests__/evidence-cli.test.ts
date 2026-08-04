import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import expectedBundle from "../../examples/evidence-kernel-v0.1.bundle.json" with { type: "json" };

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/evidence-cli.ts", ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 10_000,
  });
}

test("the file-only CLI emits the deterministic checked-in bundle", () => {
  const result = runCli("examples/evidence-kernel-v0.1.input.json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expectedBundle);
});

test("the evidence CLI exposes no payment or network option", () => {
  for (const option of ["--pay", "--rpc", "--wallet", "--url"]) {
    const result = runCli(option);
    assert.equal(result.status, 2, option);
    assert.match(result.stderr, /Unknown option/);
    assert.equal(result.stdout, "");
  }
});

test("malformed input fails closed without emitting a partial bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-evidence-cli-"));
  try {
    const inputPath = join(root, "malformed.json");
    await writeFile(inputPath, JSON.stringify({ schemaVersion: "0.1" }), { mode: 0o600 });
    const result = runCli(inputPath);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing required field/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
