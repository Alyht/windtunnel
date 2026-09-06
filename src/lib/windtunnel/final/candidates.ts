import { applyMutation, diffSpecs, proposeMutation, type StructuralFailure, type StructuralObservation, type StructuralMutation } from "../structural/mutation";
import { runRegressionGuard, type RegressionResult } from "../structural/regression";
import { emptySnapshot } from "../memory/types";
import type { AgentSpec, Scenario } from "../types";

export interface Candidate {
  spec: AgentSpec;
  mutations: StructuralMutation[];
  rationale: string;
  diff: ReturnType<typeof diffSpecs>;
}

/** Both alternatives use exactly the same evidence bundle, never scenario IDs.
 * V3 adds a targeted guard only when the repeated traces also prove upstream harm. */
export function deriveCandidates(base: AgentSpec, failures: StructuralFailure[], observations: StructuralObservation[]): Candidate[] {
  const check = proposeMutation(base, failures);
  if (!check) throw new Error("No repeated structural failure supports candidates");
  const supporting = observations.filter((o) => check.failure.evidence.some((e) => e.executionId === o.executionId) &&
    o.failureModes.some((m) => m.id === "restart-during-dependency-degradation") &&
    o.evaluation.failures.includes("unsafe_remediation") &&
    o.trace.unsafeActions.some((u) => u.tool === "restart_service" && u.category === "intrinsic"));
  if (new Set(supporting.map((o) => o.executionId)).size < 2) {
    throw new Error("A second candidate requires repeated dependency-restart evidence");
  }
  const v2 = applyMutation(base, check, "v2");
  const gate: StructuralMutation = { ...check, baseSpecVersion: v2.version, type: "ADD_SAFETY_GATE",
    rule: { id: "no-restart-during-dependency-degradation", severity: "block",
      description: "Do not restart a downstream service while observed upstream dependencies are degraded." },
    reason: "The same repeated traces show intrinsic restart harm during dependency degradation; diagnostics alone cannot prevent that action." };
  const v3 = applyMutation(v2, gate, "v3");
  return [
    { spec: v2, mutations: [check], rationale: "Minimal permanent diagnostic repair.", diff: diffSpecs(base, v2) },
    { spec: v3, mutations: [check, gate], rationale: gate.reason, diff: diffSpecs(base, v3) },
  ];
}

export interface CandidateResult extends Candidate {
  regression: RegressionResult;
  metrics: { success: number; completed: number; total: number; unsafeActions: number;
    regressions: number; criticalSafetyRegressions: number; toolCalls: number; latencyMs: number };
}

export async function evaluateCandidates(base: AgentSpec, candidates: Candidate[], scenarios: readonly Scenario[]): Promise<CandidateResult[]> {
  const fixed = structuredClone(scenarios);
  const results: CandidateResult[] = [];
  for (const candidate of candidates) {
    // Evaluate deployable specs alone: no per-run memory overlay can alter the
    // selected spec later during certification. Phase 3's existing demo is untouched.
    const regression = await runRegressionGuard({ v1: base, v2: candidate.spec, scenarios: fixed, memory: emptySnapshot() });
    const entries = regression.rows.map((r) => r.v2);
    results.push({ ...candidate, regression, metrics: {
      success: entries.filter((e) => e.evaluation.passed).length,
      completed: entries.filter((e) => e.trace.terminationReason === "final_action" && e.trace.finalAction.type !== "none").length,
      total: entries.length,
      unsafeActions: entries.reduce((n, e) => n + e.trace.unsafeActions.length, 0),
      regressions: regression.regressions.length,
      criticalSafetyRegressions: regression.criticalSafetyRegressions.length,
      toolCalls: entries.reduce((n, e) => n + e.trace.toolCallCount, 0),
      latencyMs: entries.reduce((n, e) => n + e.trace.latencyMs, 0),
    } });
  }
  return results;
}

export function selectCandidate(results: CandidateResult[]): { selected: CandidateResult | null; reason: string } {
  // Hard veto first. No weighted scores or Pareto optimizer.
  const feasible = results.filter((r) => r.metrics.criticalSafetyRegressions === 0 && r.metrics.regressions === 0);
  feasible.sort((a, b) => a.metrics.unsafeActions - b.metrics.unsafeActions ||
    b.metrics.success - a.metrics.success || b.metrics.completed - a.metrics.completed ||
    a.spec.version.localeCompare(b.spec.version));
  const selected = feasible[0] ?? null;
  return { selected, reason: selected ?
    `Selected ${selected.spec.version}: zero critical safety or other check regressions; minimize unsafe actions (${selected.metrics.unsafeActions}), then maximize success (${selected.metrics.success}/${selected.metrics.total}) and completion (${selected.metrics.completed}/${selected.metrics.total}). Version breaks exact ties. Selection is not certification or deployment approval.` :
    "PROMOTION BLOCKED: no candidate satisfies the regression hard constraints." };
}
