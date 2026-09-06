/**
 * Runs the scenario suite against an AgentSpec and prints the report.
 *
 *   npm run scenarios              # spec v1, heuristic brain
 *   npm run scenarios -- --verbose # include full tool traces
 *   npm run scenarios -- --brain=llm
 */

import { LlmBrain } from "../src/lib/windtunnel/model/llm-brain";
import { runSuite } from "../src/lib/windtunnel/suite";
import { SPEC_V1 } from "../src/lib/windtunnel/specs/v1";
import { getScenario } from "../src/lib/windtunnel/scenarios";
import type { Brain } from "../src/lib/windtunnel/brain";
import type { SuiteEntry } from "../src/lib/windtunnel/types";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const brainArg = args.find((a) => a.startsWith("--brain="))?.split("=")[1] ?? process.env.WINDTUNNEL_BRAIN;

const PASS = "PASS";
const FAIL = "FAIL";

function bar(entry: SuiteEntry): string {
  return entry.evaluation.checks.map((c) => (c.passed ? "+" : "x")).join("");
}

async function main(): Promise<void> {
  let brain: Brain | undefined;
  if (brainArg === "llm") {
    const llm = LlmBrain.fromEnv();
    if (!llm) {
      console.error(
        "--brain=llm requires TENSORMUX_API_KEY. Copy .env.example to .env.local and set it.",
      );
      process.exitCode = 1;
      return;
    }
    brain = llm;
  }

  const spec = SPEC_V1;
  const suite = await runSuite({ spec, ...(brain ? { brain } : {}) });

  console.log("");
  console.log(`WINDTUNNEL — ${suite.specName} ${suite.specVersion} (${suite.brain} brain)`);
  console.log("=".repeat(72));

  for (const entry of suite.entries) {
    const { trace, evaluation } = entry;
    const scenario = getScenario(trace.scenarioId);
    const verdict = evaluation.passed ? PASS : FAIL;

    console.log("");
    console.log(`[${verdict}] ${scenario.id}  ${bar(entry)}  score ${(evaluation.score * 100).toFixed(0)}%`);
    console.log(`        ${scenario.title}`);
    console.log(
      `        final: ${describeFinal(trace)} | tools: ${trace.toolCallCount} | latency: ${trace.latencyMs}ms | unsafe: ${trace.unsafeActions.length}`,
    );

    for (const check of evaluation.checks) {
      if (!check.passed) console.log(`        x ${check.id}: ${check.detail}`);
    }

    if (verbose) {
      for (const call of trace.toolCalls) {
        const status = call.blockedBy.length > 0 ? "BLOCKED" : call.ok ? "ok" : "error";
        console.log(`          #${call.index} ${call.tool} ${JSON.stringify(call.args)} -> ${status}`);
        if (call.error) console.log(`             ${call.error}`);
        for (const reason of call.unsafeReasons) console.log(`             UNSAFE: ${reason}`);
      }
      if (trace.finalAction.type === "escalate") {
        console.log(`          escalation reason: ${trace.finalAction.reason}`);
      }
    }
  }

  console.log("");
  console.log("-".repeat(72));
  console.log(
    `${suite.passed}/${suite.total} scenarios passed (${(suite.passRate * 100).toFixed(0)}%)  |  ` +
      `${suite.totalUnsafeActions} unsafe actions  |  ${suite.totalToolCalls} tool calls  |  ${suite.totalLatencyMs}ms simulated`,
  );
  console.log("");
  console.log("Check breakdown:");
  for (const [id, counts] of Object.entries(suite.checkBreakdown)) {
    console.log(`  ${id.padEnd(24)} ${counts.passed}/${counts.passed + counts.failed}`);
  }
  console.log("");
}

function describeFinal(trace: SuiteEntry["trace"]): string {
  const a = trace.finalAction;
  switch (a.type) {
    case "rollback_deployment":
      return `rollback ${a.deploymentId}`;
    case "restart_service":
      return `restart ${a.service}`;
    default:
      return a.type;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
