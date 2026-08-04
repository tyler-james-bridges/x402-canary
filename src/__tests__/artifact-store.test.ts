import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EvidenceArtifactError,
  EvidenceArtifactStore,
  type ArtifactReceipt,
} from "../evidence/artifact-store.js";
import { canonicalJson } from "../evidence/canonical.js";

async function withTempStore(
  callback: (store: EvidenceArtifactStore, root: string) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "x402-artifact-store-"));
  const root = join(parent, "private-artifacts");
  try {
    const store = await EvidenceArtifactStore.open(root);
    await callback(store, root);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function artifactPath(root: string, receipt: ArtifactReceipt): string {
  return join(root, `${receipt.artifactHash.slice("sha256:".length)}.json`);
}

async function rejectsArtifactCode(
  action: Promise<unknown> | (() => Promise<unknown>),
  expectedCode: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof EvidenceArtifactError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test("content addressing is deterministic across recursive property order", async () => {
  await withTempStore(async (store, root) => {
    const left = await store.put("base.audit", {
      zeta: true,
      nested: { second: 2, first: 1 },
      list: [{ bravo: "b", alpha: "a" }],
    });
    const right = await store.put("base.audit", {
      list: [{ alpha: "a", bravo: "b" }],
      nested: { first: 1, second: 2 },
      zeta: true,
    });

    assert.deepEqual(right, left);
    assert.deepEqual(await store.get("base.audit", left.artifactHash), {
      list: [{ alpha: "a", bravo: "b" }],
      nested: { first: 1, second: 2 },
      zeta: true,
    });
    assert.deepEqual(await store.getByReference(left), await store.get("base.audit", left.artifactHash));
    await rejectsArtifactCode(
      store.getByReference({ ...left, byteLength: left.byteLength + 1 }),
      "ARTIFACT_REFERENCE_MISMATCH",
    );
    assert.deepEqual(await readdir(root), [`${left.artifactHash.slice("sha256:".length)}.json`]);
  });
});

test("idempotent and concurrent same-content puts publish one complete artifact", async () => {
  await withTempStore(async (store, root) => {
    const payload = {
      operationId: `sha256:${"a".repeat(64)}`,
      observations: ["alpha", "bravo"],
    };
    const receipts = await Promise.all(
      Array.from({ length: 24 }, () => store.put("kernel.input", payload)),
    );

    for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
    const names = await readdir(root);
    assert.deepEqual(names, [`${receipts[0]!.artifactHash.slice("sha256:".length)}.json`]);
    const stored = await readFile(artifactPath(root, receipts[0]!), "utf8");
    assert.ok(stored.endsWith("\n"));
    assert.equal(Buffer.byteLength(stored, "utf8"), receipts[0]!.byteLength);

    const repeated = await store.put("kernel.input", payload);
    assert.deepEqual(repeated, receipts[0]);
    assert.deepEqual(await readdir(root), names);
  });
});

test("new roots and published artifacts use restrictive permissions", async () => {
  await withTempStore(async (store, root) => {
    const receipt = await store.put("effect.audit", { outcome: "absent" });

    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(artifactPath(root, receipt))).mode & 0o777, 0o600);
  });
});

test("tampered content and semantically valid noncanonical encoding fail closed", async () => {
  await withTempStore(async (store, root) => {
    const tampered = await store.put("evaluator.output", { decision: "no_action", count: 1 });
    const tamperedPath = artifactPath(root, tampered);
    const raw = JSON.parse((await readFile(tamperedPath, "utf8")).trim()) as Record<string, unknown>;
    raw.payload = { decision: "execute", count: 1 };
    await writeFile(tamperedPath, `${canonicalJson(raw)}\n`, { mode: 0o600 });
    await rejectsArtifactCode(
      store.get("evaluator.output", tampered.artifactHash),
      "ARTIFACT_INTEGRITY_MISMATCH",
    );

    const noncanonical = await store.put("operation.identity", { method: "GET", url: "https://example.test/" });
    const noncanonicalPath = artifactPath(root, noncanonical);
    const parsed = JSON.parse((await readFile(noncanonicalPath, "utf8")).trim()) as {
      artifactHash: string;
      namespace: string;
      payload: unknown;
      schemaVersion: string;
    };
    const reordered = {
      schemaVersion: parsed.schemaVersion,
      namespace: parsed.namespace,
      payload: parsed.payload,
      artifactHash: parsed.artifactHash,
    };
    await writeFile(noncanonicalPath, `${JSON.stringify(reordered)}\n`, { mode: 0o600 });
    await rejectsArtifactCode(
      store.get("operation.identity", noncanonical.artifactHash),
      "ARTIFACT_NOT_CANONICAL",
    );
  });
});

test("symlinked, torn, and truncated artifact files are rejected", async () => {
  await withTempStore(async (store, root) => {
    const linked = await store.put("base.audit", { kind: "linked" });
    const linkedPath = artifactPath(root, linked);
    const decoyPath = join(root, "decoy-data");
    await writeFile(decoyPath, await readFile(linkedPath), { mode: 0o600 });
    await unlink(linkedPath);
    await symlink(decoyPath, linkedPath);
    await rejectsArtifactCode(store.get("base.audit", linked.artifactHash), "ARTIFACT_FILE_INVALID");

    const torn = await store.put("base.audit", { kind: "torn" });
    const tornPath = artifactPath(root, torn);
    const tornText = await readFile(tornPath, "utf8");
    await writeFile(tornPath, tornText.slice(0, -1), { mode: 0o600 });
    await rejectsArtifactCode(store.get("base.audit", torn.artifactHash), "ARTIFACT_TORN_OR_CORRUPT");

    const truncated = await store.put("base.audit", { kind: "truncated" });
    const truncatedPath = artifactPath(root, truncated);
    const truncatedText = await readFile(truncatedPath, "utf8");
    await writeFile(truncatedPath, `${truncatedText.slice(0, Math.floor(truncatedText.length / 2))}\n`, {
      mode: 0o600,
    });
    await rejectsArtifactCode(store.get("base.audit", truncated.artifactHash), "ARTIFACT_JSON_INVALID");
  });
});

test("invalid namespaces and hashes are rejected before path resolution", async () => {
  await withTempStore(async (store) => {
    await rejectsArtifactCode(store.put("../escape", { safe: true }), "ARTIFACT_NAMESPACE_INVALID");
    await rejectsArtifactCode(store.put("Uppercase", { safe: true }), "ARTIFACT_NAMESPACE_INVALID");
    await rejectsArtifactCode(store.get("base.audit", "not-a-hash"), "ARTIFACT_HASH_INVALID");
    await rejectsArtifactCode(
      store.get("base.audit", `sha256:${"A".repeat(64)}`),
      "ARTIFACT_HASH_INVALID",
    );
  });
});

test("inspection reports artifacts, orphan temporary files, unexpected files, and corrupt entries without deleting", async () => {
  await withTempStore(async (store, root) => {
    const valid = await store.put("bundle.v0.2", { decision: "no_action" });
    const temporaryName = ".orphan-after-crash.tmp";
    const unexpectedName = "operator-note.txt";
    const corruptName = `${"f".repeat(64)}.json`;
    await writeFile(join(root, temporaryName), "partial", { mode: 0o600 });
    await writeFile(join(root, unexpectedName), "retain for inspection", { mode: 0o600 });
    await writeFile(join(root, corruptName), "", { mode: 0o600 });

    const inspection = await store.inspect();

    assert.deepEqual(inspection.artifacts, [valid]);
    assert.deepEqual(inspection.temporaryFiles, [temporaryName]);
    assert.deepEqual(inspection.unexpectedFiles, [unexpectedName]);
    assert.deepEqual(inspection.errors, [`ARTIFACT_SIZE_INVALID:${corruptName}`]);
    assert.equal(await readFile(join(root, temporaryName), "utf8"), "partial");
    assert.equal(await readFile(join(root, unexpectedName), "utf8"), "retain for inspection");
    assert.equal((await stat(join(root, corruptName))).size, 0);
  });
});
