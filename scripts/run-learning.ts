/**
 * End-to-end learning sequence.
 *
 *   npm run learn              # deterministic reflector, prints the sequence
 *   npm run learn -- --save    # also writes data/memory.json
 *
 * Uses TensorMux to phrase lessons when TENSORMUX_API_KEY is set; the structure
 * of memory is identical either way.
 */

import { DEMO_SEQUENCE, runLearningSequence } from "../src/lib/windtunnel/memory/learn";
import { DeterministicReflector, TensorMuxReflector } from "../src/lib/windtunnel/memory/reflect";
import { MemoryStore, DEFAULT_MEMORY_PATH } from "../src/lib/windtunnel/memory/store";
import { SPEC_V1 } from "../src/lib/windtunnel/specs/v1";
import type { Reflector } from "../src/lib/windtunnel/memory/types";

const save = process.argv.includes("--save");

async function main(): Promise<void> {
  const llm = TensorMuxReflector.fromEnv();
  const reflector: Reflector = llm ?? new DeterministicReflector();

  console.log("");
  console.log("WINDTUNNEL — learning sequence");
  console.log(`reflector: ${llm ? "tensormux" : "deterministic"}`);
  console.log("=".repeat(78));

  const store = MemoryStore.empty();
  const { steps } = await runLearningSequence({
    spec: SPEC_V1,
    scenarioIds: DEMO_SEQUENCE,
    store,
    reflector,
  });

  for (const step of steps) {
    const { record, applied } = step;
    console.log("");
    console.log(
      `${record.runId}  ${record.passed ? "PASS" : "FAIL"}  ${record.scenarioId}  ` +
        `score ${(record.score * 100).toFixed(0)}%  unsafe ${record.unsafeActionCount}`,
    );
    console.log(`  tools:    ${record.toolSequence.join(" -> ") || "(none)"}`);
    console.log(`  final:    ${record.finalActionType}`);
    console.log(
      `  recalled: ${record.retrievedMemoryRuleIds.length > 0 ? record.retrievedMemoryRuleIds.join(", ") : "(nothing in memory yet)"}`,
    );
    if (applied.addedSafetyRuleIds.length > 0) {
      console.log(`    + guards:   ${applied.addedSafetyRuleIds.join(", ")}`);
    }
    if (applied.addedRequiredChecks.length > 0) {
      console.log(`    + checks:   ${applied.addedRequiredChecks.join(", ")}`);
    }
    if (applied.removedTools.length > 0) {
      console.log(`    - tools:    ${applied.removedTools.join(", ")}`);
    }
    if (record.learnedRuleIds.length > 0) {
      console.log(`  learned:  ${record.learnedRuleIds.join(", ")}`);
    }
    if (record.reinforcedRuleIds.length > 0) {
      console.log(`  reinforced: ${record.reinforcedRuleIds.join(", ")}`);
    }
    if (record.revisedRuleIds.length > 0) {
      console.log(`  REVISED:  ${record.revisedRuleIds.join(", ")}`);
      for (const id of record.revisedRuleIds) {
        const rule = store.getRule(id);
        console.log(`            ${rule?.revisionNotes.at(-1) ?? ""}`);
      }
    }
  }

  console.log("");
  console.log("-".repeat(78));
  console.log("Learned rules");
  for (const rule of store.rules) {
    const reusedIn = store.runs
      .filter((r) => r.retrievedMemoryRuleIds.includes(rule.id) && r.runId !== rule.createdInRunId)
      .map((r) => r.runId);
    console.log("");
    console.log(
      `${rule.id} v${rule.version} [${rule.status}] confidence ${rule.confidence.toFixed(2)}`,
    );
    console.log(`  ${rule.statement}`);
    console.log(`  trigger:  ${JSON.stringify(rule.trigger)}`);
    console.log(`  directive:${JSON.stringify(rule.directive)}`);
    console.log(`  tags:     ${rule.tags.join(", ")}`);
    console.log(
      `  learned from ${rule.createdInRunId} (${rule.originScenarioId}); ` +
        `reused in ${reusedIn.length > 0 ? reusedIn.join(", ") : "(not yet reused)"}`,
    );
    for (const note of rule.revisionNotes) console.log(`  revision: ${note}`);
  }

  console.log("");
  if (save) {
    store.save(DEFAULT_MEMORY_PATH);
    console.log(`memory written to ${DEFAULT_MEMORY_PATH}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
