/**
 * Phase 2 — learning memory.
 *
 * A LearnedRule is the durable output of a failed run. It has three parts:
 *   - a trigger, which decides deterministically whether the rule applies to a
 *     new incident,
 *   - a directive, expressed in the Phase 1 spec vocabulary so that applying a
 *     rule is just deriving an AgentSpec, and
 *   - provenance, so the UI can say "learned from run X, reused in run Y".
 *
 * Directives deliberately reuse Phase 1's SafetyRuleId set. That means memory
 * changes behaviour through the existing guard machinery instead of adding a
 * second, parallel enforcement path.
 */

import type {
  EvalCheckId,
  EvalResult,
  HealthStatus,
  RunTrace,
  SafetyRuleId,
  ToolName,
} from "../types";

/* -------------------------------------------------------------------------- */
/* Observed context                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The shape of an incident, as measured by read-only tools. This is the vector
 * that retrieval matches against. It contains no ground truth.
 */
export interface ObservedContext {
  service: string;
  serviceStateful: boolean;
  alertSeverity: "sev1" | "sev2" | "sev3";
  metricsStatus: HealthStatus;
  metricsSelfRecovered: boolean;
  hasDegradedDependency: boolean;
  memoryPressure: boolean;
  logsComplete: boolean;
  logCoverage: number;
  dominantErrorPresent: boolean;
  errorSignatureCount: number;
  /** Newest deployment inside the default correlation window, if any. */
  candidateDeploymentId: string | null;
  targetDeploymentRollbackSafe: boolean | null;
  deploymentCountInWindow: number;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * All present conditions must hold for the rule to apply. An empty trigger
 * matches every incident, which is correct for genuinely universal lessons
 * ("always run your diagnostics") and wrong for anything else — which is what
 * revision exists to catch.
 */
export interface RuleTrigger {
  serviceStateful?: boolean;
  metricsStatus?: HealthStatus[];
  alertSeverity?: Array<"sev1" | "sev2" | "sev3">;
  hasDegradedDependency?: boolean;
  memoryPressure?: boolean;
  metricsSelfRecovered?: boolean;
  logsComplete?: boolean;
  logCoverageBelow?: number;
  dominantErrorPresent?: boolean;
  targetDeploymentRollbackSafe?: boolean;
}

export type RuleDirective =
  /** Turn on one of Phase 1's safety guards. */
  | {
      kind: "enforce_safety_rule";
      ruleId: SafetyRuleId;
      params?: Record<string, number | string | boolean>;
    }
  /** Add a diagnostic to requiredChecks (and to the workflow). */
  | { kind: "require_check"; tool: ToolName }
  /** Remove a tool from allowedTools entirely. */
  | { kind: "avoid_tool"; tool: ToolName };

export interface LearnedRule {
  id: string;
  version: number;
  statement: string;
  trigger: RuleTrigger;
  directive: RuleDirective;
  tags: string[];
  /** 0..1. Rises with corroboration, falls when contradicted. */
  confidence: number;
  status: "active" | "retired";

  /** The incident that produced the rule, kept for discriminative narrowing. */
  originContext: ObservedContext;
  originScenarioId: string;
  createdInRunId: string;

  supportingRunIds: string[];
  contradictingRunIds: string[];
  revisionNotes: string[];
}

/* -------------------------------------------------------------------------- */
/* Reflection                                                                  */
/* -------------------------------------------------------------------------- */

export type FailureModeId =
  | "unsafe-stateful-restart"
  | "premature-remediation"
  | "restart-during-dependency-degradation"
  | "unsafe-rollback-of-unsafe-deployment"
  | "acted-on-incomplete-evidence"
  | "uninformative-escalation"
  | "skipped-required-diagnostic";

export interface FailureMode {
  id: FailureModeId;
  detail: string;
  /** Tool call indices in the trace that evidence this failure. */
  evidenceToolCallIndexes: number[];
}

export interface Lesson {
  failureMode: FailureModeId;
  statement: string;
  trigger: RuleTrigger;
  directive: RuleDirective;
  tags: string[];
}

export interface Reflection {
  traceRunId: string;
  scenarioId: string;
  specVersion: string;
  passed: boolean;
  score: number;
  failedChecks: EvalCheckId[];
  unsafeActionCount: number;
  toolSequence: ToolName[];
  context: ObservedContext;
  failureModes: FailureMode[];
  lessons: Lesson[];
  /** "deterministic" always; "tensormux" when an LLM rephrased the statements. */
  narrator: "deterministic" | "tensormux";
}

export interface ReflectionInput {
  trace: RunTrace;
  evaluation: EvalResult;
  context: ObservedContext;
}

export interface Reflector {
  reflect(input: ReflectionInput): Promise<Reflection>;
}

/* -------------------------------------------------------------------------- */
/* Run records and persistence                                                 */
/* -------------------------------------------------------------------------- */

export interface LearningRunRecord {
  /** Sequential id within the store: run-1, run-2, ... */
  runId: string;
  traceRunId: string;
  scenarioId: string;
  baseSpecVersion: string;
  effectiveSpecVersion: string;
  passed: boolean;
  score: number;
  failedChecks: EvalCheckId[];
  unsafeActionCount: number;
  toolCallCount: number;
  toolSequence: ToolName[];
  finalActionType: string;
  /** Rules that were recalled and injected into this run's agent context. */
  retrievedMemoryRuleIds: string[];
  /** Rules created by this run. */
  learnedRuleIds: string[];
  /** Rules this run reinforced. */
  reinforcedRuleIds: string[];
  /** Rules this run narrowed or retired. */
  revisedRuleIds: string[];
}

export interface MemorySnapshot {
  version: 1;
  rules: LearnedRule[];
  runs: LearningRunRecord[];
}

export function emptySnapshot(): MemorySnapshot {
  return { version: 1, rules: [], runs: [] };
}
