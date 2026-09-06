/**
 * Revision.
 *
 * A rule is contradicted when it was recalled, the run failed on final_outcome,
 * and the rule is what removed the action the incident actually needed. That is
 * evidence the rule's trigger is too broad — not evidence the lesson was wrong.
 *
 * So the response is to narrow the trigger, using the first context feature on
 * which the rule's origin incident and the contradicting incident actually
 * differ. The rule keeps protecting the case it was learned from and stops
 * firing on the case it got wrong. Only when no such feature exists is the rule
 * retired, because then it genuinely cannot be made precise.
 */

import type { Scenario } from "../types";
import type { LearnedRule, LearningRunRecord, ObservedContext, RuleTrigger } from "./types";
import { MIN_CONFIDENCE } from "./store";

/**
 * Context features usable as discriminators, most causally apt first. Numeric
 * and identifier fields are excluded: they do not generalise.
 */
const DISCRIMINATOR_KEYS = [
  "targetDeploymentRollbackSafe",
  "serviceStateful",
  "hasDegradedDependency",
  "dominantErrorPresent",
  "logsComplete",
  "memoryPressure",
  "metricsSelfRecovered",
] as const satisfies ReadonlyArray<keyof ObservedContext & keyof RuleTrigger>;

type DiscriminatorKey = (typeof DISCRIMINATOR_KEYS)[number];

export function isContradictedBy(
  rule: LearnedRule,
  record: LearningRunRecord,
  scenario: Scenario,
): boolean {
  if (!record.retrievedMemoryRuleIds.includes(rule.id)) return false;
  if (record.passed) return false;
  if (!record.failedChecks.includes("final_outcome")) return false;

  // Only a directive that removed an option can be blamed for the outcome; the
  // safety guards are self-gating and cannot fire on the wrong incident.
  if (rule.directive.kind !== "avoid_tool") return false;

  return scenario.groundTruth.expectedFinalAction.type === rule.directive.tool;
}

export interface RevisionOutcome {
  rule: LearnedRule;
  action: "narrowed" | "retired";
  note: string;
}

export function reviseRule(
  rule: LearnedRule,
  contradicting: ObservedContext,
  record: LearningRunRecord,
): RevisionOutcome {
  const revised: LearnedRule = structuredClone(rule);
  revised.version += 1;
  revised.confidence = Math.max(MIN_CONFIDENCE, revised.confidence - 0.2);
  if (!revised.contradictingRunIds.includes(record.runId)) {
    revised.contradictingRunIds.push(record.runId);
  }

  const key = findDiscriminator(rule, contradicting);

  if (key === null) {
    revised.status = "retired";
    const note = `retired after ${record.runId} (${record.scenarioId}): no context feature separates it from the incident it got wrong`;
    revised.revisionNotes.push(note);
    return { rule: revised, action: "retired", note };
  }

  const originValue = rule.originContext[key];
  revised.trigger = { ...revised.trigger, [key]: originValue };

  const note = `narrowed after ${record.runId} (${record.scenarioId}): now requires ${key}=${String(originValue)}, which held in ${rule.originScenarioId} but not here`;
  revised.revisionNotes.push(note);
  return { rule: revised, action: "narrowed", note };
}

/**
 * First feature where the rule's origin incident and the contradicting incident
 * disagree, and which the trigger does not already constrain.
 */
function findDiscriminator(
  rule: LearnedRule,
  contradicting: ObservedContext,
): DiscriminatorKey | null {
  for (const key of DISCRIMINATOR_KEYS) {
    if (rule.trigger[key] !== undefined) continue;
    const origin = rule.originContext[key];
    const other = contradicting[key];
    if (origin === null || other === null) continue;
    if (origin !== other) return key;
  }
  return null;
}
