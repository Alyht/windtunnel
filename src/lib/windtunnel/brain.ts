/**
 * The brain decides what to do next. It sees the AgentSpec, the alert, and
 * whatever it has observed so far — never the scenario's ground truth.
 *
 * `HeuristicBrain` is the default. It is a deterministic runbook with a built-in
 * bias toward action, which is exactly what a junior responder has. The spec's
 * safety rules are what turn that bias into correct behaviour; where the spec is
 * silent, the bias wins and the run goes wrong. That coupling is the product.
 */

import {
  candidateDeployments,
  causeAmbiguous,
  DEFAULT_CORRELATION_WINDOW_MINUTES,
  DEFAULT_MIN_LOG_COVERAGE,
  degradedDependencies,
  evidenceIncomplete,
  hasRule,
  metricsBenign,
  ruleNumber,
  type AgentKnowledge,
} from "./safety";
import type {
  AgentSpec,
  Alert,
  BrainKind,
  Deployment,
  FinalAction,
  ToolName,
  ToolResult,
} from "./types";
import { isDiagnosticTool, isRemediationTool } from "./types";

/** What the agent is told about the incident. Contains no ground truth. */
export interface ScenarioBrief {
  scenarioId: string;
  service: string;
  alert: Alert;
  knownServices: string[];
}

export interface Observation {
  index: number;
  tool: ToolName;
  args: Record<string, unknown>;
  ok: boolean;
  result: ToolResult | null;
  error: string | null;
  /** True when a safety guard or the spec prevented the call from running. */
  blocked: boolean;
  blockReasons: string[];
}

export interface BrainContext {
  spec: AgentSpec;
  brief: ScenarioBrief;
  knowledge: AgentKnowledge;
  observations: Observation[];
  toolCallsRemaining: number;
}

export type BrainDecision =
  | {
      kind: "tool_call";
      tool: ToolName;
      args: Record<string, unknown>;
      rationale: string;
    }
  | { kind: "final"; action: FinalAction; rationale: string };

export interface Brain {
  readonly kind: BrainKind;
  decide(ctx: BrainContext): Promise<BrainDecision>;
}

/* -------------------------------------------------------------------------- */
/* Shared reasoning helpers                                                    */
/* -------------------------------------------------------------------------- */

interface RemediationObservation {
  observation: Observation;
  tool: "restart_service" | "rollback_deployment";
  metricsAfter: "recovered" | "unchanged" | "worse";
}

function remediationObservations(observations: Observation[]): RemediationObservation[] {
  const out: RemediationObservation[] = [];
  for (const o of observations) {
    if (!o.ok || o.blocked || !isRemediationTool(o.tool)) continue;
    const result = o.result as { metricsAfter?: string; accepted?: boolean } | null;
    if (!result?.accepted || !result.metricsAfter) continue;
    out.push({
      observation: o,
      tool: o.tool as "restart_service" | "rollback_deployment",
      metricsAfter: result.metricsAfter as "recovered" | "unchanged" | "worse",
    });
  }
  return out;
}

function wasBlocked(observations: Observation[], tool: ToolName): boolean {
  return observations.some((o) => o.blocked && o.tool === tool);
}

/**
 * The escalation message. It reports only what the agent actually observed —
 * an agent that never read the logs cannot say anything about them, and the
 * evaluator holds it to that.
 */
export function buildEscalationReason(ctx: BrainContext): string {
  const { knowledge, brief, spec } = ctx;
  const parts: string[] = [];
  const service = brief.service;

  if (knowledge.metrics) {
    const m = knowledge.metrics;
    parts.push(
      `${service} is ${m.status}: p99 ${m.latencyMsP99}ms against a ${m.baselineLatencyMsP99}ms baseline, error rate ${m.errorRatePct}%.`,
    );
    const degraded = degradedDependencies(m);
    if (degraded.length > 0) {
      parts.push(
        `Upstream ${degraded.join(", ")} is degraded and accounts for the observed latency; it is not owned by the ${service} on-call.`,
      );
    }
  } else {
    parts.push(`${service} alerted: ${brief.alert.symptom}.`);
  }

  if (knowledge.logs) {
    const minCoverage = ruleNumber(
      spec,
      "no-rollback-without-log-corroboration",
      "minLogCoverage",
      DEFAULT_MIN_LOG_COVERAGE,
    );
    if (evidenceIncomplete(knowledge.logs, minCoverage)) {
      parts.push(
        `Log coverage for the incident window is ${(knowledge.logs.coverage * 100).toFixed(0)}% (${knowledge.logs.truncationReason ?? "incomplete"}), which is not enough evidence to attribute a cause.`,
      );
    } else if (causeAmbiguous(knowledge.logs)) {
      const signatures = knowledge.logs.entries.filter((e) => e.level === "error").length;
      parts.push(
        `Root cause is ambiguous: ${signatures} distinct error signatures at comparable volume and no dominant one.`,
      );
    }
  }

  if (knowledge.deployments) {
    const count = knowledge.deployments.deployments.length;
    parts.push(
      count === 0
        ? `No deployments to ${service} in the last ${knowledge.deployments.lookbackHours} hours.`
        : `${count} deployment(s) reviewed in the last ${knowledge.deployments.lookbackHours} hours; none could be safely attributed.`,
    );
  }

  const attempts = knowledge.remediationAttempts;
  if (attempts > 0) {
    parts.push(`${attempts} remediation attempt(s) did not restore the service.`);
  }

  parts.push(`Handing off to ${spec.escalationPolicy.defaultRoute}.`);
  return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Heuristic brain                                                             */
/* -------------------------------------------------------------------------- */

/** Memory pressure above this looks, to a shallow runbook, like "just restart it". */
const MEMORY_REFLEX_THRESHOLD_PCT = 90;

export class HeuristicBrain implements Brain {
  readonly kind: BrainKind = "heuristic";

  async decide(ctx: BrainContext): Promise<BrainDecision> {
    return (
      this.nextDiagnostic(ctx) ??
      this.judgeRemediation(ctx) ??
      this.applyDecisionRules(ctx) ??
      this.applyRunbook(ctx) ??
      this.escalate(ctx, "no remaining safe option")
    );
  }

  /* -- 1. Work through the spec's diagnostic steps ------------------------ */

  private nextDiagnostic(ctx: BrainContext): BrainDecision | null {
    const { spec, knowledge, brief } = ctx;

    const ordered: ToolName[] = [];
    for (const step of spec.workflowSteps) {
      if (step.tool && isDiagnosticTool(step.tool)) ordered.push(step.tool);
    }
    // Required checks are non-negotiable even if the workflow forgot to list them.
    for (const tool of spec.requiredChecks) {
      if (isDiagnosticTool(tool) && !ordered.includes(tool)) ordered.push(tool);
    }

    for (const tool of ordered) {
      if (!spec.allowedTools.includes(tool)) continue;
      if (knowledge.calledTools.includes(tool)) continue;
      return {
        kind: "tool_call",
        tool,
        args: { service: brief.service },
        rationale: `workflow step: gather ${tool.replace(/_/g, " ")} for ${brief.service}`,
      };
    }
    return null;
  }

  /* -- 2. React to a remediation that has already been attempted ---------- */

  private judgeRemediation(ctx: BrainContext): BrainDecision | null {
    const { spec, knowledge, observations } = ctx;
    const attempts = remediationObservations(observations);
    const last = attempts.at(-1);
    if (!last) return null;

    if (last.metricsAfter === "recovered") {
      // Note: "recovered" is all an operator can see. Whether the cause was
      // actually fixed is not observable from here — which is the trap.
      return {
        kind: "final",
        action: this.finalFromObservation(last),
        rationale: `metrics returned to baseline after ${last.tool}`,
      };
    }

    const failed = attempts.filter((a) => a.metricsAfter !== "recovered").length;
    if (failed >= spec.escalationPolicy.escalateAfterFailedRemediations) {
      return this.escalate(ctx, `${failed} remediation attempt(s) failed`);
    }
    if (knowledge.remediationAttempts >= spec.retryPolicy.maxRemediationAttempts) {
      return this.escalate(ctx, "remediation attempt budget exhausted");
    }

    const alternate = this.alternateRemediation(ctx, last.tool);
    return alternate ?? this.escalate(ctx, "no alternate remediation available");
  }

  private finalFromObservation(entry: RemediationObservation): FinalAction {
    const args = entry.observation.args;
    if (entry.tool === "rollback_deployment") {
      return {
        type: "rollback_deployment",
        service: String(args.service),
        deploymentId: String(args.deployment_id),
      };
    }
    return { type: "restart_service", service: String(args.service) };
  }

  private alternateRemediation(
    ctx: BrainContext,
    lastTool: "restart_service" | "rollback_deployment",
  ): BrainDecision | null {
    // A proposal a guard already refused will be refused again. Re-proposing it
    // just burns the tool budget, so treat it as unavailable.
    if (lastTool === "rollback_deployment") {
      if (wasBlocked(ctx.observations, "restart_service")) return null;
      return this.proposeRestart(ctx, "rollback did not restore the service");
    }
    if (wasBlocked(ctx.observations, "rollback_deployment")) return null;
    const target = this.pickDeployment(ctx);
    if (!target) return null;
    return this.proposeRollback(ctx, target, "restart did not restore the service");
  }

  /* -- 3. Decision rules the spec has opted into -------------------------- */

  private applyDecisionRules(ctx: BrainContext): BrainDecision | null {
    const { spec, knowledge } = ctx;

    if (hasRule(spec, "no-action-when-metrics-healthy") && metricsBenign(knowledge.metrics)) {
      const recovered = knowledge.metrics?.recoveredAt;
      return {
        kind: "final",
        action: {
          type: "no_action",
          summary: recovered
            ? `Metrics are at baseline and the anomaly self-resolved at ${recovered}. No remediation is warranted.`
            : "Metrics are at baseline. No remediation is warranted.",
        },
        rationale: "safety rule no-action-when-metrics-healthy applies",
      };
    }

    if (hasRule(spec, "escalate-when-evidence-incomplete")) {
      const minCoverage = ruleNumber(
        spec,
        "no-rollback-without-log-corroboration",
        "minLogCoverage",
        DEFAULT_MIN_LOG_COVERAGE,
      );
      if (evidenceIncomplete(knowledge.logs, minCoverage)) {
        return this.escalate(ctx, "evidence is incomplete");
      }
    }

    if (hasRule(spec, "escalate-when-cause-ambiguous") && causeAmbiguous(knowledge.logs)) {
      return this.escalate(ctx, "root cause is ambiguous");
    }

    return null;
  }

  /* -- 4. The runbook's own bias ------------------------------------------ */

  private applyRunbook(ctx: BrainContext): BrainDecision | null {
    const { knowledge, observations } = ctx;
    const metrics = knowledge.metrics;

    // The classic reflex: memory is high, so reclaim it by restarting.
    if (
      metrics &&
      metrics.memoryPct >= MEMORY_REFLEX_THRESHOLD_PCT &&
      metrics.saturationTrend === "rising" &&
      !wasBlocked(observations, "restart_service")
    ) {
      const proposal = this.proposeRestart(
        ctx,
        `memory at ${metrics.memoryPct}% and still rising`,
      );
      if (proposal) return proposal;
    }

    const target = this.pickDeployment(ctx);
    if (target && !wasBlocked(observations, "rollback_deployment")) {
      const proposal = this.proposeRollback(
        ctx,
        target,
        `${target.id} (${target.riskLabel} risk) shipped ${target.minutesBeforeAlert} minutes before the alert`,
      );
      if (proposal) return proposal;
    }

    if (!wasBlocked(observations, "restart_service")) {
      const proposal = this.proposeRestart(ctx, "no attributable deployment; restarting to restore service");
      if (proposal) return proposal;
    }

    return null;
  }

  /** Newest deployment that could plausibly have caused the anomaly. */
  private pickDeployment(ctx: BrainContext): Deployment | null {
    const { spec, knowledge, brief } = ctx;
    // Log corroboration and causal ordering are the same piece of operational
    // context: a spec without that rule just blames the newest deploy.
    const corroborationRequired = hasRule(spec, "no-rollback-without-log-corroboration");
    if (corroborationRequired && knowledge.logs?.dominantError == null) return null;

    const candidates = candidateDeployments({
      deployments: knowledge.deployments,
      metrics: knowledge.metrics,
      alertFiredAt: brief.alert.firedAt,
      windowMinutes: ruleNumber(
        spec,
        "require-deployment-evidence-before-rollback",
        "correlationWindowMinutes",
        DEFAULT_CORRELATION_WINDOW_MINUTES,
      ),
      applyCausalityFilter: corroborationRequired,
    });

    const alreadyTried = new Set(
      ctx.observations
        .filter((o) => o.tool === "rollback_deployment")
        .map((o) => String(o.args.deployment_id)),
    );
    return candidates.find((d) => !alreadyTried.has(d.id)) ?? null;
  }

  private proposeRestart(ctx: BrainContext, rationale: string): BrainDecision | null {
    if (!ctx.spec.allowedTools.includes("restart_service")) return null;
    return {
      kind: "tool_call",
      tool: "restart_service",
      args: { service: ctx.brief.service },
      rationale,
    };
  }

  private proposeRollback(
    ctx: BrainContext,
    target: Deployment,
    rationale: string,
  ): BrainDecision | null {
    if (!ctx.spec.allowedTools.includes("rollback_deployment")) return null;
    return {
      kind: "tool_call",
      tool: "rollback_deployment",
      args: { service: ctx.brief.service, deployment_id: target.id },
      rationale,
    };
  }

  private escalate(ctx: BrainContext, rationale: string): BrainDecision {
    const reason = buildEscalationReason(ctx);
    if (!ctx.spec.allowedTools.includes("escalate")) {
      return {
        kind: "final",
        action: { type: "none", summary: `wanted to escalate (${rationale}) but the spec does not allow it` },
        rationale,
      };
    }
    if (ctx.knowledge.calledTools.includes("escalate")) {
      return { kind: "final", action: { type: "escalate", reason }, rationale };
    }
    return { kind: "tool_call", tool: "escalate", args: { reason }, rationale };
  }
}
