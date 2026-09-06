import Link from "next/link";
import { runStructuralDemo } from "@/lib/windtunnel/structural/demo";

export const dynamic = "force-dynamic";

export default async function StructuralPage() {
  const result = await runStructuralDemo();
  const guard = result.regression;
  return <main>
    <h1>WINDTUNNEL — structural engineering</h1>
    <p><Link href="/traces">V1 runs</Link> · <Link href="/memory">Learning memory</Link></p>
    <p>{result.experiment}</p>
    <h2>Structural mutation: {result.mutation.type}</h2>
    <p>{result.mutation.reason}</p>
    {result.mutation.failure.evidence.map((e) => <article className="scenario" key={e.executionId}>
      <p><code>{e.executionId}</code> · recalled {e.retrievedRuleIds.join(", ")} · unsafe call #{e.toolCallIndex}</p>
      <ul>{e.evaluatorChecks.map((c) => <li key={c.id}>{c.id}: {c.detail}</li>)}</ul>
    </article>)}
    <h2>AgentSpec V1 → V2 diff</h2>
    {result.diff.map((d) => <section key={d.field}>
      <h3>{d.field}</h3>
      <pre style={{ whiteSpace: "pre-wrap" }}>{`- V1 ${JSON.stringify(d.before, null, 2)}\n+ V2 ${JSON.stringify(d.after, null, 2)}`}</pre>
    </section>)}
    <h2>Regression Guard: {guard.promotion}</h2>
    <p>{guard.reason}</p>
    <ul>
      <li>Fixed evaluator-check failures: {guard.fixedCheckFailures}</li>
      <li>Fixed failures: {guard.fixedFailures.length} ({guard.fixedFailures.join(", ") || "none"})</li>
      <li>Preserved successes: {guard.preservedSuccesses.length} ({guard.preservedSuccesses.join(", ") || "none"})</li>
      <li>Regressions: {guard.regressions.length} ({guard.regressions.join(", ") || "none"})</li>
      <li>Critical safety regressions: {guard.criticalSafetyRegressions.length} ({guard.criticalSafetyRegressions.join(", ") || "none"})</li>
      <li>Remaining failures: {guard.remainingFailures.length}</li>
    </ul>
    {guard.rows.map((r) => <article className="scenario" key={r.scenarioId}>
      <h3>{r.scenarioId}: {r.v1.evaluation.passed ? "PASS" : "FAIL"} → {r.v2.evaluation.passed ? "PASS" : "FAIL"}</h3>
      <p>Fixed checks: {r.fixedChecks.join(", ") || "none"}; regressed checks: {r.regressedChecks.join(", ") || "none"}</p>
      <p>Unsafe actions: {r.v1.trace.unsafeActions.length} → {r.v2.trace.unsafeActions.length}</p>
    </article>)}
  </main>;
}
