const RELEASE_CORE_SHA = "3ead8680d764ecbafe0739865f3789f8928f0fa6";
const THEME_KEY = "x402-canary-theme";
const STATUS_ROUTES = new Set(["/api/health", "/api/evidence-status"]);
const X402_INTENT_ROUTE = "/api/x402-intent";
const BASE_NETWORK_ID = "eip155:8453";
const BASE_USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;
const CANONICAL_UINT_PATTERN = /^(?:0|[1-9]\d*)$/;
const VERIFIER_TIMEOUT_MS = 20_000;
const DEPLOYMENT_ENVIRONMENTS = new Set([
  "production",
  "preview",
  "development",
  "local",
  "unknown",
]);

const CAPABILITY_EXPECTATIONS = {
  x402RequirementComparisonEnabled: true,
  callerDeclaredRequirementEnabled: true,
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
  schemaVersion: "0.2",
  scope: "supported_x402_v2_settlement_terms",
  supportedX402Version: 2,
  supportedScheme: "exact",
  networkId: BASE_NETWORK_ID,
  nativeUsdcAsset: BASE_USDC_ASSET,
  transferMethod: "eip3009",
  configuredSources: 2,
  quorum: "unanimous",
  finality: "shared_finalized_anchor",
  callerSelectedRpcEnabled: false,
  paymentRequirementsForwardedToRpc: false,
};

const HEALTH_INTENT_EXPECTATIONS = {
  enabled: true,
  schemaVersion: "0.2",
  scope: "supported_x402_v2_settlement_terms",
  requirementTransport: "request_body",
  paymentRequirementsForwardedToRpc: false,
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
  x402WireExchangeProven: false,
  requirementAuthenticityProven: false,
  resourceBindingProven: false,
  authorizationWindowProven: false,
  httpDeliveryProven: false,
  businessEffectProven: false,
  duplicatePurchaseProven: false,
  retrySafetyProven: false,
};

const LAYER_EXPECTATIONS = [
  {
    id: "strict_requirement_normalization",
    cardId: "requirement-normalizer",
    status: "verified",
    boundary: "caller_declared_supported_x402_v2_fields_only",
  },
  {
    id: "fixed_base_collection",
    cardId: "base-collector",
    status: "verified",
    boundary: "unanimous_operator_declared_rpc_trust_domains",
  },
  {
    id: "exact_settlement_comparison",
    cardId: "settlement-comparator",
    status: "verified",
    boundary: "finalized_native_usdc_recipient_and_amount_only",
  },
  {
    id: "deterministic_report_seal",
    cardId: "report-seal",
    status: "verified",
    boundary: "unsigned_content_identity_no_authenticity",
  },
];

const BOUNDARY_LABELS = {
  caller_declared_supported_x402_v2_fields_only:
    "Strictly accepts one caller-declared x402 v2 exact requirement for Base native USDC and rejects unsupported fields before any RPC runtime exists.",
  unanimous_operator_declared_rpc_trust_domains:
    "Unanimous observation across operator-declared RPC trust domains. Transport identity does not prove Base consensus truth.",
  finalized_native_usdc_recipient_and_amount_only:
    "Compares recipient and amount only after one finalized native-USDC EIP-3009 event pair is established. Protocol and timeout metadata remain declarations.",
  unsigned_content_identity_no_authenticity:
    "Domain-separated hashes make case and report content reproducible. They are not signatures and do not authenticate the requirement issuer.",
};

const OUTCOME_EXPECTATIONS = [
  {
    id: "settlement_terms_matched",
    baseEvidence: "confirmed",
    requirementComparison: "matched",
    claimMade: true,
    actionDirective: "none",
  },
  {
    id: "settlement_terms_mismatch",
    baseEvidence: "confirmed",
    requirementComparison: "mismatched",
    claimMade: true,
    actionDirective: "none",
  },
  {
    id: "pending_finality",
    baseEvidence: "pending_finality",
    requirementComparison: "not_evaluated",
    claimMade: false,
    actionDirective: "none",
  },
  {
    id: "not_observed",
    baseEvidence: "not_observed",
    requirementComparison: "not_evaluated",
    claimMade: false,
    actionDirective: "none",
  },
  {
    id: "multiple_payments_observed",
    baseEvidence: "multiple",
    requirementComparison: "not_evaluated",
    claimMade: false,
    actionDirective: "none",
  },
  {
    id: "contradiction",
    baseEvidence: "contradiction",
    requirementComparison: "not_evaluated",
    claimMade: false,
    actionDirective: "none",
  },
];

const ROUTE_EXPECTATIONS = [
  {
    path: "/api/x402-intent",
    methods: ["POST"],
    disposition: "x402_requirement_verification",
    callerSelectedTargetEnabled: false,
    outboundRequestsEnabled: true,
  },
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
      "intentAwareRequirementVerification",
      "fixedSourceBaseVerification",
      "legacyProbeRoutes",
      "scheduledMonitoringEnabled",
      "callerSelectedRpcEnabled",
      "requestOutboundReadsMade",
      "capabilities",
    ]) &&
    value.schemaVersion === "0.2" &&
    value.service === "x402-canary" &&
    value.status === "operational_read_only" &&
    value.mode === "live_x402_requirement_verification" &&
    matchesExactRecord(
      value.intentAwareRequirementVerification,
      HEALTH_INTENT_EXPECTATIONS,
    ) &&
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
    value.session === 9 &&
    hasExactKeys(value.deterministicSuite, ["passed", "total", "status"]) &&
    Number.isSafeInteger(value.deterministicSuite.passed) &&
    value.deterministicSuite.passed > 0 &&
    value.deterministicSuite.passed === value.deterministicSuite.total &&
    value.deterministicSuite.status === "PASS" &&
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
    value.schemaVersion === "0.2" &&
    value.kind === "public_evidence_release_status" &&
    value.service === "x402-canary" &&
    value.mode === "intent_aware_read_only" &&
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
    setCellText(row.querySelector("[data-field='base']"), outcome.baseEvidence);
    setCellText(
      row.querySelector("[data-field='comparison']"),
      outcome.requirementComparison,
    );
    const claimCell = row.querySelector("[data-field='claim']");
    setCellText(claimCell, outcome.claimMade ? "yes" : "no");
    const claim = claimCell ? claimCell.firstElementChild : null;
    if (claim) {
      claim.classList.toggle("pass", outcome.claimMade);
      claim.classList.toggle("block", !outcome.claimMade);
    }
    setCellText(row.querySelector("[data-field='action']"), outcome.actionDirective);
  });
}

function renderTrust(trust) {
  setText("external-truth-value", trust.externalTruthProven);
  setText("requirement-authenticity-value", trust.requirementAuthenticityProven);
  setText("resource-binding-value", trust.resourceBindingProven);
  setText("delivery-value", trust.httpDeliveryProven);
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
    "The live release matches the checked-in six-verdict matrix. Only one finalized payment can produce a settlement-terms match or mismatch claim.",
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
    "The static checked-in six-verdict matrix is shown below; live release metadata is unavailable or did not match the exact public schema.",
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

const PUBLIC_INTENT_CAPABILITIES = {
  x402RequirementComparisonEnabled: true,
  fixedSourceBaseVerificationEnabled: true,
  callerDeclaredRequirementEnabled: true,
  callerSelectedTransactionHashEnabled: true,
  callerSelectedTargetEnabled: false,
  callerSelectedRpcEnabled: false,
  callerDeclaredResourceUrlEnabled: false,
  paymentExecutionEnabled: false,
  walletAccessEnabled: false,
  signingEnabled: false,
  transactionSubmissionEnabled: false,
  retryExecutionEnabled: false,
  actionExecutionEnabled: false,
};

const PUBLIC_INTENT_ASSURANCE = {
  scope: "supported_x402_v2_settlement_terms",
  requirementSource: "caller_declared",
  sourceIdentity: "server_pinned_origins",
  finality: "shared_finalized_block_hash",
  quorum: "unanimous",
  reportIntegrity: "unsigned_sha256_content_identity",
  externalTruthProven: false,
};

const PUBLIC_INTENT_PRIVACY = {
  transactionHashTransport: "request_body",
  requirementTransport: "request_body",
  paymentRequirementsForwardedToRpc: false,
  applicationPersistenceEnabled: false,
};

const PUBLIC_INTENT_LIMITATIONS = {
  x402WireExchangeProven: false,
  requirementAuthenticityProven: false,
  resourceBindingProven: false,
  expectedPayerProven: false,
  expectedNonceProven: false,
  authorizationWindowProven: false,
  timeoutComplianceProven: false,
  authorizationSignatureProven: false,
  httpDeliveryProven: false,
  businessEffectProven: false,
  duplicatePurchaseProven: false,
  retrySafetyProven: false,
};

const CASE_STATUSES = new Set([
  "settlement_terms_matched",
  "settlement_terms_mismatch",
  "pending_finality",
  "not_observed",
  "multiple_payments_observed",
  "contradiction",
]);

const BASE_OBSERVATION_STATUSES = new Set([
  "confirmed",
  "multiple",
  "pending_finality",
  "not_observed",
  "not_eip3009_usdc",
  "reverted",
  "contradiction",
]);

const COMPARISON_FIELDS = [
  "scheme",
  "network",
  "asset",
  "transferMethod",
  "tokenDomain",
  "recipient",
  "amount",
  "maxTimeoutSeconds",
];

const COMPARISON_LABELS = {
  scheme: "Scheme",
  network: "Network",
  asset: "Asset",
  transferMethod: "Transfer method",
  tokenDomain: "Token domain",
  recipient: "Recipient",
  amount: "Amount",
  maxTimeoutSeconds: "Timeout",
};

const COMPARISON_STATUSES = new Set([
  "matched",
  "mismatched",
  "declared_only",
  "not_evaluated",
]);

const COMPARISON_BASES = new Set([
  "supported_requirement",
  "fixed_source_base_observation",
  "native_usdc_identity",
  "eip3009_event_pair",
  "caller_declaration",
]);

const VERDICT_COPY = {
  settlement_terms_matched: {
    chip: "terms match",
    title: "Settlement terms matched",
    summary: "The finalized native-USDC EIP-3009 payment has the exact recipient and amount declared by this supported x402 v2 requirement.",
  },
  settlement_terms_mismatch: {
    chip: "mismatch",
    title: "Settlement terms did not match",
    summary: "A finalized native-USDC EIP-3009 payment was observed, but its recipient or amount differs from the declared requirement.",
  },
  pending_finality: {
    chip: "finality pending",
    title: "No final match yet",
    summary: "The transaction was observed, but the configured sources have not placed it behind their shared finalized anchor.",
  },
  not_observed: {
    chip: "not established",
    title: "Payment was not established",
    summary: "The fixed observation did not establish one finalized native-USDC EIP-3009 payment for comparison.",
  },
  multiple_payments_observed: {
    chip: "multiple payments",
    title: "Multiple payments were observed",
    summary: "The transaction contains multiple qualifying native-USDC EIP-3009 payment pairs, so Canary does not select one as the declared intent.",
  },
  contradiction: {
    chip: "contradiction",
    title: "Evidence could not support a claim",
    summary: "The configured observations did not satisfy the canonical verification policy. No settlement-terms claim was made.",
  },
};

const LIVE_EXAMPLE = {
  transactionHash: "0x0246829b14840ccd32eeb31476ea04f54a7c8d034ca4336d9b08f18a90b26ea7",
  paymentRequirements: {
    scheme: "exact",
    network: "eip155:8453",
    amount: "19483",
    asset: BASE_USDC_ASSET,
    payTo: "0xe9030014f5dae217d0a152f02a043567b16c1abf",
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USD Coin",
      version: "2",
    },
  },
};

const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

class VerifierRequestError extends Error {
  constructor(code, detail = null, retryAfterSeconds = null) {
    super(code);
    this.name = "VerifierRequestError";
    this.code = code;
    this.detail = detail;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class IntentInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IntentInputError";
    this.code = code;
  }
}

let verifierRequestSequence = 0;
let activeVerifierController = null;
let lastCaseRequest = null;
let lastReport = null;

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

function canonicalTransactionHash(value) {
  return TRANSACTION_HASH_PATTERN.test(value) ? value.toLowerCase() : null;
}

function exactStringKeys(value, keys) {
  return hasExactKeys(value, keys) && Object.values(value).every((item) => typeof item === "string");
}

function normalizePaymentRequirements(value) {
  if (
    !hasExactKeys(value, [
      "scheme",
      "network",
      "amount",
      "asset",
      "payTo",
      "maxTimeoutSeconds",
      "extra",
    ])
  ) {
    throw new IntentInputError("FIELDS", "Use exactly the seven x402 v2 PaymentRequirements fields shown in the example.");
  }
  if (value.scheme !== "exact") {
    throw new IntentInputError("SCHEME", "This release supports the x402 exact scheme only.");
  }
  if (value.network !== BASE_NETWORK_ID) {
    throw new IntentInputError("NETWORK", "This release verifies Base mainnet requirements only (eip155:8453).");
  }
  if (typeof value.asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.asset)) {
    throw new IntentInputError("ASSET", "Asset must be a 20-byte EVM token address.");
  }
  const asset = value.asset.toLowerCase();
  if (asset !== BASE_USDC_ASSET) {
    throw new IntentInputError("ASSET", "This release verifies native Base USDC only.");
  }
  if (typeof value.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.payTo)) {
    throw new IntentInputError("RECIPIENT", "payTo must be a nonzero 20-byte EVM address.");
  }
  const payTo = value.payTo.toLowerCase();
  if (payTo === ZERO_ADDRESS) {
    throw new IntentInputError("RECIPIENT", "payTo must not be the zero address.");
  }
  if (!isCanonicalUint(value.amount, false)) {
    throw new IntentInputError("AMOUNT", "amount must be a positive canonical decimal string in USDC atomic units.");
  }
  const amount = BigInt(value.amount);
  if (amount > UINT256_MAX) {
    throw new IntentInputError("AMOUNT", "amount exceeds the uint256 range.");
  }
  if (
    !Number.isSafeInteger(value.maxTimeoutSeconds) ||
    value.maxTimeoutSeconds <= 0 ||
    value.maxTimeoutSeconds > 86_400
  ) {
    throw new IntentInputError("TIMEOUT", "maxTimeoutSeconds must be a positive integer no greater than 86400.");
  }
  if (!isRecord(value.extra)) {
    throw new IntentInputError("EXTRA", "extra must declare the native USDC EIP-712 domain.");
  }
  const extraKeys = Object.keys(value.extra).sort();
  const validExtraKeys =
    matchesStringArray(extraKeys, ["name", "version"]) ||
    matchesStringArray(extraKeys, ["assetTransferMethod", "name", "version"]);
  if (!validExtraKeys) {
    throw new IntentInputError("EXTRA", "extra may contain only assetTransferMethod, name, and version.");
  }
  if (
    value.extra.assetTransferMethod !== undefined &&
    value.extra.assetTransferMethod !== "eip3009"
  ) {
    throw new IntentInputError("METHOD", "This release supports the EIP-3009 transfer method only.");
  }
  if (value.extra.name !== "USD Coin" || value.extra.version !== "2") {
    throw new IntentInputError("DOMAIN", "Native Base USDC requires the USD Coin / 2 EIP-712 domain.");
  }
  return {
    scheme: "exact",
    network: BASE_NETWORK_ID,
    amount: value.amount,
    asset,
    payTo,
    maxTimeoutSeconds: value.maxTimeoutSeconds,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USD Coin",
      version: "2",
    },
  };
}

function parsePaymentRequirementsInput(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new IntentInputError("EMPTY", "Paste one PaymentRequirements JSON object.");
  }
  if (source.length > 4096) {
    throw new IntentInputError("SIZE", "PaymentRequirements JSON must be 4 KB or smaller.");
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new IntentInputError("JSON", "PaymentRequirements must be valid JSON.");
  }
  return normalizePaymentRequirements(value);
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
    value.agreeing <= 2 &&
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
  return (
    Array.isArray(value) &&
    value.every((reason) => typeof reason === "string" && /^[A-Z][A-Z0-9_]*$/.test(reason)) &&
    value.every((reason, index) => index === 0 || value[index - 1] < reason)
  );
}

function validateRequirement(value, expected) {
  try {
    const normalized = normalizePaymentRequirements(value);
    return JSON.stringify(normalized) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function validateComparison(value, field) {
  return (
    hasExactKeys(value, ["field", "expected", "observed", "status", "basis"]) &&
    value.field === field &&
    typeof value.expected === "string" &&
    (value.observed === null || typeof value.observed === "string") &&
    COMPARISON_STATUSES.has(value.status) &&
    COMPARISON_BASES.has(value.basis)
  );
}

function validateBaseEvidence(value, transactionHash) {
  return (
    hasExactKeys(value, [
      "status",
      "observationHash",
      "receipt",
      "finalizedAnchor",
      "sourceAgreement",
      "confirmations",
      "settlementCount",
      "truncated",
    ]) &&
    BASE_OBSERVATION_STATUSES.has(value.status) &&
    isSha256(value.observationHash) &&
    validateReceipt(value.receipt, transactionHash) &&
    validateFinalizedAnchor(value.finalizedAnchor) &&
    validateSourceAgreement(value.sourceAgreement) &&
    isSafeUnsignedInteger(value.confirmations) &&
    isSafeUnsignedInteger(value.settlementCount) &&
    typeof value.truncated === "boolean"
  );
}

function validatePublicIntentReport(value, request) {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "checkedAt",
      "status",
      "transactionHash",
      "caseId",
      "reportHash",
      "intent",
      "comparisons",
      "observedPayment",
      "baseEvidence",
      "reasons",
      "assurance",
      "capabilities",
      "privacy",
      "limitations",
    ]) ||
    value.schemaVersion !== "0.2" ||
    value.kind !== "public_x402_requirement_verification" ||
    !isCanonicalTimestamp(value.checkedAt) ||
    !CASE_STATUSES.has(value.status) ||
    value.transactionHash !== request.transactionHash ||
    !isSha256(value.caseId) ||
    !isSha256(value.reportHash) ||
    !hasExactKeys(value.intent, ["x402Version", "paymentRequirements", "intentHash"]) ||
    value.intent.x402Version !== 2 ||
    !validateRequirement(value.intent.paymentRequirements, request.paymentRequirements) ||
    !isSha256(value.intent.intentHash) ||
    !Array.isArray(value.comparisons) ||
    value.comparisons.length !== COMPARISON_FIELDS.length ||
    !value.comparisons.every((item, index) => validateComparison(item, COMPARISON_FIELDS[index])) ||
    !(value.observedPayment === null || validateSettlement(value.observedPayment)) ||
    !validateBaseEvidence(value.baseEvidence, request.transactionHash) ||
    !validateReasons(value.reasons) ||
    !matchesExactRecord(value.assurance, PUBLIC_INTENT_ASSURANCE) ||
    !matchesExactRecord(value.capabilities, PUBLIC_INTENT_CAPABILITIES) ||
    !matchesExactRecord(value.privacy, PUBLIC_INTENT_PRIVACY) ||
    !matchesExactRecord(value.limitations, PUBLIC_INTENT_LIMITATIONS)
  ) {
    return false;
  }

  const isFinalTermsResult =
    value.status === "settlement_terms_matched" ||
    value.status === "settlement_terms_mismatch";
  if (isFinalTermsResult) {
    return (
      value.baseEvidence.status === "confirmed" &&
      value.baseEvidence.receipt?.status === "success" &&
      value.baseEvidence.finalizedAnchor !== null &&
      value.baseEvidence.sourceAgreement.agreeing === 2 &&
      value.baseEvidence.settlementCount === 1 &&
      value.baseEvidence.truncated === false &&
      value.observedPayment !== null
    );
  }
  if (value.status === "multiple_payments_observed") {
    return value.baseEvidence.status === "multiple" && value.observedPayment === null;
  }
  if (value.status === "pending_finality") {
    return value.baseEvidence.status === "pending_finality" && value.observedPayment === null;
  }
  if (value.status === "contradiction") {
    return value.observedPayment === null;
  }
  return value.observedPayment === null;
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
  const textarea = element("payment-requirements");
  const button = element("verify-button");
  const sample = element("load-example");
  const label = button?.querySelector(".button-label");
  if (form) form.dataset.state = loading ? "loading" : "ready";
  if (input) input.disabled = loading;
  if (textarea) textarea.disabled = loading;
  if (sample) sample.disabled = loading;
  if (button) {
    button.disabled = loading;
    button.setAttribute("aria-busy", loading ? "true" : "false");
  }
  if (label) label.textContent = loading ? "Verifying…" : "Verify settlement terms";
}

function announceVerification(message) {
  setText("verification-announcement", "");
  window.setTimeout(() => setText("verification-announcement", message), 0);
}

function clearFieldError(fieldId, errorId) {
  const field = element(fieldId);
  const error = element(errorId);
  field?.setAttribute("aria-invalid", "false");
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
}

function showFieldError(fieldId, errorId, message) {
  const field = element(fieldId);
  const error = element(errorId);
  field?.setAttribute("aria-invalid", "true");
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  field?.focus();
}

function clearAllInputErrors() {
  clearFieldError("transaction-hash", "transaction-hash-error");
  clearFieldError("payment-requirements", "payment-requirements-error");
}

function updateIntentPreview() {
  const source = element("payment-requirements")?.value ?? "";
  const preview = element("intent-preview");
  if (!preview) return;
  try {
    const requirement = parsePaymentRequirementsInput(source);
    setText(
      "intent-preview-summary",
      `${formatUsdc(requirement.amount)} → ${requirement.payTo}`,
    );
    preview.hidden = false;
  } catch {
    preview.hidden = true;
  }
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
  announceVerification("Comparing the declared x402 requirement with fixed-source Base evidence.");
}

function formatUsdc(valueAtomic) {
  const value = BigInt(valueAtomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction} USDC`;
}

function formatComparisonValue(field, value) {
  if (value === null) return "not evaluated";
  if (field === "amount") return `${value} atomic · ${formatUsdc(value)}`;
  if (field === "maxTimeoutSeconds") return `${value} seconds`;
  return value;
}

function comparisonCard(item) {
  const card = document.createElement("article");
  card.className = "comparison-card";
  card.dataset.status = item.status;

  const header = document.createElement("div");
  header.className = "comparison-card-head";
  const label = document.createElement("strong");
  label.textContent = COMPARISON_LABELS[item.field];
  const status = document.createElement("span");
  status.textContent = item.status.replace("_", " ");
  header.append(label, status);

  const values = document.createElement("dl");
  const expected = document.createElement("div");
  const expectedTerm = document.createElement("dt");
  const expectedValue = document.createElement("dd");
  expectedTerm.textContent = "Expected";
  expectedValue.textContent = formatComparisonValue(item.field, item.expected);
  expected.append(expectedTerm, expectedValue);
  const observed = document.createElement("div");
  const observedTerm = document.createElement("dt");
  const observedValue = document.createElement("dd");
  observedTerm.textContent = "Observed";
  observedValue.textContent = formatComparisonValue(item.field, item.observed);
  observed.append(observedTerm, observedValue);
  values.append(expected, observed);
  card.append(header, values);
  return card;
}

function renderComparisons(comparisons) {
  const list = element("comparison-list");
  if (!list) return;
  list.replaceChildren(...comparisons.map(comparisonCard));
}

function addObservedFact(list, label, value) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  list.append(row);
}

function renderObservedPayment(payment) {
  const section = element("settlement-section");
  const list = element("observed-payment");
  if (!section || !list) return;
  list.replaceChildren();
  section.hidden = payment === null;
  if (payment === null) return;
  addObservedFact(list, "Payer · observed only", payment.from);
  addObservedFact(list, "Recipient", payment.to);
  addObservedFact(list, "Amount", `${payment.valueAtomic} atomic · ${formatUsdc(payment.valueAtomic)}`);
  addObservedFact(list, "Nonce · observed only", payment.nonce);
  addObservedFact(
    list,
    "Event indexes",
    `${payment.authorizationUsedLogIndex} → ${payment.transferLogIndex}`,
  );
}

function renderVerifierResult(value) {
  const copy = VERDICT_COPY[value.status];
  const base = value.baseEvidence;
  lastReport = value;
  setVerifierSections("verifier-result");
  setState("verifier-panel", value.status);
  setVerdictChip(value.status, copy.chip);
  setText("result-title", copy.title);
  setText("result-summary", copy.summary);
  setText("result-case-id", value.caseId);
  setText("result-report-hash", value.reportHash);
  setText("result-transaction-hash", value.transactionHash);
  setText("result-checked-at", value.checkedAt);
  setText(
    "result-receipt",
    base.receipt === null
      ? "not established"
      : `${base.receipt.status} · block ${base.receipt.blockNumber} · ${base.confirmations} confirmations · ${base.receipt.blockHash}`,
  );
  setText(
    "result-anchor",
    base.finalizedAnchor === null
      ? "not established"
      : `block ${base.finalizedAnchor.blockNumber} · ${base.finalizedAnchor.blockHash}`,
  );
  setText(
    "result-sources",
    `${base.sourceAgreement.agreeing} / ${base.sourceAgreement.configured} · unanimous policy`,
  );
  setText("result-kicker", `Settlement requirement report · ${value.reasons.join(" · ")}`);
  renderComparisons(value.comparisons);
  renderObservedPayment(value.observedPayment);

  const panel = element("verifier-panel");
  if (panel) {
    panel.setAttribute("aria-busy", "false");
    panel.setAttribute("aria-labelledby", "result-title");
  }
  setFormLoading(false);
  announceVerification(`${copy.title}. ${copy.summary}`);
  element("result-title")?.focus();
}

function errorPresentation(error) {
  if (error instanceof VerifierRequestError) {
    if (error.code === "RATE_LIMITED") {
      const wait = error.retryAfterSeconds === null
        ? "Please wait before running this case again."
        : `Please wait ${error.retryAfterSeconds} seconds before running this case again.`;
      return {
        title: "Request limit reached",
        message: `${wait} No settlement-terms claim was made.`,
      };
    }
    if (error.code === "TIMED_OUT") {
      return {
        title: "Verification timed out",
        message: "The fixed Base sources did not complete within the bounded window. No settlement-terms claim was made.",
      };
    }
    if (error.code === "SCHEMA_MISMATCH") {
      return {
        title: "Response could not be verified",
        message: "The live response did not match the exact public report schema. Canary rejected it and made no claim.",
      };
    }
    if (error.code === "INVALID_INTENT") {
      return {
        title: "Intent was not accepted",
        message: `The server rejected this requirement (${error.detail ?? "unsupported intent"}). No Base lookup claim was made.`,
      };
    }
  }
  return {
    title: "Verification unavailable",
    message: "The fixed Base sources are unavailable or the verifier is not ready. No settlement-terms claim was made.",
  };
}

function showVerifierError(error) {
  const presentation = errorPresentation(error);
  lastReport = null;
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
  element("error-title")?.setAttribute("tabindex", "-1");
  element("error-title")?.focus();
}

function retryAfterSeconds(response) {
  const value = response.headers.get("Retry-After");
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 600 ? seconds : null;
}

async function errorReason(response) {
  try {
    const value = await response.json();
    return isRecord(value) && isRecord(value.error) && typeof value.error.reason === "string"
      ? value.error.reason
      : null;
  } catch {
    return null;
  }
}

async function fetchIntentReport(request, signal) {
  const response = await window.fetch(X402_INTENT_ROUTE, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      x402Version: 2,
      transactionHash: request.transactionHash,
      paymentRequirements: request.paymentRequirements,
    }),
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 413) {
      throw new VerifierRequestError("INVALID_INTENT", await errorReason(response));
    }
    if (response.status === 429) {
      throw new VerifierRequestError("RATE_LIMITED", null, retryAfterSeconds(response));
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
  if (!validatePublicIntentReport(value, request)) {
    throw new VerifierRequestError("SCHEMA_MISMATCH");
  }
  return value;
}

async function verifyCase(request) {
  const sequence = ++verifierRequestSequence;
  activeVerifierController?.abort();
  const controller = new AbortController();
  activeVerifierController = controller;
  lastCaseRequest = request;
  lastReport = null;
  showVerifierLoading();

  const timeout = window.setTimeout(() => controller.abort(), VERIFIER_TIMEOUT_MS);
  try {
    const value = await fetchIntentReport(request, controller.signal);
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

async function copyReport() {
  if (lastReport === null) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
    setText("copy-report", "Copied");
    announceVerification("JSON report copied to the clipboard.");
    window.setTimeout(() => setText("copy-report", "Copy JSON report"), 1600);
  } catch {
    announceVerification("The browser could not copy the JSON report.");
  }
}

function downloadReport() {
  if (lastReport === null) return;
  const blob = new Blob([`${JSON.stringify(lastReport, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `x402-case-${lastReport.caseId.slice(-12)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  announceVerification("JSON report download started.");
}

function resetVerifier() {
  ++verifierRequestSequence;
  activeVerifierController?.abort();
  activeVerifierController = null;
  lastCaseRequest = null;
  lastReport = null;
  setFormLoading(false);
  clearAllInputErrors();
  const input = element("transaction-hash");
  const textarea = element("payment-requirements");
  if (input) input.value = "";
  if (textarea) textarea.value = "";
  const preview = element("intent-preview");
  if (preview) preview.hidden = true;
  showVerifierIdle();
  input?.focus({ preventScroll: true });
  input?.scrollIntoView({ block: "center" });
}

function initializeVerifier() {
  const form = element("verify-form");
  const input = element("transaction-hash");
  const textarea = element("payment-requirements");
  if (!form || !input || !textarea) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearAllInputErrors();
    const transactionHash = canonicalTransactionHash(input.value);
    if (transactionHash === null) {
      showFieldError(
        "transaction-hash",
        "transaction-hash-error",
        "Enter exactly 0x followed by 64 hexadecimal characters, with no spaces.",
      );
      return;
    }
    let paymentRequirements;
    try {
      paymentRequirements = parsePaymentRequirementsInput(textarea.value);
    } catch (error) {
      showFieldError(
        "payment-requirements",
        "payment-requirements-error",
        error instanceof IntentInputError ? error.message : "PaymentRequirements is invalid.",
      );
      return;
    }
    input.value = transactionHash;
    textarea.value = JSON.stringify(paymentRequirements, null, 2);
    updateIntentPreview();
    void verifyCase({ transactionHash, paymentRequirements });
  });

  input.addEventListener("input", () => {
    clearFieldError("transaction-hash", "transaction-hash-error");
  });
  textarea.addEventListener("input", () => {
    clearFieldError("payment-requirements", "payment-requirements-error");
    updateIntentPreview();
  });
  element("load-example")?.addEventListener("click", () => {
    clearAllInputErrors();
    input.value = LIVE_EXAMPLE.transactionHash;
    textarea.value = JSON.stringify(LIVE_EXAMPLE.paymentRequirements, null, 2);
    updateIntentPreview();
    input.focus();
  });
  element("verify-again")?.addEventListener("click", resetVerifier);
  element("retry-verification")?.addEventListener("click", () => {
    if (lastCaseRequest !== null) void verifyCase(lastCaseRequest);
  });
  element("copy-report")?.addEventListener("click", () => {
    void copyReport();
  });
  element("download-report")?.addEventListener("click", downloadReport);
}

initializeTheme();
initializeVerifier();
loadStatus();
