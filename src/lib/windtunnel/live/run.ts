/** Server-side composition only. Core runner, provider client, safety guards,
 * evaluator and memory implementations remain unchanged. No filesystem writes. */
import { randomUUID } from "node:crypto";
import type { Brain, BrainContext, BrainDecision, Observation } from "../brain";
import { createRealClock } from "../clock";
import { evaluateRun } from "../evaluator";
import { applyRulesToSpec } from "../memory/apply";
import { probeContext } from "../memory/context";
import { DeterministicReflector } from "../memory/reflect";
import { retrieveRules } from "../memory/retrieve";
import { MemoryStore } from "../memory/store";
import { LlmBrain } from "../model/llm-brain";
import { readTensorMuxConfig, TensorMuxClient } from "../model/tensormux";
import { runScenario } from "../runner";
import { getScenario } from "../scenarios";
import { SPEC_V1 } from "../specs/v1";
import type { LiveEvent, LiveResult } from "./types";

export class LiveRunError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function liveConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = readTensorMuxConfig(env);
  if (!config) throw new LiveRunError("NOT_CONFIGURED", "Live agent unavailable: configure TENSORMUX_API_KEY on the server. The executed proof below is still available.");
  return config;
}

/** This wrapper observes actual runner feedback and bounds model waiting time.
 * It never chooses tools, changes a model decision, or falls back to a heuristic. */
async function boundedDecision(brain: LlmBrain, ctx: BrainContext, timeoutMs: number, signal?: AbortSignal): Promise<BrainDecision> {
  if (signal?.aborted) throw new LiveRunError("CANCELLED", "Live run cancelled.");
  if (timeoutMs <= 0) throw new LiveRunError("TIMEOUT", "TensorMux live run exceeded its time limit. No fallback result was generated.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      brain.decide(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LiveRunError("TIMEOUT", "TensorMux response timed out. No fallback result was generated.")), timeoutMs);
        abort = () => reject(new LiveRunError("CANCELLED", "Live run cancelled."));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } catch (error) {
    if (error instanceof LiveRunError) throw error;
    // Provider responses can contain sensitive text. Do not forward/log their body,
    // request headers, API key, or raw exceptions to the browser.
    throw new LiveRunError("MODEL_ERROR", "TensorMux model request failed or returned an invalid tool response. Check the server's provider configuration. No fallback result was generated.");
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export async function runLiveIncident(options: {
  client: TensorMuxClient;
  model: string;
  emit: (event: LiveEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LiveResult> {
  const runId = `live-${randomUUID()}`;
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 90_000);
  // Fixed public demo input, never a sealed fixture or browser-supplied prompt.
  const scenario = getScenario("dependency-degradation");
  const store = MemoryStore.empty();
  const context = probeContext(scenario);
  const retrievedRules = retrieveRules(store.activeRules, context).map((r) => r.rule);
  const { spec } = applyRulesToSpec(SPEC_V1, retrievedRules);
  const llm = new LlmBrain(options.client);
  options.emit({ type: "start", data: { runId, model: options.model, specVersion: spec.version,
    incident: { id: scenario.id, title: scenario.title, service: scenario.service, symptom: scenario.alert.symptom }, retrievedRules } });
  let emitted = 0;
  let modelError: LiveRunError | undefined;
  const flush = (observations: readonly Observation[]) => {
    for (; emitted < observations.length; emitted += 1) options.emit({ type: "tool", data: observations[emitted]! });
  };
  const brain: Brain = { kind: "llm", async decide(ctx) {
    // On the next iteration the previous call has actually reached the runner.
    flush(ctx.observations);
    try { return await boundedDecision(llm, ctx, Math.min(25_000, deadline - Date.now()), options.signal); }
    catch (error) { modelError = error as LiveRunError; throw error; }
  } };
  const original = await runScenario({ spec, scenario, brain, clock: createRealClock() });
  // Final/terminal calls have no following decision iteration; flush them now.
  flush(original.toolCalls.map((c): Observation => ({ index: c.index, tool: c.tool, args: c.args,
    ok: c.ok, result: c.result, error: c.error, blocked: c.blockedBy.length > 0 || c.error?.startsWith("not permitted") === true,
    blockReasons: c.error ? [c.error] : [] })));
  if (modelError || original.terminationReason === "brain_error") {
    const failure = modelError ?? new LiveRunError("MODEL_ERROR", "The live agent failed. No fallback result was generated.");
    options.emit({ type: "error", code: failure.code, message: failure.message, runId });
    throw failure;
  }
  // Preserve core execution, giving this fresh live observation a unique identity.
  const trace = { ...original, runId };
  const evaluation = evaluateRun(trace, scenario);
  const reflection = await new DeterministicReflector().reflect({ trace, evaluation, context });
  for (const lesson of reflection.lessons) store.ingest(lesson, { runId, scenarioId: scenario.id, context });
  const result: LiveResult = { runId, trace, evaluation, reflection, learnedRules: store.rules,
    wallLatencyMs: Date.now() - started,
    simulatedToolLatencyMs: trace.toolCalls.reduce((n, call) => n + call.latencyMs, 0),
    finalStatus: evaluation.passed && trace.success ? "PASS" : "FAIL",
    promotion: "PROMOTION BLOCKED",
    promotionReason: "A single live incident cannot establish promotion safety. This request does not run Regression Guard or sealed certification; the committed benchmark decision is unchanged." };
  options.emit({ type: "result", data: result });
  return result;
}
