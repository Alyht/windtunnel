import { runWithMemory } from "../memory/learn";
import { MemoryStore } from "../memory/store";
import { getScenario, SCENARIOS } from "../scenarios";
import { SPEC_V1 } from "../specs/v1";
import { applyMutation, detectStructuralFailures, diffSpecs, proposeMutation, type StructuralObservation } from "./mutation";
import { runRegressionGuard } from "./regression";

/** IDs belong only to this experiment's fixture selection, never the engineer.
 * One-slot retrieval is explicit: the ordering lesson is recalled, but it can
 * only enforce V1's incomplete requiredChecks list. Structural repair closes it. */
export async function runStructuralDemo() {
  const store = MemoryStore.empty();
  const seed = await runWithMemory({ spec: SPEC_V1, scenario: getScenario("premature-restart-trap"), store });
  const scenario = getScenario("dependency-degradation");
  const memory = store.toSnapshot();
  const retrieval = { limit: 1 };
  const observations: StructuralObservation[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const run = await runWithMemory({ spec: SPEC_V1, scenario,
      store: MemoryStore.fromSnapshot(memory), retrieval, learn: false });
    observations.push({ executionId: `structural-replay-${i}`, baseSpecVersion: SPEC_V1.version,
      trace: run.trace, evaluation: run.evaluation, failureModes: run.reflection.failureModes,
      retrievedRules: memory.rules.filter((r) => run.record.retrievedMemoryRuleIds.includes(r.id)) });
  }
  const failures = detectStructuralFailures(SPEC_V1, observations);
  const mutation = proposeMutation(SPEC_V1, failures);
  if (!mutation) throw new Error("No evidence-backed structural mutation found");
  const v2 = applyMutation(SPEC_V1, mutation);
  const regression = await runRegressionGuard({ v1: SPEC_V1, v2, scenarios: SCENARIOS, memory, retrieval });
  return { experiment: "Deterministic heuristic; six fixed existing scenarios; frozen learned memory; retrieval limit=1 in both arms; no learning during comparison.",
    seed: { trace: seed.trace, evaluation: seed.evaluation }, memory, observations,
    mutation, v1: SPEC_V1, v2, diff: diffSpecs(SPEC_V1, v2), regression };
}
