import type {
  EffectEvaluation,
  EffectObservation,
} from "./types.js";

const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_TEXT_MAX_LENGTH = 1_024;
const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

type ValidObservation = EffectObservation & {
  observedAtEpochMs: number;
  finalAfterEpochMs: number;
};

function isCanonicalSha256(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SHA256.test(value);
}

function isNonemptyCanonicalText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= SAFE_TEXT_MAX_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/**
 * Parse the canonical UTC subset used by the evidence kernel. Date.parse alone
 * is intentionally insufficient because it normalizes some invalid calendar
 * dates and accepts multiple representations of the same instant.
 */
function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millis = Number(millisText ?? "0");

  // Avoid Date.UTC's special interpretation of years 0 through 99.
  if (year < 100 || hour > 23 || minute > 59 || second > 59) return null;

  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const parsed = new Date(epochMs);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second ||
    parsed.getUTCMilliseconds() !== millis
  ) {
    return null;
  }

  return epochMs;
}

function evidenceIdentity(observation: ValidObservation): string {
  return JSON.stringify([
    observation.operationId,
    observation.source,
    observation.queryKey,
    observation.effectType,
    observation.status,
    observation.authoritative,
    observation.observedAt,
    observation.finalAfter,
    observation.effectId ?? null,
    observation.payloadHash ?? null,
  ]);
}

function result(
  status: EffectEvaluation["status"],
  authoritative: boolean,
  committedEffects: ReadonlyMap<string, string>,
  reasons: ReadonlySet<string>,
): EffectEvaluation {
  return {
    status,
    authoritative,
    effectCount: committedEffects.size,
    effectIds: [...committedEffects.keys()].sort(),
    reasons: [...reasons].sort(),
  };
}

/**
 * Reduce effect observations into an objective, fail-closed verdict.
 *
 * This function performs no I/O. `authoritative` is an assertion supplied by a
 * separately configured effect adapter; callers must not mark vendor response
 * metadata authoritative without an actual authoritative lookup contract.
 */
export function evaluateEffectEvidence(
  operationId: string,
  observations: readonly EffectObservation[],
): EffectEvaluation {
  const reasons = new Set<string>();
  const committedEffects = new Map<string, string>();

  if (!isCanonicalSha256(operationId)) {
    reasons.add("INVALID_OPERATION_ID");
    return result("contradiction", false, committedEffects, reasons);
  }
  if (!Array.isArray(observations)) {
    reasons.add("INVALID_EFFECT_OBSERVATIONS");
    return result("contradiction", false, committedEffects, reasons);
  }
  if (observations.length === 0) {
    reasons.add("NO_EFFECT_OBSERVATIONS");
    return result("unknown", false, committedEffects, reasons);
  }

  const validObservations: ValidObservation[] = [];
  let structurallyInvalid = false;

  for (const observation of observations) {
    let valid = true;

    if (!isCanonicalSha256(observation?.operationId)) {
      reasons.add("INVALID_OBSERVATION_OPERATION_ID");
      valid = false;
    } else if (observation.operationId !== operationId) {
      reasons.add("WRONG_OPERATION_ID");
      valid = false;
    }
    if (!isNonemptyCanonicalText(observation?.source)) {
      reasons.add("INVALID_EFFECT_SOURCE");
      valid = false;
    }
    if (!isNonemptyCanonicalText(observation?.queryKey)) {
      reasons.add("INVALID_EFFECT_QUERY_KEY");
      valid = false;
    }
    if (!isNonemptyCanonicalText(observation?.effectType)) {
      reasons.add("INVALID_EFFECT_TYPE");
      valid = false;
    }
    if (
      observation?.status !== "committed" &&
      observation?.status !== "absent" &&
      observation?.status !== "unknown"
    ) {
      reasons.add("INVALID_EFFECT_STATUS");
      valid = false;
    }
    if (typeof observation?.authoritative !== "boolean") {
      reasons.add("INVALID_AUTHORITATIVE_FLAG");
      valid = false;
    }

    const observedAtEpochMs = parseCanonicalTimestamp(observation?.observedAt);
    const finalAfterEpochMs = parseCanonicalTimestamp(observation?.finalAfter);
    if (observedAtEpochMs === null) {
      reasons.add("INVALID_OBSERVED_AT");
      valid = false;
    }
    if (finalAfterEpochMs === null) {
      reasons.add("INVALID_FINAL_AFTER");
      valid = false;
    }

    if (observation?.status === "committed") {
      if (!isNonemptyCanonicalText(observation.effectId)) {
        reasons.add("INVALID_COMMITTED_EFFECT_ID");
        valid = false;
      }
      if (!isCanonicalSha256(observation.payloadHash)) {
        reasons.add("INVALID_COMMITTED_PAYLOAD_HASH");
        valid = false;
      }
    } else {
      if (observation?.effectId !== undefined) {
        reasons.add("NON_COMMITTED_EFFECT_ID_PRESENT");
        valid = false;
      }
      if (observation?.payloadHash !== undefined) {
        reasons.add("NON_COMMITTED_PAYLOAD_HASH_PRESENT");
        valid = false;
      }
    }

    if (!valid || observedAtEpochMs === null || finalAfterEpochMs === null) {
      structurallyInvalid = true;
      continue;
    }

    validObservations.push({
      ...observation,
      observedAtEpochMs,
      finalAfterEpochMs,
    });
  }

  const deduped = new Map<string, ValidObservation>();
  for (const observation of validObservations) {
    deduped.set(evidenceIdentity(observation), observation);
  }
  const evidence = [...deduped.values()];

  const queryKeys = new Set(evidence.map((observation) => observation.queryKey));
  const effectTypes = new Set(evidence.map((observation) => observation.effectType));
  const finalAfters = new Set(evidence.map((observation) => observation.finalAfterEpochMs));
  if (queryKeys.size > 1) reasons.add("EFFECT_QUERY_KEY_CONFLICT");
  if (effectTypes.size > 1) reasons.add("EFFECT_TYPE_CONFLICT");
  if (finalAfters.size > 1) reasons.add("EFFECT_FINAL_AFTER_CONFLICT");

  let finalAuthoritativeAbsence = false;
  let nonAuthoritativeCommit = false;

  for (const observation of evidence) {
    if (observation.status === "committed") {
      if (!observation.authoritative) {
        nonAuthoritativeCommit = true;
        reasons.add("COMMIT_NOT_AUTHORITATIVE");
        continue;
      }

      const existingHash = committedEffects.get(observation.effectId!);
      if (existingHash !== undefined && existingHash !== observation.payloadHash) {
        reasons.add("EFFECT_PAYLOAD_HASH_CONFLICT");
      } else {
        committedEffects.set(observation.effectId!, observation.payloadHash!);
      }
      continue;
    }

    if (observation.status === "absent") {
      if (!observation.authoritative) {
        reasons.add("ABSENCE_NOT_AUTHORITATIVE");
      } else if (observation.observedAtEpochMs < observation.finalAfterEpochMs) {
        reasons.add("ABSENCE_BEFORE_FINAL_AFTER");
      } else {
        finalAuthoritativeAbsence = true;
      }
      continue;
    }

    reasons.add("EFFECT_STATUS_UNKNOWN");
  }

  if (committedEffects.size > 0 && finalAuthoritativeAbsence) {
    reasons.add("COMMITTED_ABSENCE_CONFLICT");
  }

  const contradiction =
    structurallyInvalid ||
    queryKeys.size > 1 ||
    effectTypes.size > 1 ||
    finalAfters.size > 1 ||
    reasons.has("EFFECT_PAYLOAD_HASH_CONFLICT") ||
    reasons.has("COMMITTED_ABSENCE_CONFLICT");
  if (contradiction) {
    return result("contradiction", false, committedEffects, reasons);
  }

  if (committedEffects.size > 1) {
    reasons.add("MULTIPLE_EFFECTS_COMMITTED");
    return result("duplicate", true, committedEffects, reasons);
  }
  if (committedEffects.size === 1) {
    return result("committed", true, committedEffects, reasons);
  }
  if (finalAuthoritativeAbsence && !nonAuthoritativeCommit) {
    return result("absent", true, committedEffects, reasons);
  }

  reasons.add("NO_AUTHORITATIVE_EFFECT_EVIDENCE");
  return result("unknown", false, committedEffects, reasons);
}
