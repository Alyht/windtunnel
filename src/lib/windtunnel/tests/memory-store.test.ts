import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { probeContext } from "../memory/context";
import {
  contextTags,
  matchesTrigger,
  retrieveRules,
  triggerSpecificity,
} from "../memory/retrieve";
import { directiveKey, MemoryStore } from "../memory/store";
import { getScenario } from "../scenarios";
import type { Lesson, ObservedContext } from "../memory/types";

const workdir = mkdtempSync(join(tmpdir(), "windtunnel-memory-"));
after(() => rmSync(workdir, { recursive: true, force: true }));

const statefulContext = probeContext(getScenario("premature-restart-trap"));
const gatewayContext = probeContext(getScenario("ambiguous-root-cause"));

const statefulLesson: Lesson = {
  failureMode: "unsafe-stateful-restart",
  statement: "Never restart a stateful service.",
  trigger: { serviceStateful: true },
  directive: { kind: "enforce_safety_rule", ruleId: "no-restart-on-stateful-service" },
  tags: ["restart", "stateful-service"],
};

function origin(runId = "run-1", scenarioId = "premature-restart-trap") {
  return { runId, scenarioId, context: statefulContext };
}

/* -------------------------------------------------------------------------- */
/* Observed context                                                            */
/* -------------------------------------------------------------------------- */

describe("observed context", () => {
  test("the probe reads the incident without mutating anything", () => {
    const ctx = probeContext(getScenario("premature-restart-trap"));

    assert.equal(ctx.service, "session-store");
    assert.equal(ctx.serviceStateful, true);
    assert.equal(ctx.metricsStatus, "degraded");
    assert.equal(ctx.memoryPressure, true);
    assert.equal(ctx.logsComplete, true);
    assert.equal(ctx.dominantErrorPresent, true);
  });

  test("it captures the signals that distinguish incidents", () => {
    const incomplete = probeContext(getScenario("incomplete-logs"));
    assert.equal(incomplete.serviceStateful, true);
    assert.equal(incomplete.logsComplete, false);
    assert.equal(incomplete.logCoverage, 0.12);

    const dependency = probeContext(getScenario("dependency-degradation"));
    assert.equal(dependency.hasDegradedDependency, true);
    assert.equal(dependency.serviceStateful, false);

    const falseAlarm = probeContext(getScenario("false-alarm-spike"));
    assert.equal(falseAlarm.metricsSelfRecovered, true);
    assert.equal(falseAlarm.candidateDeploymentId, null);
  });

  test("the rollback-safety of the candidate deployment is captured", () => {
    assert.equal(gatewayContext.candidateDeploymentId, "dep-9102");
    assert.equal(gatewayContext.targetDeploymentRollbackSafe, false);

    const goodDeploy = probeContext(getScenario("bad-deployment-latency"));
    assert.equal(goodDeploy.candidateDeploymentId, "dep-4471");
    assert.equal(goodDeploy.targetDeploymentRollbackSafe, true);
  });

  test("probing is deterministic", () => {
    assert.deepEqual(
      probeContext(getScenario("incomplete-logs")),
      probeContext(getScenario("incomplete-logs")),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

describe("persistence", () => {
  test("an unwritten path loads as empty memory", () => {
    const store = MemoryStore.load(join(workdir, "does-not-exist.json"));
    assert.deepEqual(store.rules, []);
    assert.deepEqual(store.runs, []);
    assert.equal(store.nextRunId(), "run-1");
  });

  test("rules and runs survive a save/load round trip", () => {
    const path = join(workdir, "roundtrip.json");
    const store = MemoryStore.load(path);
    const { rule } = store.ingest(statefulLesson, origin());
    store.appendRun({
      runId: "run-1",
      traceRunId: "v1::premature-restart-trap",
      scenarioId: "premature-restart-trap",
      baseSpecVersion: "v1",
      effectiveSpecVersion: "v1",
      passed: false,
      score: 0.17,
      failedChecks: ["final_outcome"],
      unsafeActionCount: 2,
      toolCallCount: 3,
      toolSequence: ["query_metrics", "get_recent_deployments", "restart_service"],
      finalActionType: "restart_service",
      retrievedMemoryRuleIds: [],
      learnedRuleIds: [rule.id],
      reinforcedRuleIds: [],
      revisedRuleIds: [],
    });
    store.save();

    assert.ok(existsSync(path));
    const reloaded = MemoryStore.load(path);
    assert.deepEqual(reloaded.toSnapshot(), store.toSnapshot());
    assert.equal(reloaded.getRule(rule.id)?.statement, statefulLesson.statement);
    assert.equal(reloaded.nextRunId(), "run-2");
  });

  test("the file on disk is human-readable JSON", () => {
    const path = join(workdir, "readable.json");
    const store = MemoryStore.load(path);
    store.ingest(statefulLesson, origin());
    store.save();

    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"rules": \[/);
    assert.ok(raw.endsWith("\n"));
    assert.equal((JSON.parse(raw) as { version: number }).version, 1);
  });

  test("save creates missing directories", () => {
    const path = join(workdir, "nested", "deeper", "memory.json");
    const store = MemoryStore.load(path);
    store.ingest(statefulLesson, origin());
    store.save();
    assert.ok(existsSync(path));
  });

  test("an unsupported snapshot version is rejected rather than silently read", () => {
    const path = join(workdir, "future.json");
    const store = MemoryStore.load(path);
    store.save();
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    snapshot.version = 99;
    writeFileSync(path, JSON.stringify(snapshot), "utf8");

    assert.throws(() => MemoryStore.load(path), /unsupported memory snapshot version/);
  });

  test("reads are cloned, so a caller cannot mutate stored memory", () => {
    const store = MemoryStore.empty();
    const { rule } = store.ingest(statefulLesson, origin());

    const copy = store.getRule(rule.id);
    assert.ok(copy);
    copy.confidence = 0.99;
    copy.statement = "tampered";

    assert.equal(store.getRule(rule.id)?.confidence, 0.5);
    assert.equal(store.getRule(rule.id)?.statement, statefulLesson.statement);
  });

  test("rule ids are sequential and stable", () => {
    const store = MemoryStore.empty();
    const a = store.ingest(statefulLesson, origin());
    const b = store.ingest(
      { ...statefulLesson, directive: { kind: "require_check", tool: "inspect_logs" } },
      origin(),
    );
    assert.equal(a.rule.id, "rule-1");
    assert.equal(b.rule.id, "rule-2");
  });
});

/* -------------------------------------------------------------------------- */
/* Ingestion (no blind appending)                                              */
/* -------------------------------------------------------------------------- */

describe("ingestion", () => {
  test("the same lesson twice reinforces one rule instead of appending", () => {
    const store = MemoryStore.empty();
    const first = store.ingest(statefulLesson, origin("run-1"));
    const second = store.ingest(statefulLesson, origin("run-2", "incomplete-logs"));

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.rule.id, first.rule.id);
    assert.equal(store.rules.length, 1);
    assert.deepEqual(second.rule.supportingRunIds, ["run-1", "run-2"]);
    assert.ok(second.rule.confidence > first.rule.confidence);
  });

  test("confidence is capped", () => {
    const store = MemoryStore.empty();
    for (let i = 1; i <= 20; i += 1) store.ingest(statefulLesson, origin(`run-${i}`));
    assert.equal(store.rules[0]?.confidence, 0.95);
  });

  test("re-learning a retired rule reinstates it", () => {
    const store = MemoryStore.empty();
    const { rule } = store.ingest(statefulLesson, origin("run-1"));
    store.replaceRule({ ...rule, status: "retired" });

    const again = store.ingest(statefulLesson, origin("run-2"));
    assert.equal(again.rule.status, "active");
    assert.equal(again.rule.version, 2);
  });

  test("directive identity is what decides sameness", () => {
    assert.equal(
      directiveKey({ directive: { kind: "avoid_tool", tool: "rollback_deployment" } }),
      "avoid_tool:rollback_deployment",
    );
    assert.notEqual(
      directiveKey({ directive: { kind: "require_check", tool: "inspect_logs" } }),
      directiveKey({ directive: { kind: "require_check", tool: "query_metrics" } }),
    );
  });

  test("replacing an unknown rule is an error, not a silent insert", () => {
    const store = MemoryStore.empty();
    const { rule } = store.ingest(statefulLesson, origin());
    assert.throws(() => store.replaceRule({ ...rule, id: "rule-999" }), /unknown rule/);
  });
});

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

describe("retrieval", () => {
  test("an empty trigger matches every incident", () => {
    assert.equal(matchesTrigger({}, statefulContext), true);
    assert.equal(matchesTrigger({}, gatewayContext), true);
  });

  test("a trigger condition gates on context", () => {
    assert.equal(matchesTrigger({ serviceStateful: true }, statefulContext), true);
    assert.equal(matchesTrigger({ serviceStateful: true }, gatewayContext), false);
  });

  test("every trigger field participates in matching", () => {
    const ctx: ObservedContext = { ...statefulContext };
    assert.equal(matchesTrigger({ metricsStatus: ["critical"] }, ctx), false);
    assert.equal(matchesTrigger({ metricsStatus: ["degraded"] }, ctx), true);
    assert.equal(matchesTrigger({ alertSeverity: ["sev1"] }, ctx), false);
    assert.equal(matchesTrigger({ memoryPressure: true }, ctx), true);
    assert.equal(matchesTrigger({ logsComplete: false }, ctx), false);
    assert.equal(matchesTrigger({ logCoverageBelow: 0.5 }, ctx), false);
    assert.equal(matchesTrigger({ dominantErrorPresent: true }, ctx), true);
    assert.equal(matchesTrigger({ hasDegradedDependency: true }, ctx), false);
    assert.equal(matchesTrigger({ metricsSelfRecovered: false }, ctx), true);
    assert.equal(matchesTrigger({ targetDeploymentRollbackSafe: false }, ctx), false);
  });

  test("all conditions must hold, not just one", () => {
    assert.equal(
      matchesTrigger({ serviceStateful: true, memoryPressure: true }, statefulContext),
      true,
    );
    assert.equal(
      matchesTrigger({ serviceStateful: true, hasDegradedDependency: true }, statefulContext),
      false,
    );
  });

  test("low-confidence rules are not retrieved", () => {
    const store = MemoryStore.empty();
    const { rule } = store.ingest(statefulLesson, origin());
    store.replaceRule({ ...rule, confidence: 0.2 });

    assert.equal(retrieveRules(store.activeRules, statefulContext).length, 0);
    assert.equal(
      retrieveRules(store.activeRules, statefulContext, { confidenceFloor: 0.1 }).length,
      1,
    );
  });

  test("retired rules are never retrieved", () => {
    const store = MemoryStore.empty();
    const { rule } = store.ingest(statefulLesson, origin());
    store.replaceRule({ ...rule, status: "retired" });
    assert.equal(retrieveRules(store.activeRules, statefulContext).length, 0);
  });

  test("tags rank the matches, most contextually apt first", () => {
    const store = MemoryStore.empty();
    store.ingest(
      {
        failureMode: "premature-remediation",
        statement: "universal",
        trigger: {},
        directive: { kind: "enforce_safety_rule", ruleId: "no-remediation-before-required-checks" },
        tags: ["ordering"],
      },
      origin(),
    );
    store.ingest(statefulLesson, origin());

    const results = retrieveRules(store.activeRules, statefulContext);
    assert.equal(results.length, 2);
    // The stateful rule shares a tag with the incident and has a real trigger.
    assert.equal(results[0]?.rule.directive.kind, "enforce_safety_rule");
    assert.ok(results[0]);
    assert.equal(results[0].tagOverlap, 1);
    assert.ok(results[0].score > (results[1]?.score ?? 0));
  });

  test("context tags describe the incident shape", () => {
    assert.deepEqual(contextTags(statefulContext).sort(), ["memory-pressure", "stateful-service"]);
    assert.ok(contextTags(probeContext(getScenario("incomplete-logs"))).includes("incomplete-logs"));
    assert.ok(
      contextTags(probeContext(getScenario("dependency-degradation"))).includes(
        "dependency-degradation",
      ),
    );
  });

  test("more specific triggers score higher", () => {
    assert.equal(triggerSpecificity({}), 0);
    assert.equal(triggerSpecificity({ serviceStateful: true }), 1);
    assert.equal(triggerSpecificity({ serviceStateful: true, memoryPressure: true }), 2);
  });

  test("retrieval is deterministic and ordering is stable", () => {
    const store = MemoryStore.empty();
    store.ingest(statefulLesson, origin());
    store.ingest(
      {
        failureMode: "premature-remediation",
        statement: "universal",
        trigger: {},
        directive: { kind: "enforce_safety_rule", ruleId: "no-remediation-before-required-checks" },
        tags: ["ordering"],
      },
      origin(),
    );

    const a = retrieveRules(store.activeRules, statefulContext).map((r) => r.rule.id);
    const b = retrieveRules(store.activeRules, statefulContext).map((r) => r.rule.id);
    assert.deepEqual(a, b);
  });

  test("limit truncates to the best matches", () => {
    const store = MemoryStore.empty();
    store.ingest(statefulLesson, origin());
    store.ingest(
      {
        failureMode: "premature-remediation",
        statement: "universal",
        trigger: {},
        directive: { kind: "enforce_safety_rule", ruleId: "no-remediation-before-required-checks" },
        tags: ["ordering"],
      },
      origin(),
    );

    assert.equal(retrieveRules(store.activeRules, statefulContext, { limit: 1 }).length, 1);
  });
});
