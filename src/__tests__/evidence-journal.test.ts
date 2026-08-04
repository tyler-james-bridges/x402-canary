import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveJournalHead,
  EvidenceJournal,
  JournalHeadConflictError,
  validateJournalRecord,
} from "../evidence/journal.js";
import type { JournalEventInput } from "../evidence/types.js";

const OPERATION_ID = `sha256:${"a".repeat(64)}`;
const OTHER_OPERATION_ID = `sha256:${"c".repeat(64)}`;
const AUTHORIZATION_ID = `sha256:${"b".repeat(64)}`;
const OTHER_AUTHORIZATION_ID = `sha256:${"d".repeat(64)}`;

function event(eventId: string, overrides: Partial<JournalEventInput> = {}): JournalEventInput {
  return {
    eventId,
    operationId: OPERATION_ID,
    kind: "attempt_opened",
    occurredAt: "2026-08-03T12:00:00.000Z",
    evidence: { source: "fixture", nested: { count: 1 } },
    ...overrides,
  };
}

async function withTempJournal(
  callback: (journalPath: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "x402-evidence-journal-"));
  try {
    await callback(join(root, "private", "events.jsonl"), root);
  } finally {
    await chmod(join(root, "private"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

interface JournalHolder {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
}

async function startJournalHolder(journalPath: string): Promise<JournalHolder> {
  const journalModuleUrl = new URL("../evidence/journal.ts", import.meta.url).href;
  const source = [
    `import { EvidenceJournal } from ${JSON.stringify(journalModuleUrl)};`,
    `const journal = await EvidenceJournal.open(${JSON.stringify(journalPath)});`,
    `process.stdout.write("READY\\n");`,
    `await new Promise((resolve) => process.stdin.once("data", resolve));`,
    `await journal.close();`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`journal holder timed out: ${stderr}`)), 10_000);
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (stdout.includes("READY\n")) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`journal holder exited before ready (${String(code)}/${String(signal)}): ${stderr}`));
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
  return { child, stderr: () => stderr };
}

async function closeJournalHolder(holder: JournalHolder): Promise<void> {
  const exit = once(holder.child, "exit");
  holder.child.stdin.end("close\n");
  const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null, holder.stderr());
  assert.equal(code, 0, holder.stderr());
}

test("journal persists a hash chain, hardens modes, and validates across restart", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    const first = await journal.append(event("evt-1"));
    const second = await journal.append(
      event("evt-2", {
        kind: "authorization_recorded",
        authorizationId: AUTHORIZATION_ID,
        occurredAt: "2026-08-03T12:00:01.000Z",
      }),
    );

    assert.equal(first.sequence, 1);
    assert.equal(first.previousHash, null);
    assert.match(first.recordHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.recordHash);
    assert.deepEqual(journal.head(), {
      journalId: journal.journalId,
      sequence: 2,
      recordHash: second.recordHash,
    });
    assert.deepEqual(deriveJournalHead(journal.readAll(), journal.journalId), journal.head());
    assert.deepEqual(
      validateJournalRecord(second, journal.journalId, 2, first.recordHash),
      second,
    );
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(journalPath, ".."))).mode & 0o777, 0o700);

    const detached = journal.readAll();
    detached[0]!.eventId = "mutated-copy";
    assert.equal(journal.readAll()[0]!.eventId, "evt-1");
    await journal.close();

    const restarted = await EvidenceJournal.open(journalPath);
    assert.deepEqual(
      restarted.readAll().map((record) => record.eventId),
      ["evt-1", "evt-2"],
    );
    const third = await restarted.append(
      event("evt-3", { kind: "authorization_transmitted", authorizationId: AUTHORIZATION_ID }),
    );
    assert.equal(third.sequence, 3);
    assert.equal(third.previousHash, second.recordHash);
    await restarted.close();
  });
});

test("journal IDs are stable across restart and distinct across journals", async () => {
  await withTempJournal(async (journalPath, root) => {
    const first = await EvidenceJournal.open(journalPath);
    const firstId = first.journalId;
    await first.close();

    const restarted = await EvidenceJournal.open(journalPath);
    assert.equal(restarted.journalId, firstId);
    await restarted.close();

    const otherPath = join(root, "private", "other.jsonl");
    const other = await EvidenceJournal.open(otherPath);
    assert.notEqual(other.journalId, firstId);
    assert.match(other.journalId, /^sha256:[0-9a-f]{64}$/);
    await other.close();
  });
});

test("missing metadata for an existing journal is rejected", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-metadata-missing"));
    await journal.close();

    await unlink(`${journalPath}.meta.json`);
    await assert.rejects(
      EvidenceJournal.open(journalPath),
      /Journal metadata is missing for an existing journal/,
    );
  });
});

test("metadata cannot silently recreate a missing journal under an old identity", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-journal-missing"));
    await journal.close();

    await unlink(journalPath);
    await assert.rejects(
      EvidenceJournal.open(journalPath),
      /Journal metadata exists while the journal is missing; manual recovery is required/,
    );
  });
});

test("tampered metadata cannot re-identify an existing journal", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-metadata-tampered"));
    await journal.close();

    const metadataPath = `${journalPath}.meta.json`;
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      journalId: string;
      schemaVersion: string;
    };
    metadata.journalId = OTHER_AUTHORIZATION_ID;
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

    await assert.rejects(EvidenceJournal.open(journalPath), /Journal ID mismatch at sequence 1/);
  });
});

test("metadata swapped between journals is rejected by both hash chains", async () => {
  await withTempJournal(async (journalPath, root) => {
    const otherPath = join(root, "private", "other.jsonl");
    const first = await EvidenceJournal.open(journalPath);
    await first.append(event("evt-swap-first"));
    await first.close();
    const second = await EvidenceJournal.open(otherPath);
    await second.append(
      event("evt-swap-second", { operationId: OTHER_OPERATION_ID }),
    );
    await second.close();

    const firstMetadataPath = `${journalPath}.meta.json`;
    const secondMetadataPath = `${otherPath}.meta.json`;
    const [firstMetadata, secondMetadata] = await Promise.all([
      readFile(firstMetadataPath, "utf8"),
      readFile(secondMetadataPath, "utf8"),
    ]);
    await Promise.all([
      writeFile(firstMetadataPath, secondMetadata, { mode: 0o600 }),
      writeFile(secondMetadataPath, firstMetadata, { mode: 0o600 }),
    ]);

    await assert.rejects(EvidenceJournal.open(journalPath), /Journal ID mismatch at sequence 1/);
    await assert.rejects(EvidenceJournal.open(otherPath), /Journal ID mismatch at sequence 1/);
  });
});

test("appendOnceAtHead replays exactly and rejects event, head, and journal conflicts", async () => {
  await withTempJournal(async (journalPath, root) => {
    const journal = await EvidenceJournal.open(journalPath);
    const originalHead = journal.head();
    const exactEvent = event("evt-once");
    const first = await journal.appendOnceAtHead(originalHead, exactEvent);
    assert.equal(first.replayed, false);
    assert.equal(first.record.sequence, 1);

    await journal.append(
      event("evt-after-once", {
        kind: "authorization_recorded",
        authorizationId: AUTHORIZATION_ID,
      }),
    );
    const replay = await journal.appendOnceAtHead(originalHead, exactEvent);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.record, first.record);
    assert.equal(replay.currentHead.sequence, 2);

    await assert.rejects(
      journal.appendOnceAtHead(
        originalHead,
        event("evt-once", { occurredAt: "2026-08-03T12:00:01.000Z" }),
      ),
      /JOURNAL_EVENT_ID_CONFLICT/,
    );
    await assert.rejects(
      journal.appendOnceAtHead(originalHead, event("evt-stale-head")),
      (error: unknown) => error instanceof JournalHeadConflictError,
    );

    const other = await EvidenceJournal.open(join(root, "private", "other-cas.jsonl"));
    const foreignHead = other.head();
    await assert.rejects(
      journal.appendOnceAtHead(foreignHead, event("evt-foreign-head")),
      (error: unknown) =>
        error instanceof JournalHeadConflictError &&
        error.expected.journalId === foreignHead.journalId &&
        error.actual.journalId === journal.journalId,
    );
    await other.close();
    await journal.close();
  });
});

test("concurrent appendOnceAtHead calls allow one writer at the same head", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    const expectedHead = journal.head();
    const outcomes = await Promise.allSettled([
      journal.appendOnceAtHead(expectedHead, event("evt-cas-a")),
      journal.appendOnceAtHead(
        expectedHead,
        event("evt-cas-b", { operationId: OTHER_OPERATION_ID }),
      ),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert(rejected && rejected.status === "rejected");
    assert(rejected.reason instanceof JournalHeadConflictError);
    assert.equal(journal.readAll().length, 1);
    await journal.close();
  });
});

test("Promise.all appends are serialized without sequence or hash-chain gaps", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    const appended = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        journal.append(event(`evt-concurrent-${index.toString().padStart(2, "0")}`)),
      ),
    );

    assert.deepEqual(
      appended.map((record) => record.sequence),
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    const records = journal.readAll();
    assert.equal(new Set(records.map((record) => record.eventId)).size, 40);
    records.forEach((record, index) => {
      assert.equal(record.sequence, index + 1);
      assert.equal(record.previousHash, index === 0 ? null : records[index - 1]!.recordHash);
    });
    await journal.close();
  });
});

test("kernel input and bundle commits are globally adjacent and the bundle closes the operation", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-lifecycle-open"));

    await assert.rejects(
      journal.append(
        event("evt-bundle-too-early", {
          kind: "kernel_bundle_committed",
          authorizationId: AUTHORIZATION_ID,
        }),
      ),
      /JOURNAL_BUNDLE_MUST_BE_GLOBALLY_ADJACENT_TO_INPUT/,
    );

    await journal.append(
      event("evt-input", {
        kind: "kernel_input_committed",
        authorizationId: AUTHORIZATION_ID,
        evidence: { artifactHash: `sha256:${"1".repeat(64)}` },
      }),
    );
    await assert.rejects(
      journal.append(
        event("evt-interleaved", {
          operationId: OTHER_OPERATION_ID,
        }),
      ),
      /JOURNAL_INPUT_AWAITS_ADJACENT_BUNDLE/,
    );
    await assert.rejects(
      journal.append(
        event("evt-wrong-bundle-operation", {
          operationId: OTHER_OPERATION_ID,
          authorizationId: AUTHORIZATION_ID,
          kind: "kernel_bundle_committed",
        }),
      ),
      /JOURNAL_INPUT_AWAITS_ADJACENT_BUNDLE/,
    );
    await assert.rejects(
      journal.append(
        event("evt-wrong-bundle-authorization", {
          authorizationId: OTHER_AUTHORIZATION_ID,
          kind: "kernel_bundle_committed",
        }),
      ),
      /JOURNAL_INPUT_AWAITS_ADJACENT_BUNDLE/,
    );

    const bundle = await journal.append(
      event("evt-bundle", {
        kind: "kernel_bundle_committed",
        authorizationId: AUTHORIZATION_ID,
        evidence: { artifactHash: `sha256:${"2".repeat(64)}` },
      }),
    );
    assert.equal(bundle.sequence, 3);
    assert.deepEqual(
      journal.readAll().map((record) => record.kind),
      ["attempt_opened", "kernel_input_committed", "kernel_bundle_committed"],
    );

    await assert.rejects(
      journal.append(
        event("evt-after-bundle", {
          kind: "attempt_closed",
        }),
      ),
      /JOURNAL_OPERATION_ALREADY_CLOSED/,
    );
    await journal.append(
      event("evt-other-operation", {
        operationId: OTHER_OPERATION_ID,
      }),
    );
    await journal.close();

    const restarted = await EvidenceJournal.open(journalPath);
    assert.equal(restarted.readAll().length, 4);
    await restarted.close();
  });
});

test("duplicate event IDs are rejected before and after restart", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-duplicate"));
    await assert.rejects(journal.append(event("evt-duplicate")), /Duplicate eventId/);
    assert.equal(journal.readAll().length, 1);
    await journal.close();

    const restarted = await EvidenceJournal.open(journalPath);
    await assert.rejects(restarted.append(event("evt-duplicate")), /Duplicate eventId/);
    await restarted.append(event("evt-after-rejection"));
    assert.equal(restarted.readAll().length, 2);
    await restarted.close();
  });
});

test("tampered records fail closed on restart", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-tamper"));
    await journal.close();

    const contents = await readFile(journalPath, "utf8");
    assert.match(contents, /attempt_opened/);
    await writeFile(journalPath, contents.replace("attempt_opened", "attempt_closed"), { mode: 0o600 });

    await assert.rejects(EvidenceJournal.open(journalPath), /recordHash mismatch/);
  });
});

test("torn and corrupt JSON records fail closed on restart", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-torn"));
    await journal.close();

    const contents = await readFile(journalPath, "utf8");
    await writeFile(journalPath, contents.slice(0, -1), { mode: 0o600 });
    await assert.rejects(EvidenceJournal.open(journalPath), /torn or corrupt/);

    await writeFile(journalPath, `${contents}{not-json}\n`, { mode: 0o600 });
    await assert.rejects(EvidenceJournal.open(journalPath), /corrupt JSON/);
  });
});

test("external truncation poisons the open journal before another append", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-before-truncate"));
    await truncate(journalPath, 0);

    await assert.rejects(
      journal.append(event("evt-after-truncate")),
      /JOURNAL_FILE_IDENTITY_OR_SIZE_CHANGED/,
    );
    await assert.rejects(
      journal.append(event("evt-after-poison")),
      /Journal durability is uncertain/,
    );
    await journal.close();
  });
});

test("external path replacement poisons the open journal before another append", async () => {
  await withTempJournal(async (journalPath, root) => {
    const journal = await EvidenceJournal.open(journalPath);
    await journal.append(event("evt-before-replacement"));
    const displacedPath = join(root, "private", "events.displaced.jsonl");
    await rename(journalPath, displacedPath);
    await writeFile(journalPath, "", { mode: 0o600 });

    await assert.rejects(
      journal.append(event("evt-after-replacement")),
      /JOURNAL_FILE_IDENTITY_OR_SIZE_CHANGED/,
    );
    await journal.close();
  });
});

test("recursive secret-like evidence keys are rejected without writing", async () => {
  await withTempJournal(async (journalPath) => {
    const journal = await EvidenceJournal.open(journalPath);
    await assert.rejects(
      journal.append(
        event("evt-secret", {
          evidence: { safe: [{ nested: { api_key: "must-never-land-on-disk" } }] },
        }),
      ),
      /Forbidden secret key.*api_key/,
    );
    await assert.rejects(
      journal.append(event("evt-signature", { evidence: { proof: { paymentSignature: "0xsecret" } } })),
      /Forbidden secret key.*paymentSignature/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      journal.append(event("evt-cycle", { evidence: cyclic as JournalEventInput["evidence"] })),
      /must not contain a cycle/,
    );
    assert.deepEqual(journal.readAll(), []);
    assert.equal(await readFile(journalPath, "utf8"), "");
    await journal.close();
  });
});

test("a second in-process handle is rejected until the journal is closed", async () => {
  await withTempJournal(async (journalPath) => {
    const first = await EvidenceJournal.open(journalPath);
    await assert.rejects(EvidenceJournal.open(journalPath), /already open/);
    await first.close();

    const second = await EvidenceJournal.open(journalPath);
    await second.close();
  });
});

test("openExisting opens durable journal state without changing its identity", async () => {
  await withTempJournal(async (journalPath) => {
    const created = await EvidenceJournal.open(journalPath);
    const first = await created.append(event("evt-open-existing"));
    const journalId = created.journalId;
    await created.close();

    const existing = await EvidenceJournal.openExisting(journalPath);
    assert.equal(existing.journalId, journalId);
    assert.deepEqual(existing.readAll(), [first]);
    const second = await existing.append(
      event("evt-open-existing-second", {
        kind: "authorization_recorded",
        authorizationId: AUTHORIZATION_ID,
      }),
    );
    assert.equal(second.previousHash, first.recordHash);
    await existing.close();
  });
});

test("openExisting rejects a missing journal without creating parent, data, metadata, or lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-evidence-open-existing-missing-"));
  try {
    const missingParent = join(root, "must-not-exist");
    const missingPath = join(missingParent, "events.jsonl");
    await assert.rejects(EvidenceJournal.openExisting(missingPath));
    await assert.rejects(stat(missingParent));
    await assert.rejects(stat(missingPath));
    await assert.rejects(stat(`${missingPath}.meta.json`));
    await assert.rejects(stat(`${missingPath}.lock`));

    const existingParent = join(root, "existing");
    const seed = await EvidenceJournal.open(join(existingParent, "seed.jsonl"));
    await seed.close();
    const absentPath = join(existingParent, "absent.jsonl");
    await assert.rejects(
      EvidenceJournal.openExisting(absentPath),
      /Existing journal is required/,
    );
    await assert.rejects(stat(absentPath));
    await assert.rejects(stat(`${absentPath}.meta.json`));
    await assert.rejects(stat(`${absentPath}.lock`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openExisting rejects symlinked journal parents and final paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-evidence-open-existing-symlink-"));
  try {
    const realParent = join(root, "real");
    const realPath = join(realParent, "events.jsonl");
    const journal = await EvidenceJournal.open(realPath);
    await journal.append(event("evt-symlink-target"));
    await journal.close();

    const linkedParent = join(root, "linked-parent");
    await symlink(realParent, linkedParent, "dir");
    await assert.rejects(
      EvidenceJournal.openExisting(join(linkedParent, "events.jsonl")),
      /Existing journal directory must not be a symbolic link/,
    );

    const ordinaryParent = join(root, "ordinary");
    const ordinarySeed = await EvidenceJournal.open(join(ordinaryParent, "seed.jsonl"));
    await ordinarySeed.close();
    const linkedFinal = join(ordinaryParent, "events.jsonl");
    await symlink(realPath, linkedFinal, "file");
    await assert.rejects(
      EvidenceJournal.openExisting(linkedFinal),
      /Journal path must be a regular file and must not be a symbolic link/,
    );
    await assert.rejects(stat(`${linkedFinal}.lock`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a writer in another process excludes this process until clean close", async () => {
  await withTempJournal(async (journalPath) => {
    const holder = await startJournalHolder(journalPath);
    try {
      await assert.rejects(
        EvidenceJournal.open(journalPath),
        /Journal writer lock exists; verify that no writer is alive/,
      );
    } finally {
      await closeJournalHolder(holder);
    }

    const reopened = await EvidenceJournal.open(journalPath);
    await reopened.close();
  });
});

test("SIGKILL leaves a fail-closed sentinel that requires proven-dead manual recovery", async () => {
  await withTempJournal(async (journalPath) => {
    const holder = await startJournalHolder(journalPath);
    const exit = once(holder.child, "exit");
    assert.equal(holder.child.kill("SIGKILL"), true);
    const [code, signal] = (await exit) as [number | null, NodeJS.Signals | null];
    assert.equal(code, null, holder.stderr());
    assert.equal(signal, "SIGKILL", holder.stderr());

    const lockPath = `${journalPath}.lock`;
    assert.equal((await stat(lockPath)).isFile(), true);
    await assert.rejects(
      EvidenceJournal.open(journalPath),
      /manual stale-lock recovery/,
    );

    // The child exit above proves this test's writer is dead. Production callers
    // must make the equivalent operator determination before removing a sentinel.
    await unlink(lockPath);
    const recovered = await EvidenceJournal.open(journalPath);
    await recovered.close();
  });
});

test("opening a journal does not change permissions on an existing parent directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-evidence-existing-directory-"));
  try {
    await chmod(root, 0o755);
    const before = (await stat(root)).mode & 0o777;
    const journal = await EvidenceJournal.open(join(root, "events.jsonl"));
    assert.equal((await stat(root)).mode & 0o777, before);
    await journal.close();
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
