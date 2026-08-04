import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

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
  "kernel_input_committed",
  "kernel_bundle_committed",
  "attempt_closed",
]);
const MAX_RECORD_BYTES = 1_048_576;
const openJournalPaths = new Set<string>();
const JOURNAL_METADATA_FIELDS = new Set(["schemaVersion", "journalId"]);

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
  expectedJournalId: string,
  expectedSequence: number,
  expectedPreviousHash: string | null,
): JournalRecord {
  if (!isPlainObject(raw)) throw new Error(`Journal record ${expectedSequence} must be an object`);
  const allowed = new Set([
    "sequence",
    "journalId",
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

  if (raw.journalId !== expectedJournalId || !HASH_PATTERN.test(expectedJournalId)) {
    throw new Error(`Journal ID mismatch at sequence ${expectedSequence}`);
  }

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
    journalId: expectedJournalId,
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
  journalId: string;
  sequence: number;
  recordHash: string | null;
}

export class JournalHeadConflictError extends Error {
  constructor(
    readonly expected: JournalHead,
    readonly actual: JournalHead,
  ) {
    super("JOURNAL_HEAD_CONFLICT");
    this.name = "JournalHeadConflictError";
  }
}

export interface JournalAppendOnceResult {
  record: JournalRecord;
  replayed: boolean;
  currentHead: JournalHead;
}

function normalizeJournalHead(input: unknown): JournalHead {
  if (!isPlainObject(input)) throw new Error("Expected journal head must be an object");
  assertExactKeys(input, new Set(["journalId", "sequence", "recordHash"]), "Expected journal head");
  if (typeof input.journalId !== "string" || !HASH_PATTERN.test(input.journalId)) {
    throw new Error("Expected journal head journalId must be a sha256 identity");
  }
  if (
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0
  ) throw new Error("Expected journal head sequence must be a non-negative safe integer");
  if (
    (input.sequence === 0 && input.recordHash !== null) ||
    (input.sequence > 0 && (typeof input.recordHash !== "string" || !HASH_PATTERN.test(input.recordHash)))
  ) throw new Error("Expected journal head hash is inconsistent with its sequence");
  return {
    journalId: input.journalId,
    sequence: input.sequence,
    recordHash: input.recordHash as string | null,
  };
}

function sameHead(left: JournalHead, right: JournalHead): boolean {
  return (
    left.journalId === right.journalId &&
    left.sequence === right.sequence &&
    left.recordHash === right.recordHash
  );
}

/** Revalidates an in-memory chain and returns its append head. */
export function deriveJournalHead(
  records: readonly JournalRecord[],
  journalId: string,
): JournalHead {
  if (!HASH_PATTERN.test(journalId)) throw new Error("journalId must be a sha256 identity");
  let previousHash: string | null = null;
  const eventIds = new Set<string>();
  for (const [index, raw] of records.entries()) {
    const record = validateJournalRecord(raw, journalId, index + 1, previousHash);
    if (eventIds.has(record.eventId)) throw new Error(`Duplicate eventId in journal: ${record.eventId}`);
    eventIds.add(record.eventId);
    previousHash = record.recordHash;
  }
  return { journalId, sequence: records.length, recordHash: previousHash };
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

async function syncDirectoryRequired(path: string, code: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, constants.O_RDONLY);
    await directory.sync();
  } catch {
    throw new Error(code);
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

interface JournalMetadata {
  schemaVersion: "0.1";
  journalId: string;
}

async function readMetadataFile(path: string): Promise<JournalMetadata> {
  const metadataStat = await lstat(path);
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
    throw new Error("Journal metadata must be a regular file and not a symbolic link");
  }
  if (metadataStat.size > 4_096) throw new Error("Journal metadata exceeds the size limit");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const text = await handle.readFile({ encoding: "utf8" });
    if (!text.endsWith("\n")) throw new Error("Journal metadata is torn or corrupt");
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(0, -1)) as unknown;
    } catch {
      throw new Error("Journal metadata is corrupt JSON");
    }
    if (!isPlainObject(raw)) throw new Error("Journal metadata must be an object");
    assertExactKeys(raw, JOURNAL_METADATA_FIELDS, "Journal metadata");
    if (raw.schemaVersion !== "0.1" || typeof raw.journalId !== "string" || !HASH_PATTERN.test(raw.journalId)) {
      throw new Error("Journal metadata is invalid");
    }
    if (`${canonicalJson(raw as JsonValue)}\n` !== text) {
      throw new Error("Journal metadata is not canonical JSON");
    }
    return { schemaVersion: "0.1", journalId: raw.journalId };
  } finally {
    await handle.close();
  }
}

async function loadOrCreateMetadata(
  journalPath: string,
  directoryPath: string,
  allowCreate: boolean,
): Promise<JournalMetadata> {
  const metadataPath = `${journalPath}.meta.json`;
  try {
    const existing = await readMetadataFile(metadataPath);
    if (allowCreate) {
      throw new Error(
        "Journal metadata exists while the journal is missing; manual recovery is required",
      );
    }
    return existing;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  if (!allowCreate) {
    throw new Error("Journal metadata is missing for an existing journal");
  }

  const metadata: JournalMetadata = {
    schemaVersion: "0.1",
    journalId: `sha256:${randomBytes(32).toString("hex")}`,
  };
  const temporaryPath = `${metadataPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${canonicalJson(metadata as unknown as JsonValue)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await link(temporaryPath, metadataPath);
    published = true;
    await syncDirectoryRequired(directoryPath, "Journal metadata directory sync failed");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      if (!published) await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    const existing = await readMetadataFile(metadataPath);
    if (existing.journalId !== metadata.journalId) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new Error("Journal metadata publication conflict");
    }
    await syncDirectoryRequired(directoryPath, "Journal metadata directory sync failed");
  }
  await unlink(temporaryPath);
  await syncDirectoryRequired(directoryPath, "Journal metadata cleanup sync failed");
  await chmodBestEffort(metadataPath, 0o600);
  return metadata;
}

async function acquireWriterLock(
  journalPath: string,
  directoryPath: string,
): Promise<{ path: string; handle: FileHandle; device: number; inode: number }> {
  const lockPath = `${journalPath}.lock`;
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(
        "Journal writer lock exists; verify that no writer is alive before manual stale-lock recovery",
      );
    }
    throw error;
  }
  try {
    const lockRecord = {
      schemaVersion: "0.1",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    await handle.writeFile(`${canonicalJson(lockRecord)}\n`, "utf8");
    await handle.sync();
    await syncDirectoryBestEffort(directoryPath);
    const identity = await handle.stat();
    return { path: lockPath, handle, device: identity.dev, inode: identity.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

async function releaseWriterLock(
  lockPath: string,
  handle: FileHandle,
  device: number,
  inode: number,
): Promise<void> {
  let ownsPath = false;
  try {
    const handleIdentity = await handle.stat();
    const pathIdentity = await lstat(lockPath);
    ownsPath =
      pathIdentity.isFile() &&
      !pathIdentity.isSymbolicLink() &&
      handleIdentity.dev === device &&
      handleIdentity.ino === inode &&
      pathIdentity.dev === device &&
      pathIdentity.ino === inode;
  } catch {
    ownsPath = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!ownsPath) throw new Error("Journal writer lock identity changed");
  await unlink(lockPath);
  await syncDirectoryBestEffort(dirname(lockPath));
}

function assertLifecycleAppend(records: readonly JournalRecord[], event: JournalEventInput): void {
  const globalLast = records.at(-1);
  if (globalLast?.kind === "kernel_input_committed") {
    if (
      event.kind !== "kernel_bundle_committed" ||
      event.operationId !== globalLast.operationId ||
      event.authorizationId !== globalLast.authorizationId
    ) {
      throw new Error("JOURNAL_INPUT_AWAITS_ADJACENT_BUNDLE");
    }
  } else if (event.kind === "kernel_bundle_committed") {
    throw new Error("JOURNAL_BUNDLE_MUST_BE_GLOBALLY_ADJACENT_TO_INPUT");
  }

  const operationRecords = records.filter((record) => record.operationId === event.operationId);
  const closed = operationRecords.some(
    (record) => record.kind === "attempt_closed" || record.kind === "kernel_bundle_committed",
  );
  if (closed) throw new Error("JOURNAL_OPERATION_ALREADY_CLOSED");

  if (event.kind === "kernel_input_committed") {
    const opens = operationRecords.filter((record) => record.kind === "attempt_opened");
    if (opens.length !== 1) throw new Error("JOURNAL_INPUT_REQUIRES_EXACTLY_ONE_OPEN");
    if (operationRecords.some((record) => record.kind === "kernel_input_committed")) {
      throw new Error("JOURNAL_INPUT_ALREADY_COMMITTED");
    }
  }
  if (event.kind === "kernel_bundle_committed") {
    const inputs = operationRecords.filter((record) => record.kind === "kernel_input_committed");
    if (inputs.length !== 1) throw new Error("JOURNAL_BUNDLE_REQUIRES_EXACTLY_ONE_INPUT");
    if (inputs[0]!.authorizationId !== event.authorizationId) {
      throw new Error("JOURNAL_BUNDLE_AUTHORIZATION_MISMATCH");
    }
  }
}

function eventFromRecord(record: JournalRecord): JournalEventInput {
  return {
    eventId: record.eventId,
    operationId: record.operationId,
    ...(record.authorizationId === undefined ? {} : { authorizationId: record.authorizationId }),
    kind: record.kind,
    occurredAt: record.occurredAt,
    ...(record.evidence === undefined ? {} : { evidence: record.evidence }),
  };
}

async function readAndValidate(handle: FileHandle, journalId: string): Promise<JournalRecord[]> {
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

    const record = validateJournalRecord(raw, journalId, sequence, previousHash);
    if (eventIds.has(record.eventId)) {
      throw new Error(`Duplicate eventId in journal: ${record.eventId}`);
    }
    eventIds.add(record.eventId);
    records.push(record);
    previousHash = record.recordHash;
  }

  const prior: JournalRecord[] = [];
  for (const record of records) {
    assertLifecycleAppend(prior, eventFromRecord(record));
    prior.push(record);
  }

  return records;
}

export class EvidenceJournal {
  readonly path: string;
  readonly journalId: string;
  private readonly handle: FileHandle;
  private readonly lockHandle: FileHandle;
  private readonly lockPath: string;
  private readonly lockDevice: number;
  private readonly lockInode: number;
  private readonly records: JournalRecord[];
  private readonly eventIds: Set<string>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned: Error | undefined;
  private readonly device: number;
  private readonly inode: number;
  private expectedSize: number;

  private constructor(
    path: string,
    journalId: string,
    handle: FileHandle,
    lockPath: string,
    lockHandle: FileHandle,
    lockDevice: number,
    lockInode: number,
    device: number,
    inode: number,
    expectedSize: number,
    records: JournalRecord[],
  ) {
    this.path = path;
    this.journalId = journalId;
    this.handle = handle;
    this.lockPath = lockPath;
    this.lockHandle = lockHandle;
    this.lockDevice = lockDevice;
    this.lockInode = lockInode;
    this.device = device;
    this.inode = inode;
    this.expectedSize = expectedSize;
    this.records = records;
    this.eventIds = new Set(records.map((record) => record.eventId));
  }

  static async open(path: string): Promise<EvidenceJournal> {
    return EvidenceJournal.openInternal(path, true);
  }

  /** Open an existing operator journal without creating its directory, data, or metadata. */
  static async openExisting(path: string): Promise<EvidenceJournal> {
    return EvidenceJournal.openInternal(path, false);
  }

  private static async openInternal(
    path: string,
    allowCreate: boolean,
  ): Promise<EvidenceJournal> {
    if (typeof path !== "string" || path.length === 0) throw new Error("Journal path is required");
    const absolutePath = resolve(path);
    if (openJournalPaths.has(absolutePath)) {
      throw new Error(`Journal is already open in this process: ${absolutePath}`);
    }
    openJournalPaths.add(absolutePath);

    let handle: FileHandle | undefined;
    let writerLock:
      | { path: string; handle: FileHandle; device: number; inode: number }
      | undefined;
    try {
      const directoryPath = dirname(absolutePath);
      if (allowCreate) {
        const createdDirectory = await mkdir(directoryPath, { recursive: true, mode: 0o700 });
        if (createdDirectory !== undefined) await chmodBestEffort(directoryPath, 0o700);
      } else {
        const directory = await lstat(directoryPath);
        if (directory.isSymbolicLink() || !directory.isDirectory()) {
          throw new Error("Existing journal directory must not be a symbolic link");
        }
      }

      writerLock = await acquireWriterLock(absolutePath, directoryPath);
      let journalExisted = false;
      try {
        const existing = await lstat(absolutePath);
        journalExisted = true;
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error("Journal path must be a regular file and must not be a symbolic link");
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      if (!journalExisted && !allowCreate) {
        throw new Error("Existing journal is required");
      }

      const metadata = await loadOrCreateMetadata(
        absolutePath,
        directoryPath,
        allowCreate && !journalExisted,
      );

      const flags =
        constants.O_APPEND |
        constants.O_RDWR |
        (allowCreate ? constants.O_CREAT : 0) |
        (constants.O_NOFOLLOW ?? 0);
      handle = await open(absolutePath, flags, 0o600);
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw new Error("Journal path must resolve to a regular file");
      await chmodBestEffort(absolutePath, 0o600);

      const records = await readAndValidate(handle, metadata.journalId);
      await handle.sync();
      await syncDirectoryRequired(directoryPath, "Journal directory sync failed");
      const openedIdentity = await handle.stat();
      return new EvidenceJournal(
        absolutePath,
        metadata.journalId,
        handle,
        writerLock.path,
        writerLock.handle,
        writerLock.device,
        writerLock.inode,
        openedIdentity.dev,
        openedIdentity.ino,
        openedIdentity.size,
        records,
      );
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (writerLock) {
        await releaseWriterLock(
          writerLock.path,
          writerLock.handle,
          writerLock.device,
          writerLock.inode,
        ).catch(() => undefined);
      }
      openJournalPaths.delete(absolutePath);
      throw error;
    }
  }

  readAll(): JournalRecord[] {
    return cloneJson(this.records);
  }

  head(): JournalHead {
    return {
      journalId: this.journalId,
      sequence: this.records.length,
      recordHash: this.records.at(-1)?.recordHash ?? null,
    };
  }

  append(event: JournalEventInput): Promise<JournalRecord> {
    if (this.closed) return Promise.reject(new Error("Journal is closed"));
    if (this.poisoned) return Promise.reject(this.poisoned);
    let normalized: JournalEventInput;
    try {
      normalized = normalizeEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(() => this.appendSerialized(normalized));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  appendAtHead(expectedHead: JournalHead, event: JournalEventInput): Promise<JournalRecord> {
    if (this.closed) return Promise.reject(new Error("Journal is closed"));
    if (this.poisoned) return Promise.reject(this.poisoned);
    let expected: JournalHead;
    let normalized: JournalEventInput;
    try {
      expected = normalizeJournalHead(expectedHead);
      normalized = normalizeEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(() => this.appendSerialized(normalized, expected));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  appendOnceAtHead(
    expectedHead: JournalHead,
    event: JournalEventInput,
  ): Promise<JournalAppendOnceResult> {
    if (this.closed) return Promise.reject(new Error("Journal is closed"));
    if (this.poisoned) return Promise.reject(this.poisoned);
    let expected: JournalHead;
    let normalized: JournalEventInput;
    try {
      expected = normalizeJournalHead(expectedHead);
      normalized = normalizeEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(() => this.appendOnceSerialized(normalized, expected));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appendOnceSerialized(
    event: JournalEventInput,
    expectedHead: JournalHead,
  ): Promise<JournalAppendOnceResult> {
    if (expectedHead.journalId !== this.journalId) {
      throw new JournalHeadConflictError(expectedHead, this.head());
    }
    const existing = this.records.find((record) => record.eventId === event.eventId);
    if (existing) {
      if (canonicalJson(eventFromRecord(existing)) !== canonicalJson(event)) {
        throw new Error("JOURNAL_EVENT_ID_CONFLICT");
      }
      if (
        existing.sequence !== expectedHead.sequence + 1 ||
        existing.previousHash !== expectedHead.recordHash
      ) throw new Error("JOURNAL_EVENT_REPLAY_HEAD_MISMATCH");
      return { record: cloneJson(existing), replayed: true, currentHead: this.head() };
    }
    const record = await this.appendSerialized(event, expectedHead);
    return { record, replayed: false, currentHead: this.head() };
  }

  private async appendSerialized(
    event: JournalEventInput,
    expectedHead?: JournalHead,
  ): Promise<JournalRecord> {
    if (this.poisoned) throw this.poisoned;
    const actualHead = this.head();
    if (expectedHead && !sameHead(expectedHead, actualHead)) {
      throw new JournalHeadConflictError(expectedHead, actualHead);
    }
    if (this.eventIds.has(event.eventId)) {
      throw new Error(`Duplicate eventId: ${event.eventId}`);
    }
    assertLifecycleAppend(this.records, event);

    const sequence = this.records.length + 1;
    const previousHash = this.records.at(-1)?.recordHash ?? null;
    const withoutHash: Omit<JournalRecord, "recordHash"> = {
      ...event,
      journalId: this.journalId,
      sequence,
      previousHash,
    };
    const record: JournalRecord = { ...withoutHash, recordHash: hashRecord(withoutHash) };
    const line = `${canonicalJson(record as unknown as JsonValue)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`Journal record exceeds the ${MAX_RECORD_BYTES}-byte size limit`);
    }

    try {
      const handleStat = await this.handle.stat();
      const pathStat = await lstat(this.path);
      if (
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        handleStat.dev !== this.device ||
        handleStat.ino !== this.inode ||
        pathStat.dev !== this.device ||
        pathStat.ino !== this.inode ||
        handleStat.size !== this.expectedSize ||
        pathStat.size !== this.expectedSize
      ) throw new Error("JOURNAL_FILE_IDENTITY_OR_SIZE_CHANGED");

      const bytes = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.handle.write(bytes, offset, bytes.length - offset, null);
        if (bytesWritten <= 0) throw new Error("JOURNAL_SHORT_WRITE");
        offset += bytesWritten;
      }
      await this.handle.sync();
      const after = await this.handle.stat();
      if (after.size !== this.expectedSize + bytes.length) {
        throw new Error("JOURNAL_SIZE_AFTER_WRITE_MISMATCH");
      }
      this.expectedSize = after.size;
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
    let journalClosed = false;
    try {
      await this.handle.close();
      journalClosed = true;
    } finally {
      openJournalPaths.delete(this.path);
    }
    if (journalClosed) {
      await releaseWriterLock(
        this.lockPath,
        this.lockHandle,
        this.lockDevice,
        this.lockInode,
      );
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
