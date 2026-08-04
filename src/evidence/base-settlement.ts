import { BASE_MAINNET_NETWORK, BASE_USDC_ASSET } from "../contracts.js";
import type {
  AuthorizationStateObservation,
  BaseReceiptLog,
  BaseReceiptObservation,
  BaseTransactionReceipt,
  ExactAuthorizationDescriptor,
  SettlementEvaluation,
  SettlementStatus,
} from "./types.js";

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** keccak256("AuthorizationUsed(address,bytes32)"), with both arguments indexed by EIP-3009. */
export const EIP3009_AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const CANONICAL_UINT = /^(?:0|[1-9]\d*)$/;

interface ValidatedAuthorization {
  from: string;
  to: string;
  asset: string;
  value: bigint;
  validBefore: bigint;
  nonce: string;
}

type ReceiptOutcomeKind = "match" | "missing" | "mismatch" | "duplicate";

interface ReceiptOutcome {
  kind: ReceiptOutcomeKind;
  source: string;
  fingerprint: string;
  reasons: string[];
  matchingTransferCount: number;
  confirmations: number;
  transactionHash?: string;
  blockNumber?: string;
  blockNumberValue?: bigint;
  blockHash?: string;
}

interface StateOutcome {
  source: string;
  used: boolean;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  confirmations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedHex(value: string): string {
  return value.toLowerCase();
}

function parseCanonicalUint(value: unknown): bigint | null {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_MILLISECONDS.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function result(
  status: SettlementStatus,
  authoritative: boolean,
  settlementCount: number,
  confirmations: number,
  reasons: string[],
  identity?: { transactionHash: string; blockNumber: string },
): SettlementEvaluation {
  return {
    status,
    authoritative,
    settlementCount,
    confirmations,
    ...(identity ?? {}),
    reasons: [...new Set(reasons)].sort(),
  };
}

function validateAuthorization(value: unknown): {
  authorization?: ValidatedAuthorization;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!isRecord(value)) return { reasons: ["AUTHORIZATION_MALFORMED"] };

  if (value.networkId !== BASE_MAINNET_NETWORK) {
    addReason(reasons, "AUTHORIZATION_NETWORK_MISMATCH");
  }

  const asset = typeof value.asset === "string" ? normalizedHex(value.asset) : "";
  if (!ADDRESS.test(String(value.asset ?? "")) || asset !== BASE_USDC_ASSET) {
    addReason(reasons, "AUTHORIZATION_ASSET_MISMATCH");
  }

  const from = typeof value.from === "string" ? normalizedHex(value.from) : "";
  const to = typeof value.to === "string" ? normalizedHex(value.to) : "";
  if (!ADDRESS.test(String(value.from ?? "")) || from === ZERO_ADDRESS) {
    addReason(reasons, "AUTHORIZATION_FROM_INVALID");
  }
  if (!ADDRESS.test(String(value.to ?? "")) || to === ZERO_ADDRESS) {
    addReason(reasons, "AUTHORIZATION_TO_INVALID");
  }

  const amount = parseCanonicalUint(value.valueAtomic);
  if (amount === null || amount === 0n || amount > UINT256_MAX) {
    addReason(reasons, "AUTHORIZATION_VALUE_INVALID");
  }

  const validAfter = parseCanonicalUint(value.validAfter);
  const validBefore = parseCanonicalUint(value.validBefore);
  if (
    validAfter === null ||
    validBefore === null ||
    validAfter > UINT256_MAX ||
    validBefore > UINT256_MAX ||
    validBefore <= validAfter
  ) {
    addReason(reasons, "AUTHORIZATION_VALIDITY_WINDOW_INVALID");
  }

  const nonce = typeof value.nonce === "string" ? normalizedHex(value.nonce) : "";
  if (!BYTES32.test(String(value.nonce ?? ""))) {
    addReason(reasons, "AUTHORIZATION_NONCE_INVALID");
  }

  if (reasons.length > 0 || amount === null || validBefore === null) return { reasons };
  return {
    authorization: { from, to, asset, value: amount, validBefore, nonce },
    reasons,
  };
}

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

function uint256Data(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function validateGenericLog(
  log: unknown,
  transactionHash: string,
  reasons: string[],
): log is BaseReceiptLog {
  if (!isRecord(log)) {
    addReason(reasons, "RECEIPT_LOG_MALFORMED");
    return false;
  }

  let valid = true;
  if (typeof log.address !== "string" || !ADDRESS.test(log.address)) valid = false;
  if (
    !Array.isArray(log.topics) ||
    !log.topics.every((topic) => typeof topic === "string" && BYTES32.test(topic))
  ) {
    valid = false;
  }
  if (typeof log.data !== "string" || !HEX_DATA.test(log.data)) valid = false;
  if (!Number.isSafeInteger(log.logIndex) || Number(log.logIndex) < 0) valid = false;
  if (typeof log.transactionHash !== "string" || !BYTES32.test(log.transactionHash)) {
    valid = false;
  } else if (normalizedHex(log.transactionHash) !== transactionHash) {
    addReason(reasons, "LOG_TRANSACTION_HASH_MISMATCH");
  }
  if (log.removed !== undefined && typeof log.removed !== "boolean") valid = false;
  if (log.removed === true) addReason(reasons, "REMOVED_LOG_REJECTED");

  if (!valid) addReason(reasons, "RECEIPT_LOG_MALFORMED");
  return valid;
}

function receiptFingerprint(
  observation: Record<string, unknown>,
  receipt: BaseTransactionReceipt,
): string {
  const logs = [...receipt.logs]
    .sort((left, right) => left.logIndex - right.logIndex)
    .map((log) => ({
      address: normalizedHex(log.address),
      topics: log.topics.map(normalizedHex),
      data: normalizedHex(log.data),
      logIndex: log.logIndex,
      transactionHash: normalizedHex(log.transactionHash),
      removed: log.removed === true,
    }));
  return JSON.stringify({
    networkId: observation.networkId,
    canonicalBlockHash:
      typeof observation.canonicalBlockHash === "string"
        ? normalizedHex(observation.canonicalBlockHash)
        : observation.canonicalBlockHash,
    transactionHash: normalizedHex(receipt.transactionHash),
    blockHash: normalizedHex(receipt.blockHash),
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    logs,
  });
}

function inspectReceiptObservation(
  value: unknown,
  authorization: ValidatedAuthorization,
): ReceiptOutcome {
  const reasons: string[] = [];
  if (!isRecord(value)) {
    return {
      kind: "mismatch",
      source: "",
      fingerprint: "malformed",
      reasons: ["RECEIPT_OBSERVATION_MALFORMED"],
      matchingTransferCount: 0,
      confirmations: 0,
    };
  }

  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (source.length === 0) addReason(reasons, "RECEIPT_SOURCE_INVALID");
  if (value.networkId !== BASE_MAINNET_NETWORK) {
    addReason(reasons, "RECEIPT_NETWORK_MISMATCH");
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    addReason(reasons, "RECEIPT_OBSERVED_AT_INVALID");
  }
  const head = parseCanonicalUint(value.observedHeadBlockNumber);
  if (head === null || head > UINT256_MAX) addReason(reasons, "RECEIPT_HEAD_BLOCK_INVALID");

  if (value.receipt === null) {
    if (value.canonicalBlockHash !== null) {
      addReason(reasons, "MISSING_RECEIPT_HAS_CANONICAL_HASH");
    }
    return {
      kind: reasons.length === 0 ? "missing" : "mismatch",
      source,
      fingerprint: reasons.length === 0 ? "missing" : `invalid:${reasons.join(",")}`,
      reasons,
      matchingTransferCount: 0,
      confirmations: 0,
    };
  }

  if (!isRecord(value.receipt)) {
    addReason(reasons, "RECEIPT_MALFORMED");
    return {
      kind: "mismatch",
      source,
      fingerprint: `invalid:${reasons.join(",")}`,
      reasons,
      matchingTransferCount: 0,
      confirmations: 0,
    };
  }

  const rawReceipt = value.receipt;
  const transactionHash =
    typeof rawReceipt.transactionHash === "string"
      ? normalizedHex(rawReceipt.transactionHash)
      : "";
  const blockHash =
    typeof rawReceipt.blockHash === "string" ? normalizedHex(rawReceipt.blockHash) : "";
  const blockNumber = parseCanonicalUint(rawReceipt.blockNumber);

  if (!BYTES32.test(String(rawReceipt.transactionHash ?? ""))) {
    addReason(reasons, "RECEIPT_TRANSACTION_HASH_INVALID");
  }
  if (!BYTES32.test(String(rawReceipt.blockHash ?? ""))) {
    addReason(reasons, "RECEIPT_BLOCK_HASH_INVALID");
  }
  if (blockNumber === null || blockNumber > UINT256_MAX) {
    addReason(reasons, "RECEIPT_BLOCK_NUMBER_INVALID");
  }
  if (rawReceipt.status !== "success" && rawReceipt.status !== "reverted") {
    addReason(reasons, "RECEIPT_STATUS_INVALID");
  } else if (rawReceipt.status === "reverted") {
    addReason(reasons, "RECEIPT_REVERTED");
  }
  if (!Array.isArray(rawReceipt.logs)) addReason(reasons, "RECEIPT_LOGS_INVALID");

  if (typeof value.canonicalBlockHash !== "string" || !BYTES32.test(value.canonicalBlockHash)) {
    addReason(reasons, "CANONICAL_BLOCK_HASH_INVALID");
  } else if (normalizedHex(value.canonicalBlockHash) !== blockHash) {
    addReason(reasons, "CANONICAL_BLOCK_HASH_MISMATCH");
  }

  if (head !== null && blockNumber !== null) {
    if (head < blockNumber) addReason(reasons, "OBSERVED_HEAD_PRECEDES_RECEIPT");
    if (head - blockNumber + 1n > BigInt(Number.MAX_SAFE_INTEGER)) {
      addReason(reasons, "CONFIRMATION_COUNT_OUT_OF_RANGE");
    }
  }

  const logs = Array.isArray(rawReceipt.logs) ? rawReceipt.logs : [];
  const validLogs: BaseReceiptLog[] = [];
  const logIndexes = new Set<number>();
  for (const log of logs) {
    if (!validateGenericLog(log, transactionHash, reasons)) continue;
    if (logIndexes.has(log.logIndex)) addReason(reasons, "DUPLICATE_LOG_INDEX");
    logIndexes.add(log.logIndex);
    validLogs.push(log);
  }

  const expectedFrom = addressTopic(authorization.from);
  const expectedTo = addressTopic(authorization.to);
  const expectedValue = uint256Data(authorization.value);
  const transferCandidates = validLogs.filter(
    (log) => normalizedHex(log.topics[0] ?? "") === ERC20_TRANSFER_TOPIC,
  );
  const exactTransfers = transferCandidates.filter(
    (log) =>
      normalizedHex(log.address) === authorization.asset &&
      log.topics.length === 3 &&
      normalizedHex(log.topics[1] ?? "") === expectedFrom &&
      normalizedHex(log.topics[2] ?? "") === expectedTo &&
      normalizedHex(log.data) === expectedValue &&
      normalizedHex(log.transactionHash) === transactionHash &&
      log.removed !== true,
  );

  if (exactTransfers.length === 0) {
    if (transferCandidates.length === 0) {
      addReason(reasons, "TRANSFER_LOG_MISSING");
    } else {
      if (transferCandidates.every((log) => normalizedHex(log.address) !== authorization.asset)) {
        addReason(reasons, "TRANSFER_TOKEN_MISMATCH");
      }
      if (
        transferCandidates.every(
          (log) =>
            log.topics.length < 2 || normalizedHex(log.topics[1] ?? "") !== expectedFrom,
        )
      ) {
        addReason(reasons, "TRANSFER_FROM_MISMATCH");
      }
      if (
        transferCandidates.every(
          (log) => log.topics.length < 3 || normalizedHex(log.topics[2] ?? "") !== expectedTo,
        )
      ) {
        addReason(reasons, "TRANSFER_TO_MISMATCH");
      }
      if (transferCandidates.every((log) => normalizedHex(log.data) !== expectedValue)) {
        addReason(reasons, "TRANSFER_VALUE_MISMATCH");
      }
      if (transferCandidates.every((log) => log.topics.length !== 3)) {
        addReason(reasons, "TRANSFER_LOG_SHAPE_INVALID");
      }
    }
  } else if (exactTransfers.length > 1) {
    addReason(reasons, "DUPLICATE_MATCHING_TRANSFERS");
  }

  const authorizationUsedCandidates = validLogs.filter(
    (log) => normalizedHex(log.topics[0] ?? "") === EIP3009_AUTHORIZATION_USED_TOPIC,
  );
  const exactAuthorizationUsedEvents = authorizationUsedCandidates.filter(
    (log) =>
      normalizedHex(log.address) === authorization.asset &&
      log.topics.length === 3 &&
      normalizedHex(log.topics[1] ?? "") === expectedFrom &&
      normalizedHex(log.topics[2] ?? "") === authorization.nonce &&
      normalizedHex(log.data) === "0x" &&
      normalizedHex(log.transactionHash) === transactionHash &&
      log.removed !== true,
  );

  if (exactAuthorizationUsedEvents.length === 0) {
    if (authorizationUsedCandidates.length === 0) {
      addReason(reasons, "AUTHORIZATION_USED_EVENT_MISSING");
    } else {
      if (
        authorizationUsedCandidates.every(
          (log) => normalizedHex(log.address) !== authorization.asset,
        )
      ) {
        addReason(reasons, "AUTHORIZATION_USED_TOKEN_MISMATCH");
      }
      if (
        authorizationUsedCandidates.every(
          (log) =>
            log.topics.length < 2 || normalizedHex(log.topics[1] ?? "") !== expectedFrom,
        )
      ) {
        addReason(reasons, "AUTHORIZATION_USED_AUTHORIZER_MISMATCH");
      }
      if (
        authorizationUsedCandidates.every(
          (log) =>
            log.topics.length < 3 ||
            normalizedHex(log.topics[2] ?? "") !== authorization.nonce,
        )
      ) {
        addReason(reasons, "AUTHORIZATION_USED_NONCE_MISMATCH");
      }
      if (
        authorizationUsedCandidates.every(
          (log) => log.topics.length !== 3 || normalizedHex(log.data) !== "0x",
        )
      ) {
        addReason(reasons, "AUTHORIZATION_USED_EVENT_SHAPE_INVALID");
      }
    }
  } else if (exactAuthorizationUsedEvents.length > 1) {
    addReason(reasons, "DUPLICATE_AUTHORIZATION_USED_EVENTS");
  }

  // Circle's EIP-3009 path marks the nonce used before transferring, so the
  // AuthorizationUsed event must immediately precede its Transfer event. Two
  // existential matches elsewhere in a batched transaction are ambiguous.
  const exactAuthorizationTransferPairs = exactAuthorizationUsedEvents.flatMap(
    (authorizationUsed) =>
      exactTransfers.filter(
        (transfer) => transfer.logIndex === authorizationUsed.logIndex + 1,
      ),
  );
  if (
    exactAuthorizationUsedEvents.length > 0 &&
    exactTransfers.length > 0 &&
    exactAuthorizationTransferPairs.length === 0
  ) {
    addReason(reasons, "AUTHORIZATION_TRANSFER_PAIR_MISSING");
  }

  const structurallyUsable =
    BYTES32.test(String(rawReceipt.transactionHash ?? "")) &&
    BYTES32.test(String(rawReceipt.blockHash ?? "")) &&
    blockNumber !== null &&
    blockNumber <= UINT256_MAX &&
    (rawReceipt.status === "success" || rawReceipt.status === "reverted") &&
    Array.isArray(rawReceipt.logs) &&
    validLogs.length === logs.length;
  const receipt = structurallyUsable ? (rawReceipt as unknown as BaseTransactionReceipt) : undefined;
  const fingerprint = receipt
    ? receiptFingerprint(value, receipt)
    : `invalid:${reasons.join(",")}`;
  const confirmations =
    head !== null &&
    head <= UINT256_MAX &&
    blockNumber !== null &&
    blockNumber <= UINT256_MAX &&
    head >= blockNumber &&
    head - blockNumber + 1n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(head - blockNumber + 1n)
      : 0;

  const onlyDuplicateReason =
    reasons.length === 1 && reasons[0] === "DUPLICATE_MATCHING_TRANSFERS";
  const kind: ReceiptOutcomeKind =
    exactTransfers.length > 1 && onlyDuplicateReason
      ? "duplicate"
      : reasons.length > 0
        ? "mismatch"
        : exactTransfers.length === 1
          ? "match"
          : "mismatch";

  return {
    kind,
    source,
    fingerprint,
    reasons,
    matchingTransferCount: exactTransfers.length,
    confirmations,
    ...(transactionHash ? { transactionHash } : {}),
    ...(typeof rawReceipt.blockNumber === "string"
      ? { blockNumber: rawReceipt.blockNumber }
      : {}),
    ...(blockNumber !== null ? { blockNumberValue: blockNumber } : {}),
    ...(blockHash ? { blockHash } : {}),
  };
}

function inspectAuthorizationState(
  value: unknown,
  authorization: ValidatedAuthorization,
): { state?: StateOutcome; reasons: string[] } {
  const reasons: string[] = [];
  if (!isRecord(value)) return { reasons: ["AUTHORIZATION_STATE_OBSERVATION_MALFORMED"] };

  const source = typeof value.source === "string" ? value.source.trim() : "";
  if (source.length === 0) addReason(reasons, "AUTHORIZATION_STATE_SOURCE_INVALID");
  if (value.networkId !== BASE_MAINNET_NETWORK) {
    addReason(reasons, "AUTHORIZATION_STATE_NETWORK_MISMATCH");
  }
  if (
    typeof value.asset !== "string" ||
    !ADDRESS.test(value.asset) ||
    normalizedHex(value.asset) !== authorization.asset
  ) {
    addReason(reasons, "AUTHORIZATION_STATE_ASSET_MISMATCH");
  }
  if (
    typeof value.authorizer !== "string" ||
    !ADDRESS.test(value.authorizer) ||
    normalizedHex(value.authorizer) !== authorization.from
  ) {
    addReason(reasons, "AUTHORIZATION_STATE_AUTHORIZER_MISMATCH");
  }
  if (
    typeof value.nonce !== "string" ||
    !BYTES32.test(value.nonce) ||
    normalizedHex(value.nonce) !== authorization.nonce
  ) {
    addReason(reasons, "AUTHORIZATION_STATE_NONCE_MISMATCH");
  }
  if (typeof value.used !== "boolean") addReason(reasons, "AUTHORIZATION_STATE_USED_INVALID");

  const blockNumber = parseCanonicalUint(value.observedBlockNumber);
  const blockTimestamp = parseCanonicalUint(value.observedBlockTimestamp);
  const observedHeadBlockNumber = parseCanonicalUint(value.observedHeadBlockNumber);
  if (blockNumber === null || blockNumber > UINT256_MAX) {
    addReason(reasons, "AUTHORIZATION_STATE_BLOCK_NUMBER_INVALID");
  }
  if (typeof value.observedBlockHash !== "string" || !BYTES32.test(value.observedBlockHash)) {
    addReason(reasons, "AUTHORIZATION_STATE_BLOCK_HASH_INVALID");
  }
  if (blockTimestamp === null || blockTimestamp > UINT256_MAX) {
    addReason(reasons, "AUTHORIZATION_STATE_BLOCK_TIMESTAMP_INVALID");
  }
  if (observedHeadBlockNumber === null || observedHeadBlockNumber > UINT256_MAX) {
    addReason(reasons, "AUTHORIZATION_STATE_HEAD_BLOCK_INVALID");
  }
  if (
    blockNumber !== null &&
    blockNumber <= UINT256_MAX &&
    observedHeadBlockNumber !== null &&
    observedHeadBlockNumber <= UINT256_MAX
  ) {
    if (observedHeadBlockNumber < blockNumber) {
      addReason(reasons, "AUTHORIZATION_STATE_HEAD_PRECEDES_OBSERVATION");
    } else if (
      observedHeadBlockNumber - blockNumber + 1n >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      addReason(reasons, "AUTHORIZATION_STATE_CONFIRMATION_COUNT_OUT_OF_RANGE");
    }
  }

  if (
    reasons.length > 0 ||
    blockNumber === null ||
    blockTimestamp === null ||
    observedHeadBlockNumber === null ||
    typeof value.used !== "boolean" ||
    typeof value.observedBlockHash !== "string"
  ) {
    return { reasons };
  }

  return {
    state: {
      source,
      used: value.used,
      blockNumber,
      blockHash: normalizedHex(value.observedBlockHash),
      blockTimestamp,
      confirmations: Number(observedHeadBlockNumber - blockNumber + 1n),
    },
    reasons,
  };
}

function stateContradictionReasons(states: StateOutcome[]): string[] {
  const reasons: string[] = [];
  for (let leftIndex = 0; leftIndex < states.length; leftIndex += 1) {
    const left = states[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < states.length; rightIndex += 1) {
      const right = states[rightIndex];
      if (!right) continue;
      if (left.blockNumber === right.blockNumber) {
        if (left.blockHash !== right.blockHash || left.blockTimestamp !== right.blockTimestamp) {
          addReason(reasons, "AUTHORIZATION_STATE_CANONICAL_BLOCK_CONTRADICTION");
        }
        if (left.used !== right.used) {
          addReason(reasons, "AUTHORIZATION_STATE_VALUE_CONTRADICTION");
        }
      }
      const earlier = left.blockNumber < right.blockNumber ? left : right;
      const later = earlier === left ? right : left;
      if (earlier.used && !later.used) {
        addReason(reasons, "AUTHORIZATION_STATE_MONOTONICITY_CONTRADICTION");
      }
    }
  }
  return reasons;
}

/**
 * Evaluate already-observed Base facts. This function performs no RPC calls and
 * never upgrades a vendor claim, an unfinalized receipt, or elapsed wall time
 * into authoritative settlement evidence.
 */
export function evaluateBaseSettlement(
  authorization: ExactAuthorizationDescriptor,
  receiptObservations: BaseReceiptObservation[],
  authorizationStateObservations: AuthorizationStateObservation[],
  minimumConfirmations: number,
): SettlementEvaluation {
  const checkedAuthorization = validateAuthorization(authorization);
  if (!checkedAuthorization.authorization) {
    return result("mismatch", false, 0, 0, checkedAuthorization.reasons);
  }
  const validatedAuthorization = checkedAuthorization.authorization;

  if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < 1) {
    return result("mismatch", false, 0, 0, ["MINIMUM_CONFIRMATIONS_INVALID"]);
  }
  if (!Array.isArray(receiptObservations)) {
    return result("mismatch", false, 0, 0, ["RECEIPT_OBSERVATIONS_INVALID"]);
  }
  if (!Array.isArray(authorizationStateObservations)) {
    return result("mismatch", false, 0, 0, ["AUTHORIZATION_STATE_OBSERVATIONS_INVALID"]);
  }

  const receiptOutcomes = receiptObservations.map((observation) =>
    inspectReceiptObservation(observation, validatedAuthorization),
  );
  const verifiedMatchingTransactionHashes = new Set(
    receiptOutcomes.flatMap((outcome) =>
      outcome.kind === "match" && outcome.transactionHash
        ? [outcome.transactionHash]
        : [],
    ),
  );
  const verifiedSettlementCount = Math.max(
    verifiedMatchingTransactionHashes.size,
    0,
    ...receiptOutcomes.map((outcome) =>
      outcome.kind === "duplicate" ? outcome.matchingTransferCount : 0,
    ),
  );
  const receiptSources = new Set<string>();
  for (const outcome of receiptOutcomes) {
    if (receiptSources.has(outcome.source)) {
      return result(
        "mismatch",
        false,
        0,
        0,
        ["DUPLICATE_RECEIPT_OBSERVATION_SOURCE"],
      );
    }
    receiptSources.add(outcome.source);
  }

  const checkedStates = authorizationStateObservations.map((observation) =>
    inspectAuthorizationState(observation, validatedAuthorization),
  );
  const stateValidationReasons = checkedStates.flatMap((checked) => checked.reasons);
  if (stateValidationReasons.length > 0) {
    return result(
      "mismatch",
      false,
      0,
      0,
      [...new Set(stateValidationReasons)],
    );
  }
  const states = checkedStates.flatMap((checked) => (checked.state ? [checked.state] : []));
  const stateSources = new Set<string>();
  for (const state of states) {
    if (stateSources.has(state.source)) {
      return result(
        "mismatch",
        false,
        0,
        0,
        ["DUPLICATE_AUTHORIZATION_STATE_SOURCE"],
      );
    }
    stateSources.add(state.source);
  }

  const stateContradictions = stateContradictionReasons(states);
  if (stateContradictions.length > 0) {
    return result(
      "contradiction",
      false,
      verifiedSettlementCount,
      0,
      stateContradictions,
    );
  }

  const duplicateOutcome = receiptOutcomes.find((outcome) => outcome.kind === "duplicate");
  if (duplicateOutcome) {
    return result(
      "duplicate",
      false,
      duplicateOutcome.matchingTransferCount,
      duplicateOutcome.confirmations,
      ["DUPLICATE_MATCHING_TRANSFERS"],
      duplicateOutcome.transactionHash && duplicateOutcome.blockNumber
        ? {
            transactionHash: duplicateOutcome.transactionHash,
            blockNumber: duplicateOutcome.blockNumber,
          }
        : undefined,
    );
  }

  const distinctReceiptFingerprints = new Set(
    receiptOutcomes.map((outcome) => outcome.fingerprint),
  );
  if (receiptOutcomes.length > 1 && distinctReceiptFingerprints.size > 1) {
    const matchingTransactions = new Set(
      receiptOutcomes.flatMap((outcome) =>
        outcome.kind === "match" && outcome.transactionHash ? [outcome.transactionHash] : [],
      ),
    );
    return result(
      "contradiction",
      false,
      matchingTransactions.size,
      0,
      ["INDEPENDENT_RECEIPT_OBSERVATIONS_CONTRADICT"],
    );
  }

  const receiptMismatchReasons = receiptOutcomes
    .filter((outcome) => outcome.kind === "mismatch")
    .flatMap((outcome) => outcome.reasons);
  if (receiptMismatchReasons.length > 0) {
    return result(
      "mismatch",
      false,
      0,
      0,
      [...new Set(receiptMismatchReasons)],
    );
  }

  const matchingReceipts = receiptOutcomes.filter((outcome) => outcome.kind === "match");
  if (matchingReceipts.length > 0) {
    const representative = matchingReceipts[0];
    if (
      !representative?.transactionHash ||
      !representative.blockNumber ||
      !representative.blockHash
    ) {
      return result("mismatch", false, 0, 0, ["RECEIPT_IDENTITY_MISSING"]);
    }

    const receiptBlock = representative.blockNumberValue;
    if (receiptBlock === undefined) {
      return result("mismatch", false, 0, 0, ["RECEIPT_BLOCK_NUMBER_INVALID"]);
    }
    if (
      states.some(
        (state) =>
          state.blockNumber === receiptBlock && state.blockHash !== representative.blockHash,
      )
    ) {
      return result(
        "contradiction",
        false,
        1,
        0,
        ["AUTHORIZATION_STATE_RECEIPT_BLOCK_HASH_CONTRADICTION"],
      );
    }
    const stateConflictsWithReceipt = states.some(
      (state) =>
        (!state.used && state.blockNumber >= receiptBlock) ||
        (state.used && state.blockNumber < receiptBlock),
    );
    if (stateConflictsWithReceipt) {
      return result("contradiction", false, 1, 0, ["AUTHORIZATION_STATE_RECEIPT_CONTRADICTION"]);
    }

    const confirmations = Math.min(...matchingReceipts.map((outcome) => outcome.confirmations));
    const identity = {
      transactionHash: representative.transactionHash,
      blockNumber: representative.blockNumber,
    };
    if (confirmations < minimumConfirmations) {
      return result(
        "pending_finality",
        false,
        1,
        confirmations,
        ["MINIMUM_CONFIRMATIONS_NOT_REACHED"],
        identity,
      );
    }
    return result(
      "confirmed",
      true,
      1,
      confirmations,
      ["SETTLEMENT_CONFIRMED"],
      identity,
    );
  }

  const usedStates = states.filter((state) => state.used);
  if (usedStates.length > 0) {
    return result(
      "unknown",
      false,
      0,
      0,
      ["AUTHORIZATION_USED_WITHOUT_RECEIPT"],
    );
  }

  const postExpiryUnusedStates = states.filter(
    (state) => !state.used && state.blockTimestamp > validatedAuthorization.validBefore,
  );
  const firstAbsenceState = postExpiryUnusedStates[0];
  const sameCanonicalAbsenceSnapshot =
    firstAbsenceState !== undefined &&
    postExpiryUnusedStates.every(
      (state) =>
        state.blockNumber === firstAbsenceState.blockNumber &&
        state.blockHash === firstAbsenceState.blockHash &&
        state.blockTimestamp === firstAbsenceState.blockTimestamp,
    );
  const absenceConfirmations =
    postExpiryUnusedStates.length > 0
      ? Math.min(...postExpiryUnusedStates.map((state) => state.confirmations))
      : 0;
  if (
    postExpiryUnusedStates.length >= 2 &&
    postExpiryUnusedStates.length === states.length &&
    new Set(postExpiryUnusedStates.map((state) => state.source)).size >= 2 &&
    sameCanonicalAbsenceSnapshot &&
    absenceConfirmations >= minimumConfirmations
  ) {
    return result(
      "absent",
      true,
      0,
      absenceConfirmations,
      ["AUTHORIZATION_EXPIRED_UNUSED_INDEPENDENTLY_CONFIRMED"],
    );
  }

  const reasons: string[] = [];
  if (receiptOutcomes.length === 0) addReason(reasons, "RECEIPT_OBSERVATIONS_MISSING");
  else addReason(reasons, "RECEIPT_NOT_OBSERVED");
  if (states.length === 0) addReason(reasons, "AUTHORIZATION_STATE_OBSERVATIONS_MISSING");
  else if (states.length < 2) addReason(reasons, "INDEPENDENT_ABSENCE_OBSERVATIONS_INSUFFICIENT");
  else if (postExpiryUnusedStates.length !== states.length) {
    addReason(reasons, "AUTHORIZATION_NOT_EXPIRED_AT_ALL_OBSERVATIONS");
  } else if (!sameCanonicalAbsenceSnapshot) {
    addReason(reasons, "AUTHORIZATION_STATE_SNAPSHOT_DISAGREEMENT");
  } else if (absenceConfirmations < minimumConfirmations) {
    addReason(reasons, "AUTHORIZATION_STATE_MINIMUM_CONFIRMATIONS_NOT_REACHED");
  }
  return result("unknown", false, 0, 0, reasons);
}
