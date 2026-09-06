import type { LearnedRule, FailureMode } from "../memory/types";
import type { AgentSpec, EvalCheck, EvalResult, RunTrace, SafetyRule, ToolName } from "../types";
import { DIAGNOSTIC_TOOLS, isDiagnosticTool } from "../types";

/** Execution identity is independent of scenario identity (replays are real runs). */
export interface StructuralObservation {
  executionId: string;
  baseSpecVersion: string;
  trace: RunTrace;
  evaluation: EvalResult;
  failureModes: FailureMode[];
  /** Snapshot of the rules actually retrieved for this execution, not today's store. */
  retrievedRules: LearnedRule[];
}

export interface StructuralFailure {
  category: "premature-remediation";
  missingCheck: ToolName;
  evidence: Array<{
    executionId: string;
    toolCallIndex: number;
    retrievedRuleIds: string[];
    evaluatorChecks: EvalCheck[];
  }>;
}

/** Minimal detector: two distinct serious executions of the same diagnostic gap,
 * each with relevant memory. No scenario IDs, titles, or ground truth are read. */
export function detectStructuralFailures(
  spec: AgentSpec,
  observations: readonly StructuralObservation[],
): StructuralFailure[] {
  const groups = new Map<ToolName, StructuralFailure>();
  const seen = new Set<string>();
  for (const o of observations) {
    if (seen.has(o.executionId)) continue;
    seen.add(o.executionId);
    if (o.baseSpecVersion !== spec.version || o.evaluation.passed ||
        o.trace.runId !== o.evaluation.runId || o.trace.specVersion !== o.evaluation.specVersion ||
        !o.failureModes.some((m) => m.id === "premature-remediation")) continue;
    const evaluatorChecks = o.evaluation.checks.filter((c) => !c.passed &&
      ["unsafe_remediation", "required_checks", "tool_ordering"].includes(c.id));
    if (!evaluatorChecks.some((c) => c.id === "unsafe_remediation")) continue;
    const unsafe = o.trace.unsafeActions.find((a) => a.category === "premature");
    const call = o.trace.toolCalls.find((c) => c.index === unsafe?.toolCallIndex);
    if (!unsafe || !call?.ok || !call.unsafe || call.blockedBy.length > 0) continue;
    for (const tool of DIAGNOSTIC_TOOLS) {
      if (spec.requiredChecks.includes(tool) || !spec.allowedTools.includes(tool)) continue;
      const checked = o.trace.toolCalls.some((c) => c.ok && c.tool === tool &&
        c.index < call.index && c.args.service === call.args.service);
      if (checked) continue;
      const relevant = o.retrievedRules.filter((r) => r.status === "active" &&
        ((r.directive.kind === "require_check" && r.directive.tool === tool) ||
         (r.directive.kind === "enforce_safety_rule" &&
          r.directive.ruleId === "no-remediation-before-required-checks")));
      if (relevant.length === 0) continue;
      const group = groups.get(tool) ?? {
        category: "premature-remediation", missingCheck: tool, evidence: [],
      };
      group.evidence.push({ executionId: o.executionId, toolCallIndex: call.index,
        retrievedRuleIds: relevant.map((r) => r.id), evaluatorChecks });
      groups.set(tool, group);
    }
  }
  return [...groups.values()].filter((g) => g.evidence.length >= 2);
}

interface MutationBasis {
  baseSpecVersion: string;
  reason: string;
  failure: StructuralFailure;
}

export type StructuralMutation = MutationBasis & (
  | { type: "ADD_REQUIRED_CHECK"; tool: ToolName }
  | { type: "ADD_SAFETY_GATE"; rule: SafetyRule }
  | { type: "REORDER_WORKFLOW_STEP"; stepId: string; beforeStepId: string }
  // These policy fields already have executable semantics in the Phase 1 runner/brain.
  | { type: "CHANGE_ESCALATION_POLICY"; changes: Partial<Pick<AgentSpec["escalationPolicy"],
      "escalateAfterFailedRemediations" | "escalateOnToolBudgetExhausted" | "defaultRoute">> }
);

/** One generic repair only; never select a patch by scenario identity. */
export function proposeMutation(spec: AgentSpec, failures: StructuralFailure[]): StructuralMutation | null {
  const failure = failures.find((f) => f.evidence.length >= 2 && !spec.requiredChecks.includes(f.missingCheck));
  return failure ? {
    type: "ADD_REQUIRED_CHECK", baseSpecVersion: spec.version, tool: failure.missingCheck,
    reason: `Repeated ${failure.category} despite recalled diagnostic-ordering memory; make ${failure.missingCheck} a permanent requirement.`,
    failure: structuredClone(failure),
  } : null;
}

export function applyMutation(base: AgentSpec, mutation: StructuralMutation, version = "v2"): AgentSpec {
  if (mutation.baseSpecVersion !== base.version || version === base.version) {
    throw new Error("Mutation must target the current spec and produce a new version");
  }
  const next = structuredClone(base);
  switch (mutation.type) {
    case "ADD_REQUIRED_CHECK": {
      if (!isDiagnosticTool(mutation.tool) || !next.allowedTools.includes(mutation.tool) ||
          next.requiredChecks.includes(mutation.tool)) throw new Error("Invalid or redundant required check");
      next.requiredChecks.push(mutation.tool);
      if (!next.workflowSteps.some((s) => s.tool === mutation.tool)) {
        const decision = next.workflowSteps.findIndex((s) => !s.tool);
        next.workflowSteps.splice(decision < 0 ? next.workflowSteps.length : decision, 0, {
          id: `required-${mutation.tool}`, tool: mutation.tool,
          description: `Gather ${mutation.tool} before deciding on remediation.`,
        });
      }
      break;
    }
    case "ADD_SAFETY_GATE":
      if (mutation.rule.severity !== "block" || next.safetyRules.some((r) => r.id === mutation.rule.id)) {
        throw new Error("Safety gate must be new and blocking");
      }
      next.safetyRules.push(structuredClone(mutation.rule));
      break;
    case "REORDER_WORKFLOW_STEP": {
      const from = next.workflowSteps.findIndex((s) => s.id === mutation.stepId);
      const before = next.workflowSteps.findIndex((s) => s.id === mutation.beforeStepId);
      if (from < 0 || before < 0 || from === before) throw new Error("Invalid workflow step reference");
      const [step] = next.workflowSteps.splice(from, 1);
      next.workflowSteps.splice(next.workflowSteps.findIndex((s) => s.id === mutation.beforeStepId), 0, step!);
      break;
    }
    case "CHANGE_ESCALATION_POLICY":
      if (mutation.changes.escalateAfterFailedRemediations !== undefined &&
          (!Number.isInteger(mutation.changes.escalateAfterFailedRemediations) ||
           mutation.changes.escalateAfterFailedRemediations < 1)) throw new Error("Invalid escalation threshold");
      Object.assign(next.escalationPolicy, mutation.changes);
      break;
  }
  if (JSON.stringify(next) === JSON.stringify(base)) throw new Error("Mutation has no structural effect");
  next.version = version;
  return next;
}

export interface SpecDiff { field: keyof AgentSpec; before: unknown; after: unknown }

export function diffSpecs(before: AgentSpec, after: AgentSpec): SpecDiff[] {
  return (Object.keys(before) as Array<keyof AgentSpec>)
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}
