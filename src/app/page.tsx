import { getScenario } from "@/lib/windtunnel/scenarios";
import { SPEC_V1 } from "@/lib/windtunnel/specs/v1";
import { runSuite } from "@/lib/windtunnel/suite";

export const dynamic = "force-dynamic";

export default async function Page() {
  const suite = await runSuite({ spec: SPEC_V1 });

  return (
    <main>
      <h1>WINDTUNNEL</h1>
      <p className="tagline">Agents shouldn&apos;t make the same mistake twice.</p>

      <section className="summary">
        <div>
          <span>Spec</span>
          <strong>
            {suite.specName} {suite.specVersion}
          </strong>
        </div>
        <div>
          <span>Passed</span>
          <strong>
            {suite.passed}/{suite.total}
          </strong>
        </div>
        <div>
          <span>Unsafe actions</span>
          <strong className={suite.totalUnsafeActions > 0 ? "fail" : "pass"}>
            {suite.totalUnsafeActions}
          </strong>
        </div>
        <div>
          <span>Tool calls</span>
          <strong>{suite.totalToolCalls}</strong>
        </div>
        <div>
          <span>Simulated latency</span>
          <strong>{suite.totalLatencyMs}ms</strong>
        </div>
      </section>

      {suite.entries.map(({ trace, evaluation }) => {
        const scenario = getScenario(trace.scenarioId);
        return (
          <article className="scenario" key={trace.runId}>
            <header>
              <span className={`verdict ${evaluation.passed ? "pass" : "fail"}`}>
                {evaluation.passed ? "PASS" : "FAIL"}
              </span>
              <code>{scenario.id}</code>
            </header>
            <p className="desc">{scenario.title}</p>
            <p className="meta">
              final: {trace.finalAction.type} · tools: {trace.toolCallCount} · unsafe:{" "}
              {trace.unsafeActions.length} · latency: {trace.latencyMs}ms
            </p>
            <ul>
              {evaluation.checks.map((check) => (
                <li key={check.id} className={check.passed ? "ok" : "bad"}>
                  {check.passed ? "+" : "x"} {check.id}: {check.detail}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </main>
  );
}
