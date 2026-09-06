/**
 * Local JSON persistence for learned rules and run history.
 *
 * Deliberately a plain file: no database, no vector store. Rule ids are
 * sequential so a replayed learning sequence produces byte-identical memory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  LearnedRule,
  LearningRunRecord,
  Lesson,
  MemorySnapshot,
  ObservedContext,
} from "./types";
import { emptySnapshot } from "./types";

export const DEFAULT_MEMORY_PATH = "data/memory.json";

/** Confidence a rule starts at when a single run produced it. */
export const INITIAL_CONFIDENCE = 0.5;
export const CONFIDENCE_STEP = 0.15;
export const MAX_CONFIDENCE = 0.95;
export const MIN_CONFIDENCE = 0.1;

/** Two lessons are the same lesson when they prescribe the same thing. */
export function directiveKey(lesson: Pick<Lesson, "directive">): string {
  const d = lesson.directive;
  switch (d.kind) {
    case "enforce_safety_rule":
      return `enforce_safety_rule:${d.ruleId}`;
    case "require_check":
      return `require_check:${d.tool}`;
    case "avoid_tool":
      return `avoid_tool:${d.tool}`;
  }
}

export class MemoryStore {
  private snapshot: MemorySnapshot;

  private constructor(
    snapshot: MemorySnapshot,
    private readonly path: string | null,
  ) {
    this.snapshot = snapshot;
  }

  /** In-memory only. Used by tests and by the read-only UI path. */
  static empty(): MemoryStore {
    return new MemoryStore(emptySnapshot(), null);
  }

  static fromSnapshot(snapshot: MemorySnapshot): MemoryStore {
    return new MemoryStore(structuredClone(snapshot), null);
  }

  /** Loads from disk, or starts empty if the file does not exist yet. */
  static load(path: string = DEFAULT_MEMORY_PATH): MemoryStore {
    if (!existsSync(path)) return new MemoryStore(emptySnapshot(), path);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as MemorySnapshot;
    if (parsed.version !== 1) {
      throw new Error(`unsupported memory snapshot version: ${String(parsed.version)}`);
    }
    return new MemoryStore(
      { version: 1, rules: parsed.rules ?? [], runs: parsed.runs ?? [] },
      path,
    );
  }

  save(path: string = this.path ?? DEFAULT_MEMORY_PATH): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(this.snapshot, null, 2)}\n`, "utf8");
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  get rules(): LearnedRule[] {
    return this.snapshot.rules.map((r) => structuredClone(r));
  }

  get activeRules(): LearnedRule[] {
    return this.rules.filter((r) => r.status === "active");
  }

  get runs(): LearningRunRecord[] {
    return this.snapshot.runs.map((r) => structuredClone(r));
  }

  getRule(id: string): LearnedRule | undefined {
    const rule = this.snapshot.rules.find((r) => r.id === id);
    return rule ? structuredClone(rule) : undefined;
  }

  findByDirective(key: string): LearnedRule | undefined {
    const rule = this.snapshot.rules.find((r) => directiveKey(r) === key);
    return rule ? structuredClone(rule) : undefined;
  }

  toSnapshot(): MemorySnapshot {
    return structuredClone(this.snapshot);
  }

  nextRunId(): string {
    return `run-${this.snapshot.runs.length + 1}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Adds a lesson as a new rule, or reinforces the existing rule that already
   * prescribes the same thing. Never appends a duplicate directive.
   */
  ingest(
    lesson: Lesson,
    origin: { runId: string; scenarioId: string; context: ObservedContext },
  ): { rule: LearnedRule; created: boolean } {
    const key = directiveKey(lesson);
    const existing = this.snapshot.rules.find((r) => directiveKey(r) === key);

    if (existing) {
      if (!existing.supportingRunIds.includes(origin.runId)) {
        existing.supportingRunIds.push(origin.runId);
        existing.confidence = Math.min(MAX_CONFIDENCE, existing.confidence + CONFIDENCE_STEP);
      }
      // A retired rule that keeps being relearned earns its way back.
      if (existing.status === "retired") {
        existing.status = "active";
        existing.version += 1;
        existing.revisionNotes.push(`reinstated by ${origin.runId} (${origin.scenarioId})`);
      }
      return { rule: structuredClone(existing), created: false };
    }

    const rule: LearnedRule = {
      id: `rule-${this.snapshot.rules.length + 1}`,
      version: 1,
      statement: lesson.statement,
      trigger: lesson.trigger,
      directive: lesson.directive,
      tags: [...lesson.tags],
      confidence: INITIAL_CONFIDENCE,
      status: "active",
      originContext: structuredClone(origin.context),
      originScenarioId: origin.scenarioId,
      createdInRunId: origin.runId,
      supportingRunIds: [origin.runId],
      contradictingRunIds: [],
      revisionNotes: [],
    };
    this.snapshot.rules.push(rule);
    return { rule: structuredClone(rule), created: true };
  }

  /** Replaces a rule in place, preserving its position and id. */
  replaceRule(rule: LearnedRule): void {
    const index = this.snapshot.rules.findIndex((r) => r.id === rule.id);
    if (index === -1) throw new Error(`cannot replace unknown rule "${rule.id}"`);
    this.snapshot.rules[index] = structuredClone(rule);
  }

  appendRun(record: LearningRunRecord): void {
    this.snapshot.runs.push(structuredClone(record));
  }
}
