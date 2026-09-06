import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyRulesToSpec } from "../memory/apply";
import { probeContext } from "../memory/context";
import { DEMO_SEQUENCE, runLearningSequence, runWithMemory } from "../memory/learn";
import { DeterministicReflector } from "../memory/reflect";
import { isContradictedBy, reviseRule } from "../memory/revise";
import { MemoryStore } from "../memory/store";
import { getScenario } from "../scenarios";
import { SPEC_V1 } from "../specs/v1";
import type { LearnedRule } from "../memory/types";
import type { EvalCheckId } from "../types";

const RUN_A = "premature-restart-trap";
const RUN_B = "incomplete-logs";

/** Runs one scenario against a fresh store: the no-memory control. */
async function withoutMemory(scenarioId: string) {
  return runWithMemory({
    spec: SPEC_V1,
    scenario: getScenario(scenarioId),
    store: MemoryStore.empty(),
  });
}

/* -------------------------------------------------------------------------- */
/* Reflection                                                                  */
/* -------------------------------------------------------------------------- */

describe("reflection", () => {
  test("a failing run produces structured failure modes and lessons", async () => {
    const { reflection } = await withoutMemory(RUN_A);

    assert.equal(reflection.passed, false);
    assert.equal(reflection.narrator, "deterministic");
    assert.ok(reflection.failureModes.some((m) => m.id === "unsafe-stateful-restart"));
    assert.ok(reflection.failureModes.some((m) => m.id === "premature-remediation"));
    assert.ok(reflection.lessons.length > 0);
    for (const lesson of reflection.lessons) {
      assert.ok(lesson.statement.length > 0);
      assert.ok(lesson.tags.length > 0);
    }
  });

  test("a passing run produces no lessons", async () => {
    const { reflection } = await withoutMemory("false-alarm-spike");

    assert.equal(reflection.passed, true);
    assert.deepEqual(reflection.failureModes, []);
    assert.deepEqual(reflection.lessons, []);
  });

  test("reflection is deterministic", async () => {
    const a = await withoutMemory(RUN_A);
    const b = await withoutMemory(RUN_A);
    assert.deepEqual(a.reflection, b.reflection);
  });

  test("lessons never duplicate a directive", async () => {
    const { reflection } = await withoutMemory(RUN_B);
    const keys = reflection.lessons.map((l) => JSON.stringify(l.directive));
    assert.equal(new Set(keys).size, keys.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Injection                                                                   */
/* -------------------------------------------------------------------------- */

describe("rule injection", () => {
  const statefulRule: LearnedRule = {
    id: "rule-1",
    version: 1,
    statement: "Never restart a stateful service.",
    trigger: { serviceStateful: true },
    directive: { kind: "enforce_safety_rule", ruleId: "no-restart-on-stateful-service" },
    tags: ["restart"],
    confidence: 0.5,
    status: "active",
    originContext: probeContext(getScenario(RUN_A)),
    originScenarioId: RUN_A,
    createdInRunId: "run-1",
    supportingRunIds: ["run-1"],
    contradictingRunIds: [],
    revisionNotes: [],
  };

  test("no rules means the base spec is used unchanged", () => {
    const applied = applyRulesToSpec(SPEC_V1, []);
    assert.equal(applied.spec, SPEC_V1);
    assert.deepEqual(applied.retrievedMemoryRuleIds, []);
  });

  test("a safety-rule directive becomes an enforced guard", () => {
    const applied = applyRulesToSpec(SPEC_V1, [statefulRule]);

    assert.ok(applied.spec.safetyRules.some((r) => r.id === "no-restart-on-stateful-service"));
    assert.deepEqual(applied.addedSafetyRuleIds, ["no-restart-on-stateful-service"]);
    assert.deepEqual(applied.retrievedMemoryRuleIds, ["rule-1"]);
    // The base spec is never mutated.
    assert.ok(!SPEC_V1.safetyRules.some((r) => r.id === "no-restart-on-stateful-service"));
  });

  test("a require_check directive extends requiredChecks and the workflow", () => {
    const applied = applyRulesToSpec(SPEC_V1, [
      { ...statefulRule, directive: { kind: "require_check", tool: "inspect_logs" } },
    ]);

    assert.ok(applied.spec.requiredChecks.includes("inspect_logs"));
    assert.deepEqual(applied.addedRequiredChecks, ["inspect_logs"]);
    // Inserted before the first decision step, so it is gathered before acting.
    const logIndex = applied.spec.workflowSteps.findIndex((s) => s.tool === "inspect_logs");
    const decideIndex = applied.spec.workflowSteps.findIndex((s) => s.tool === undefined);
    assert.ok(logIndex >= 0 && logIndex < decideIndex);
  });

  test("an avoid_tool directive removes the tool", () => {
    const applied = applyRulesToSpec(SPEC_V1, [
      { ...statefulRule, directive: { kind: "avoid_tool", tool: "rollback_deployment" } },
    ]);

    assert.ok(!applied.spec.allowedTools.includes("rollback_deployment"));
    assert.deepEqual(applied.removedTools, ["rollback_deployment"]);
  });

  test("recalled statements are injected into the system prompt", () => {
    const applied = applyRulesToSpec(SPEC_V1, [statefulRule]);

    assert.match(applied.spec.systemPrompt, /Recalled from previous incidents/);
    assert.match(applied.spec.systemPrompt, /Never restart a stateful service/);
    assert.match(applied.spec.systemPrompt, /rule-1/);
    assert.match(applied.spec.version, /\+mem\(rule-1\)/);
  });

  test("a rule the base spec already covers is not added twice", () => {
    const applied = applyRulesToSpec(SPEC_V1, [
      {
        ...statefulRule,
        directive: {
          kind: "enforce_safety_rule",
          ruleId: "require-deployment-evidence-before-rollback",
        },
      },
    ]);

    assert.equal(
      applied.spec.safetyRules.filter(
        (r) => r.id === "require-deployment-evidence-before-rollback",
      ).length,
      1,
    );
    assert.deepEqual(applied.addedSafetyRuleIds, []);
  });
});

/* -------------------------------------------------------------------------- */
/* Reuse across two distinct scenarios                                         */
/* -------------------------------------------------------------------------- */

describe("reuse across distinct scenarios", () => {
  test("run A fails and writes rules to memory", async () => {
    const store = MemoryStore.empty();
    const a = await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_A), store });

    assert.equal(a.record.passed, false);
    assert.deepEqual(a.record.retrievedMemoryRuleIds, [], "memory starts empty");
    assert.ok(a.record.learnedRuleIds.length > 0);
    assert.ok(
      store.rules.some(
        (r) =>
          r.directive.kind === "enforce_safety_rule" &&
          r.directive.ruleId === "no-restart-on-stateful-service",
      ),
      "run A must learn not to restart a stateful service",
    );
  });

  test("run B is a different scenario, recalls run A's rule, and improves", async () => {
    const store = MemoryStore.empty();
    const a = await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_A), store });
    const b = await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_B), store });
    const control = await withoutMemory(RUN_B);

    // The two runs really are distinct incidents.
    assert.notEqual(a.record.scenarioId, b.record.scenarioId);
    assert.notEqual(a.context.service, b.context.service);

    // The rule learned in A was recalled in B.
    const statefulRuleId = store.rules.find(
      (r) =>
        r.directive.kind === "enforce_safety_rule" &&
        r.directive.ruleId === "no-restart-on-stateful-service",
    )?.id;
    assert.ok(statefulRuleId);
    assert.ok(
      b.record.retrievedMemoryRuleIds.includes(statefulRuleId),
      "run B must recall the rule learned in run A",
    );
    assert.equal(store.getRule(statefulRuleId)?.createdInRunId, a.record.runId);

    // And it changed what happened.
    assert.ok(
      b.applied.addedSafetyRuleIds.includes("no-restart-on-stateful-service"),
      "the recalled rule must be enforced in run B",
    );
    const blockedRestart = b.trace.toolCalls.find(
      (c) => c.tool === "restart_service" && c.blockedBy.includes("no-restart-on-stateful-service"),
    );
    assert.ok(blockedRestart, "run B's restart must be blocked by the recalled rule");

    // The outcome is measurably better than the same scenario with no memory.
    assert.ok(
      b.record.score > control.record.score,
      `expected improvement, got ${control.record.score} -> ${b.record.score}`,
    );
    assert.ok(
      b.record.unsafeActionCount < control.record.unsafeActionCount,
      `expected fewer unsafe actions, got ${control.record.unsafeActionCount} -> ${b.record.unsafeActionCount}`,
    );
    assert.notDeepEqual(b.record.toolSequence, control.record.toolSequence);
  });

  test("the improvement in run B is attributable to memory, not to the scenario", async () => {
    const control = await withoutMemory(RUN_B);

    assert.deepEqual(control.record.retrievedMemoryRuleIds, []);
    assert.ok(control.trace.toolCalls.some((c) => c.tool === "restart_service" && c.ok));
    assert.ok(
      control.trace.unsafeActions.some((u) =>
        u.reason.includes("restarting a stateful payments service"),
      ),
      "without memory the agent restarts the stateful service",
    );
  });

  test("a rule whose trigger does not match is not recalled", async () => {
    const store = MemoryStore.empty();
    await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_A), store });

    const statefulRuleId = store.rules.find(
      (r) =>
        r.directive.kind === "enforce_safety_rule" &&
        r.directive.ruleId === "no-restart-on-stateful-service",
    )?.id;

    // api-gateway is not stateful, so the stateful rule must stay out of it.
    const gateway = await runWithMemory({
      spec: SPEC_V1,
      scenario: getScenario("ambiguous-root-cause"),
      store,
      learn: false,
    });

    assert.ok(statefulRuleId);
    assert.ok(!gateway.record.retrievedMemoryRuleIds.includes(statefulRuleId));
  });

  test("learn:false reuses memory but writes nothing back", async () => {
    const store = MemoryStore.empty();
    await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_A), store });
    const before = store.toSnapshot();

    await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_B), store, learn: false });

    assert.deepEqual(store.toSnapshot(), before);
  });
});

/* -------------------------------------------------------------------------- */
/* Revision                                                                    */
/* -------------------------------------------------------------------------- */

describe("revision", () => {
  test("a rule is contradicted only when it removed the needed action", async () => {
    const store = MemoryStore.empty();
    await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: [RUN_A, RUN_B, "ambiguous-root-cause"],
      store,
    });

    const avoidRollback = store.rules.find((r) => r.directive.kind === "avoid_tool");
    assert.ok(avoidRollback, "the ambiguous incident should teach an avoid_tool rule");

    const badDeploy = getScenario("bad-deployment-latency");
    const failingRecord = {
      runId: "run-x",
      traceRunId: "t",
      scenarioId: badDeploy.id,
      baseSpecVersion: "v1",
      effectiveSpecVersion: "v1",
      passed: false,
      score: 0.5,
      failedChecks: ["final_outcome"] satisfies EvalCheckId[] as EvalCheckId[],
      unsafeActionCount: 0,
      toolCallCount: 3,
      toolSequence: [],
      finalActionType: "restart_service",
      retrievedMemoryRuleIds: [avoidRollback.id],
      learnedRuleIds: [],
      reinforcedRuleIds: [],
      revisedRuleIds: [],
    };

    assert.equal(isContradictedBy(avoidRollback, { ...failingRecord }, badDeploy), true);

    // Not contradicted when it was not recalled...
    assert.equal(
      isContradictedBy(
        avoidRollback,
        { ...failingRecord, retrievedMemoryRuleIds: [] },
        badDeploy,
      ),
      false,
    );
    // ...nor when the run passed...
    assert.equal(
      isContradictedBy(avoidRollback, { ...failingRecord, passed: true }, badDeploy),
      false,
    );
    // ...nor when the failure was not about the final outcome.
    assert.equal(
      isContradictedBy(
        avoidRollback,
        { ...failingRecord, failedChecks: ["required_checks"] },
        badDeploy,
      ),
      false,
    );
  });

  test("a self-gating safety rule can never be blamed for an outcome", async () => {
    const store = MemoryStore.empty();
    await runWithMemory({ spec: SPEC_V1, scenario: getScenario(RUN_A), store });
    const guardRule = store.rules.find((r) => r.directive.kind === "enforce_safety_rule");
    assert.ok(guardRule);

    assert.equal(
      isContradictedBy(
        guardRule,
        {
          runId: "run-x",
          traceRunId: "t",
          scenarioId: "bad-deployment-latency",
          baseSpecVersion: "v1",
          effectiveSpecVersion: "v1",
          passed: false,
          score: 0.5,
          failedChecks: ["final_outcome"],
          unsafeActionCount: 0,
          toolCallCount: 0,
          toolSequence: [],
          finalActionType: "restart_service",
          retrievedMemoryRuleIds: [guardRule.id],
          learnedRuleIds: [],
          reinforcedRuleIds: [],
          revisedRuleIds: [],
        },
        getScenario("bad-deployment-latency"),
      ),
      false,
    );
  });

  test("contradiction narrows the trigger instead of deleting the rule", () => {
    const originContext = probeContext(getScenario("ambiguous-root-cause"));
    const contradicting = probeContext(getScenario("bad-deployment-latency"));

    const rule: LearnedRule = {
      id: "rule-9",
      version: 1,
      statement: "avoid rollback here",
      trigger: { metricsStatus: ["critical"] },
      directive: { kind: "avoid_tool", tool: "rollback_deployment" },
      tags: ["rollback"],
      confidence: 0.5,
      status: "active",
      originContext,
      originScenarioId: "ambiguous-root-cause",
      createdInRunId: "run-3",
      supportingRunIds: ["run-3"],
      contradictingRunIds: [],
      revisionNotes: [],
    };

    const outcome = reviseRule(rule, contradicting, {
      runId: "run-4",
      scenarioId: "bad-deployment-latency",
    } as never);

    assert.equal(outcome.action, "narrowed");
    assert.equal(outcome.rule.status, "active");
    assert.equal(outcome.rule.version, 2);
    assert.equal(outcome.rule.trigger.targetDeploymentRollbackSafe, false);
    // The original condition is kept, not replaced.
    assert.deepEqual(outcome.rule.trigger.metricsStatus, ["critical"]);
    assert.ok(outcome.rule.confidence < rule.confidence);
    assert.deepEqual(outcome.rule.contradictingRunIds, ["run-4"]);
    assert.match(outcome.rule.revisionNotes[0] ?? "", /narrowed after run-4/);

    // Narrowed: it still fires on the incident it was learned from, and no
    // longer fires on the one it got wrong.
    assert.equal(outcome.rule.trigger.targetDeploymentRollbackSafe, originContext.targetDeploymentRollbackSafe);
    assert.notEqual(
      outcome.rule.trigger.targetDeploymentRollbackSafe,
      contradicting.targetDeploymentRollbackSafe,
    );
  });

  test("a rule that cannot be narrowed is retired rather than left firing", () => {
    const context = probeContext(getScenario("bad-deployment-latency"));
    const rule: LearnedRule = {
      id: "rule-9",
      version: 1,
      statement: "avoid rollback",
      trigger: {},
      directive: { kind: "avoid_tool", tool: "rollback_deployment" },
      tags: [],
      confidence: 0.5,
      status: "active",
      // Origin and contradiction are the same incident: nothing separates them.
      originContext: context,
      originScenarioId: "bad-deployment-latency",
      createdInRunId: "run-1",
      supportingRunIds: ["run-1"],
      contradictingRunIds: [],
      revisionNotes: [],
    };

    const outcome = reviseRule(rule, context, {
      runId: "run-2",
      scenarioId: "bad-deployment-latency",
    } as never);

    assert.equal(outcome.action, "retired");
    assert.equal(outcome.rule.status, "retired");
    assert.match(outcome.rule.revisionNotes[0] ?? "", /no context feature separates it/);
  });
});

/* -------------------------------------------------------------------------- */
/* The full sequence                                                           */
/* -------------------------------------------------------------------------- */

describe("end-to-end learning sequence", () => {
  test("memory improves a previously failing scenario and survives revision", async () => {
    const { store, steps } = await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: DEMO_SEQUENCE,
      store: MemoryStore.empty(),
      reflector: new DeterministicReflector(),
    });

    assert.equal(steps.length, DEMO_SEQUENCE.length);
    const [runA, runB, , runD, runE] = steps;
    assert.ok(runA && runB && runD && runE);

    // Run A: nothing to recall, learns.
    assert.deepEqual(runA.record.retrievedMemoryRuleIds, []);
    assert.ok(runA.record.learnedRuleIds.length > 0);

    // Run B: distinct scenario, recalls, improves against the no-memory control.
    const controlB = await withoutMemory(RUN_B);
    assert.ok(runB.record.retrievedMemoryRuleIds.length > 0);
    assert.ok(runB.record.score > controlB.record.score);

    // Run D: an over-broad rule costs a correct outcome and is narrowed.
    assert.equal(runD.record.passed, false);
    assert.equal(runD.record.revisedRuleIds.length, 1);
    const revisedId = runD.record.revisedRuleIds[0];
    assert.ok(revisedId);
    const revised = store.getRule(revisedId);
    assert.equal(revised?.version, 2);
    assert.equal(revised?.status, "active");

    // Run E: same scenario, the narrowed rule no longer fires, and it passes.
    assert.equal(runE.record.scenarioId, runD.record.scenarioId);
    assert.ok(!runE.record.retrievedMemoryRuleIds.includes(revisedId));
    assert.equal(runE.record.passed, true);
    assert.equal(runE.record.unsafeActionCount, 0);
  });

  test("the same sequence always produces the same memory", async () => {
    const first = await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: DEMO_SEQUENCE,
      store: MemoryStore.empty(),
    });
    const second = await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: DEMO_SEQUENCE,
      store: MemoryStore.empty(),
    });

    assert.deepEqual(first.store.toSnapshot(), second.store.toSnapshot());
  });

  test("every run record carries the ids it recalled", async () => {
    const { store } = await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: DEMO_SEQUENCE,
      store: MemoryStore.empty(),
    });

    assert.equal(store.runs.length, DEMO_SEQUENCE.length);
    for (const run of store.runs) {
      assert.ok(Array.isArray(run.retrievedMemoryRuleIds));
      for (const id of run.retrievedMemoryRuleIds) {
        assert.ok(store.getRule(id), `run ${run.runId} recalled unknown rule ${id}`);
      }
    }
  });

  test("provenance supports 'learned from run X, reused in run Y'", async () => {
    const { store } = await runLearningSequence({
      spec: SPEC_V1,
      scenarioIds: DEMO_SEQUENCE,
      store: MemoryStore.empty(),
    });

    const reusedSomewhere = store.rules.filter((rule) =>
      store.runs.some(
        (run) => run.retrievedMemoryRuleIds.includes(rule.id) && run.runId !== rule.createdInRunId,
      ),
    );
    assert.ok(reusedSomewhere.length > 0, "at least one rule must be reused in a later run");

    for (const rule of store.rules) {
      assert.ok(rule.createdInRunId.startsWith("run-"));
      assert.ok(rule.supportingRunIds.includes(rule.createdInRunId));
      assert.ok(rule.originScenarioId.length > 0);
    }
  });
});
