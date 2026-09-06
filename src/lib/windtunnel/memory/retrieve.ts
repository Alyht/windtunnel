/**
 * Deterministic retrieval.
 *
 * Three signals, in this order:
 *   1. context — the rule's trigger must match the probed incident. This gates.
 *   2. confidence — below the floor a rule is not trusted enough to act on.
 *   3. tags — rank the survivors, so the most contextually apt rules come first.
 *
 * No embeddings, no similarity search, no model call. Same context in, same
 * rule ids out, every time.
 */

import type { LearnedRule, ObservedContext, RuleTrigger } from "./types";

export const DEFAULT_CONFIDENCE_FLOOR = 0.4;

/** Tags that matter for a given incident shape, used only for ranking. */
export function contextTags(context: ObservedContext): string[] {
  const tags: string[] = [];
  if (context.serviceStateful) tags.push("stateful-service");
  if (context.hasDegradedDependency) tags.push("dependency-degradation");
  if (!context.logsComplete) tags.push("incomplete-logs");
  if (context.memoryPressure) tags.push("memory-pressure");
  if (!context.dominantErrorPresent) tags.push("ambiguous-cause");
  if (context.metricsSelfRecovered) tags.push("self-recovered");
  if (context.targetDeploymentRollbackSafe === false) tags.push("rollback-unsafe-deployment");
  return tags;
}

export function matchesTrigger(trigger: RuleTrigger, context: ObservedContext): boolean {
  if (trigger.serviceStateful !== undefined && trigger.serviceStateful !== context.serviceStateful) {
    return false;
  }
  if (trigger.metricsStatus && !trigger.metricsStatus.includes(context.metricsStatus)) {
    return false;
  }
  if (trigger.alertSeverity && !trigger.alertSeverity.includes(context.alertSeverity)) {
    return false;
  }
  if (
    trigger.hasDegradedDependency !== undefined &&
    trigger.hasDegradedDependency !== context.hasDegradedDependency
  ) {
    return false;
  }
  if (trigger.memoryPressure !== undefined && trigger.memoryPressure !== context.memoryPressure) {
    return false;
  }
  if (
    trigger.metricsSelfRecovered !== undefined &&
    trigger.metricsSelfRecovered !== context.metricsSelfRecovered
  ) {
    return false;
  }
  if (trigger.logsComplete !== undefined && trigger.logsComplete !== context.logsComplete) {
    return false;
  }
  if (trigger.logCoverageBelow !== undefined && context.logCoverage >= trigger.logCoverageBelow) {
    return false;
  }
  if (
    trigger.dominantErrorPresent !== undefined &&
    trigger.dominantErrorPresent !== context.dominantErrorPresent
  ) {
    return false;
  }
  if (
    trigger.targetDeploymentRollbackSafe !== undefined &&
    trigger.targetDeploymentRollbackSafe !== context.targetDeploymentRollbackSafe
  ) {
    return false;
  }
  return true;
}

/** How specific a trigger is. More conditions means a better-earned match. */
export function triggerSpecificity(trigger: RuleTrigger): number {
  return Object.values(trigger).filter((v) => v !== undefined).length;
}

export interface RetrievedRule {
  rule: LearnedRule;
  /** Number of the rule's tags that are relevant to this incident. */
  tagOverlap: number;
  score: number;
}

export interface RetrieveOptions {
  confidenceFloor?: number;
  limit?: number;
}

export function retrieveRules(
  rules: LearnedRule[],
  context: ObservedContext,
  options: RetrieveOptions = {},
): RetrievedRule[] {
  const floor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const relevant = new Set(contextTags(context));

  const matched = rules
    .filter((rule) => rule.status === "active")
    .filter((rule) => rule.confidence >= floor)
    .filter((rule) => matchesTrigger(rule.trigger, context))
    .map((rule) => {
      const tagOverlap = rule.tags.filter((t) => relevant.has(t)).length;
      return {
        rule,
        tagOverlap,
        score: tagOverlap * 2 + triggerSpecificity(rule.trigger) + rule.confidence,
      };
    });

  // Ties break on rule id so ordering is stable across runs.
  matched.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));

  return options.limit === undefined ? matched : matched.slice(0, options.limit);
}
