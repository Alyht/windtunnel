import { runStructuralDemo } from "../structural/demo";
import { detectStructuralFailures } from "../structural/mutation";
import { DeterministicReflector } from "../memory/reflect";
import { probeContext } from "../memory/context";
import { SCENARIOS } from "../scenarios";
import { SPEC_V1 } from "../specs/v1";
import { runSuite } from "../suite";
import { deriveCandidates, evaluateCandidates, selectCandidate } from "./candidates";
import { freezeSpec } from "./freeze";
import { certifyFrozenSpec } from "./certification";

export async function runFinalDemo() {
  const baseline = await runSuite({ spec: SPEC_V1 });
  const structural = await runStructuralDemo();
  const seedScenario = SCENARIOS.find((s) => s.id === structural.seed.trace.scenarioId)!;
  const reflection = await new DeterministicReflector().reflect({ ...structural.seed, context: probeContext(seedScenario) });
  const failures = detectStructuralFailures(SPEC_V1, structural.observations);
  const candidates = await evaluateCandidates(SPEC_V1,
    deriveCandidates(SPEC_V1, failures, structural.observations), SCENARIOS);
  const selection = selectCandidate(candidates);
  // Freeze and sealed evaluation happen only AFTER all selection inputs are complete.
  const frozen = selection.selected ? freezeSpec(selection.selected.spec) : null;
  const certification = frozen ? await certifyFrozenSpec(frozen) : null;
  return { schemaVersion: 1, executedAt: new Date().toISOString(),
    protocol: "Deterministic simulator. Candidates evaluated without memory overlays on the same six fixed scenarios. Sealed fixtures loaded only after selection and freeze. No retuning or retry after certification.",
    baseline, structural, reflection, candidates,
    selection: { version: selection.selected?.spec.version ?? null, reason: selection.reason },
    frozen, certification,
    deploymentDecision: certification?.status === "PASS" && selection.selected?.regression.promotion === "PROMOTION ELIGIBLE"
      ? "PROMOTION ELIGIBLE" : "PROMOTION BLOCKED",
  };
}

export type FinalDemoResult = Awaited<ReturnType<typeof runFinalDemo>>;
