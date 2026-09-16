export type PublicDeploymentEnvironment =
  | "production"
  | "preview"
  | "development"
  | "local"
  | "unknown";

export interface PublicEvidenceLayerV02 {
  id:
    | "strict_requirement_normalization"
    | "fixed_base_collection"
    | "exact_settlement_comparison"
    | "deterministic_report_seal";
  status: "verified";
  boundary:
    | "caller_declared_supported_x402_v2_fields_only"
    | "unanimous_operator_declared_rpc_trust_domains"
    | "finalized_native_usdc_recipient_and_amount_only"
    | "unsigned_content_identity_no_authenticity";
}

export interface PublicOutcomeRowV02 {
  id:
    | "settlement_terms_matched"
    | "settlement_terms_mismatch"
    | "pending_finality"
    | "not_observed"
    | "multiple_payments_observed"
    | "contradiction";
  baseEvidence:
    | "confirmed"
    | "pending_finality"
    | "not_observed"
    | "multiple"
    | "contradiction";
  requirementComparison: "matched" | "mismatched" | "not_evaluated";
  claimMade: boolean;
  actionDirective: "none";
}

export interface PublicRouteInventoryEntryV02 {
  path:
    | "/api/x402-intent"
    | "/api/base-transaction"
    | "/api/evidence-status"
    | "/api/health"
    | "/api/trust"
    | "/api/preflight";
  methods: readonly ("GET" | "HEAD" | "POST" | "OPTIONS")[];
  disposition:
    | "x402_requirement_verification"
    | "fixed_source_base_verification"
    | "read_only_status"
    | "disabled_gone";
  callerSelectedTargetEnabled: false;
  outboundRequestsEnabled: boolean;
}

export interface PublicEvidenceReleaseV02 {
  schemaVersion: "0.2";
  kind: "public_evidence_release_status";
  service: "x402-canary";
  mode: "intent_aware_read_only";
  evidenceCoreCommit: "3ead8680d764ecbafe0739865f3789f8928f0fa6";
  verification: {
    session: 9;
    deterministicSuite: {
      passed: number;
      total: number;
      status: "PASS" | "PENDING";
    };
    independentReview: {
      status: "PASS" | "PENDING";
    };
  };
  evidenceLayers: {
    count: 4;
    items: readonly PublicEvidenceLayerV02[];
  };
  outcomeMatrix: {
    rowCount: 6;
    rows: readonly PublicOutcomeRowV02[];
  };
  capabilities: {
    x402RequirementComparisonEnabled: true;
    callerDeclaredRequirementEnabled: true;
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
    schemaVersion: "0.2";
    scope: "supported_x402_v2_settlement_terms";
    supportedX402Version: 2;
    supportedScheme: "exact";
    networkId: "eip155:8453";
    nativeUsdcAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    transferMethod: "eip3009";
    configuredSources: 2;
    quorum: "unanimous";
    finality: "shared_finalized_anchor";
    callerSelectedRpcEnabled: false;
    paymentRequirementsForwardedToRpc: false;
  };
  trust: {
    externalTruthProven: false;
    x402WireExchangeProven: false;
    requirementAuthenticityProven: false;
    resourceBindingProven: false;
    authorizationWindowProven: false;
    httpDeliveryProven: false;
    businessEffectProven: false;
    duplicatePurchaseProven: false;
    retrySafetyProven: false;
  };
  publicRoutes: readonly PublicRouteInventoryEntryV02[];
}

export interface PublicEvidenceStatusV02 extends PublicEvidenceReleaseV02 {
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
  schemaVersion: "0.2",
  kind: "public_evidence_release_status",
  service: "x402-canary",
  mode: "intent_aware_read_only",
  evidenceCoreCommit: "3ead8680d764ecbafe0739865f3789f8928f0fa6",
  verification: {
    session: 9,
    deterministicSuite: { passed: 333, total: 333, status: "PASS" },
    independentReview: { status: "PASS" },
  },
  evidenceLayers: {
    count: 4,
    items: [
      {
        id: "strict_requirement_normalization",
        status: "verified",
        boundary: "caller_declared_supported_x402_v2_fields_only",
      },
      {
        id: "fixed_base_collection",
        status: "verified",
        boundary: "unanimous_operator_declared_rpc_trust_domains",
      },
      {
        id: "exact_settlement_comparison",
        status: "verified",
        boundary: "finalized_native_usdc_recipient_and_amount_only",
      },
      {
        id: "deterministic_report_seal",
        status: "verified",
        boundary: "unsigned_content_identity_no_authenticity",
      },
    ],
  },
  outcomeMatrix: {
    rowCount: 6,
    rows: [
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
    ],
  },
  capabilities: {
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
  },
  liveVerifier: {
    schemaVersion: "0.2",
    scope: "supported_x402_v2_settlement_terms",
    supportedX402Version: 2,
    supportedScheme: "exact",
    networkId: "eip155:8453",
    nativeUsdcAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    transferMethod: "eip3009",
    configuredSources: 2,
    quorum: "unanimous",
    finality: "shared_finalized_anchor",
    callerSelectedRpcEnabled: false,
    paymentRequirementsForwardedToRpc: false,
  },
  trust: {
    externalTruthProven: false,
    x402WireExchangeProven: false,
    requirementAuthenticityProven: false,
    resourceBindingProven: false,
    authorizationWindowProven: false,
    httpDeliveryProven: false,
    businessEffectProven: false,
    duplicatePurchaseProven: false,
    retrySafetyProven: false,
  },
  publicRoutes: [
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
} as const satisfies PublicEvidenceReleaseV02;

export const PUBLIC_EVIDENCE_RELEASE: PublicEvidenceReleaseV02 = deepFreeze(release);

export function createPublicEvidenceStatus(input?: {
  environment?: unknown;
  gitCommitSha?: unknown;
  servedAt?: unknown;
}): PublicEvidenceStatusV02 {
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
