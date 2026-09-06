import type { Observation } from "../brain";
import type { LearnedRule, Reflection } from "../memory/types";
import type { EvalResult, RunTrace } from "../types";

export interface LiveStart {
  runId: string;
  incident: { id: string; title: string; service: string; symptom: string };
  model: string;
  specVersion: string;
  retrievedRules: LearnedRule[];
}

export interface LiveResult {
  runId: string;
  trace: RunTrace;
  evaluation: EvalResult;
  reflection: Reflection;
  learnedRules: LearnedRule[];
  wallLatencyMs: number;
  simulatedToolLatencyMs: number;
  finalStatus: "PASS" | "FAIL";
  promotion: "PROMOTION BLOCKED";
  promotionReason: string;
}

export type LiveEvent =
  | { type: "start"; data: LiveStart }
  | { type: "tool"; data: Observation }
  | { type: "result"; data: LiveResult }
  | { type: "error"; code: string; message: string; runId?: string };
