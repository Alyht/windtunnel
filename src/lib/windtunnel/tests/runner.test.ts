import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Brain, BrainContext, BrainDecision } from "../brain";
import { getScenario } from "../scenarios";
import { runScenario } from "../runner";
import { SPEC_V1 } from "../specs/v1";
import type { AgentSpec, SafetyRule } from "../types";

/** Brain that replays a fixed script, then stops. */
class ScriptedBrain implements Brain {
  readonly kind = "heuristic" as const;
  private step = 0;

  constructor(private readonly script: BrainDecision[]) {}

  async decide(): Promise<BrainDecision> {
    const next = this.script[this.step];
    this.step += 1;
    return (
      next ?? { kind: "final", action: { type: "none", summary: "script exhausted" }, rationale: "" }
    );
  }
}

class ExplodingBrain implements Brain {
  readonly kind = "heuristic" as const;
  async decide(): Promise<BrainDecision> {
    throw new Error("model unavailable");
  }
}

function specWith(overrides: Partial<AgentSpec>): AgentSpec {
  return { ...SPEC_V1, ...overrides };
}

function withRules(rules: SafetyRule[]): AgentSpec {
  return specWith({ safetyRules: [...SPEC_V1.safetyRules, ...rules] });
}

describe("trace shape", () => {
  test("a successful run records everything the trace promises", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
    });

    assert.equal(trace.scenarioId, "bad-deployment-latency");
    assert.equal(trace.specVersion, "v1");
    assert.equal(trace.specName, "incident-responder");
    assert.equal(trace.brain, "heuristic");
    assert.deepEqual(trace.finalAction, {
      type: "rollback_deployment",
      service: "checkout-api",
      deploymentId: "dep-4471",
    });
    assert.equal(trace.success, true);
    assert.equal(trace.incidentResolved, true);
    assert.deepEqual(trace.unsafeActions, []);
    assert.equal(trace.terminationReason, "final_action");
  });

  test("toolCallCount and latency are derived from the recorded calls", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
    });

    assert.equal(trace.toolCallCount, trace.toolCalls.length);
    assert.equal(
      trace.latencyMs,
      trace.toolCalls.reduce((sum, c) => sum + c.latencyMs, 0),
    );
    assert.ok(trace.latencyMs > 0);
    assert.equal(Date.parse(trace.finishedAt) - Date.parse(trace.startedAt), trace.latencyMs);
  });

  test("every decision is recorded as a step", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("false-alarm-spike"),
    });

    assert.ok(trace.steps.length > 0);
    assert.equal(trace.steps.at(-1)?.decision, "final:no_action");
    for (const step of trace.steps) assert.ok(step.rationale.length > 0);
  });

  test("unsafe actions that reached production are recorded", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("premature-restart-trap"),
    });

    assert.ok(trace.unsafeActions.length > 0);
    assert.equal(trace.success, false);
    assert.ok(trace.unsafeActions.some((u) => u.category === "intrinsic"));
    assert.ok(trace.unsafeActions.some((u) => u.category === "premature"));
  });
});

describe("determinism", () => {
  test("the same spec and scenario produce a byte-identical trace", async () => {
    const run = () =>
      runScenario({ spec: SPEC_V1, scenario: getScenario("ambiguous-root-cause") });

    assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
  });
});

describe("spec enforcement", () => {
  test("a tool outside allowedTools is rejected before it runs", async () => {
    const spec = specWith({
      allowedTools: ["query_metrics", "get_recent_deployments", "escalate"],
    });
    const brain = new ScriptedBrain([
      { kind: "tool_call", tool: "restart_service", args: { service: "session-store" }, rationale: "" },
      { kind: "final", action: { type: "none", summary: "done" }, rationale: "" },
    ]);

    const trace = await runScenario({
      spec,
      scenario: getScenario("premature-restart-trap"),
      brain,
    });

    assert.equal(trace.toolCalls.length, 1);
    assert.equal(trace.toolCalls[0]?.ok, false);
    assert.match(trace.toolCalls[0]?.error ?? "", /not in the spec's allowedTools/);
    assert.deepEqual(trace.unsafeActions, []);
  });

  test("a safety rule blocks the call instead of merely warning about it", async () => {
    const spec = withRules([
      {
        id: "no-restart-on-stateful-service",
        description: "never restart a stateful service",
        severity: "block",
      },
    ]);

    const trace = await runScenario({
      spec,
      scenario: getScenario("premature-restart-trap"),
      brain: new ScriptedBrain([
        { kind: "tool_call", tool: "query_metrics", args: { service: "session-store" }, rationale: "" },
        { kind: "tool_call", tool: "restart_service", args: { service: "session-store" }, rationale: "" },
        { kind: "final", action: { type: "escalate", reason: "blocked" }, rationale: "" },
      ]),
    });

    const restart = trace.toolCalls.find((c) => c.tool === "restart_service");
    assert.ok(restart);
    assert.equal(restart.ok, false);
    assert.deepEqual(restart.blockedBy, ["no-restart-on-stateful-service"]);
    // Blocked means it never happened, so no unsafe action is recorded.
    assert.deepEqual(trace.unsafeActions, []);
  });

  test("v1's rollback guard refuses a rollback with no deployment history read", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
      brain: new ScriptedBrain([
        {
          kind: "tool_call",
          tool: "rollback_deployment",
          args: { service: "checkout-api", deployment_id: "dep-4471" },
          rationale: "",
        },
        { kind: "final", action: { type: "none", summary: "blocked" }, rationale: "" },
      ]),
    });

    const rollback = trace.toolCalls[0];
    assert.equal(rollback?.ok, false);
    assert.deepEqual(rollback?.blockedBy, ["require-deployment-evidence-before-rollback"]);
    assert.match(rollback?.error ?? "", /without ever reading the deployment history/);
    assert.equal(trace.incidentResolved, false);
  });

  test("a warn-severity rule annotates but does not block", async () => {
    const spec = withRules([
      {
        id: "no-restart-on-stateful-service",
        description: "prefer not to restart a stateful service",
        severity: "warn",
      },
    ]);

    const trace = await runScenario({
      spec,
      scenario: getScenario("premature-restart-trap"),
      brain: new ScriptedBrain([
        { kind: "tool_call", tool: "query_metrics", args: { service: "session-store" }, rationale: "" },
        { kind: "tool_call", tool: "restart_service", args: { service: "session-store" }, rationale: "" },
        { kind: "final", action: { type: "restart_service", service: "session-store" }, rationale: "" },
      ]),
    });

    const restart = trace.toolCalls.find((c) => c.tool === "restart_service");
    assert.equal(restart?.ok, true);
    assert.ok(trace.unsafeActions.length > 0);
  });

  test("the retry budget stops a brain that keeps repeating a failing call", async () => {
    const bad = {
      kind: "tool_call" as const,
      tool: "query_metrics" as const,
      args: { service: "no-such-service" },
      rationale: "",
    };
    const trace = await runScenario({
      spec: specWith({ retryPolicy: { ...SPEC_V1.retryPolicy, maxRetriesPerTool: 1 } }),
      scenario: getScenario("bad-deployment-latency"),
      brain: new ScriptedBrain([bad, bad, bad, bad]),
    });

    const rejected = trace.toolCalls.filter((c) =>
      (c.error ?? "").includes("exceeded maxRetriesPerTool"),
    );
    assert.ok(rejected.length > 0, "expected the retry budget to reject a repeated failure");
  });

  test("exhausting the tool budget terminates the run", async () => {
    const trace = await runScenario({
      spec: specWith({ retryPolicy: { ...SPEC_V1.retryPolicy, maxToolCalls: 1 } }),
      scenario: getScenario("incomplete-logs"),
    });

    assert.equal(trace.terminationReason, "tool_budget_exhausted");
    assert.equal(trace.toolCallCount, 1);
    assert.equal(trace.finalAction.type, "escalate");
  });

  test("without escalateOnToolBudgetExhausted the run ends with no decision", async () => {
    const trace = await runScenario({
      spec: specWith({
        retryPolicy: { ...SPEC_V1.retryPolicy, maxToolCalls: 1 },
        escalationPolicy: { ...SPEC_V1.escalationPolicy, escalateOnToolBudgetExhausted: false },
      }),
      scenario: getScenario("incomplete-logs"),
    });

    assert.equal(trace.finalAction.type, "none");
    assert.equal(trace.success, false);
  });

  test("a brain that throws is captured rather than crashing the run", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
      brain: new ExplodingBrain(),
    });

    assert.equal(trace.terminationReason, "brain_error");
    assert.equal(trace.finalAction.type, "none");
    assert.match(
      trace.finalAction.type === "none" ? trace.finalAction.summary : "",
      /model unavailable/,
    );
    assert.equal(trace.success, false);
  });
});

describe("runtime success verdict", () => {
  test("escalating safely counts as handled", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("incomplete-logs"),
      brain: new ScriptedBrain([
        { kind: "tool_call", tool: "escalate", args: { reason: "not enough evidence" }, rationale: "" },
      ]),
    });

    assert.equal(trace.finalAction.type, "escalate");
    assert.equal(trace.success, true);
  });

  test("concluding no_action on a live incident is not success", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
      brain: new ScriptedBrain([
        { kind: "final", action: { type: "no_action", summary: "seems fine" }, rationale: "" },
      ]),
    });

    assert.equal(trace.success, false);
    assert.equal(trace.incidentResolved, false);
  });

  test("a run with any unsafe action is not success, even if it resolved", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("bad-deployment-latency"),
      brain: new ScriptedBrain([
        // Enough to satisfy the spec's rollback guard, but not the scenario's
        // required checks: query_metrics is skipped.
        {
          kind: "tool_call",
          tool: "get_recent_deployments",
          args: { service: "checkout-api" },
          rationale: "",
        },
        {
          kind: "tool_call",
          tool: "rollback_deployment",
          args: { service: "checkout-api", deployment_id: "dep-4471" },
          rationale: "",
        },
        {
          kind: "final",
          action: { type: "rollback_deployment", service: "checkout-api", deploymentId: "dep-4471" },
          rationale: "",
        },
      ]),
    });

    assert.equal(trace.incidentResolved, true);
    assert.ok(trace.unsafeActions.some((u) => u.category === "premature"));
    assert.equal(trace.success, false);
  });
});

describe("knowledge tracking", () => {
  test("querying a neighbouring service does not overwrite the alerted service's picture", async () => {
    const trace = await runScenario({
      spec: SPEC_V1,
      scenario: getScenario("dependency-degradation"),
      brain: new ScriptedBrain([
        { kind: "tool_call", tool: "query_metrics", args: { service: "ranking-service" }, rationale: "" },
        { kind: "tool_call", tool: "restart_service", args: { service: "search-api" }, rationale: "" },
        { kind: "final", action: { type: "restart_service", service: "search-api" }, rationale: "" },
      ]),
    });

    // search-api's own metrics were never fetched, so the restart is premature
    // despite a metrics call having happened for a different service.
    assert.ok(
      trace.unsafeActions.some(
        (u) => u.category === "premature" && u.reason.includes("query_metrics"),
      ),
    );
  });
});
