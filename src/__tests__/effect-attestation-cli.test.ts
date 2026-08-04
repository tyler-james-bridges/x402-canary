import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_HASH = "sha256:f06a237ee94a3da72c52a64b6b87727dbf1c1724d94ed2f55df680d2d8029db3";

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/effect-attestation-verify-cli.ts", ...args],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      timeout: 10_000,
    },
  );
}

test("the file-only effect CLI verifies the checked-in signed absence fixture", () => {
  const result = runCli(
    REGISTRY_HASH,
    "examples/effect-authority-registry-v0.1.json",
    "examples/effect-verification-request-v0.1.json",
    "examples/effect-attestation-v0.1.json",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as Record<string, any>;
  assert.equal(output.verified.registryHash, REGISTRY_HASH);
  assert.equal(output.verified.outcome, "zero");
  assert.equal(output.verified.assurance.authoritySignatureVerified, true);
  assert.equal(output.verified.assurance.paymentExecutionEnabled, false);
  assert.equal(output.effectObservations.length, 1);
  assert.equal(output.effectObservations[0].status, "absent");
  assert.equal(output.effectObservations[0].authoritative, true);
  assert.equal(result.stdout.includes("01J4AIFI"), false);
  assert.equal(result.stdout.includes("signature"), false);
  assert.equal(result.stdout.includes("publicKey"), false);
});

test("the effect CLI requires the out-of-band registry pin and exposes no action option", () => {
  const wrongHash = runCli(
    `sha256:${"0".repeat(64)}`,
    "examples/effect-authority-registry-v0.1.json",
    "examples/effect-verification-request-v0.1.json",
    "examples/effect-attestation-v0.1.json",
  );
  assert.equal(wrongHash.status, 2);
  assert.match(wrongHash.stderr, /out-of-band expected hash/);
  assert.equal(wrongHash.stdout, "");

  for (const option of ["--pay", "--retry", "--wallet", "--rpc", "--url"]) {
    const result = runCli(option);
    assert.equal(result.status, 2, option);
    assert.match(result.stderr, /Unknown option/);
    assert.equal(result.stdout, "");
  }
});
