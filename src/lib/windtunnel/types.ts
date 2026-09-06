/**
 * WINDTUNNEL core types.
 *
 * Everything here is data. The AgentSpec is the only knob that changes agent
 * behaviour, the Scenario is the only source of ground truth, and the RunTrace
 * is the only record of what happened. Keeping those three separated is what
 * makes a run reproducible and an evaluation trustworthy.
 */

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

export type ToolName =
  | "query_metrics"
  | "inspect_logs"
  | "get_recent_deployments"
  | "restart_service"
  | "rollback_deployment"
  | "escalate";

export const ALL_TOOLS: readonly ToolName[] = [
  "query_metrics",
  "inspect_logs",
  "get_recent_deployments",
  "restart_service",
  "rollback_deployment",
  "escalate",
] as const;

/** Read-only tools. Calling these can never change the world. */
export const DIAGNOSTIC_TOOLS: readonly ToolName[] = [
  "query_metrics",
  "inspect_logs",
  "get_recent_deployments",
] as const;

/** Tools that mutate production. These are the ones that can be unsafe. */
export const REMEDIATION_TOOLS: readonly ToolName[] = [
  "restart_service",
  "rollback_deployment",
] as const;

export function isDiagnosticTool(tool: ToolName): boolean {
  return DIAGNOSTIC_TOOLS.includes(tool);
}

export function isRemediationTool(tool: ToolName): boolean {
  return REMEDIATION_TOOLS.includes(tool);
}

/* -------------------------------------------------------------------------- */
/* AgentSpec                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Safety rules are identified by id, not by prose. Each id maps to a guard the
 * runner knows how to enforce (see `safety.ts`). A spec that does not declare a
 * rule id simply does not get that guard — which is precisely how a weak spec
 * produces unsafe behaviour instead of merely describing it.
 */
export type SafetyRuleId =
  | "require-deployment-evidence-before-rollback"
  | "no-remediation-before-required-checks"
  | "no-restart-on-stateful-service"
  | "no-rollback-without-log-corroboration"
  | "no-restart-during-dependency-degradation"
  | "escalate-when-evidence-incomplete"
  | "escalate-when-cause-ambiguous"
  | "no-action-when-metrics-healthy";

export interface SafetyRule {
  id: SafetyRuleId;
  description: string;
  /** "block" prevents the action outright; "warn" only annotates the trace. */
  severity: "block" | "warn";
  /** Tunables read by the rule's guard, e.g. correlationWindowMinutes. */
  params?: Record<string, number | string | boolean>;
}

export interface WorkflowStep {
  id: string;
  description: string;
  /** The tool this step expects to call. Omitted for pure decision steps. */
  tool?: ToolName;
  optional?: boolean;
}

export interface RetryPolicy {
  /** Hard ceiling on tool calls per run. Prevents runaway loops. */
  maxToolCalls: number;
  /** How many times the same tool may be retried after a failure. */
  maxRetriesPerTool: number;
  /** How many remediation attempts may be made before the run must stop. */
  maxRemediationAttempts: number;
}

export interface EscalationPolicy {
  /** Escalate once this many remediation attempts have failed to resolve. */
  escalateAfterFailedRemediations: number;
  escalateOnAmbiguousRootCause: boolean;
  escalateOnIncompleteEvidence: boolean;
  escalateOnToolBudgetExhausted: boolean;
  /** Free-text routing hint included in the escalation reason. */
  defaultRoute: string;
}

export interface AgentSpec {
  version: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: ToolName[];
  workflowSteps: WorkflowStep[];
  requiredChecks: ToolName[];
  safetyRules: SafetyRule[];
  retryPolicy: RetryPolicy;
  escalationPolicy: EscalationPolicy;
}

/* -------------------------------------------------------------------------- */
/* Simulated world                                                             */
/* -------------------------------------------------------------------------- */

export type HealthStatus = "healthy" | "degraded" | "critical";

export interface DependencyHealth {
  service: string;
  status: HealthStatus;
  latencyMsP99: number;
  baselineLatencyMsP99: number;
}

export interface MetricsResult {
  service: string;
  window: string;
  /** Service metadata the metrics API enriches each series with. */
  owner: string;
  /** True when restarting the service destroys live state. */
  stateful: boolean;
  status: HealthStatus;
  latencyMsP50: number;
  latencyMsP95: number;
  latencyMsP99: number;
  baselineLatencyMsP99: number;
  errorRatePct: number;
  baselineErrorRatePct: number;
  cpuPct: number;
  memoryPct: number;
  saturationTrend: "flat" | "rising" | "recovering";
  /** ISO timestamp the anomaly began, or null if nothing anomalous. */
  anomalyStartedAt: string | null;
  /** ISO timestamp the anomaly self-resolved, or null if still ongoing. */
  recoveredAt: string | null;
  upstreamDependencies: DependencyHealth[];
  notes: string;
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  count: number;
}

export interface LogsResult {
  service: string;
  window: string;
  /** Fraction of the incident window actually retrievable, 0..1. */
  coverage: number;
  complete: boolean;
  truncationReason: string | null;
  entries: LogEntry[];
  dominantError: string | null;
}

export interface Deployment {
  id: string;
  service: string;
  deployedAt: string;
  minutesBeforeAlert: number;
  author: string;
  summary: string;
  riskLabel: "low" | "medium" | "high";
  rollbackSafe: boolean;
}

export interface DeploymentsResult {
  service: string;
  lookbackHours: number;
  deployments: Deployment[];
}

/**
 * Note: remediation results deliberately do NOT report whether the incident is
 * actually resolved. A real operator only sees the metrics move. Exposing
 * ground truth here would let the agent cheat on exactly the scenarios (the
 * premature-restart trap) that the suite exists to catch.
 */
export interface RestartResult {
  service: string;
  accepted: boolean;
  metricsAfter: "recovered" | "unchanged" | "worse";
  evidenceDestroyed: boolean;
  sideEffects: string[];
}

export interface RollbackResult {
  service: string;
  deploymentId: string;
  found: boolean;
  accepted: boolean;
  metricsAfter: "recovered" | "unchanged" | "worse";
  evidenceDestroyed: boolean;
  sideEffects: string[];
}

export interface EscalateResult {
  acknowledged: boolean;
  reason: string;
  routedTo: string;
}

export type ToolResult =
  | MetricsResult
  | LogsResult
  | DeploymentsResult
  | RestartResult
  | RollbackResult
  | EscalateResult;

/** Everything the simulator knows about one service in one scenario. */
export interface ServiceWorld {
  name: string;
  /** Stateful services lose data on restart. This is world truth, not policy. */
  stateful: boolean;
  owner: string;
  metrics: MetricsResult;
  logs: LogsResult;
  deployments: DeploymentsResult;
}

export interface RemediationOutcome {
  metricsAfter: "recovered" | "unchanged" | "worse";
  resolvesIncident: boolean;
  evidenceDestroyed: boolean;
  sideEffects: string[];
  /** True when the action is harmful no matter how well-informed the agent is. */
  intrinsicallyUnsafe: boolean;
  unsafeReason?: string;
}

export interface RemediationEffects {
  restart: RemediationOutcome;
  /** Keyed by deployment id. */
  rollback: Record<string, RemediationOutcome>;
  /** Applied when rolling back a deployment with no specific entry. */
  rollbackDefault: RemediationOutcome;
}

export interface Alert {
  id: string;
  service: string;
  symptom: string;
  severity: "sev1" | "sev2" | "sev3";
  firedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Scenario ground truth                                                       */
/* -------------------------------------------------------------------------- */

export type ExpectedFinalAction =
  | { type: "no_action" }
  | { type: "escalate" }
  | { type: "restart_service"; service: string }
  | { type: "rollback_deployment"; service: string; deploymentId: string };

export interface ForbiddenAction {
  tool: ToolName;
  reason: string;
}

export interface OrderingConstraint {
  /** `before` must appear in the trace ahead of every occurrence of `after`. */
  before: ToolName;
  after: ToolName;
  reason: string;
}

export interface GroundTruth {
  rootCause: string;
  /** Diagnostics a competent responder must run before touching production. */
  requiredChecks: ToolName[];
  forbiddenActions: ForbiddenAction[];
  expectedFinalAction: ExpectedFinalAction;
  orderingConstraints: OrderingConstraint[];
  shouldEscalate: boolean;
  /** Substrings the escalation reason must mention to count as useful. */
  escalationMustMention: string[];
}

export interface Scenario {
  id: string;
  title: string;
  category: string;
  description: string;
  service: string;
  alert: Alert;
  services: Record<string, ServiceWorld>;
  effects: RemediationEffects;
  groundTruth: GroundTruth;
}

/* -------------------------------------------------------------------------- */
/* Run traces                                                                  */
/* -------------------------------------------------------------------------- */

export type BrainKind = "heuristic" | "llm";

/**
 * Only actions that actually reached production count as unsafe. A call that a
 * guard blocked never happened, so it is recorded on the ToolCallRecord via
 * `blockedBy` instead — a good spec's trace shows blocks, not unsafe actions.
 */
export type UnsafeCategory = "intrinsic" | "premature";

export interface UnsafeAction {
  toolCallIndex: number;
  tool: ToolName;
  args: Record<string, unknown>;
  category: UnsafeCategory;
  reason: string;
}

export interface ToolCallRecord {
  index: number;
  tool: ToolName;
  args: Record<string, unknown>;
  ok: boolean;
  result: ToolResult | null;
  error: string | null;
  latencyMs: number;
  unsafe: boolean;
  unsafeReasons: string[];
  /** Safety rule ids that were evaluated and blocked this call, if any. */
  blockedBy: SafetyRuleId[];
}

export interface AgentStep {
  index: number;
  /** Why the brain chose what it chose. Kept short and machine-readable. */
  rationale: string;
  decision: string;
}

export type FinalAction =
  | { type: "no_action"; summary: string }
  | { type: "escalate"; reason: string }
  | { type: "restart_service"; service: string }
  | { type: "rollback_deployment"; service: string; deploymentId: string }
  | { type: "none"; summary: string };

export type TerminationReason =
  | "final_action"
  | "tool_budget_exhausted"
  | "remediation_budget_exhausted"
  | "brain_error";

export interface RunTrace {
  runId: string;
  scenarioId: string;
  specVersion: string;
  specName: string;
  brain: BrainKind;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  toolCalls: ToolCallRecord[];
  toolCallCount: number;
  finalAction: FinalAction;
  /** Runtime verdict: the incident ended in a handled state with no unsafe act. */
  success: boolean;
  unsafeActions: UnsafeAction[];
  incidentResolved: boolean;
  terminationReason: TerminationReason;
  steps: AgentStep[];
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                  */
/* -------------------------------------------------------------------------- */

export type EvalCheckId =
  | "forbidden_actions"
  | "required_checks"
  | "final_outcome"
  | "unsafe_remediation"
  | "escalation_correctness"
  | "tool_ordering";

export const EVAL_CHECK_IDS: readonly EvalCheckId[] = [
  "forbidden_actions",
  "required_checks",
  "final_outcome",
  "unsafe_remediation",
  "escalation_correctness",
  "tool_ordering",
] as const;

export interface EvalCheck {
  id: EvalCheckId;
  label: string;
  passed: boolean;
  detail: string;
}

export interface EvalResult {
  runId: string;
  scenarioId: string;
  specVersion: string;
  passed: boolean;
  /** Fraction of checks passed, 0..1. Useful for ranking near-misses. */
  score: number;
  checks: EvalCheck[];
  failures: EvalCheckId[];
}

export interface SuiteEntry {
  trace: RunTrace;
  evaluation: EvalResult;
}

export interface SuiteResult {
  specVersion: string;
  specName: string;
  brain: BrainKind;
  ranAt: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  totalUnsafeActions: number;
  totalToolCalls: number;
  totalLatencyMs: number;
  checkBreakdown: Record<EvalCheckId, { passed: number; failed: number }>;
  entries: SuiteEntry[];
}
