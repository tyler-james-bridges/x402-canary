export type PublicDeploymentEnvironment =
  | "production"
  | "preview"
  | "development"
  | "local"
  | "unknown";

export interface PublicEvidenceLayerV01 {
  id:
    | "authenticated_base_collection"
    | "signed_effect_authority"
    | "journal_bound_integrity"
    | "no_action_shadow_runner";
  status: "verified";
  boundary:
    | "unanimous_operator_declared_rpc_trust_domains"
    | "ed25519_out_of_band_registry"
    | "content_addressed_artifacts_and_hash_linked_journal"
    | "deterministic_shadow_only_orchestration";
}

export interface PublicOutcomeRowV01 {
  id:
    | "confirmed_committed"
    | "absent_absent"
    | "pending_confirmations"
    | "base_contradiction"
    | "duplicate_settlement"
    | "confirmed_effect_absent"
    | "confirmed_effect_unknown"
    | "confirmed_effect_duplicate"
    | "confirmed_effect_contradiction";
  settlement:
    | "confirmed"
    | "absent"
    | "pending_finality"
    | "contradiction"
    | "duplicate";
  effect: "committed" | "absent" | "unknown" | "duplicate" | "contradiction";
  terminalState:
    | "settled_delivered"
    | "settlement_failed"
    | "settled_pending_finality"
    | "evidence_contradiction"
    | "duplicate_settlement"
    | "settled_delivery_failed"
    | "settled_delivery_unverified";
  invariantPassed: boolean;
}

export interface PublicRouteInventoryEntryV01 {
  path:
    | "/api/base-transaction"
    | "/api/evidence-status"
    | "/api/health"
    | "/api/trust"
    | "/api/preflight";
  methods: readonly ("GET" | "HEAD" | "POST" | "OPTIONS")[];
  disposition: "fixed_source_base_verification" | "read_only_status" | "disabled_gone";
  callerSelectedTargetEnabled: false;
  outboundRequestsEnabled: boolean;
}

export interface PublicEvidenceReleaseV01 {
  schemaVersion: "0.1";
  kind: "public_evidence_release_status";
  service: "x402-canary";
  mode: "shadow_no_action";
  evidenceCoreCommit: "3ead8680d764ecbafe0739865f3789f8928f0fa6";
  verification: {
    session: 6;
    deterministicSuite: {
      passed: 283;
      total: 283;
      status: "PASS";
    };
    independentReview: {
      status: "PASS";
    };
  };
  evidenceLayers: {
    count: 4;
    items: readonly PublicEvidenceLayerV01[];
  };
  outcomeMatrix: {
    rowCount: 9;
    rows: readonly PublicOutcomeRowV01[];
  };
  capabilities: {
    paymentExecutionEnabled: false;
    walletAccessEnabled: false;
    signingEnabled: false;
    transactionSubmissionEnabled: false;
    retryExecutionEnabled: false;
    actionExecutionEnabled: false;
    callerSelectedTargetEnabled: false;
    callerSelectedTransactionHashEnabled: true;
    fixedSourceBaseVerificationEnabled: true;
    publicOutboundMonitoringEnabled: false;
  };
  liveVerifier: {
    schemaVersion: "0.1";
    scope: "transaction_only";
    networkId: "eip155:8453";
    nativeUsdcAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    configuredSources: 2;
    quorum: "unanimous";
    finality: "shared_finalized_anchor";
    callerSelectedRpcEnabled: false;
  };
  trust: {
    externalTruthProven: false;
    operatorDatabaseTruthIndependentlyProven: false;
    externalAntiRollbackCheckpoint: false;
    trustedLocalWriterRequired: true;
    historicalTransportReauthentication: false;
    historicalSignatureReverification: false;
  };
  publicRoutes: readonly PublicRouteInventoryEntryV01[];
}

export interface PublicEvidenceStatusV01 extends PublicEvidenceReleaseV01 {
  deployment: {
    environment: PublicDeploymentEnvironment;
    gitCommitSha: string | null;
    servedAt: string;
  };
}

export class PublicEvidenceStatusError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PublicEvidenceStatusError";
  }
}

const STATUS_INPUT_FIELDS = new Set(["environment", "gitCommitSha", "servedAt"]);
const DEPLOYMENT_ENVIRONMENTS = new Set<PublicDeploymentEnvironment>([
  "production",
  "preview",
  "development",
  "local",
]);
const GIT_SHA = /^[0-9a-fA-F]{40}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(code: string): never {
  throw new PublicEvidenceStatusError(code);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function normalizeInput(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("PUBLIC_EVIDENCE_STATUS_INPUT_INVALID");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("PUBLIC_EVIDENCE_STATUS_INPUT_INVALID");
  }
  const normalized: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !STATUS_INPUT_FIELDS.has(key)) {
      fail("PUBLIC_EVIDENCE_STATUS_INPUT_FIELD_INVALID");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail("PUBLIC_EVIDENCE_STATUS_INPUT_DESCRIPTOR_INVALID");
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function deploymentEnvironment(value: unknown): PublicDeploymentEnvironment {
  return typeof value === "string" &&
    DEPLOYMENT_ENVIRONMENTS.has(value as PublicDeploymentEnvironment)
    ? (value as PublicDeploymentEnvironment)
    : "unknown";
}

function gitCommitSha(value: unknown): string | null {
  return typeof value === "string" && GIT_SHA.test(value) ? value.toLowerCase() : null;
}

function servedAt(value: unknown): string {
  const candidate = value === undefined ? new Date().toISOString() : value;
  if (
    typeof candidate !== "string" ||
    !CANONICAL_TIMESTAMP.test(candidate) ||
    !Number.isFinite(Date.parse(candidate)) ||
    new Date(candidate).toISOString() !== candidate
  ) {
    fail("PUBLIC_EVIDENCE_STATUS_SERVED_AT_INVALID");
  }
  return candidate;
}

const release = {
  schemaVersion: "0.1",
  kind: "public_evidence_release_status",
  service: "x402-canary",
  mode: "shadow_no_action",
  evidenceCoreCommit: "3ead8680d764ecbafe0739865f3789f8928f0fa6",
  verification: {
    session: 6,
    deterministicSuite: { passed: 283, total: 283, status: "PASS" },
    independentReview: { status: "PASS" },
  },
  evidenceLayers: {
    count: 4,
    items: [
      {
        id: "authenticated_base_collection",
        status: "verified",
        boundary: "unanimous_operator_declared_rpc_trust_domains",
      },
      {
        id: "signed_effect_authority",
        status: "verified",
        boundary: "ed25519_out_of_band_registry",
      },
      {
        id: "journal_bound_integrity",
        status: "verified",
        boundary: "content_addressed_artifacts_and_hash_linked_journal",
      },
      {
        id: "no_action_shadow_runner",
        status: "verified",
        boundary: "deterministic_shadow_only_orchestration",
      },
    ],
  },
  outcomeMatrix: {
    rowCount: 9,
    rows: [
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
    ],
  },
  capabilities: {
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
  },
  liveVerifier: {
    schemaVersion: "0.1",
    scope: "transaction_only",
    networkId: "eip155:8453",
    nativeUsdcAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    configuredSources: 2,
    quorum: "unanimous",
    finality: "shared_finalized_anchor",
    callerSelectedRpcEnabled: false,
  },
  trust: {
    externalTruthProven: false,
    operatorDatabaseTruthIndependentlyProven: false,
    externalAntiRollbackCheckpoint: false,
    trustedLocalWriterRequired: true,
    historicalTransportReauthentication: false,
    historicalSignatureReverification: false,
  },
  publicRoutes: [
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
      path: "/api/trust",
      methods: ["GET", "OPTIONS"],
      disposition: "disabled_gone",
      callerSelectedTargetEnabled: false,
      outboundRequestsEnabled: false,
    },
    {
      path: "/api/preflight",
      methods: ["POST", "OPTIONS"],
      disposition: "disabled_gone",
      callerSelectedTargetEnabled: false,
      outboundRequestsEnabled: false,
    },
  ],
} as const satisfies PublicEvidenceReleaseV01;

export const PUBLIC_EVIDENCE_RELEASE: PublicEvidenceReleaseV01 = deepFreeze(release);

export function createPublicEvidenceStatus(input?: {
  environment?: unknown;
  gitCommitSha?: unknown;
  servedAt?: unknown;
}): PublicEvidenceStatusV01 {
  const normalized = normalizeInput(input);
  return deepFreeze({
    ...PUBLIC_EVIDENCE_RELEASE,
    deployment: {
      environment: deploymentEnvironment(normalized.environment),
      gitCommitSha: gitCommitSha(normalized.gitCommitSha),
      servedAt: servedAt(normalized.servedAt),
    },
  });
}
