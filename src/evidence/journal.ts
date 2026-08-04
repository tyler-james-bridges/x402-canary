import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { JournalEventInput, JournalRecord, JsonValue } from "./types.js";
import { canonicalJson } from "./canonical.js";

const JOURNAL_RECORD_DOMAIN = "x402-canary:journal-record:v0.1";
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EVENT_KINDS = new Set([
  "attempt_opened",
  "authorization_recorded",
  "authorization_transmitted",
  "settlement_observed",
  "effect_observed",
  "attempt_closed",
]);
const MAX_RECORD_BYTES = 1_048_576;
const openJournalPaths = new Set<string>();

const FORBIDDEN_SECRET_KEYS = new Set([
  "authorization",
  "authorizationheader",
  "apikey",
  "accesstoken",
  "bearertoken",
  "clientsecret",
  "mnemonic",
  "payment",
  "paymentauthorization",
  "paymentcredential",
  "paymentheader",
  "paymenttoken",
  "privatekey",
  "rawsignedtransaction",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seedphrase",
  "signedauthorization",
  "signedpayload",
  "token",
  "x402payment",
  "xpayment",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeSecretKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenSecretKey(key: string): boolean {
  const normalized = normalizeSecretKey(key);
  return (
    FORBIDDEN_SECRET_KEYS.has(normalized) ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("signature")
  );
}

function assertNoForbiddenSecretKeys(
  value: unknown,
  path = "evidence",
  ancestors: Set<object> = new Set(),
): void {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`Evidence must not contain a cycle at ${path}`);
    ancestors.add(value);
    try {
      value.forEach((item, index) =>
        assertNoForbiddenSecretKeys(item, `${path}[${index}]`, ancestors),
      );
    } finally {
      ancestors.delete(value);
    }
    return;
  }
  if (!isPlainObject(value)) return;

  if (ancestors.has(value)) throw new Error(`Evidence must not contain a cycle at ${path}`);
  ancestors.add(value);
  try {
    for (const [key, nested] of Object.entries(value)) {
      if (isForbiddenSecretKey(key)) {
        throw new Error(`Forbidden secret key at ${path}.${key}`);
      }
      assertNoForbiddenSecretKeys(nested, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unexpected field: ${key}`);
  }
}

function assertIdentifier(value: unknown, field: string, hashOnly = false): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${field} must be a non-empty string no longer than 256 characters`);
  }
  if (hashOnly && !HASH_PATTERN.test(value)) {
    throw new Error(`${field} must be a sha256 identity`);
  }
  if (!hashOnly && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${field} contains prohibited characters`);
  }
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function normalizeEvent(input: unknown): JournalEventInput {
  if (!isPlainObject(input)) throw new Error("Journal event must be a plain object");
  const allowed = new Set(["eventId", "operationId", "authorizationId", "kind", "occurredAt", "evidence"]);
  assertExactKeys(input, allowed, "Journal event");

  assertIdentifier(input.eventId, "eventId");
  assertIdentifier(input.operationId, "operationId", true);
  if (input.authorizationId !== undefined) {
    assertIdentifier(input.authorizationId, "authorizationId", true);
  }
  if (typeof input.kind !== "string" || !EVENT_KINDS.has(input.kind)) {
    throw new Error(`Unsupported journal event kind: ${String(input.kind)}`);
  }
  if (
    typeof input.occurredAt !== "string" ||
    Number.isNaN(Date.parse(input.occurredAt)) ||
    new Date(input.occurredAt).toISOString() !== input.occurredAt
  ) {
    throw new Error("occurredAt must be a canonical ISO-8601 UTC timestamp");
  }

  if (input.evidence !== undefined) {
    assertNoForbiddenSecretKeys(input.evidence);
    canonicalJson(input.evidence as JsonValue);
  }

  const normalized: JournalEventInput = {
    eventId: input.eventId,
    operationId: input.operationId,
    kind: input.kind as JournalEventInput["kind"],
    occurredAt: input.occurredAt,
  };
  if (input.authorizationId !== undefined) normalized.authorizationId = input.authorizationId;
  if (input.evidence !== undefined) normalized.evidence = cloneJson(input.evidence as JsonValue);
  return normalized;
}

function hashRecord(record: Omit<JournalRecord, "recordHash">): string {
  const preimage = `${JOURNAL_RECORD_DOMAIN}\n${canonicalJson(record as unknown as JsonValue)}`;
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

export function validateJournalRecord(
  raw: unknown,
  expectedSequence: number,
  expectedPreviousHash: string | null,
): JournalRecord {
  if (!isPlainObject(raw)) throw new Error(`Journal record ${expectedSequence} must be an object`);
  const allowed = new Set([
    "sequence",
    "previousHash",
    "recordHash",
    "eventId",
    "operationId",
    "authorizationId",
    "kind",
    "occurredAt",
    "evidence",
  ]);
  assertExactKeys(raw, allowed, `Journal record ${expectedSequence}`);

  if (raw.sequence !== expectedSequence) {
    throw new Error(`Journal sequence mismatch: expected ${expectedSequence}`);
  }
  if (raw.previousHash !== expectedPreviousHash) {
    throw new Error(`Journal previousHash mismatch at sequence ${expectedSequence}`);
  }
  if (typeof raw.recordHash !== "string" || !HASH_PATTERN.test(raw.recordHash)) {
    throw new Error(`Invalid recordHash at sequence ${expectedSequence}`);
  }

  const event = normalizeEvent({
    eventId: raw.eventId,
    operationId: raw.operationId,
    ...(raw.authorizationId === undefined ? {} : { authorizationId: raw.authorizationId }),
    kind: raw.kind,
    occurredAt: raw.occurredAt,
    ...(raw.evidence === undefined ? {} : { evidence: raw.evidence }),
  });
  const withoutHash: Omit<JournalRecord, "recordHash"> = {
    ...event,
    sequence: expectedSequence,
    previousHash: expectedPreviousHash,
  };
  const expectedHash = hashRecord(withoutHash);
  if (raw.recordHash !== expectedHash) {
    throw new Error(`Journal recordHash mismatch at sequence ${expectedSequence}`);
  }

  return { ...withoutHash, recordHash: raw.recordHash };
}

export interface JournalHead {
  sequence: number;
  recordHash: string | null;
}

/** Revalidates an in-memory chain and returns its append head. */
export function deriveJournalHead(records: readonly JournalRecord[]): JournalHead {
  let previousHash: string | null = null;
  const eventIds = new Set<string>();
  for (const [index, raw] of records.entries()) {
    const record = validateJournalRecord(raw, index + 1, previousHash);
    if (eventIds.has(record.eventId)) throw new Error(`Duplicate eventId in journal: ${record.eventId}`);
    eventIds.add(record.eventId);
    previousHash = record.recordHash;
  }
  return { sequence: records.length, recordHash: previousHash };
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // ACLs and some filesystems do not support POSIX modes. The journal's
    // integrity checks remain fail-closed even when mode hardening is unavailable.
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, constants.O_RDONLY);
    await directory.sync();
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function readAndValidate(handle: FileHandle): Promise<JournalRecord[]> {
  const contents = await handle.readFile({ encoding: "utf8" });
  if (contents.length === 0) return [];
  if (!contents.endsWith("\n")) {
    throw new Error("Journal is torn or corrupt: final record is not newline-terminated");
  }

  const lines = contents.slice(0, -1).split("\n");
  const records: JournalRecord[] = [];
  const eventIds = new Set<string>();
  let previousHash: string | null = null;

  for (const [index, line] of lines.entries()) {
    const sequence = index + 1;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`Journal record ${sequence} exceeds the size limit`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Journal record ${sequence} is corrupt JSON`);
    }
    if (canonicalJson(raw as JsonValue) !== line) {
      throw new Error(`Journal record ${sequence} is not canonical JSON`);
    }

    const record = validateJournalRecord(raw, sequence, previousHash);
    if (eventIds.has(record.eventId)) {
      throw new Error(`Duplicate eventId in journal: ${record.eventId}`);
    }
    eventIds.add(record.eventId);
    records.push(record);
    previousHash = record.recordHash;
  }

  return records;
}

export class EvidenceJournal {
  readonly path: string;
  private readonly handle: FileHandle;
  private readonly records: JournalRecord[];
  private readonly eventIds: Set<string>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned: Error | undefined;

  private constructor(path: string, handle: FileHandle, records: JournalRecord[]) {
    this.path = path;
    this.handle = handle;
    this.records = records;
    this.eventIds = new Set(records.map((record) => record.eventId));
  }

  static async open(path: string): Promise<EvidenceJournal> {
    if (typeof path !== "string" || path.length === 0) throw new Error("Journal path is required");
    const absolutePath = resolve(path);
    if (openJournalPaths.has(absolutePath)) {
      throw new Error(`Journal is already open in this process: ${absolutePath}`);
    }
    openJournalPaths.add(absolutePath);

    let handle: FileHandle | undefined;
    try {
      const directoryPath = dirname(absolutePath);
      const createdDirectory = await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      if (createdDirectory !== undefined) await chmodBestEffort(directoryPath, 0o700);

      try {
        const existing = await lstat(absolutePath);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("Journal path must be a regular file and must not be a symbolic link");
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }

      const flags = constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
      handle = await open(absolutePath, flags, 0o600);
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw new Error("Journal path must resolve to a regular file");
      await chmodBestEffort(absolutePath, 0o600);

      const records = await readAndValidate(handle);
      await handle.sync();
      await syncDirectoryBestEffort(directoryPath);
      return new EvidenceJournal(absolutePath, handle, records);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      openJournalPaths.delete(absolutePath);
      throw error;
    }
  }

  readAll(): JournalRecord[] {
    return cloneJson(this.records);
  }

  head(): JournalHead {
    return {
      sequence: this.records.length,
      recordHash: this.records.at(-1)?.recordHash ?? null,
    };
  }

  append(event: JournalEventInput): Promise<JournalRecord> {
    if (this.closed) return Promise.reject(new Error("Journal is closed"));
    if (this.poisoned) return Promise.reject(this.poisoned);

    const result = this.queue.then(() => this.appendSerialized(event));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appendSerialized(input: JournalEventInput): Promise<JournalRecord> {
    if (this.poisoned) throw this.poisoned;
    const event = normalizeEvent(input);
    if (this.eventIds.has(event.eventId)) {
      throw new Error(`Duplicate eventId: ${event.eventId}`);
    }

    const sequence = this.records.length + 1;
    const previousHash = this.records.at(-1)?.recordHash ?? null;
    const withoutHash: Omit<JournalRecord, "recordHash"> = {
      ...event,
      sequence,
      previousHash,
    };
    const record: JournalRecord = { ...withoutHash, recordHash: hashRecord(withoutHash) };
    const line = `${canonicalJson(record as unknown as JsonValue)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`Journal record exceeds the ${MAX_RECORD_BYTES}-byte size limit`);
    }

    try {
      await this.handle.writeFile(line, { encoding: "utf8" });
      await this.handle.sync();
    } catch (error) {
      this.poisoned = new Error(
        `Journal durability is uncertain; close and validate before continuing: ${errorMessage(error)}`,
      );
      throw this.poisoned;
    }

    this.records.push(record);
    this.eventIds.add(record.eventId);
    return cloneJson(record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try {
      await this.handle.close();
    } finally {
      openJournalPaths.delete(this.path);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
