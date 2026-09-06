import { readFile } from "node:fs/promises";
import Link from "next/link";
import type { FinalDemoResult } from "@/lib/windtunnel/final/demo";

export const dynamic = "force-dynamic";

export default async function DemoPage() {
  let result: FinalDemoResult;
  try {
    result = JSON.parse(await readFile("artifacts/final-demo.json", "utf8")) as FinalDemoResult;
  } catch {
    return <main><h1>WINDTUNNEL — final demo</h1><p>No executed proof record available. Run <code>npm run demo</code> first.</p></main>;
  }
  const { baseline, structural, reflection, candidates, selection, frozen, certification } = result;
  return <main>
    <h1>WINDTUNNEL — agents shouldn&apos;t make the same mistake twice</h1>
    <p>Observe → learn → repair → compare → freeze → certify.</p>
    <p><Link href="/">Baseline traces</Link> · <Link href="/memory">Memory loop</Link> · <Link href="/structural">Phase 3</Link></p>
    <p className="meta">Executed record: {result.executedAt}. Refreshing this page does not rerun certification.</p>
    <p>{result.protocol}</p>
    <h2 className="fail">Final decision: {result.deploymentDecision}</h2>

    <section className="scenario">
      <h2>1. Baseline — AgentSpec V1</h2>
      <p>{baseline.passed}/{baseline.total} successful · {baseline.totalUnsafeActions} unsafe-action records · {baseline.totalToolCalls} tool calls · {baseline.totalLatencyMs}ms simulated latency</p>
    </section>

    <section className="scenario">
      <h2>2. Failure trace — Run {structural.memory.rules[0]?.createdInRunId}</h2>
      <p><code>{structural.seed.trace.runId}</code> · {structural.seed.evaluation.passed ? "PASS" : "FAIL"}</p>
      <ol>{structural.seed.trace.toolCalls.map((c) => <li key={c.index}>
        #{c.index} {c.tool}: {c.ok ? "executed" : "blocked/rejected"}{c.unsafe ? ` — UNSAFE: ${c.unsafeReasons.join("; ")}` : ""}
      </li>)}</ol>
    </section>

    <section className="scenario">
      <h2>3. Reflection</h2>
      <ul>{reflection.failureModes.map((m) => <li key={m.id}><strong>{m.id}</strong>: {m.detail}</li>)}</ul>
    </section>

    <section className="scenario">
      <h2>4. Learned memory</h2>
      {structural.memory.rules.map((r) => <p key={r.id}><code>{r.id}</code> learned from <strong>{r.createdInRunId}</strong>: {r.statement}</p>)}
      <h2>5. Memory recalled in later runs</h2>
      {structural.observations.map((o) => <div key={o.executionId}>
        {o.retrievedRules.map((r) => <p key={r.id}><strong>Learned from Run {r.createdInRunId} → reused in Run {o.executionId}</strong>: {r.id}</p>)}
        <p>Outcome: {o.evaluation.passed ? "PASS" : "FAIL"}; {o.trace.unsafeActions.length} unsafe-action records despite relevant memory.</p>
      </div>)}
      <p>The structural replay uses the existing one-rule retrieval budget. Recalled ordering memory enforces V1&apos;s list, but that list omits logs.</p>
    </section>

    <section className="scenario">
      <h2>6. Structural failure detected</h2>
      <p>{structural.mutation.failure.category}: {structural.mutation.failure.evidence.length} distinct executions with relevant recalled memory and evaluator-confirmed unsafe remediation.</p>
      {structural.mutation.failure.evidence.map((e) => <details key={e.executionId}>
        <summary>{e.executionId} — unsafe call #{e.toolCallIndex}; recalled {e.retrievedRuleIds.join(", ")}</summary>
        <ul>{e.evaluatorChecks.map((c) => <li key={c.id}>{c.id}: {c.detail}</li>)}</ul>
      </details>)}
    </section>

    <section className="scenario">
      <h2>7. AgentSpec mutations — V1 → V2 / V3</h2>
      {candidates.map((c) => <details key={c.spec.version} open>
        <summary><strong>V1 → {c.spec.version.toUpperCase()}</strong>: {c.mutations.map((m) => m.type).join(" + ")}</summary>
        <p>{c.rationale}</p>
        {c.diff.map((d) => <details key={d.field}><summary>{d.field}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{`- V1 ${JSON.stringify(d.before, null, 2)}\n+ ${c.spec.version.toUpperCase()} ${JSON.stringify(d.after, null, 2)}`}</pre>
        </details>)}
      </details>)}
    </section>

    <section className="scenario">
      <h2>8. Candidate comparison</h2>
      <p>Same six fixed scenarios, no memory overlays in either arm. Success means all evaluator checks pass; completion only means the agent reached a final decision.</p>
      <div style={{ overflowX: "auto" }}><table><thead><tr>
        <th>Spec</th><th>Success</th><th>Completion</th><th>Unsafe</th><th>Regressions</th><th>Critical safety regressions</th><th>Tools</th><th>Latency (simulated)</th>
      </tr></thead><tbody>{candidates.map((c) => <tr key={c.spec.version}>
        <td>{c.spec.version}</td><td>{c.metrics.success}/{c.metrics.total}</td><td>{c.metrics.completed}/{c.metrics.total}</td>
        <td>{c.metrics.unsafeActions}</td><td>{c.metrics.regressions}</td><td>{c.metrics.criticalSafetyRegressions}</td>
        <td>{c.metrics.toolCalls}</td><td>{c.metrics.latencyMs}ms</td>
      </tr>)}</tbody></table></div>
      <p>Tokens/cost: unavailable — this path makes no model calls. No estimated token or dollar figures are invented.</p>
      <p><strong>{selection.reason}</strong></p>
    </section>

    <section className="scenario">
      <h2>9. Regression Guard</h2>
      {candidates.map((c) => <div key={c.spec.version}>
        <h3>{c.spec.version}: {c.regression.promotion}</h3>
        <p>{c.regression.reason}</p>
        <p>Fixed scenarios: {c.regression.fixedFailures.join(", ") || "none"}; preserved successes: {c.regression.preservedSuccesses.join(", ") || "none"}; regressions: {c.regression.regressions.join(", ") || "none"}; critical safety regressions: {c.regression.criticalSafetyRegressions.join(", ") || "none"}.</p>
      </div>)}
      <p>Any critical safety regression ⇒ PROMOTION BLOCKED. Regression eligibility is not certification approval.</p>
    </section>

    <section className="scenario">
      <h2>10. Frozen winner — {selection.version ?? "none"}</h2>
      <p>Status: {frozen?.status ?? "not frozen"}. Deep-frozen independent spec, with hash checked before and after certification.</p>
      <p>SHA-256: <code style={{ overflowWrap: "anywhere" }}>{frozen?.hash ?? "unavailable"}</code></p>
    </section>

    <section className="scenario">
      <h2>11. Sealed certification — {certification?.status ?? "NOT RUN"}</h2>
      {certification && <>
        <p>{certification.success}/{certification.total} successes · {certification.unsafeActions} unsafe actions · {certification.policyViolationCount} policy violations · {certification.attempts} attempt</p>
        <p>Policy violations count failed forbidden-action, required-check and tool-ordering checks. Every evaluator check must pass for certification PASS.</p>
        {certification.suite.entries.map((e) => <details key={e.trace.runId}>
          <summary>{e.trace.scenarioId}: {e.evaluation.passed ? "PASS" : "FAIL"} — {e.trace.finalAction.type}</summary>
          <ul>{e.evaluation.checks.map((c) => <li key={c.id}>{c.passed ? "PASS" : "FAIL"} {c.id}: {c.detail}</li>)}</ul>
        </details>)}
      </>}
      <p>Separate fixtures are loaded only after selection and freeze. No learning, reflection, mutation, selection, or retuning uses them. This local protocol is not a secure external certification service.</p>
    </section>
  </main>;
}
