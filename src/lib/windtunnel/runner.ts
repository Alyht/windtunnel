/**
 * The agent runner.
 *
 * A real iterative tool-use loop: ask the brain what to do, enforce the spec
 * (allowed tools, retry budget, safety guards), execute against the simulator,
 * feed the result back, repeat. Everything that happens is written to a
 * RunTrace, which is the only artefact downstream stages are allowed to read.
 */

import { createVirtualClock, type Clock } from "./clock";
import { HeuristicBrain, type Brain, type BrainContext, type Observation, type ScenarioBrief } from "./brain";
import { IncidentSimulator } from "./simulator";
import { blockingVerdicts, evaluateGuards, type AgentKnowledge, type ProposedAction } from "./safety";
import type {
  AgentSpec,
  AgentStep,
  DeploymentsResult,
  FinalAction,
  LogsResult,
  MetricsResult,
  RunTrace,
  Scenario,
  TerminationReason,
  ToolCallRecord,
  ToolName,
  UnsafeAction,
} from "./types";
import { isRemediationTool } from "./types";

export interface RunOptions {
  spec: AgentSpec;
  scenario: Scenario;
  brain?: Brain;
  clock?: Clock;
}

/** Hard stop so a misbehaving brain can never hang the suite. */
const ABSOLUTE_ITERATION_CAP = 64;

export async function runScenario(options: RunOptions): Promise<RunTrace> {
  const { spec, scenario } = options;
  const brain = options.brain ?? new HeuristicBrain();
  const clock = options.clock ?? createVirtualClock();

  const startedAt = clock.nowIso();
  const startMs = clock.now();

  const simulator = new IncidentSimulator(scenario, clock);
  const brief: ScenarioBrief = {
    scenarioId: scenario.id,
    service: scenario.service,
    alert: scenario.alert,
    knownServices: Object.keys(scenario.services),
  };

  const observations: Observation[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const unsafeActions: UnsafeAction[] = [];
  const steps: AgentStep[] = [];
  const failureCountByTool = new Map<ToolName, number>();

  const knowledge: AgentKnowledge = {
    service: scenario.service,
    metrics: null,
    logs: null,
    deployments: null,
    calledTools: [],
    remediationAttempts: 0,
  };

  let finalAction: FinalAction = { type: "none", summary: "the agent reached no decision" };
  let terminationReason: TerminationReason = "final_action";

  for (let iteration = 0; iteration < ABSOLUTE_ITERATION_CAP; iteration += 1) {
    if (toolCalls.length >= spec.retryPolicy.maxToolCalls) {
      terminationReason = "tool_budget_exhausted";
      finalAction = spec.escalationPolicy.escalateOnToolBudgetExhausted
        ? {
            type: "escalate",
            reason: `Tool budget of ${spec.retryPolicy.maxToolCalls} calls was exhausted before a conclusion was reached on ${scenario.service}.`,
          }
        : {
            type: "none",
            summary: `tool budget of ${spec.retryPolicy.maxToolCalls} calls exhausted`,
          };
      break;
    }

    const ctx: BrainContext = {
      spec,
      brief,
      knowledge,
      observations,
      toolCallsRemaining: spec.retryPolicy.maxToolCalls - toolCalls.length,
    };

    let decision;
    try {
      decision = await brain.decide(ctx);
    } catch (err) {
      terminationReason = "brain_error";
      finalAction = {
        type: "none",
        summary: `brain failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      break;
    }

    steps.push({
      index: steps.length,
      rationale: decision.rationale,
      decision:
        decision.kind === "final"
          ? `final:${decision.action.type}`
          : `call:${decision.tool}`,
    });

    if (decision.kind === "final") {
      finalAction = decision.action;
      terminationReason = "final_action";
      break;
    }

    const index = toolCalls.length;
    const { tool, args } = decision;

    /* -- Spec enforcement, before anything reaches the simulator ---------- */

    const rejection = rejectByPolicy(spec, tool, failureCountByTool);
    if (rejection) {
      record({
        index,
        tool,
        args,
        ok: false,
        result: null,
        error: rejection,
        latencyMs: 0,
        unsafe: false,
        unsafeReasons: [],
        blockedBy: [],
      });
      continue;
    }

    if (isRemediationTool(tool)) {
      const proposal = toProposedAction(tool, args, scenario.service);
      const verdicts = evaluateGuards(proposal, knowledge, spec);
      const blocking = blockingVerdicts(verdicts);
      if (blocking.length > 0) {
        record({
          index,
          tool,
          args,
          ok: false,
          result: null,
          error: `blocked by safety rules: ${blocking.map((v) => `${v.ruleId} (${v.reason})`).join("; ")}`,
          latencyMs: 0,
          unsafe: false,
          unsafeReasons: [],
          blockedBy: blocking.map((v) => v.ruleId),
        });
        continue;
      }
    }

    /* -- Execute ---------------------------------------------------------- */

    const execution = simulator.callTool(tool, args);
    record({
      index,
      tool,
      args,
      ok: execution.ok,
      result: execution.result,
      error: execution.error,
      latencyMs: execution.latencyMs,
      unsafe: execution.unsafe,
      unsafeReasons: execution.unsafeReasons,
      blockedBy: [],
    });

    if (execution.unsafe) {
      for (let i = 0; i < execution.unsafeReasons.length; i += 1) {
        unsafeActions.push({
          toolCallIndex: index,
          tool,
          args,
          category: execution.unsafeCategories[i] ?? "intrinsic",
          reason: execution.unsafeReasons[i] ?? "unsafe action",
        });
      }
    }

    if (!execution.ok) {
      failureCountByTool.set(tool, (failureCountByTool.get(tool) ?? 0) + 1);
      continue;
    }

    // Scoped to the alerting service: a check run against a neighbour does not
    // count toward the spec's required checks either.
    knowledge.calledTools = simulator.calledToolsForService(scenario.service);
    knowledge.remediationAttempts = simulator.remediationAttemptCount;
    absorb(knowledge, tool, execution.result);

    if (execution.terminal) {
      finalAction = { type: "escalate", reason: String(args.reason ?? "") };
      terminationReason = "final_action";
      break;
    }
  }

  const finishedAt = clock.nowIso();

  const handled =
    finalAction.type === "escalate"
      ? true
      : finalAction.type === "none"
        ? false
        : simulator.incidentResolved;

  return {
    runId: `${spec.version}::${scenario.id}`,
    scenarioId: scenario.id,
    specVersion: spec.version,
    specName: spec.name,
    brain: brain.kind,
    startedAt,
    finishedAt,
    latencyMs: clock.now() - startMs,
    toolCalls,
    toolCallCount: toolCalls.length,
    finalAction,
    // Runtime verdict only. Spec conformance is the evaluator's job.
    success: handled && unsafeActions.length === 0 && terminationReason === "final_action",
    unsafeActions,
    incidentResolved: simulator.incidentResolved,
    terminationReason,
    steps,
  };

  function record(entry: ToolCallRecord): void {
    toolCalls.push(entry);
    observations.push({
      index: entry.index,
      tool: entry.tool,
      args: entry.args,
      ok: entry.ok,
      result: entry.result,
      error: entry.error,
      blocked: entry.blockedBy.length > 0 || entry.error?.startsWith("not permitted") === true,
      blockReasons: entry.error ? [entry.error] : [],
    });
  }
}

function rejectByPolicy(
  spec: AgentSpec,
  tool: ToolName,
  failureCountByTool: Map<ToolName, number>,
): string | null {
  if (!spec.allowedTools.includes(tool)) {
    return `not permitted: "${tool}" is not in the spec's allowedTools`;
  }
  const failures = failureCountByTool.get(tool) ?? 0;
  if (failures > spec.retryPolicy.maxRetriesPerTool) {
    return `not permitted: "${tool}" exceeded maxRetriesPerTool (${spec.retryPolicy.maxRetriesPerTool})`;
  }
  return null;
}

function toProposedAction(
  tool: ToolName,
  args: Record<string, unknown>,
  fallbackService: string,
): ProposedAction {
  const service = typeof args.service === "string" ? args.service : fallbackService;
  if (tool === "rollback_deployment") {
    return {
      tool: "rollback_deployment",
      service,
      deploymentId: typeof args.deployment_id === "string" ? args.deployment_id : "",
    };
  }
  return { tool: "restart_service", service };
}

/**
 * Fold a diagnostic result into the agent's knowledge. Only results about the
 * alerted service update the working picture; querying a neighbouring service
 * is informative but must not overwrite it.
 */
function absorb(knowledge: AgentKnowledge, tool: ToolName, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const service = (result as { service?: unknown }).service;
  if (service !== knowledge.service) return;

  switch (tool) {
    case "query_metrics":
      knowledge.metrics = result as MetricsResult;
      break;
    case "inspect_logs":
      knowledge.logs = result as LogsResult;
      break;
    case "get_recent_deployments":
      knowledge.deployments = result as DeploymentsResult;
      break;
    default:
      break;
  }
}
