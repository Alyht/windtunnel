/**
 * LLM-backed brain.
 *
 * Same Brain interface as the heuristic one, so the runner, simulator and
 * evaluator are identical either way — only the decision-maker swaps out. The
 * AgentSpec is rendered into the system prompt and the tool schema, so the spec
 * still governs behaviour rather than the model's instincts.
 *
 * The heuristic brain remains the default because the test suite and the
 * scenario runner need determinism; this one is for driving the real thing.
 */

import type { Brain, BrainContext, BrainDecision, Observation } from "../brain";
import type { AgentSpec, BrainKind, FinalAction, ToolName } from "../types";
import { isRemediationTool } from "../types";
import {
  readTensorMuxConfig,
  TensorMuxClient,
  TensorMuxError,
  type ChatMessage,
  type ToolDefinition,
} from "./tensormux";

const SERVICE_ARG = {
  type: "string",
  description: "Name of the service to act on.",
} as const;

const TOOL_SCHEMAS: Record<ToolName, ToolDefinition> = {
  query_metrics: {
    type: "function",
    function: {
      name: "query_metrics",
      description:
        "Current latency, error rate, saturation and upstream dependency health for a service.",
      parameters: {
        type: "object",
        properties: { service: SERVICE_ARG },
        required: ["service"],
      },
    },
  },
  inspect_logs: {
    type: "function",
    function: {
      name: "inspect_logs",
      description:
        "Aggregated logs for the incident window. Check the `coverage` field: partial coverage means the evidence is not trustworthy.",
      parameters: {
        type: "object",
        properties: { service: SERVICE_ARG },
        required: ["service"],
      },
    },
  },
  get_recent_deployments: {
    type: "function",
    function: {
      name: "get_recent_deployments",
      description: "Deployment history for a service, newest first, with risk and rollback safety.",
      parameters: {
        type: "object",
        properties: { service: SERVICE_ARG },
        required: ["service"],
      },
    },
  },
  restart_service: {
    type: "function",
    function: {
      name: "restart_service",
      description:
        "Restart every instance of a service. This mutates production, drops in-flight work, and destroys in-memory log evidence.",
      parameters: {
        type: "object",
        properties: { service: SERVICE_ARG },
        required: ["service"],
      },
    },
  },
  rollback_deployment: {
    type: "function",
    function: {
      name: "rollback_deployment",
      description: "Revert a specific deployment. This mutates production.",
      parameters: {
        type: "object",
        properties: {
          service: SERVICE_ARG,
          deployment_id: {
            type: "string",
            description: "Deployment id taken from get_recent_deployments.",
          },
        },
        required: ["service", "deployment_id"],
      },
    },
  },
  escalate: {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Hand the incident to a human. The reason must state what you observed and why you cannot safely act.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Everything the receiving human needs to continue without re-diagnosing.",
          },
        },
        required: ["reason"],
      },
    },
  },
};

const CONCLUDE_NO_ACTION: ToolDefinition = {
  type: "function",
  function: {
    name: "conclude_no_action",
    description:
      "Close the incident without touching production, because no remediation is warranted.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Why no action is the right call." },
      },
      required: ["summary"],
    },
  },
};

export function renderSystemPrompt(spec: AgentSpec): string {
  const lines: string[] = [spec.systemPrompt, ""];

  lines.push("Workflow:");
  spec.workflowSteps.forEach((step, i) => {
    const tool = step.tool ? ` (${step.tool})` : "";
    lines.push(`${i + 1}. ${step.description}${tool}`);
  });

  lines.push("", `Required checks before any remediation: ${spec.requiredChecks.join(", ")}.`);

  if (spec.safetyRules.length > 0) {
    lines.push("", "Safety rules:");
    for (const rule of spec.safetyRules) {
      lines.push(`- [${rule.severity}] ${rule.id}: ${rule.description}`);
    }
  }

  lines.push(
    "",
    `Escalate to ${spec.escalationPolicy.defaultRoute} after ${spec.escalationPolicy.escalateAfterFailedRemediations} failed remediation attempt(s).`,
    `You may make at most ${spec.retryPolicy.maxToolCalls} tool calls and at most ${spec.retryPolicy.maxRemediationAttempts} remediation attempt(s).`,
    "",
    "Call exactly one tool per turn. When the incident is handled, stop calling tools and reply with a one-line summary.",
  );

  return lines.join("\n");
}

function renderObservation(o: Observation): string {
  const header = `${o.tool}(${JSON.stringify(o.args)})`;
  if (o.blocked) return `${header} -> BLOCKED: ${o.blockReasons.join("; ")}`;
  if (!o.ok) return `${header} -> ERROR: ${o.error}`;
  return `${header} -> ${JSON.stringify(o.result)}`;
}

export class LlmBrain implements Brain {
  readonly kind: BrainKind = "llm";

  constructor(private readonly client: TensorMuxClient) {}

  /** Returns null when no API key is configured, so callers can fall back. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmBrain | null {
    const config = readTensorMuxConfig(env);
    return config ? new LlmBrain(new TensorMuxClient(config)) : null;
  }

  async decide(ctx: BrainContext): Promise<BrainDecision> {
    const tools: ToolDefinition[] = ctx.spec.allowedTools.map((t) => TOOL_SCHEMAS[t]);
    tools.push(CONCLUDE_NO_ACTION);

    const messages: ChatMessage[] = [
      { role: "system", content: renderSystemPrompt(ctx.spec) },
      { role: "user", content: this.renderIncident(ctx) },
    ];

    const choice = await this.client.chat({ messages, tools });
    const call = choice.message.tool_calls?.[0];

    if (!call) {
      return {
        kind: "final",
        action: this.inferFinalAction(ctx, choice.message.content ?? ""),
        rationale: (choice.message.content ?? "model stopped calling tools").slice(0, 300),
      };
    }

    const name = call.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      throw new TensorMuxError(`model produced unparseable tool arguments: ${call.function.arguments}`);
    }

    if (name === "conclude_no_action") {
      return {
        kind: "final",
        action: { type: "no_action", summary: String(args.summary ?? "no action required") },
        rationale: String(args.summary ?? "no action required"),
      };
    }

    if (!(name in TOOL_SCHEMAS)) {
      throw new TensorMuxError(`model called unknown tool "${name}"`);
    }

    return {
      kind: "tool_call",
      tool: name as ToolName,
      args,
      rationale: `model chose ${name}`,
    };
  }

  private renderIncident(ctx: BrainContext): string {
    const { brief, observations, toolCallsRemaining } = ctx;
    const lines = [
      `ALERT ${brief.alert.id} (${brief.alert.severity}) on ${brief.service}`,
      `Symptom: ${brief.alert.symptom}`,
      `Fired at: ${brief.alert.firedAt}`,
      `Services you can query: ${brief.knownServices.join(", ")}`,
      "",
    ];

    if (observations.length === 0) {
      lines.push("No tool calls yet.");
    } else {
      lines.push("Tool calls so far:");
      observations.forEach((o, i) => lines.push(`${i + 1}. ${renderObservation(o)}`));
    }

    lines.push("", `Tool calls remaining: ${toolCallsRemaining}.`, "What is your next single step?");
    return lines.join("\n");
  }

  /**
   * The model stopped calling tools. If it had already remediated, that
   * remediation is its final action; otherwise it closed without acting.
   */
  private inferFinalAction(ctx: BrainContext, summary: string): FinalAction {
    const lastRemediation = [...ctx.observations]
      .reverse()
      .find((o) => o.ok && !o.blocked && isRemediationTool(o.tool));

    if (!lastRemediation) {
      return { type: "no_action", summary: summary || "model concluded without acting" };
    }
    if (lastRemediation.tool === "rollback_deployment") {
      return {
        type: "rollback_deployment",
        service: String(lastRemediation.args.service),
        deploymentId: String(lastRemediation.args.deployment_id),
      };
    }
    return { type: "restart_service", service: String(lastRemediation.args.service) };
  }
}
