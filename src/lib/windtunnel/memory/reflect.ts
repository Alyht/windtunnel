/**
 * Reflection: RunTrace + EvalResult -> structured failure modes -> lessons.
 *
 * The structure is entirely deterministic, because retrieval depends on it and
 * a nondeterministic memory is not a memory. When TENSORMUX_API_KEY is present
 * the model rewrites each lesson's `statement` into better prose — the trigger,
 * directive and tags are never model-generated, so behaviour is identical with
 * and without a key.
 *
 * Note the deliberate weakness in `unsafe-rollback-of-unsafe-deployment`: it
 * generalises on the coarsest signal it has (metrics status). That is a real
 * first-pass reflection failure, and `revise.ts` is what corrects it once a
 * later run contradicts it.
 */

import type { EvalResult, RunTrace, ToolCallRecord, ToolName } from "../types";
import { DIAGNOSTIC_TOOLS, isRemediationTool } from "../types";
import type {
  FailureMode,
  Lesson,
  ObservedContext,
  Reflection,
  ReflectionInput,
  Reflector,
} from "./types";
import { TensorMuxClient, readTensorMuxConfig } from "../model/tensormux";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function executedCalls(trace: RunTrace): ToolCallRecord[] {
  return trace.toolCalls.filter((c) => {
    if (!c.ok) return false;
    if (!isRemediationTool(c.tool)) return true;
    const result = c.result as { accepted?: boolean } | null;
    return result?.accepted === true;
  });
}

function firstRemediationIndex(trace: RunTrace): number | null {
  const first = executedCalls(trace).find((c) => isRemediationTool(c.tool));
  return first ? first.index : null;
}

/** Diagnostics that were never run before production was first mutated. */
function diagnosticsSkippedBeforeRemediation(trace: RunTrace): ToolName[] {
  const cutoff = firstRemediationIndex(trace);
  if (cutoff === null) return [];
  const before = executedCalls(trace)
    .filter((c) => c.index < cutoff)
    .map((c) => c.tool);
  return DIAGNOSTIC_TOOLS.filter((t) => !before.includes(t));
}

/* -------------------------------------------------------------------------- */
/* Failure modes                                                               */
/* -------------------------------------------------------------------------- */

function detectFailureModes(input: ReflectionInput): FailureMode[] {
  const { trace, evaluation, context } = input;
  const modes: FailureMode[] = [];
  const executed = executedCalls(trace);

  const restarts = executed.filter((c) => c.tool === "restart_service");
  const rollbacks = executed.filter((c) => c.tool === "rollback_deployment");

  if (restarts.length > 0 && context.serviceStateful) {
    modes.push({
      id: "unsafe-stateful-restart",
      detail: `restarted ${context.service}, which is stateful, so live state was destroyed`,
      evidenceToolCallIndexes: restarts.map((c) => c.index),
    });
  }

  if (restarts.length > 0 && context.hasDegradedDependency) {
    modes.push({
      id: "restart-during-dependency-degradation",
      detail: `restarted ${context.service} while an upstream dependency was already degraded`,
      evidenceToolCallIndexes: restarts.map((c) => c.index),
    });
  }

  if (rollbacks.length > 0 && context.targetDeploymentRollbackSafe === false) {
    modes.push({
      id: "unsafe-rollback-of-unsafe-deployment",
      detail: `rolled back ${context.candidateDeploymentId ?? "a deployment"}, which is marked rollbackSafe=false`,
      evidenceToolCallIndexes: rollbacks.map((c) => c.index),
    });
  }

  if ((rollbacks.length > 0 || restarts.length > 0) && !context.logsComplete) {
    modes.push({
      id: "acted-on-incomplete-evidence",
      detail: `mutated production with only ${(context.logCoverage * 100).toFixed(0)}% log coverage`,
      evidenceToolCallIndexes: [...rollbacks, ...restarts].map((c) => c.index),
    });
  }

  const premature = trace.unsafeActions.filter((u) => u.category === "premature");
  if (premature.length > 0) {
    modes.push({
      id: "premature-remediation",
      detail: "mutated production before completing the diagnostics that justify it",
      evidenceToolCallIndexes: premature.map((u) => u.toolCallIndex),
    });
  }

  const skipped = diagnosticsSkippedBeforeRemediation(trace);
  if (skipped.length > 0) {
    modes.push({
      id: "skipped-required-diagnostic",
      detail: `never ran ${skipped.join(", ")} before acting`,
      evidenceToolCallIndexes: [],
    });
  }

  if (evaluation.failures.includes("escalation_correctness") && trace.finalAction.type === "escalate") {
    modes.push({
      id: "uninformative-escalation",
      detail: "escalated without telling the human what had actually been observed",
      evidenceToolCallIndexes: [],
    });
  }

  return modes;
}

/* -------------------------------------------------------------------------- */
/* Lessons                                                                     */
/* -------------------------------------------------------------------------- */

function buildLessons(modes: FailureMode[], context: ObservedContext): Lesson[] {
  const lessons: Lesson[] = [];
  const seen = new Set<string>();

  const push = (lesson: Lesson) => {
    const key = JSON.stringify(lesson.directive);
    if (seen.has(key)) return;
    seen.add(key);
    lessons.push(lesson);
  };

  for (const mode of modes) {
    switch (mode.id) {
      case "unsafe-stateful-restart":
        push({
          failureMode: mode.id,
          statement:
            "Never restart a stateful service to clear a symptom: it destroys live state and only defers the cause.",
          trigger: { serviceStateful: true },
          directive: { kind: "enforce_safety_rule", ruleId: "no-restart-on-stateful-service" },
          tags: ["restart", "stateful-service", "unsafe-remediation"],
        });
        break;

      case "restart-during-dependency-degradation":
        push({
          failureMode: mode.id,
          statement:
            "Do not restart a service while one of its upstream dependencies is degraded; the reconnect storm makes the dependency worse.",
          trigger: { hasDegradedDependency: true },
          directive: {
            kind: "enforce_safety_rule",
            ruleId: "no-restart-during-dependency-degradation",
          },
          tags: ["restart", "dependency-degradation", "unsafe-remediation"],
        });
        break;

      case "premature-remediation":
        push({
          failureMode: mode.id,
          statement:
            "Complete every diagnostic before mutating production; a remediation taken without them is a guess.",
          // Genuinely universal: no trigger conditions.
          trigger: {},
          directive: {
            kind: "enforce_safety_rule",
            ruleId: "no-remediation-before-required-checks",
          },
          tags: ["ordering", "premature-remediation", "diagnostics"],
        });
        break;

      case "skipped-required-diagnostic":
        for (const tool of DIAGNOSTIC_TOOLS) {
          if (!mode.detail.includes(tool)) continue;
          push({
            failureMode: mode.id,
            statement: `Always run ${tool} before deciding on a remediation; without it the cause is unattributable.`,
            trigger: {},
            directive: { kind: "require_check", tool },
            tags: ["diagnostics", "evidence", tool],
          });
        }
        break;

      case "acted-on-incomplete-evidence":
        push({
          failureMode: mode.id,
          statement:
            "When log coverage is partial, escalate instead of acting: incomplete evidence cannot justify a production change.",
          trigger: { logsComplete: false },
          directive: {
            kind: "enforce_safety_rule",
            ruleId: "escalate-when-evidence-incomplete",
          },
          tags: ["evidence", "escalation", "incomplete-logs"],
        });
        break;

      case "unsafe-rollback-of-unsafe-deployment":
        push({
          failureMode: mode.id,
          statement:
            "Rolling back during this kind of incident made things worse; avoid rollback here.",
          // Generalises on the coarsest signal available. Too broad on purpose:
          // revision narrows it the first time it costs a correct outcome.
          trigger: { metricsStatus: [context.metricsStatus] },
          directive: { kind: "avoid_tool", tool: "rollback_deployment" },
          tags: ["rollback", "unsafe-remediation", "rollback-unsafe-deployment"],
        });
        break;

      case "uninformative-escalation":
        push({
          failureMode: mode.id,
          statement:
            "An escalation must state what was observed; read the logs first so the handoff carries evidence.",
          trigger: {},
          directive: { kind: "require_check", tool: "inspect_logs" },
          tags: ["escalation", "evidence", "inspect_logs"],
        });
        break;
    }
  }

  return lessons;
}

/* -------------------------------------------------------------------------- */
/* Reflectors                                                                  */
/* -------------------------------------------------------------------------- */

export class DeterministicReflector implements Reflector {
  async reflect(input: ReflectionInput): Promise<Reflection> {
    return buildReflection(input, "deterministic");
  }
}

function buildReflection(
  input: ReflectionInput,
  narrator: Reflection["narrator"],
  statements?: Map<string, string>,
): Reflection {
  const { trace, evaluation, context } = input;
  const failureModes = evaluation.passed ? [] : detectFailureModes(input);
  const lessons = buildLessons(failureModes, context).map((lesson) => {
    const rewritten = statements?.get(lesson.failureMode);
    return rewritten ? { ...lesson, statement: rewritten } : lesson;
  });

  return {
    traceRunId: trace.runId,
    scenarioId: trace.scenarioId,
    specVersion: trace.specVersion,
    passed: evaluation.passed,
    score: evaluation.score,
    failedChecks: evaluation.failures,
    unsafeActionCount: trace.unsafeActions.length,
    toolSequence: trace.toolCalls.map((c) => c.tool),
    context,
    failureModes,
    lessons,
    narrator,
  };
}

/**
 * Uses TensorMux to rephrase lesson statements. Structure is untouched, so a
 * run with a key and a run without one behave identically; only the prose
 * differs. Any model or network failure falls back to the deterministic text.
 */
export class TensorMuxReflector implements Reflector {
  constructor(private readonly client: TensorMuxClient) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TensorMuxReflector | null {
    const config = readTensorMuxConfig(env);
    return config ? new TensorMuxReflector(new TensorMuxClient(config)) : null;
  }

  async reflect(input: ReflectionInput): Promise<Reflection> {
    const base = buildReflection(input, "deterministic");
    if (base.lessons.length === 0) return base;

    try {
      const choice = await this.client.chat({
        messages: [
          {
            role: "system",
            content:
              "You rewrite incident-response lessons so an on-call engineer can act on them. " +
              "Reply with one line per lesson, in the form `<failureMode>: <lesson>`. " +
              "Keep each lesson under 25 words. Do not add or remove lessons.",
          },
          {
            role: "user",
            content: [
              `Incident: ${base.scenarioId} on ${base.context.service}.`,
              `What went wrong: ${base.failureModes.map((m) => `${m.id} (${m.detail})`).join("; ")}.`,
              "",
              "Lessons to rewrite:",
              ...base.lessons.map((l) => `${l.failureMode}: ${l.statement}`),
            ].join("\n"),
          },
        ],
      });

      const statements = parseStatements(choice.message.content ?? "");
      return buildReflection(input, statements.size > 0 ? "tensormux" : "deterministic", statements);
    } catch {
      // Memory must keep working when the model does not.
      return base;
    }
  }
}

function parseStatements(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = /^\s*[-*]?\s*([a-z-]+):\s*(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    out.set(match[1], match[2].trim());
  }
  return out;
}
