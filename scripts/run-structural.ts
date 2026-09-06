import { runStructuralDemo } from "../src/lib/windtunnel/structural/demo";

const result = await runStructuralDemo();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.experiment);
  console.log(`\nMutation: ${result.mutation.type} — ${result.mutation.reason}`);
  for (const e of result.mutation.failure.evidence) {
    console.log(`${e.executionId}: recalled ${e.retrievedRuleIds.join(", ")}; unsafe call #${e.toolCallIndex}`);
  }
  console.log("\nAgentSpec V1 → V2 diff");
  for (const d of result.diff) console.log(`${d.field}\n- ${JSON.stringify(d.before)}\n+ ${JSON.stringify(d.after)}`);
  console.table(result.regression.rows.map((r) => ({ scenario: r.scenarioId,
    V1: r.v1.evaluation.passed ? "PASS" : "FAIL", V2: r.v2.evaluation.passed ? "PASS" : "FAIL",
    fixedChecks: r.fixedChecks.join(", "), regressedChecks: r.regressedChecks.join(", "),
    critical: r.criticalSafetyRegression })));
  console.log(`Fixed evaluator-check failures: ${result.regression.fixedCheckFailures}`);
  for (const key of ["fixedFailures", "preservedSuccesses", "regressions", "criticalSafetyRegressions", "remainingFailures"] as const) {
    console.log(`${key}: ${result.regression[key].length} — ${result.regression[key].join(", ") || "none"}`);
  }
  console.log(`${result.regression.promotion}: ${result.regression.reason}`);
}
