const RELEASE_CORE_SHA = "3ead8680d764ecbafe0739865f3789f8928f0fa6";
const THEME_KEY = "x402-canary-theme";
const STATUS_ROUTES = new Set(["/api/health", "/api/evidence-status"]);
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
  publicOutboundMonitoringEnabled: false,
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
  return matchesExactRecord(value, {
    service: "x402-canary",
    status: "contained",
    publicOutboundMonitoring: false,
    publicProbeRoutes: "disabled",
    outboundRequestsMade: 0,
  });
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
  setText("health-outbound", value.outboundRequestsMade);
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
      route.outboundRequestsEnabled === false
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
    setText("live-chip-label", "live / contained");
    setText(
      "status-note",
      "Both same-origin routes returned the exact expected containment and no-action release contracts.",
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

initializeTheme();
loadStatus();
