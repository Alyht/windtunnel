/**
 * The learning loop.
 *
 *   probe context -> retrieve rules -> derive spec -> run -> evaluate
 *                 -> reflect -> revise contradicted rules -> ingest lessons
 *
 * Revision happens before ingestion so that a rule which just cost us a correct
 * outcome is narrowed before any new lesson lands on top of it.
 */

import { evaluateRun } from "../evaluator";
import { runScenario } from "../runner";
import { getScenario } from "../scenarios";
import type { AgentSpec, EvalResult, RunTrace, Scenario } from "../types";
import { applyRulesToSpec, type AppliedMemory } from "./apply";
import { probeContext } from "./context";
import { DeterministicReflector } from "./reflect";
import { retrieveRules, type RetrieveOptions } from "./retrieve";
import { isContradictedBy, reviseRule } from "./revise";
import { MemoryStore } from "./store";
import type { LearningRunRecord, ObservedContext, Reflection, Reflector } from "./types";

export interface RunWithMemoryOptions {
  spec: AgentSpec;
  scenario: Scenario;
  store: MemoryStore;
  /** When false, the run reuses memory but writes nothing back. */
  learn?: boolean;
  reflector?: Reflector;
  retrieval?: RetrieveOptions;
}

export interface LearningRunResult {
  record: LearningRunRecord;
  trace: RunTrace;
  evaluation: EvalResult;
  reflection: Reflection;
  context: ObservedContext;
  applied: AppliedMemory;
}

export async function runWithMemory(options: RunWithMemoryOptions): Promise<LearningRunResult> {
  const { spec, scenario, store } = options;
  const learn = options.learn ?? true;
  const reflector = options.reflector ?? new DeterministicReflector();

  const context = probeContext(scenario);
  const retrieved = retrieveRules(store.activeRules, context, options.retrieval ?? {});
  const applied = applyRulesToSpec(
    spec,
    retrieved.map((r) => r.rule),
  );

  const trace = await runScenario({ spec: applied.spec, scenario });
  const evaluation = evaluateRun(trace, scenario);
  const reflection = await reflector.reflect({ trace, evaluation, context });

  const record: LearningRunRecord = {
    runId: store.nextRunId(),
    traceRunId: trace.runId,
    scenarioId: scenario.id,
    baseSpecVersion: spec.version,
    effectiveSpecVersion: applied.spec.version,
    passed: evaluation.passed,
    score: evaluation.score,
    failedChecks: evaluation.failures,
    unsafeActionCount: trace.unsafeActions.length,
    toolCallCount: trace.toolCallCount,
    toolSequence: trace.toolCalls.map((c) => c.tool),
    finalActionType: trace.finalAction.type,
    retrievedMemoryRuleIds: applied.retrievedMemoryRuleIds,
    learnedRuleIds: [],
    reinforcedRuleIds: [],
    revisedRuleIds: [],
  };

  if (learn) {
    // 1. Revise anything this run contradicted.
    for (const rule of store.activeRules) {
      if (!isContradictedBy(rule, record, scenario)) continue;
      const outcome = reviseRule(rule, context, record);
      store.replaceRule(outcome.rule);
      record.revisedRuleIds.push(outcome.rule.id);
    }

    // 2. Then fold in whatever this run taught us.
    for (const lesson of reflection.lessons) {
      const { rule, created } = store.ingest(lesson, {
        runId: record.runId,
        scenarioId: scenario.id,
        context,
      });
      if (created) record.learnedRuleIds.push(rule.id);
      else record.reinforcedRuleIds.push(rule.id);
    }

    store.appendRun(record);
  }

  return { record, trace, evaluation, reflection, context, applied };
}

/* -------------------------------------------------------------------------- */
/* Sequences                                                                   */
/* -------------------------------------------------------------------------- */

export interface LearningSequenceResult {
  store: MemoryStore;
  steps: LearningRunResult[];
}

/** Runs scenarios in order against one store, so later runs see earlier lessons. */
export async function runLearningSequence(options: {
  spec: AgentSpec;
  scenarioIds: string[];
  store?: MemoryStore;
  reflector?: Reflector;
}): Promise<LearningSequenceResult> {
  const store = options.store ?? MemoryStore.empty();
  const steps: LearningRunResult[] = [];

  for (const id of options.scenarioIds) {
    steps.push(
      await runWithMemory({
        spec: options.spec,
        scenario: getScenario(id),
        store,
        ...(options.reflector ? { reflector: options.reflector } : {}),
      }),
    );
  }

  return { store, steps };
}

/**
 * The canonical demonstration sequence.
 *
 * 1. premature-restart-trap  — fails, learns not to restart a stateful service
 * 2. incomplete-logs         — different scenario, recalls those rules, improves
 * 3. ambiguous-root-cause    — learns an over-broad "avoid rollback" rule
 * 4. bad-deployment-latency  — that rule costs a correct outcome, so it narrows
 * 5. bad-deployment-latency  — narrowed rule no longer fires; correct again
 */
export const DEMO_SEQUENCE: string[] = [
  "premature-restart-trap",
  "incomplete-logs",
  "ambiguous-root-cause",
  "bad-deployment-latency",
  "bad-deployment-latency",
];
