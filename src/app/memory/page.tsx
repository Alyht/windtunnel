import { DEMO_SEQUENCE, runLearningSequence } from "@/lib/windtunnel/memory/learn";
import { MemoryStore } from "@/lib/windtunnel/memory/store";
import { SPEC_V1 } from "@/lib/windtunnel/specs/v1";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const { store, steps } = await runLearningSequence({
    spec: SPEC_V1,
    scenarioIds: DEMO_SEQUENCE,
    store: MemoryStore.empty(),
  });

  const runs = store.runs;
  const reuseOf = (ruleId: string, createdIn: string) =>
    runs.filter((r) => r.retrievedMemoryRuleIds.includes(ruleId) && r.runId !== createdIn);

  return (
    <main>
      <h1>WINDTUNNEL — memory</h1>
      <p className="tagline">
        Learned rules, what recalled them, and what changed as a result.
      </p>

      <h2>Runs</h2>
      {steps.map(({ record, applied }) => (
        <article className="scenario" key={record.runId}>
          <header>
            <span className={`verdict ${record.passed ? "pass" : "fail"}`}>
              {record.passed ? "PASS" : "FAIL"}
            </span>
            <code>
              {record.runId} · {record.scenarioId}
            </code>
          </header>
          <p className="meta">
            score {(record.score * 100).toFixed(0)}% · unsafe {record.unsafeActionCount} · final{" "}
            {record.finalActionType}
          </p>
          <p className="meta">tools: {record.toolSequence.join(" → ") || "(none)"}</p>
          <ul>
            <li className={record.retrievedMemoryRuleIds.length > 0 ? "" : "ok"}>
              recalled:{" "}
              {record.retrievedMemoryRuleIds.length > 0
                ? record.retrievedMemoryRuleIds.join(", ")
                : "(memory empty)"}
            </li>
            {applied.addedSafetyRuleIds.length > 0 && (
              <li className="ok">+ guards: {applied.addedSafetyRuleIds.join(", ")}</li>
            )}
            {applied.addedRequiredChecks.length > 0 && (
              <li className="ok">+ required checks: {applied.addedRequiredChecks.join(", ")}</li>
            )}
            {applied.removedTools.length > 0 && (
              <li className="ok">− tools removed: {applied.removedTools.join(", ")}</li>
            )}
            {record.learnedRuleIds.length > 0 && (
              <li>learned: {record.learnedRuleIds.join(", ")}</li>
            )}
            {record.reinforcedRuleIds.length > 0 && (
              <li className="ok">reinforced: {record.reinforcedRuleIds.join(", ")}</li>
            )}
            {record.revisedRuleIds.length > 0 && (
              <li className="bad">revised: {record.revisedRuleIds.join(", ")}</li>
            )}
          </ul>
        </article>
      ))}

      <h2>Learned rules</h2>
      {store.rules.map((rule) => {
        const reused = reuseOf(rule.id, rule.createdInRunId);
        return (
          <article className="scenario" key={rule.id}>
            <header>
              <span className={`verdict ${rule.status === "active" ? "pass" : "fail"}`}>
                {rule.id} v{rule.version}
              </span>
              <code>
                {rule.status} · confidence {rule.confidence.toFixed(2)}
              </code>
            </header>
            <p className="desc">{rule.statement}</p>
            <p className="meta">
              learned from {rule.createdInRunId} ({rule.originScenarioId}) ·{" "}
              {reused.length > 0
                ? `reused in ${reused.map((r) => `${r.runId} (${r.scenarioId})`).join(", ")}`
                : "not yet reused"}
            </p>
            <ul>
              <li className="ok">trigger: {JSON.stringify(rule.trigger)}</li>
              <li className="ok">directive: {JSON.stringify(rule.directive)}</li>
              <li className="ok">tags: {rule.tags.join(", ")}</li>
              {rule.revisionNotes.map((note) => (
                <li className="bad" key={note}>
                  {note}
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </main>
  );
}
