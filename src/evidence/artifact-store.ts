import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { canonicalJson } from "./canonical.js";
import type { JsonValue } from "./types.js";

const ARTIFACT_DOMAIN = "x402-canary:evidence-artifact:v0.2";
const HASH = /^sha256:[0-9a-f]{64}$/;
const NAMESPACE = /^[a-z][a-z0-9._-]{0,63}$/;
const STORED_FIELDS = new Set(["schemaVersion", "namespace", "payload", "artifactHash"]);
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

interface StoredArtifact {
  schemaVersion: "0.2";
  namespace: string;
  payload: JsonValue;
  artifactHash: string;
}

export interface ArtifactReceipt {
  schemaVersion: "0.2";
  namespace: string;
  artifactHash: string;
  byteLength: number;
}

export interface ArtifactReferenceInput {
  namespace: string;
  artifactHash: string;
  byteLength: number;
}

export interface ArtifactStoreInspection {
  artifacts: ArtifactReceipt[];
  temporaryFiles: string[];
  unexpectedFiles: string[];
  errors: string[];
}

export class EvidenceArtifactError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvidenceArtifactError";
  }
}

function fail(code: string): never {
  throw new EvidenceArtifactError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown): JsonValue {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
    canonicalJson(cloned);
  } catch {
    return fail("ARTIFACT_PAYLOAD_INVALID");
  }
  return cloned as JsonValue;
}

function requireNamespace(value: unknown): string {
  if (typeof value !== "string" || !NAMESPACE.test(value)) fail("ARTIFACT_NAMESPACE_INVALID");
  return value;
}

function requireHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail("ARTIFACT_HASH_INVALID");
  return value;
}

function artifactHash(namespace: string, payload: JsonValue): string {
  const content = { schemaVersion: "0.2", namespace, payload };
  return `sha256:${createHash("sha256")
    .update(`${ARTIFACT_DOMAIN}\n${canonicalJson(content)}`, "utf8")
    .digest("hex")}`;
}

function fileNameForHash(hash: string): string {
  return `${hash.slice("sha256:".length)}.json`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function syncDirectoryRequired(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    return fail("ARTIFACT_DIRECTORY_SYNC_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStoredArtifact(path: string): Promise<{ stored: StoredArtifact; byteLength: number }> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail("ARTIFACT_FILE_INVALID");
  if (metadata.size <= 0 || metadata.size > MAX_ARTIFACT_BYTES) fail("ARTIFACT_SIZE_INVALID");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const text = await handle.readFile({ encoding: "utf8" });
    if (!text.endsWith("\n")) fail("ARTIFACT_TORN_OR_CORRUPT");
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(0, -1)) as unknown;
    } catch {
      return fail("ARTIFACT_JSON_INVALID");
    }
    if (!isRecord(raw)) fail("ARTIFACT_SHAPE_INVALID");
    const keys = Object.keys(raw);
    if (
      keys.length !== STORED_FIELDS.size ||
      keys.some((key) => !STORED_FIELDS.has(key)) ||
      [...STORED_FIELDS].some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
    ) fail("ARTIFACT_SHAPE_INVALID");
    if (raw.schemaVersion !== "0.2") fail("ARTIFACT_SCHEMA_INVALID");
    const namespace = requireNamespace(raw.namespace);
    const payload = cloneJson(raw.payload);
    const hash = requireHash(raw.artifactHash);
    if (artifactHash(namespace, payload) !== hash) fail("ARTIFACT_INTEGRITY_MISMATCH");
    if (`${canonicalJson(raw)}\n` !== text) fail("ARTIFACT_NOT_CANONICAL");
    return {
      stored: { schemaVersion: "0.2", namespace, payload, artifactHash: hash },
      byteLength: Buffer.byteLength(text, "utf8"),
    };
  } finally {
    await handle.close();
  }
}

/** Private, immutable, content-addressed storage for verified evidence artifacts. */
export class EvidenceArtifactStore {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<EvidenceArtifactStore> {
    if (typeof root !== "string" || root.length === 0) fail("ARTIFACT_ROOT_REQUIRED");
    const absolute = resolve(root);
    const created = await mkdir(absolute, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(absolute, 0o700).catch(() => undefined);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("ARTIFACT_ROOT_INVALID");
    return new EvidenceArtifactStore(absolute);
  }

  async put(namespaceInput: string, payloadInput: unknown): Promise<ArtifactReceipt> {
    const namespace = requireNamespace(namespaceInput);
    const payload = cloneJson(payloadInput);
    const hash = artifactHash(namespace, payload);
    const stored: StoredArtifact = {
      schemaVersion: "0.2",
      namespace,
      payload,
      artifactHash: hash,
    };
    const line = `${canonicalJson(stored)}\n`;
    const byteLength = Buffer.byteLength(line, "utf8");
    if (byteLength > MAX_ARTIFACT_BYTES) fail("ARTIFACT_SIZE_INVALID");
    const finalPath = resolve(this.root, fileNameForHash(hash));

    try {
      const existing = await readStoredArtifact(finalPath);
      if (existing.stored.artifactHash !== hash || existing.stored.namespace !== namespace) {
        fail("ARTIFACT_EXISTING_FILE_CONFLICT");
      }
      await syncDirectoryRequired(this.root);
      return { schemaVersion: "0.2", namespace, artifactHash: hash, byteLength: existing.byteLength };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    const temporaryName = `.${hash.slice("sha256:".length)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const temporaryPath = resolve(this.root, temporaryName);
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    let finalCommitted = false;
    try {
      await link(temporaryPath, finalPath);
      await chmod(finalPath, 0o600).catch(() => undefined);
      await syncDirectoryRequired(this.root);
      finalCommitted = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        if (!(error instanceof EvidenceArtifactError && error.code === "ARTIFACT_DIRECTORY_SYNC_FAILED")) {
          await unlink(temporaryPath).catch(() => undefined);
        }
        throw error;
      }
      const existing = await readStoredArtifact(finalPath);
      if (existing.stored.artifactHash !== hash || existing.stored.namespace !== namespace) {
        await unlink(temporaryPath).catch(() => undefined);
        fail("ARTIFACT_EXISTING_FILE_CONFLICT");
      }
      await syncDirectoryRequired(this.root);
      finalCommitted = true;
    }
    if (finalCommitted) {
      const removed = await unlink(temporaryPath).then(
        () => true,
        () => false,
      );
      if (removed) await syncDirectoryRequired(this.root);
    }
    return { schemaVersion: "0.2", namespace, artifactHash: hash, byteLength };
  }

  async get(namespaceInput: string, hashInput: string): Promise<JsonValue> {
    const namespace = requireNamespace(namespaceInput);
    const hash = requireHash(hashInput);
    const filePath = resolve(this.root, fileNameForHash(hash));
    const { stored } = await readStoredArtifact(filePath);
    if (stored.artifactHash !== hash || stored.namespace !== namespace) {
      fail("ARTIFACT_REFERENCE_MISMATCH");
    }
    return cloneJson(stored.payload);
  }

  /** Read an artifact while enforcing the complete content-addressed receipt. */
  async getByReference(reference: ArtifactReferenceInput): Promise<JsonValue> {
    if (!isRecord(reference)) fail("ARTIFACT_REFERENCE_INVALID");
    const namespace = requireNamespace(reference.namespace);
    const hash = requireHash(reference.artifactHash);
    if (
      typeof reference.byteLength !== "number" ||
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength <= 0 ||
      reference.byteLength > MAX_ARTIFACT_BYTES
    ) fail("ARTIFACT_REFERENCE_SIZE_INVALID");
    const filePath = resolve(this.root, fileNameForHash(hash));
    const { stored, byteLength } = await readStoredArtifact(filePath);
    if (
      stored.artifactHash !== hash ||
      stored.namespace !== namespace ||
      byteLength !== reference.byteLength
    ) fail("ARTIFACT_REFERENCE_MISMATCH");
    return cloneJson(stored.payload);
  }

  async inspect(): Promise<ArtifactStoreInspection> {
    const names = (await readdir(this.root)).sort();
    const inspection: ArtifactStoreInspection = {
      artifacts: [],
      temporaryFiles: [],
      unexpectedFiles: [],
      errors: [],
    };
    for (const name of names) {
      if (name.startsWith(".") && name.endsWith(".tmp")) {
        inspection.temporaryFiles.push(name);
        continue;
      }
      if (!/^[0-9a-f]{64}\.json$/.test(name)) {
        inspection.unexpectedFiles.push(name);
        continue;
      }
      try {
        const { stored, byteLength } = await readStoredArtifact(resolve(this.root, name));
        if (fileNameForHash(stored.artifactHash) !== name) {
          inspection.errors.push(`ARTIFACT_FILENAME_HASH_MISMATCH:${name}`);
          continue;
        }
        inspection.artifacts.push({
          schemaVersion: "0.2",
          namespace: stored.namespace,
          artifactHash: stored.artifactHash,
          byteLength,
        });
      } catch (error) {
        inspection.errors.push(
          `${error instanceof EvidenceArtifactError ? error.code : "ARTIFACT_READ_FAILED"}:${name}`,
        );
      }
    }
    inspection.artifacts.sort((left, right) => left.artifactHash.localeCompare(right.artifactHash));
    return inspection;
  }
}
