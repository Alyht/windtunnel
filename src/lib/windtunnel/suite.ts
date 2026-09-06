/**
 * Runs every scenario against one AgentSpec and aggregates the verdicts.
 * This is the number that has to go up.
 */

import { createVirtualClock, type Clock } from "./clock";
import type { Brain } from "./brain";
import { evaluateRun } from "./evaluator";
import { runScenario } from "./runner";
import { SCENARIOS } from "./scenarios";
import type { AgentSpec, EvalCheckId, Scenario, SuiteEntry, SuiteResult } from "./types";
import { EVAL_CHECK_IDS } from "./types";

export interface SuiteOptions {
  spec: AgentSpec;
  scenarios?: readonly Scenario[];
  brain?: Brain;
  /** Factory so each scenario starts from the same deterministic epoch. */
  clockFactory?: () => Clock;
}

export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const { spec } = options;
  const scenarios = options.scenarios ?? SCENARIOS;
  const clockFactory = options.clockFactory ?? (() => createVirtualClock());

  const entries: SuiteEntry[] = [];
  for (const scenario of scenarios) {
    const trace = await runScenario({
      spec,
      scenario,
      ...(options.brain ? { brain: options.brain } : {}),
      clock: clockFactory(),
    });
    entries.push({ trace, evaluation: evaluateRun(trace, scenario) });
  }

  const checkBreakdown = Object.fromEntries(
    EVAL_CHECK_IDS.map((id) => [id, { passed: 0, failed: 0 }]),
  ) as Record<EvalCheckId, { passed: number; failed: number }>;

  for (const entry of entries) {
    for (const check of entry.evaluation.checks) {
      const bucket = checkBreakdown[check.id];
      if (check.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
  }

  const passed = entries.filter((e) => e.evaluation.passed).length;

  return {
    specVersion: spec.version,
    specName: spec.name,
    brain: entries[0]?.trace.brain ?? "heuristic",
    // Comes from the clock the suite ran on, so a deterministic run stays
    // deterministic all the way through the summary.
    ranAt: clockFactory().nowIso(),
    total: entries.length,
    passed,
    failed: entries.length - passed,
    passRate: entries.length === 0 ? 0 : passed / entries.length,
    totalUnsafeActions: entries.reduce((n, e) => n + e.trace.unsafeActions.length, 0),
    totalToolCalls: entries.reduce((n, e) => n + e.trace.toolCallCount, 0),
    totalLatencyMs: entries.reduce((n, e) => n + e.trace.latencyMs, 0),
    checkBreakdown,
    entries,
  };
}
