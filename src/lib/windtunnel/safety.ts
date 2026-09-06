/**
 * Safety rules, as executable guards.
 *
 * The point of WINDTUNNEL is that an AgentSpec has to *do* something, not just
 * describe good intentions. So every SafetyRuleId maps to either:
 *   - a guard, which the runner consults before a production mutation and which
 *     can block the call outright, or
 *   - a decision rule, which the brain consults when choosing a final action.
 *
 * A spec that omits a rule id simply does not get that behaviour. That is why
 * a weak spec produces unsafe runs rather than merely reading as if it might.
 */

import type {
  AgentSpec,
  Deployment,
  DeploymentsResult,
  LogsResult,
  MetricsResult,
  SafetyRule,
  SafetyRuleId,
  ToolName,
} from "./types";

export const DEFAULT_CORRELATION_WINDOW_MINUTES = 240;
export const DEFAULT_MIN_LOG_COVERAGE = 0.5;

/** Everything the agent has actually observed. Never includes ground truth. */
export interface AgentKnowledge {
  service: string;
  metrics: MetricsResult | null;
  logs: LogsResult | null;
  deployments: DeploymentsResult | null;
  calledTools: ToolName[];
  remediationAttempts: number;
}

export type ProposedAction =
  | { tool: "restart_service"; service: string }
  | { tool: "rollback_deployment"; service: string; deploymentId: string };

export interface GuardVerdict {
  ruleId: SafetyRuleId;
  severity: "block" | "warn";
  reason: string;
}

type Guard = (
  action: ProposedAction,
  knowledge: AgentKnowledge,
  rule: SafetyRule,
  spec: AgentSpec,
) => string | null;

/* -------------------------------------------------------------------------- */
/* Spec helpers                                                                */
/* -------------------------------------------------------------------------- */

export function getRule(spec: AgentSpec, id: SafetyRuleId): SafetyRule | undefined {
  return spec.safetyRules.find((r) => r.id === id);
}

export function hasRule(spec: AgentSpec, id: SafetyRuleId): boolean {
  return getRule(spec, id) !== undefined;
}

export function ruleNumber(
  spec: AgentSpec,
  id: SafetyRuleId,
  key: string,
  fallback: number,
): number {
  const value = getRule(spec, id)?.params?.[key];
  return typeof value === "number" ? value : fallback;
}

/* -------------------------------------------------------------------------- */
/* Observable signal helpers (shared by guards and the brain)                  */
/* -------------------------------------------------------------------------- */

export function metricsBenign(metrics: MetricsResult | null): boolean {
  if (!metrics) return false;
  return metrics.status === "healthy" && metrics.latencyMsP99 <= metrics.baselineLatencyMsP99;
}

export function evidenceIncomplete(logs: LogsResult | null, minCoverage: number): boolean {
  if (!logs) return false;
  return !logs.complete || logs.coverage < minCoverage;
}

/**
 * Ambiguity is observable: several distinct error signatures at comparable
 * volume and no single dominant one.
 */
export function causeAmbiguous(logs: LogsResult | null): boolean {
  if (!logs || !logs.complete) return false;
  if (logs.dominantError !== null) return false;
  const errors = logs.entries.filter((e) => e.level === "error");
  return errors.length >= 2;
}

export function degradedDependencies(metrics: MetricsResult | null): string[] {
  if (!metrics) return [];
  return metrics.upstreamDependencies.filter((d) => d.status !== "healthy").map((d) => d.service);
}

/**
 * Deployments that could plausibly have caused the anomaly: inside the
 * correlation window and not after the anomaly started. The causality filter is
 * the operational context a shallow runbook is missing — without it, the newest
 * deploy always looks guilty.
 */
export function candidateDeployments(options: {
  deployments: DeploymentsResult | null;
  metrics: MetricsResult | null;
  alertFiredAt: string;
  windowMinutes: number;
  /** When true, drop deploys that shipped after the anomaly had already begun. */
  applyCausalityFilter: boolean;
}): Deployment[] {
  const { deployments, metrics, alertFiredAt, windowMinutes, applyCausalityFilter } = options;
  if (!deployments) return [];

  let anomalyMinutesBeforeAlert: number | null = null;
  if (applyCausalityFilter && metrics?.anomalyStartedAt) {
    anomalyMinutesBeforeAlert =
      (Date.parse(alertFiredAt) - Date.parse(metrics.anomalyStartedAt)) / 60_000;
  }

  return deployments.deployments
    .filter((d) => d.minutesBeforeAlert <= windowMinutes)
    .filter(
      (d) =>
        anomalyMinutesBeforeAlert === null || d.minutesBeforeAlert >= anomalyMinutesBeforeAlert,
    )
    .sort((a, b) => a.minutesBeforeAlert - b.minutesBeforeAlert);
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

const GUARDS: Partial<Record<SafetyRuleId, Guard>> = {
  "no-remediation-before-required-checks": (_action, knowledge, _rule, spec) => {
    const missing = spec.requiredChecks.filter((t) => !knowledge.calledTools.includes(t));
    if (missing.length === 0) return null;
    return `required checks not completed: ${missing.join(", ")}`;
  },

  "require-deployment-evidence-before-rollback": (action, knowledge, rule, spec) => {
    if (action.tool !== "rollback_deployment") return null;
    if (!knowledge.deployments) {
      return "rollback proposed without ever reading the deployment history";
    }
    const target = knowledge.deployments.deployments.find((d) => d.id === action.deploymentId);
    if (!target) {
      return `deployment ${action.deploymentId} is not in the deployment history for ${action.service}`;
    }
    const window = ruleNumber(
      spec,
      rule.id,
      "correlationWindowMinutes",
      DEFAULT_CORRELATION_WINDOW_MINUTES,
    );
    if (target.minutesBeforeAlert > window) {
      return `deployment ${target.id} shipped ${target.minutesBeforeAlert} minutes before the alert, outside the ${window} minute correlation window`;
    }
    return null;
  },

  "no-restart-on-stateful-service": (action, knowledge) => {
    if (action.tool !== "restart_service") return null;
    if (!knowledge.metrics?.stateful) return null;
    return `${action.service} is stateful; restarting it destroys live state`;
  },

  "no-rollback-without-log-corroboration": (action, knowledge, rule, spec) => {
    if (action.tool !== "rollback_deployment") return null;
    const minCoverage = ruleNumber(spec, rule.id, "minLogCoverage", DEFAULT_MIN_LOG_COVERAGE);
    if (!knowledge.logs) return "rollback proposed without inspecting logs";
    if (knowledge.logs.coverage < minCoverage) {
      return `log coverage is ${(knowledge.logs.coverage * 100).toFixed(0)}%, below the ${(minCoverage * 100).toFixed(0)}% needed to attribute a cause`;
    }
    if (knowledge.logs.dominantError === null) {
      return "logs show no dominant error signature, so no deployment can be attributed as the cause";
    }
    return null;
  },

  "no-restart-during-dependency-degradation": (action, knowledge) => {
    if (action.tool !== "restart_service") return null;
    const degraded = degradedDependencies(knowledge.metrics);
    if (degraded.length === 0) return null;
    return `upstream ${degraded.join(", ")} is degraded; restarting causes a reconnect storm against a failing dependency`;
  },
};

/** Rules that shape the final decision rather than blocking a specific call. */
export const DECISION_RULE_IDS: readonly SafetyRuleId[] = [
  "escalate-when-evidence-incomplete",
  "escalate-when-cause-ambiguous",
  "no-action-when-metrics-healthy",
] as const;

/**
 * Run every guard the spec has opted into. Returns all verdicts; the caller
 * decides what to do with "warn" versus "block".
 */
export function evaluateGuards(
  action: ProposedAction,
  knowledge: AgentKnowledge,
  spec: AgentSpec,
): GuardVerdict[] {
  const verdicts: GuardVerdict[] = [];
  for (const rule of spec.safetyRules) {
    const guard = GUARDS[rule.id];
    if (!guard) continue;
    const reason = guard(action, knowledge, rule, spec);
    if (reason !== null) {
      verdicts.push({ ruleId: rule.id, severity: rule.severity, reason });
    }
  }
  return verdicts;
}

export function blockingVerdicts(verdicts: GuardVerdict[]): GuardVerdict[] {
  return verdicts.filter((v) => v.severity === "block");
}
