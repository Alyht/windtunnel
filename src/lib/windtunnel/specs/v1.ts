/**
 * AgentSpec V1 — the honest first draft.
 *
 * This is what an incident-response agent looks like before it has been through
 * anything. It is not a strawman: the workflow is sensible, the prompt is the
 * kind of thing a team actually writes, and it resolves clean single-cause
 * incidents correctly.
 *
 * What it is missing is operational context, and the gaps are specific:
 *
 *   - It never reads logs, so it cannot tell a causal deploy from a coincident
 *     one and blames whichever shipped most recently.
 *   - It has no concept of a stateful service, so "restart it" is always on the
 *     table — including for session stores and payment processors.
 *   - It has no notion of evidence quality, so 12% log coverage and 100% log
 *     coverage lead to equally confident rollbacks.
 *   - It cannot recognise that a dependency, not the service, is the problem.
 *   - It only escalates after remediation has already failed twice, which means
 *     it thrashes production before asking for help.
 *
 * Each of those is a missing safetyRule id, not missing prose. That is what
 * later phases get to fix.
 */

import type { AgentSpec } from "../types";

export const SPEC_V1: AgentSpec = {
  version: "v1",
  name: "incident-responder",
  description:
    "First-pass incident response agent. Diagnoses with metrics and deployment history, then remediates.",

  systemPrompt: [
    "You are an on-call incident response agent.",
    "An alert has fired for a production service. Your job is to restore the service quickly.",
    "Check the current metrics, check what shipped recently, and then take the action most likely to bring the service back to baseline.",
    "Prefer rolling back a recent deployment when one is available; otherwise restart the service.",
    "If your remediation attempts do not work, escalate to a human.",
  ].join(" "),

  allowedTools: [
    "query_metrics",
    "inspect_logs",
    "get_recent_deployments",
    "restart_service",
    "rollback_deployment",
    "escalate",
  ],

  workflowSteps: [
    {
      id: "assess",
      description: "Pull current metrics for the alerting service and confirm it is degraded.",
      tool: "query_metrics",
    },
    {
      id: "recent-changes",
      description: "List recent deployments to see whether something shipped just before the alert.",
      tool: "get_recent_deployments",
    },
    {
      id: "remediate",
      description:
        "Roll back the most recent deployment if there is one, otherwise restart the service.",
    },
  ],

  // Note: inspect_logs is available but never required, so the agent never
  // learns why a service is failing — only that it is.
  requiredChecks: ["query_metrics", "get_recent_deployments"],

  safetyRules: [
    {
      id: "require-deployment-evidence-before-rollback",
      description:
        "Only roll back a deployment that appears in the service's deployment history and shipped inside the correlation window.",
      severity: "block",
      // Four hours is far too generous: it makes almost any recent deploy look
      // like a suspect.
      params: { correlationWindowMinutes: 240 },
    },
    {
      id: "no-action-when-metrics-healthy",
      description: "Do not remediate a service whose metrics are already at baseline.",
      severity: "block",
    },
  ],

  retryPolicy: {
    maxToolCalls: 8,
    maxRetriesPerTool: 1,
    maxRemediationAttempts: 2,
  },

  escalationPolicy: {
    // Escalating only after two failed remediations means production gets
    // mutated twice before a human is told anything.
    escalateAfterFailedRemediations: 2,
    escalateOnAmbiguousRootCause: false,
    escalateOnIncompleteEvidence: false,
    escalateOnToolBudgetExhausted: true,
    defaultRoute: "the on-call human for the owning team",
  },
};
