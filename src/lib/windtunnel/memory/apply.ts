/**
 * Injects retrieved rules into the agent's context by deriving an AgentSpec.
 *
 * This is why directives speak Phase 1's vocabulary: applying memory is a pure
 * spec transformation. The runner, brain, simulator and evaluator are all
 * unchanged and unaware that memory exists — a recalled rule takes effect
 * through the same guard machinery a hand-written rule would.
 *
 * The statements are also appended to systemPrompt so an LLM brain sees the
 * recalled lessons in natural language, not just as enforced constraints.
 */

import type { AgentSpec, SafetyRule } from "../types";
import type { LearnedRule } from "./types";

export interface AppliedMemory {
  spec: AgentSpec;
  retrievedMemoryRuleIds: string[];
  addedSafetyRuleIds: string[];
  addedRequiredChecks: string[];
  removedTools: string[];
}

export function applyRulesToSpec(base: AgentSpec, rules: LearnedRule[]): AppliedMemory {
  if (rules.length === 0) {
    return {
      spec: base,
      retrievedMemoryRuleIds: [],
      addedSafetyRuleIds: [],
      addedRequiredChecks: [],
      removedTools: [],
    };
  }

  const safetyRules: SafetyRule[] = [...base.safetyRules];
  const requiredChecks = [...base.requiredChecks];
  let allowedTools = [...base.allowedTools];
  const workflowSteps = [...base.workflowSteps];

  const addedSafetyRuleIds: string[] = [];
  const addedRequiredChecks: string[] = [];
  const removedTools: string[] = [];

  for (const rule of rules) {
    const directive = rule.directive;

    if (directive.kind === "enforce_safety_rule") {
      if (safetyRules.some((r) => r.id === directive.ruleId)) continue;
      safetyRules.push({
        id: directive.ruleId,
        description: `${rule.statement} (learned: ${rule.id})`,
        severity: "block",
        ...(directive.params ? { params: directive.params } : {}),
      });
      addedSafetyRuleIds.push(directive.ruleId);
      continue;
    }

    if (directive.kind === "require_check") {
      if (!allowedTools.includes(directive.tool)) allowedTools.push(directive.tool);
      if (requiredChecks.includes(directive.tool)) continue;
      requiredChecks.push(directive.tool);
      addedRequiredChecks.push(directive.tool);
      // Put the diagnostic in the workflow ahead of the first non-tool step so
      // the agent gathers it before it decides anything.
      const decisionIndex = workflowSteps.findIndex((s) => s.tool === undefined);
      const step = {
        id: `learned-${directive.tool}`,
        description: `${rule.statement} (learned: ${rule.id})`,
        tool: directive.tool,
      };
      if (decisionIndex === -1) workflowSteps.push(step);
      else workflowSteps.splice(decisionIndex, 0, step);
      continue;
    }

    // avoid_tool
    if (allowedTools.includes(directive.tool)) {
      allowedTools = allowedTools.filter((t) => t !== directive.tool);
      removedTools.push(directive.tool);
    }
  }

  const recalled = rules
    .map((r) => `- [${r.id} v${r.version}, confidence ${r.confidence.toFixed(2)}] ${r.statement}`)
    .join("\n");

  return {
    spec: {
      ...base,
      version: `${base.version}+mem(${rules.map((r) => r.id).join(",")})`,
      systemPrompt: `${base.systemPrompt}\n\nRecalled from previous incidents:\n${recalled}`,
      allowedTools,
      workflowSteps,
      requiredChecks,
      safetyRules,
    },
    retrievedMemoryRuleIds: rules.map((r) => r.id),
    addedSafetyRuleIds,
    addedRequiredChecks,
    removedTools,
  };
}
