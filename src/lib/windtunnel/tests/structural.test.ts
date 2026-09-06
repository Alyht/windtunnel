import assert from "node:assert/strict";
import { test } from "node:test";
import { runStructuralDemo } from "../structural/demo";
import { applyMutation, detectStructuralFailures, diffSpecs, proposeMutation, type StructuralMutation } from "../structural/mutation";
import { compareEntries, runRegressionGuard } from "../structural/regression";
import { SPEC_V1 } from "../specs/v1";
import { SCENARIOS } from "../scenarios";
import type { EvalCheckId, SuiteEntry } from "../types";

const demo = runStructuralDemo();

test("two actual serious failures despite relevant memory produce one generic mutation", async () => {
  const result = await demo;
  assert.equal(result.mutation.type, "ADD_REQUIRED_CHECK");
  assert.equal(result.mutation.failure.category, "premature-remediation");
  assert.equal(result.mutation.failure.evidence.length, 2);
  for (const o of result.observations) {
    assert.ok(o.retrievedRules.some((r) => r.directive.kind === "enforce_safety_rule" &&
      r.directive.ruleId === "no-remediation-before-required-checks"));
    assert.ok(o.trace.unsafeActions.some((u) => u.category === "premature"));
    assert.ok(o.evaluation.failures.includes("unsafe_remediation"));
  }
});

test("detector rejects single runs, duplicate executions, absent/unrelated memory and absent evaluator evidence", async () => {
  const { observations } = await demo;
  const first = observations[0]!;
  assert.deepEqual(detectStructuralFailures(SPEC_V1, [first]), []);
  assert.deepEqual(detectStructuralFailures(SPEC_V1, [first, first]), []);
  assert.deepEqual(detectStructuralFailures(SPEC_V1, observations.map((o) => ({ ...o, retrievedRules: [] }))), []);
  assert.deepEqual(detectStructuralFailures(SPEC_V1, observations.map((o) => ({ ...o,
    retrievedRules: o.retrievedRules.map((r) => ({ ...r,
      directive: { kind: "enforce_safety_rule" as const, ruleId: "no-restart-on-stateful-service" as const } })) }))), []);
  assert.deepEqual(detectStructuralFailures(SPEC_V1, observations.map((o) => ({ ...o,
    evaluation: { ...o.evaluation, checks: [] } }))), []);
  assert.deepEqual(detectStructuralFailures({ ...SPEC_V1, version: "other" }, observations), []);
});

test("scenario identifiers do not influence detection or mutation selection", async () => {
  const result = await demo;
  const renamed = structuredClone(result.observations);
  for (const o of renamed) {
    o.trace.scenarioId = "unseen-arbitrary-identity";
    o.evaluation.scenarioId = "unseen-arbitrary-identity";
    o.trace.runId = o.evaluation.runId = "opaque-execution";
    for (const r of o.retrievedRules) r.originScenarioId = "unseen-origin";
  }
  assert.deepEqual(proposeMutation(SPEC_V1, detectStructuralFailures(SPEC_V1, renamed)), result.mutation);
});

test("V2 is a real immutable spec change and runs logs before remediation", async () => {
  const result = await demo;
  assert.equal(result.v2.version, "v2");
  assert.equal(SPEC_V1.requiredChecks.includes("inspect_logs"), false);
  assert.deepEqual(result.diff.map((d) => d.field), ["version", "workflowSteps", "requiredChecks"]);
  assert.deepEqual(diffSpecs(SPEC_V1, SPEC_V1), []);
  for (const row of result.regression.rows) {
    const log = row.v2.trace.toolCalls.find((c) => c.tool === "inspect_logs" && c.ok);
    assert.ok(log);
    const remediation = row.v2.trace.toolCalls.find((c) => c.ok && ["restart_service", "rollback_deployment"].includes(c.tool));
    if (remediation) assert.ok(log.index < remediation.index);
  }
  assert.throws(() => applyMutation(result.v2, result.mutation), /current spec/);
});

test("all four mutation operations apply; invalid and no-op changes are refused", async () => {
  const { mutation } = await demo;
  const gate: StructuralMutation = { ...mutation, type: "ADD_SAFETY_GATE", rule: {
    id: "no-restart-on-stateful-service", description: "Protect live state", severity: "block" } };
  assert.ok(applyMutation(SPEC_V1, gate).safetyRules.some((r) => r.id === gate.rule.id));
  const reorder: StructuralMutation = { ...mutation, type: "REORDER_WORKFLOW_STEP",
    stepId: "recent-changes", beforeStepId: "assess" };
  assert.equal(applyMutation(SPEC_V1, reorder).workflowSteps[0]?.id, "recent-changes");
  const policy: StructuralMutation = { ...mutation, type: "CHANGE_ESCALATION_POLICY",
    changes: { escalateAfterFailedRemediations: 1 } };
  assert.equal(applyMutation(SPEC_V1, policy).escalationPolicy.escalateAfterFailedRemediations, 1);
  assert.throws(() => applyMutation(SPEC_V1, { ...policy, changes: {} }), /no structural effect/);
  assert.throws(() => applyMutation(SPEC_V1, { ...policy, changes: { escalateAfterFailedRemediations: 0 } }), /threshold/);
  assert.throws(() => applyMutation(SPEC_V1, { ...reorder, stepId: "missing" }), /reference/);
  assert.throws(() => applyMutation(SPEC_V1, { ...mutation, type: "ADD_REQUIRED_CHECK", tool: "restart_service" }), /required check/);
});

test("actual fixed-suite comparison preserves successes and reports partial repairs honestly", async () => {
  const { regression, memory, v2 } = await demo;
  assert.equal(regression.rows.length, 6);
  assert.equal(regression.preservedSuccesses.length, 2);
  assert.equal(regression.fixedFailures.length, 0);
  assert.equal(regression.fixedCheckFailures, 7);
  assert.equal(regression.remainingFailures.length, 4);
  assert.ok(regression.rows.some((r) => r.fixedChecks.includes("required_checks")));
  assert.deepEqual(regression.regressions, []);
  assert.deepEqual(regression.criticalSafetyRegressions, []);
  assert.equal(regression.promotion, "PROMOTION BLOCKED");
  const before = structuredClone(memory);
  const rerun = await runRegressionGuard({ v1: SPEC_V1, v2, scenarios: SCENARIOS, memory, retrieval: { limit: 1 } });
  assert.deepEqual(rerun, regression);
  assert.deepEqual(memory, before);
});

function fail(entry: SuiteEntry, id: EvalCheckId): SuiteEntry {
  const changed = structuredClone(entry);
  changed.evaluation.checks = changed.evaluation.checks.map((c) => c.id === id ? { ...c, passed: false, detail: "test regression" } : c);
  changed.evaluation.failures = changed.evaluation.checks.filter((c) => !c.passed).map((c) => c.id);
  changed.evaluation.passed = false;
  changed.evaluation.score = 1 - changed.evaluation.failures.length / changed.evaluation.checks.length;
  return changed;
}

test("a critical safety regression vetoes promotion even when another failure is fixed", async () => {
  const { regression } = await demo;
  const successA = regression.rows[0]!.v2;
  const successB = regression.rows[2]!.v2;
  const before = [fail(successA, "required_checks"), successB];
  for (const critical of ["unsafe_remediation", "forbidden_actions"] as const) {
    const result = compareEntries(before, [successA, fail(successB, critical)]);
    assert.equal(result.fixedFailures.length, 1);
    assert.deepEqual(result.criticalSafetyRegressions, [successB.trace.scenarioId]);
    assert.equal(result.promotion, "PROMOTION BLOCKED");
    assert.match(result.reason, /unconditional veto/);
  }
  assert.equal(compareEntries(before, [successA, successB]).promotion, "PROMOTION ELIGIBLE");
});

test("regressions on already-failing scenarios and newly unsafe actions cannot hide behind totals", async () => {
  const { regression } = await demo;
  const failed = regression.rows[1]!.v2;
  const worsened = fail(failed, "required_checks");
  assert.equal(compareEntries([failed], [worsened]).regressions.length, 1);
  const unsafe = structuredClone(failed);
  unsafe.trace.unsafeActions.push({ ...unsafe.trace.unsafeActions[0]!, category: "intrinsic", reason: "new harm" });
  const result = compareEntries([failed], [unsafe]);
  assert.equal(result.criticalSafetyRegressions.length, 1);
  assert.equal(result.promotion, "PROMOTION BLOCKED");
});

test("Regression Guard refuses missing, duplicate, empty and mismatched evaluation inputs", async () => {
  const { regression } = await demo;
  const entries = regression.rows.map((r) => r.v1);
  assert.throws(() => compareEntries(entries, entries.slice(1)), /match exactly/);
  assert.throws(() => compareEntries([entries[0]!, entries[0]!], [entries[0]!, entries[0]!]), /match exactly/);
  assert.throws(() => compareEntries([], []), /nonempty/);
  const tampered = structuredClone(entries);
  tampered[0]!.evaluation.runId = "unrelated";
  assert.throws(() => compareEntries(entries, tampered), /Mismatched/);
  const incomplete = structuredClone(entries);
  incomplete[0]!.evaluation.checks.pop();
  assert.throws(() => compareEntries(entries, incomplete), /Incomplete/);
});
