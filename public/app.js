const RELEASE_CORE_SHA = "3ead8680d764ecbafe0739865f3789f8928f0fa6";
const THEME_KEY = "x402-canary-theme";
const STATUS_ROUTES = new Set(["/api/health", "/api/evidence-status"]);
const BASE_TRANSACTION_ROUTE = "/api/base-transaction";
const BASE_NETWORK_ID = "eip155:8453";
const BASE_USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;
const CANONICAL_UINT_PATTERN = /^(?:0|[1-9]\d*)$/;
const VERIFIER_TIMEOUT_MS = 20_000;
const VERDICT_STATUSES = new Set([
  "confirmed",
  "multiple",
  "pending_finality",
  "not_observed",
  "not_eip3009_usdc",
  "reverted",
  "contradiction",
]);
const DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "preview",
  "development",
  "local",
  "unknown",
]);

const CAPABILITY_EXPECTATIONS = {
  paymentExecutionEnabled: false,
  walletAccessEnabled: false,
  signingEnabled: false,
  transactionSubmissionEnabled: false,
  retryExecutionEnabled: false,
  actionExecutionEnabled: false,
  callerSelectedTargetEnabled: false,
  callerSelectedTransactionHashEnabled: true,
  fixedSourceBaseVerificationEnabled: true,
  publicOutboundMonitoringEnabled: false,
};

const LIVE_VERIFIER_EXPECTATIONS = {
  schemaVersion: "0.1",
  scope: "transaction_only",
  networkId: BASE_NETWORK_ID,
  nativeUsdcAsset: BASE_USDC_ASSET,
  configuredSources: 2,
  quorum: "unanimous",
  finality: "shared_finalized_anchor",
  callerSelectedRpcEnabled: false,
};

const HEALTH_CAPABILITY_EXPECTATIONS = {
  walletAccessEnabled: false,
  signingEnabled: false,
  transactionSubmissionEnabled: false,
  paymentExecutionEnabled: false,
  retryExecutionEnabled: false,
  actionExecutionEnabled: false,
};

const HEALTH_VERIFIER_EXPECTATIONS = {
  enabled: true,
  networkId: BASE_NETWORK_ID,
  nativeUsdcAsset: BASE_USDC_ASSET,
  configuredSources: 2,
  quorum: "unanimous",
  finality: "shared_finalized_anchor",
};

const TRUST_EXPECTATIONS = {
  externalTruthProven: false,
  operatorDatabaseTruthIndependentlyProven: false,
  externalAntiRollbackCheckpoint: false,
  trustedLocalWriterRequired: true,
  historicalTransportReauthentication: false,
  historicalSignatureReverification: false,
};

const LAYER_EXPECTATIONS = [
  {
    id: "authenticated_base_collection",
    cardId: "base-collector",
    status: "verified",
    boundary: "unanimous_operator_declared_rpc_trust_domains",
  },
  {
    id: "signed_effect_authority",
    cardId: "effect-authority",
    status: "verified",
    boundary: "ed25519_out_of_band_registry",
  },
  {
    id: "journal_bound_integrity",
    cardId: "journal-bundle",
    status: "verified",
    boundary: "content_addressed_artifacts_and_hash_linked_journal",
  },
  {
    id: "no_action_shadow_runner",
    cardId: "shadow-runner",
    status: "verified",
    boundary: "deterministic_shadow_only_orchestration",
  },
];

const BOUNDARY_LABELS = {
  unanimous_operator_declared_rpc_trust_domains:
    "Unanimous observation across operator-declared RPC trust domains. Transport identity does not prove Base consensus truth.",
  ed25519_out_of_band_registry:
    "Ed25519 verification against an out-of-band authority registry. A valid signature does not prove the source database truthful.",
  content_addressed_artifacts_and_hash_linked_journal:
    "Content-addressed artifacts and adjacent hash-linked journal commits bind the evaluator input, result, and closure receipt.",
  deterministic_shadow_only_orchestration:
    "Deterministic shadow-only orchestration composes the evidence layers and emits no action authority.",
};

const OUTCOME_EXPECTATIONS = [
  {
    id: "confirmed_committed",
    settlement: "confirmed",
    effect: "committed",
    terminalState: "settled_delivered",
    invariantPassed: true,
  },
  {
    id: "absent_absent",
    settlement: "absent",
    effect: "absent",
    terminalState: "settlement_failed",
    invariantPassed: true,
  },
  {
    id: "pending_confirmations",
    settlement: "pending_finality",
    effect: "committed",
    terminalState: "settled_pending_finality",
    invariantPassed: true,
  },
  {
    id: "base_contradiction",
    settlement: "contradiction",
    effect: "committed",
    terminalState: "evidence_contradiction",
    invariantPassed: true,
  },
  {
    id: "duplicate_settlement",
    settlement: "duplicate",
    effect: "committed",
    terminalState: "duplicate_settlement",
    invariantPassed: false,
  },
  {
    id: "confirmed_effect_absent",
    settlement: "confirmed",
    effect: "absent",
    terminalState: "settled_delivery_failed",
    invariantPassed: true,
  },
  {
    id: "confirmed_effect_unknown",
    settlement: "confirmed",
    effect: "unknown",
    terminalState: "settled_delivery_unverified",
    invariantPassed: true,
  },
  {
    id: "confirmed_effect_duplicate",
    settlement: "confirmed",
    effect: "duplicate",
    terminalState: "settled_delivery_failed",
    invariantPassed: false,
  },
  {
    id: "confirmed_effect_contradiction",
    settlement: "confirmed",
    effect: "contradiction",
    terminalState: "evidence_contradiction",
    invariantPassed: true,
  },
];

const ROUTE_EXPECTATIONS = [
  {
    path: "/api/base-transaction",
    methods: ["GET"],
    disposition: "fixed_source_base_verification",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: true,
  },
  {
    path: "/api/evidence-status",
    methods: ["GET", "HEAD", "OPTIONS"],
    disposition: "read_only_status",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: false,
  },
  {
    path: "/api/health",
    methods: ["GET", "HEAD", "OPTIONS"],
    disposition: "read_only_status",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: false,
  },
  {
    path: ["", "api", "trust"].join("/"),
    methods: ["GET", "OPTIONS"],
    disposition: "disabled_gone",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: false,
  },
  {
    path: ["", "api", "preflight"].join("/"),
    methods: ["POST", "OPTIONS"],
    disposition: "disabled_gone",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: false,
  },
];

function element(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const target = element(id);
  if (target) target.textContent = String(value);
}

function setState(id, state) {
  const target = element(id);
  if (target) target.dataset.state = state;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function matchesExactRecord(value, expected) {
  const keys = Object.keys(expected);
  return hasExactKeys(value, keys) && keys.every((key) => value[key] === expected[key]);
}

function matchesStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function setTheme(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  setText("theme-label", selected === "dark" ? "Light theme" : "Dark theme");
}

function initialTheme() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted contexts.
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function initializeTheme() {
  setTheme(initialTheme());
  const button = element("theme-toggle");
  if (!button) return;
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // The visible theme still changes when persistence is unavailable.
    }
  });
}

async function fetchJson(path) {
  if (!STATUS_ROUTES.has(path)) throw new Error("STATUS_ROUTE_NOT_ALLOWED");
  const response = await window.fetch(path, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!response.ok) throw new Error("STATUS_ROUTE_UNAVAILABLE");
  const value = await response.json();
  if (!isRecord(value)) throw new Error("STATUS_RESPONSE_INVALID");
  return value;
}

function validateHealth(value) {
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "service",
      "status",
      "mode",
      "fixedSourceBaseVerification",
      "legacyProbeRoutes",
      "scheduledMonitoringEnabled",
      "callerSelectedRpcEnabled",
      "requestOutboundReadsMade",
      "capabilities",
    ]) &&
    value.schemaVersion === "0.1" &&
    value.service === "x402-canary" &&
    value.status === "operational_read_only" &&
    value.mode === "live_base_transaction_verification" &&
    matchesExactRecord(value.fixedSourceBaseVerification, HEALTH_VERIFIER_EXPECTATIONS) &&
    value.legacyProbeRoutes === "disabled" &&
    value.scheduledMonitoringEnabled === false &&
    value.callerSelectedRpcEnabled === false &&
    value.requestOutboundReadsMade === 0 &&
    matchesExactRecord(value.capabilities, HEALTH_CAPABILITY_EXPECTATIONS)
  );
}

function renderHealth(value) {
  const valid = validateHealth(value);
  if (!valid) {
    setText("health-connection", "schema mismatch");
    setText("health-status", "not verified");
    setText("health-service", "unverified");
    setText("health-outbound", "unknown");
    setState("health-card", "unverified");
    return false;
  }

  setText("health-service", value.service);
  setText("health-status", value.status);
  setText("health-outbound", value.requestOutboundReadsMade);
  setText("health-connection", "verified");
  setState("health-card", "verified");
  return true;
}

function renderHealthFailure() {
  setText("health-connection", "unavailable");
  setText("health-status", "not verified");
  setText("health-service", "unavailable");
  setText("health-outbound", "unknown");
  setState("health-card", "unverified");
}

function validateVerification(value) {
  if (!hasExactKeys(value, ["session", "deterministicSuite", "independentReview"])) {
    return false;
  }
  return (
    value.session === 6 &&
    matchesExactRecord(value.deterministicSuite, {
      passed: 283,
      total: 283,
      status: "PASS",
    }) &&
    matchesExactRecord(value.independentReview, { status: "PASS" })
  );
}

function validateLayers(value) {
  if (!hasExactKeys(value, ["count", "items"])) return false;
  if (value.count !== LAYER_EXPECTATIONS.length || !Array.isArray(value.items)) return false;
  if (value.items.length !== LAYER_EXPECTATIONS.length) return false;

  return value.items.every((layer, index) => {
    const expected = LAYER_EXPECTATIONS[index];
    return matchesExactRecord(layer, {
      id: expected.id,
      status: expected.status,
      boundary: expected.boundary,
    });
  });
}

function validateOutcomes(value) {
  if (!hasExactKeys(value, ["rowCount", "rows"])) return false;
  if (value.rowCount !== OUTCOME_EXPECTATIONS.length || !Array.isArray(value.rows)) return false;
  if (value.rows.length !== OUTCOME_EXPECTATIONS.length) return false;
  return value.rows.every((row, index) => matchesExactRecord(row, OUTCOME_EXPECTATIONS[index]));
}

function validateRoutes(value) {
  if (!Array.isArray(value) || value.length !== ROUTE_EXPECTATIONS.length) return false;
  return value.every((route, index) => {
    const expected = ROUTE_EXPECTATIONS[index];
    if (
      !hasExactKeys(route, [
        "path",
        "methods",
        "disposition",
        "callerSelectedTargetEnabled",
        "outboundRequestsEnabled",
      ])
    ) {
      return false;
    }
    return (
      route.path === expected.path &&
      matchesStringArray(route.methods, expected.methods) &&
      route.disposition === expected.disposition &&
      route.callerSelectedTargetEnabled === false &&
      route.outboundRequestsEnabled === expected.outboundRequestsEnabled
    );
  });
}

function validateDeployment(value) {
  if (!hasExactKeys(value, ["environment", "gitCommitSha", "servedAt"])) return false;
  const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const canonicalCommit =
    value.gitCommitSha === null ||
    (typeof value.gitCommitSha === "string" && /^[0-9a-f]{40}$/.test(value.gitCommitSha));
  const parsedTimestamp = typeof value.servedAt === "string" ? Date.parse(value.servedAt) : NaN;
  const timestampMatches =
    typeof value.servedAt === "string" &&
    canonicalTimestamp.test(value.servedAt) &&
    Number.isFinite(parsedTimestamp) &&
    new Date(parsedTimestamp).toISOString() === value.servedAt;
  return (
    DEPLOYMENT_ENVIRONMENTS.has(value.environment) &&
    canonicalCommit &&
    timestampMatches
  );
}

function validateEvidenceStatus(value) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "service",
      "mode",
      "evidenceCoreCommit",
      "verification",
      "evidenceLayers",
      "outcomeMatrix",
      "capabilities",
      "liveVerifier",
      "trust",
      "publicRoutes",
      "deployment",
    ])
  ) {
    return false;
  }

  return (
    value.schemaVersion === "0.1" &&
    value.kind === "public_evidence_release_status" &&
    value.service === "x402-canary" &&
    value.mode === "shadow_no_action" &&
    value.evidenceCoreCommit === RELEASE_CORE_SHA &&
    validateVerification(value.verification) &&
    validateLayers(value.evidenceLayers) &&
    validateOutcomes(value.outcomeMatrix) &&
    matchesExactRecord(value.capabilities, CAPABILITY_EXPECTATIONS) &&
    matchesExactRecord(value.liveVerifier, LIVE_VERIFIER_EXPECTATIONS) &&
    matchesExactRecord(value.trust, TRUST_EXPECTATIONS) &&
    validateRoutes(value.publicRoutes) &&
    validateDeployment(value.deployment)
  );
}

function renderLayers(layers) {
  for (const layer of layers) {
    const expected = LAYER_EXPECTATIONS.find((candidate) => candidate.id === layer.id);
    const card = expected
      ? document.querySelector(`[data-component-id='${expected.cardId}']`)
      : null;
    if (!card) continue;
    const state = card.querySelector("[data-field='state']");
    const boundary = card.querySelector("[data-field='boundary']");
    if (state) state.textContent = layer.status;
    if (boundary) boundary.textContent = BOUNDARY_LABELS[layer.boundary];
  }
}

function setCellText(cell, value) {
  if (!cell) return;
  const nested = cell.childElementCount === 1 ? cell.firstElementChild : null;
  const target = nested || cell;
  target.textContent = value;
}

function renderOutcomes(rows) {
  rows.forEach((outcome, index) => {
    const row = element(`outcome-row-${index}`);
    if (!row) return;
    setCellText(
      row.querySelector("[data-field='case']"),
      `${String(index + 1).padStart(2, "0")} · ${outcome.id}`,
    );
    setCellText(row.querySelector("[data-field='base']"), outcome.settlement);
    setCellText(row.querySelector("[data-field='effect']"), outcome.effect);
    setCellText(row.querySelector("[data-field='terminalState']"), outcome.terminalState);

    const invariantCell = row.querySelector("[data-field='invariant']");
    setCellText(invariantCell, outcome.invariantPassed ? "pass" : "fail");
    const invariant = invariantCell ? invariantCell.firstElementChild : null;
    if (invariant) {
      invariant.classList.toggle("pass", outcome.invariantPassed);
      invariant.classList.toggle("block", !outcome.invariantPassed);
    }
  });
}

function renderTrust(trust) {
  setText("external-truth-value", trust.externalTruthProven);
  setText("database-truth-value", trust.operatorDatabaseTruthIndependentlyProven);
  setText("anti-rollback-value", trust.externalAntiRollbackCheckpoint);
  setText("writer-trust-value", trust.trustedLocalWriterRequired ? "required" : "not required");
}

function renderEvidence(value) {
  if (!validateEvidenceStatus(value)) {
    renderEvidenceFailure("schema mismatch");
    return false;
  }

  renderLayers(value.evidenceLayers.items);
  renderOutcomes(value.outcomeMatrix.rows);
  renderTrust(value.trust);

  setText("evidence-status", `${value.verification.deterministicSuite.status} · reviewed`);
  setText("evidence-core", value.evidenceCoreCommit);
  setText(
    "evidence-tests",
    `${value.verification.deterministicSuite.passed} / ${value.verification.deterministicSuite.total} passed`,
  );
  setText("evidence-connection", "verified");
  setState("evidence-card", "verified");

  setText("deployment-environment", value.deployment.environment);
  setText(
    "deployment-commit",
    value.deployment.gitCommitSha === null ? "not reported by runtime" : value.deployment.gitCommitSha,
  );
  setText("deployment-connection", "reported");
  setState("deployment-card", "verified");

  setText(
    "matrix-note",
    "The live release matches the checked-in nine-case matrix. Each row keeps settlement, effect, terminal state, and invariant separate.",
  );
  return true;
}

function renderEvidenceFailure(connectionState = "unavailable") {
  setText("evidence-connection", connectionState);
  setText("evidence-status", "not verified live");
  setText("evidence-core", `static ${RELEASE_CORE_SHA.slice(0, 7)}`);
  setText("evidence-tests", "not reported");
  setState("evidence-card", "unverified");
  setText("deployment-connection", connectionState);
  setText("deployment-environment", "not reported");
  setText("deployment-commit", "not reported");
  setState("deployment-card", "unverified");
  setText(
    "matrix-note",
    "The static checked-in nine-case matrix is shown below; live release metadata is unavailable or did not match the exact public schema.",
  );
}

function finishStatus(healthVerified, evidenceVerified) {
  const checkedAt = new Date().toISOString();
  setText("status-checked", checkedAt);
  if (healthVerified && evidenceVerified) {
    setState("live-chip", "verified");
    setText("live-chip-label", "live / read only");
    setText(
      "status-note",
      "Both same-origin routes returned the exact expected live read-only configuration and no-action execution contract.",
    );
    return;
  }
  if (healthVerified || evidenceVerified) {
    setState("live-chip", "degraded");
    setText("live-chip-label", "partial / unverified");
    setText(
      "status-note",
      "Only part of the live surface could be verified. Static release claims remain visible, but unavailable or mismatched fields are not treated as current.",
    );
    return;
  }
  setState("live-chip", "unverified");
  setText("live-chip-label", "offline / unverified");
  setText(
    "status-note",
    "Neither same-origin route could be verified. This page is showing its static release contract only.",
  );
}

async function loadStatus() {
  const results = await Promise.allSettled([
    fetchJson("/api/health"),
    fetchJson("/api/evidence-status"),
  ]);

  let healthVerified = false;
  let evidenceVerified = false;

  if (results[0].status === "fulfilled") healthVerified = renderHealth(results[0].value);
  else renderHealthFailure();

  if (results[1].status === "fulfilled") evidenceVerified = renderEvidence(results[1].value);
  else renderEvidenceFailure();

  finishStatus(healthVerified, evidenceVerified);
}

const PUBLIC_VERIFIER_CAPABILITIES = {
  fixedSourceBaseVerificationEnabled: true,
  callerSelectedTransactionHashEnabled: true,
  callerSelectedTargetEnabled: false,
  callerSelectedRpcEnabled: false,
  paymentExecutionEnabled: false,
  walletAccessEnabled: false,
  signingEnabled: false,
  transactionSubmissionEnabled: false,
  retryExecutionEnabled: false,
  actionExecutionEnabled: false,
};

const PUBLIC_VERIFIER_ASSURANCE = {
  scope: "fixed_source_base_receipt_and_native_usdc_eip3009_events",
  sourceIdentity: "server_pinned_origins",
  finality: "shared_finalized_block_hash",
  quorum: "unanimous",
  externalTruthProven: false,
};

const PUBLIC_VERIFIER_PRIVACY = {
  transactionHashTransport: "public_url_query",
  transactionHashMayAppearInPlatformLogs: true,
  applicationPersistenceEnabled: false,
};

const PUBLIC_VERIFIER_LIMITATIONS = {
  intendedX402TermsProven: false,
  httpDeliveryProven: false,
  businessEffectProven: false,
  retrySafetyProven: false,
};

const VERDICT_COPY = {
  confirmed: {
    chip: "confirmed",
    title: "Finalized USDC event pair observed",
  },
  multiple: {
    chip: "multiple pairs",
    title: "Multiple USDC event pairs observed",
  },
  pending_finality: {
    chip: "finality pending",
    title: "Observed, finality pending",
  },
  not_observed: {
    chip: "not observed",
    title: "Transaction not observed",
  },
  not_eip3009_usdc: {
    chip: "not EIP-3009",
    title: "No qualifying USDC event pair",
  },
  reverted: {
    chip: "reverted",
    title: "Transaction reverted",
  },
  contradiction: {
    chip: "evidence contradiction",
    title: "Observation contradicted policy",
  },
};

class VerifierRequestError extends Error {
  constructor(code, retryAfterSeconds = null) {
    super(code);
    this.name = "VerifierRequestError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

let verifierRequestSequence = 0;
let activeVerifierController = null;
let lastTransactionHash = null;

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const parsed = Date.parse(value);
  return pattern.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalUint(value, allowZero = true) {
  if (typeof value !== "string" || !CANONICAL_UINT_PATTERN.test(value)) return false;
  return allowZero || value !== "0";
}

function isSafeUnsignedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateReceipt(value, transactionHash) {
  if (value === null) return true;
  return (
    hasExactKeys(value, ["transactionHash", "blockHash", "blockNumber", "status"]) &&
    value.transactionHash === transactionHash &&
    BYTES32_PATTERN.test(value.blockHash) &&
    isCanonicalUint(value.blockNumber) &&
    (value.status === "success" || value.status === "reverted")
  );
}

function validateFinalizedAnchor(value) {
  if (value === null) return true;
  return (
    hasExactKeys(value, ["blockNumber", "blockHash", "blockTimestamp"]) &&
    isCanonicalUint(value.blockNumber) &&
    BYTES32_PATTERN.test(value.blockHash) &&
    isCanonicalUint(value.blockTimestamp)
  );
}

function validateSourceAgreement(value) {
  return (
    hasExactKeys(value, ["configured", "agreeing", "quorum"]) &&
    value.configured === 2 &&
    isSafeUnsignedInteger(value.agreeing) &&
    value.agreeing <= value.configured &&
    value.quorum === "unanimous"
  );
}

function validateSettlement(value) {
  return (
    hasExactKeys(value, [
      "from",
      "to",
      "valueAtomic",
      "nonce",
      "authorizationUsedLogIndex",
      "transferLogIndex",
    ]) &&
    ADDRESS_PATTERN.test(value.from) &&
    ADDRESS_PATTERN.test(value.to) &&
    isCanonicalUint(value.valueAtomic, false) &&
    BYTES32_PATTERN.test(value.nonce) &&
    isSafeUnsignedInteger(value.authorizationUsedLogIndex) &&
    isSafeUnsignedInteger(value.transferLogIndex) &&
    value.transferLogIndex === value.authorizationUsedLogIndex + 1
  );
}

function validateReasons(value) {
  if (!Array.isArray(value)) return false;
  if (!value.every((reason) => typeof reason === "string" && /^[A-Z][A-Z0-9_]*$/.test(reason))) {
    return false;
  }
  return value.every((reason, index) => index === 0 || value[index - 1] < reason);
}

function validatePublicBaseTransaction(value, expectedTransactionHash) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "checkedAt",
      "networkId",
      "transactionHash",
      "status",
      "receipt",
      "finalizedAnchor",
      "sourceAgreement",
      "confirmations",
      "settlementCount",
      "settlements",
      "truncated",
      "reasons",
      "observationHash",
      "assurance",
      "capabilities",
      "privacy",
      "limitations",
    ])
  ) {
    return false;
  }

  if (
    value.schemaVersion !== "0.1" ||
    value.kind !== "public_base_transaction_verification" ||
    value.networkId !== BASE_NETWORK_ID ||
    value.transactionHash !== expectedTransactionHash ||
    !isCanonicalTimestamp(value.checkedAt) ||
    !VERDICT_STATUSES.has(value.status) ||
    !validateReceipt(value.receipt, expectedTransactionHash) ||
    !validateFinalizedAnchor(value.finalizedAnchor) ||
    !validateSourceAgreement(value.sourceAgreement) ||
    !isSafeUnsignedInteger(value.confirmations) ||
    !isSafeUnsignedInteger(value.settlementCount) ||
    !Array.isArray(value.settlements) ||
    value.settlements.length > 32 ||
    !value.settlements.every(validateSettlement) ||
    typeof value.truncated !== "boolean" ||
    !validateReasons(value.reasons) ||
    !isSha256(value.observationHash) ||
    !matchesExactRecord(value.assurance, PUBLIC_VERIFIER_ASSURANCE) ||
    !matchesExactRecord(value.capabilities, PUBLIC_VERIFIER_CAPABILITIES) ||
    !matchesExactRecord(value.privacy, PUBLIC_VERIFIER_PRIVACY) ||
    !matchesExactRecord(value.limitations, PUBLIC_VERIFIER_LIMITATIONS)
  ) {
    return false;
  }

  const countMatches = value.truncated
    ? value.settlements.length === 32 && value.settlementCount > value.settlements.length
    : value.settlementCount === value.settlements.length;
  if (!countMatches) return false;

  if (value.status === "confirmed") {
    return (
      value.receipt?.status === "success" &&
      value.finalizedAnchor !== null &&
      value.sourceAgreement.agreeing === 2 &&
      value.settlementCount === 1 &&
      value.truncated === false
    );
  }
  if (value.status === "multiple") {
    return (
      value.receipt?.status === "success" &&
      value.finalizedAnchor !== null &&
      value.sourceAgreement.agreeing === 2 &&
      value.settlementCount > 1
    );
  }
  if (value.status === "not_observed") {
    return value.receipt === null && value.settlementCount === 0;
  }
  if (value.status === "not_eip3009_usdc") {
    return value.receipt?.status === "success" && value.settlementCount === 0;
  }
  if (value.status === "reverted") {
    return value.receipt?.status === "reverted" && value.settlementCount === 0;
  }
  return true;
}

function canonicalTransactionHash(value) {
  return TRANSACTION_HASH_PATTERN.test(value) ? value.toLowerCase() : null;
}

function setVerifierSections(visibleId) {
  for (const id of ["verifier-idle", "verifier-loading", "verifier-result", "verifier-error"]) {
    const section = element(id);
    if (section) section.hidden = id !== visibleId;
  }
}

function setVerdictChip(verdict, label) {
  const chip = element("verdict-chip");
  if (!chip) return;
  chip.dataset.verdict = verdict;
  chip.textContent = label;
}

function setFormLoading(loading) {
  const form = element("verify-form");
  const input = element("transaction-hash");
  const button = element("verify-button");
  const label = button?.querySelector(".button-label");
  if (form) form.dataset.state = loading ? "loading" : "ready";
  if (input) input.disabled = loading;
  if (button) {
    button.disabled = loading;
    button.setAttribute("aria-busy", loading ? "true" : "false");
  }
  if (label) label.textContent = loading ? "Verifying…" : "Verify transaction";
}

function announceVerification(message) {
  setText("verification-announcement", "");
  window.setTimeout(() => setText("verification-announcement", message), 0);
}

function clearInputError() {
  const input = element("transaction-hash");
  const error = element("transaction-hash-error");
  if (input) input.setAttribute("aria-invalid", "false");
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
}

function showInputError(message) {
  const input = element("transaction-hash");
  const error = element("transaction-hash-error");
  if (input) input.setAttribute("aria-invalid", "true");
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  input?.focus();
}

function showVerifierIdle() {
  setVerifierSections("verifier-idle");
  setState("verifier-panel", "idle");
  setVerdictChip("idle", "ready");
  const panel = element("verifier-panel");
  if (panel) {
    panel.setAttribute("aria-busy", "false");
    panel.setAttribute("aria-labelledby", "verifier-title");
  }
}

function showVerifierLoading() {
  setVerifierSections("verifier-loading");
  setState("verifier-panel", "loading");
  setVerdictChip("loading", "checking");
  const panel = element("verifier-panel");
  if (panel) {
    panel.setAttribute("aria-busy", "true");
    panel.setAttribute("aria-labelledby", "loading-title");
  }
  setFormLoading(true);
  announceVerification("Checking the Base transaction across the configured read-only sources.");
}

function summaryForVerdict(value) {
  const agreement = `${value.sourceAgreement.agreeing} of ${value.sourceAgreement.configured} configured Base sources`;
  switch (value.status) {
    case "confirmed":
      return `${agreement} agree at a shared finalized anchor. Exactly one adjacent native-USDC AuthorizationUsed to Transfer event pair was observed.`;
    case "multiple":
      return `${agreement} agree at a shared finalized anchor, but ${value.settlementCount} qualifying native-USDC event pairs were observed. No intended payment is inferred.`;
    case "pending_finality":
      return "The receipt was observed, but it is not yet at the shared finalized anchor. Recheck after Base finality advances.";
    case "not_observed":
      return "No configured source returned a receipt at this observation snapshot. The transaction may be pending or unmined; this is not proof of absence.";
    case "not_eip3009_usdc":
      return "The receipt was observed, but it contains no qualifying adjacent native-USDC EIP-3009 event pair.";
    case "reverted":
      return "Configured sources observed a reverted receipt. No native-USDC EIP-3009 event pair is claimed.";
    case "contradiction":
      return "Configured observations did not satisfy the fixed canonical verification policy. Canary makes no transaction claim.";
    default:
      return "No transaction claim was made.";
  }
}

function formatUsdc(valueAtomic) {
  const value = BigInt(valueAtomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction} USDC`;
}

function displayAddress(value) {
  const zero = `0x${"0".repeat(40)}`;
  return value === zero ? `${value} · zero address` : value;
}

function addSettlementFact(list, label, value) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  list.append(row);
}

function settlementCard(settlement, index) {
  const card = document.createElement("article");
  card.className = "settlement-card";

  const heading = document.createElement("div");
  heading.className = "settlement-card-head";
  const label = document.createElement("strong");
  const amount = document.createElement("span");
  label.textContent = `Pair ${String(index + 1).padStart(2, "0")}`;
  amount.textContent = formatUsdc(settlement.valueAtomic);
  heading.append(label, amount);

  const facts = document.createElement("dl");
  addSettlementFact(facts, "From", displayAddress(settlement.from));
  addSettlementFact(facts, "To", displayAddress(settlement.to));
  addSettlementFact(facts, "Atomic", settlement.valueAtomic);
  addSettlementFact(facts, "Nonce", settlement.nonce);
  addSettlementFact(
    facts,
    "Logs",
    `${settlement.authorizationUsedLogIndex} → ${settlement.transferLogIndex}`,
  );
  card.append(heading, facts);
  return card;
}

function renderSettlements(value) {
  const section = element("settlement-section");
  const list = element("settlement-list");
  const truncation = element("truncation-note");
  if (!section || !list || !truncation) return;
  list.replaceChildren();
  section.hidden = value.settlements.length === 0;
  setText(
    "settlement-count",
    `${value.settlementCount} ${value.settlementCount === 1 ? "pair" : "pairs"}`,
  );
  for (const [index, settlement] of value.settlements.entries()) {
    list.append(settlementCard(settlement, index));
  }
  truncation.hidden = !value.truncated;
}

function renderVerifierResult(value) {
  const copy = VERDICT_COPY[value.status];
  setVerifierSections("verifier-result");
  setState("verifier-panel", value.status);
  setVerdictChip(value.status, copy.chip);
  setText("result-title", copy.title);
  setText("result-summary", summaryForVerdict(value));
  setText("result-transaction-hash", value.transactionHash);
  setText("result-checked-at", value.checkedAt);
  setText(
    "result-receipt",
    value.receipt === null
      ? "not observed"
      : `${value.receipt.status} · block ${value.receipt.blockNumber} · ${value.confirmations} confirmations · ${value.receipt.blockHash}`,
  );
  setText(
    "result-anchor",
    value.finalizedAnchor === null
      ? "not established"
      : `block ${value.finalizedAnchor.blockNumber} · ${value.finalizedAnchor.blockHash}`,
  );
  setText(
    "result-sources",
    `${value.sourceAgreement.agreeing} / ${value.sourceAgreement.configured} · unanimous policy`,
  );
  renderSettlements(value);

  const panel = element("verifier-panel");
  if (panel) {
    panel.setAttribute("aria-busy", "false");
    panel.setAttribute("aria-labelledby", "result-title");
  }
  setFormLoading(false);
  announceVerification(`${copy.title}. ${summaryForVerdict(value)}`);
  element("result-title")?.focus();
}

function errorPresentation(error) {
  if (error instanceof VerifierRequestError) {
    if (error.code === "RATE_LIMITED") {
      const wait = error.retryAfterSeconds === null
        ? "Please wait before trying again."
        : `Please wait ${error.retryAfterSeconds} seconds before trying again.`;
      return {
        title: "Request limit reached",
        message: `${wait} No transaction claim was made.`,
      };
    }
    if (error.code === "TIMED_OUT") {
      return {
        title: "Verification timed out",
        message: "The configured Base sources did not complete within the bounded window. No transaction claim was made.",
      };
    }
    if (error.code === "SCHEMA_MISMATCH") {
      return {
        title: "Response could not be verified",
        message: "The live response did not match the exact public evidence schema. Canary rejected it and made no transaction claim.",
      };
    }
  }
  return {
    title: "Verification unavailable",
    message: "The configured Base sources are unavailable or the verifier is not ready. No transaction claim was made.",
  };
}

function showVerifierError(error) {
  const presentation = errorPresentation(error);
  setVerifierSections("verifier-error");
  setState("verifier-panel", "error");
  setVerdictChip("error", "unavailable");
  setText("error-title", presentation.title);
  setText("error-message", presentation.message);
  const panel = element("verifier-panel");
  if (panel) {
    panel.setAttribute("aria-busy", "false");
    panel.setAttribute("aria-labelledby", "error-title");
  }
  setFormLoading(false);
  announceVerification(`${presentation.title}. ${presentation.message}`);
  element("retry-verification")?.focus();
}

function retryAfterSeconds(response) {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 600 ? seconds : null;
}

async function fetchBaseTransaction(transactionHash, signal) {
  const query = new URLSearchParams({ transactionHash });
  const response = await window.fetch(`${BASE_TRANSACTION_ROUTE}?${query.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "default",
    credentials: "same-origin",
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    if (response.status === 400) throw new VerifierRequestError("INVALID_REQUEST");
    if (response.status === 429) {
      throw new VerifierRequestError("RATE_LIMITED", retryAfterSeconds(response));
    }
    throw new VerifierRequestError("UNAVAILABLE");
  }

  const contentType = String(response.headers.get("Content-Type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new VerifierRequestError("SCHEMA_MISMATCH");
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new VerifierRequestError("SCHEMA_MISMATCH");
  }
  if (!validatePublicBaseTransaction(value, transactionHash)) {
    throw new VerifierRequestError("SCHEMA_MISMATCH");
  }
  return value;
}

async function verifyTransaction(transactionHash) {
  const sequence = ++verifierRequestSequence;
  activeVerifierController?.abort();
  const controller = new AbortController();
  activeVerifierController = controller;
  lastTransactionHash = transactionHash;
  showVerifierLoading();

  const timeout = window.setTimeout(() => controller.abort(), VERIFIER_TIMEOUT_MS);
  try {
    const value = await fetchBaseTransaction(transactionHash, controller.signal);
    if (sequence === verifierRequestSequence) renderVerifierResult(value);
  } catch (error) {
    if (sequence !== verifierRequestSequence) return;
    if (controller.signal.aborted) {
      showVerifierError(new VerifierRequestError("TIMED_OUT"));
    } else {
      showVerifierError(error);
    }
  } finally {
    window.clearTimeout(timeout);
    if (sequence === verifierRequestSequence) activeVerifierController = null;
  }
}

function initializeVerifier() {
  const form = element("verify-form");
  const input = element("transaction-hash");
  const again = element("verify-again");
  const retry = element("retry-verification");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearInputError();
    const transactionHash = canonicalTransactionHash(input.value);
    if (transactionHash === null) {
      showInputError("Enter exactly 0x followed by 64 hexadecimal characters, with no spaces.");
      return;
    }
    input.value = transactionHash;
    void verifyTransaction(transactionHash);
  });

  input.addEventListener("input", clearInputError);

  again?.addEventListener("click", () => {
    ++verifierRequestSequence;
    activeVerifierController?.abort();
    activeVerifierController = null;
    lastTransactionHash = null;
    setFormLoading(false);
    clearInputError();
    input.value = "";
    showVerifierIdle();
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: "center" });
  });

  retry?.addEventListener("click", () => {
    if (lastTransactionHash !== null) void verifyTransaction(lastTransactionHash);
  });
}

initializeTheme();
initializeVerifier();
loadStatus();
