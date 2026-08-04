import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveJournalHead, EvidenceJournal, validateJournalRecord } from "../evidence/journal.js";
import type { JournalEventInput } from "../evidence/types.js";

const OPERATION_ID = `sha256:${"a".repeat(64)}`;
const AUTHORIZATION_ID = `sha256:${"b".repeat(64)}`;

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
    assert.deepEqual(journal.head(), { sequence: 2, recordHash: second.recordHash });
    assert.deepEqual(deriveJournalHead(journal.readAll()), journal.head());
    assert.deepEqual(validateJournalRecord(second, 2, first.recordHash), second);
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
