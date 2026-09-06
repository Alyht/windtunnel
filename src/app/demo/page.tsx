import { readFile } from "node:fs/promises";
import Link from "next/link";
import type { FinalDemoResult } from "@/lib/windtunnel/final/demo";
import type { RunTrace } from "@/lib/windtunnel/types";
import styles from "./demo.module.css";
import LiveRun from "./LiveRun";

export const dynamic = "force-dynamic";

function Trajectory({ trace }: { trace: RunTrace }) {
  return <ol className={styles.trajectory}>{trace.toolCalls.map((call) => <li key={call.index}
    className={call.unsafe ? styles.unsafeStep : call.blockedBy.length ? styles.blockedStep : ""}>
    <span className={styles.stepIndex}>{String(call.index + 1).padStart(2, "0")}</span>
    <code>{call.tool.replaceAll("_", " ")}</code>
    {call.unsafe && <span className={styles.stepTag}>unsafe</span>}
    {call.blockedBy.length > 0 && <span className={styles.stepTag}>blocked</span>}
  </li>)}</ol>;
}

export default async function DemoPage() {
  let result: FinalDemoResult;
  try {
    result = JSON.parse(await readFile("artifacts/final-demo.json", "utf8")) as FinalDemoResult;
  } catch {
    return <main className={styles.demo}><h1>WINDTUNNEL</h1><p>No executed record available. Run <code>npm run demo</code> first.</p></main>;
  }
  const { baseline, structural, reflection, candidates, selection, frozen, certification } = result;
  const best = candidates.find((candidate) => candidate.spec.version === selection.version);
  const story = best?.regression.rows.find((row) => !row.v1.evaluation.passed && row.v2.evaluation.passed)
    ?? best?.regression.rows[0];
  const replay = structural.observations[0];
  const recalled = replay?.retrievedRules[0];
  const learnedFailure = reflection.failureModes.find((mode) => mode.id === "premature-remediation") ?? reflection.failureModes[0];
  const addedChecks = best?.spec.requiredChecks.filter((check) => !structural.v1.requiredChecks.includes(check)) ?? [];
  const addedGates = best?.spec.safetyRules.filter((rule) => !structural.v1.safetyRules.some((old) => old.id === rule.id)) ?? [];

  return <main className={styles.demo}>
    <nav className={styles.nav} aria-label="Demo navigation">
      <Link href="/demo" className={styles.brand}><span className={styles.mark} aria-hidden="true"><i /><i /><i /></span>WINDTUNNEL</Link>
      <div><span className={styles.liveDot} />LIVE + EXECUTED PROOF<span className={styles.navDivider}>/</span><Link href="/traces">Explore raw runs ↗</Link></div>
    </nav>

    <header className={styles.hero}>
      <div className={styles.eyebrow}><span />A FLIGHT SIMULATOR FOR AI AGENTS</div>
      <h1>We crash AI agents<br /><span>before your users do.</span></h1>
      <p className={styles.subtitle}>AI agents shouldn&apos;t make the same mistake twice.</p>
      <p className={styles.heroCopy}>Turn dangerous mistakes into reusable memory and safer agent specs.<br className={styles.desktopBreak} /> Then test the repair. If it still fails, we don&apos;t ship it.</p>
      <div className={styles.heroActions}><a href="#live-run">Try a fresh AI-agent run ↓</a><a href="#executed-proof">View reproducible proof ↓</a></div>
      <div className={styles.heroRail} aria-hidden="true"><span>CRASH</span><i /><span>LEARN</span><i /><span>REPAIR</span><i /><span>VERIFY</span></div>
    </header>

    <LiveRun />
    <section id="executed-proof" className={styles.sectionHeading} aria-label="Executed proof benchmark">
      <div><p className={styles.eyebrow}>EXECUTED PROOF</p><h2>A reproducible benchmark run committed with the project.</h2></div>
    </section>
    <section className={styles.metrics} aria-label="Executed results summary">
      <article className={`${styles.metricCard} ${styles.baselineCard}`}><div className={styles.cardLabel}><span>01 / BASELINE</span><span>V1</span></div>
        <div className={styles.metricValue}>{baseline.passed}<span>/{baseline.total}</span><small>success</small></div>
        <p><span className={styles.redDot} />{baseline.totalUnsafeActions} unsafe actions</p><div className={styles.metricFoot}>Before structural repair</div></article>
      <article className={`${styles.metricCard} ${styles.bestCard}`}><div className={styles.cardLabel}><span>02 / BEST CANDIDATE</span><span>{selection.version?.toUpperCase() ?? "NONE"}</span></div>
        <div className={styles.metricValue}>{best?.metrics.success ?? "—"}<span>/{best?.metrics.total ?? "—"}</span><small>success</small></div>
        <p><span className={styles.greenDot} />{best?.metrics.unsafeActions ?? "—"} unsafe actions</p><div className={styles.metricFoot}>Improved. Not yet safe enough.</div></article>
      <article className={`${styles.metricCard} ${styles.certCard}`}><div className={styles.cardLabel}><span>03 / CERTIFICATION</span><span>SEALED TEST</span></div>
        <div className={`${styles.metricValue} ${styles.redText}`}>{certification?.status ?? "NOT RUN"}</div>
        <p className={styles.blockedBadge}>{result.deploymentDecision}</p><div className={styles.metricFoot}>The safety boundary holds.</div></article>
    </section>

    <section id="executed-run" className={styles.section}>
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>THE LEARNING LOOP</p><h2>A mistake becomes a constraint.</h2></div><p>Not a better-sounding answer.<br />A different action in the real tool trace.</p></div>
      <div className={styles.storyGrid}>
        <article className={styles.storyCard}><div className={styles.storyLabel}><span className={styles.redText}>01 — BEFORE</span><span aria-hidden="true">→</span></div>
          <h3>The agent acts too soon.</h3><p className={styles.storyCopy}>V1 touches production without completing the diagnostics that justify it.</p>
          {story && <Trajectory trace={story.v1.trace} />}
          <div className={`${styles.storyResult} ${styles.redText}`}>{story ? `${story.v1.trace.unsafeActions.length} unsafe-action records · ${story.v1.evaluation.passed ? "PASS" : "FAIL"}` : "See baseline evidence"}</div>
        </article>
        <article className={`${styles.storyCard} ${styles.learnCard}`}><div className={styles.storyLabel}><span>02 — LEARN</span><span aria-hidden="true">→</span></div>
          <h3>Remember why it failed.</h3><p className={styles.storyCopy}>An earlier incident produces a reusable rule—not a memorized scenario answer.</p>
          <div className={styles.lesson}><span className={styles.miniLabel}>REFLECTION</span><p>{learnedFailure?.detail}</p></div>
          <div className={styles.lesson}><span className={styles.miniLabel}>LEARNED MEMORY / {recalled?.id}</span><p>{recalled?.statement ?? "See recorded lessons below."}</p></div>
          <div className={styles.storyResult}>Stored once. Retrieved in a later run.</div>
        </article>
        <article className={`${styles.storyCard} ${styles.afterCard}`}><div className={styles.storyLabel}><span>03 — AFTER</span><span aria-hidden="true">↗</span></div>
          <h3>The spec changes the action.</h3><p className={styles.storyCopy}>The repaired agent checks first. Its safety gate can stop a harmful action.</p>
          {story && <Trajectory trace={story.v2.trace} />}
          <div className={styles.storyResult}>{story ? `${story.v2.trace.unsafeActions.length} unsafe-action records · ${story.v2.evaluation.passed ? "PASS" : "FAIL"}` : "See candidate evidence"}</div>
        </article>
      </div>
      <p className={styles.contextNote}>Before / after: the same <code>{story?.scenarioId}</code> regression scenario. Memory originated in the separate <code>{structural.seed.trace.scenarioId}</code> incident.</p>
      <div className={styles.provenance}><span className={styles.provenanceIcon} aria-hidden="true">↳</span><div><span className={styles.miniLabel}>PROOF OF MEMORY REUSE</span>
        <p>Learned from Run <strong>{recalled?.createdInRunId ?? "—"}</strong> <span className={styles.provenanceArrow}>→</span> reused in Run <strong>{replay?.executionId ?? "—"}</strong></p></div><span className={styles.memoryTag}>{recalled?.id}</span></div>
    </section>

    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>MEMORY WASN&apos;T ENOUGH</p><h2>Repair the agent. Not the transcript.</h2></div><span className={styles.versionFlow}>V1 <span>→</span> V2 <span>→</span> {best?.spec.version.toUpperCase()}</span></div>
      <div className={styles.evidenceStrip}><span className={styles.warningIcon}>!</span><p><strong>{structural.mutation.failure.evidence.length} repeated serious failures.</strong> Relevant memory was recalled, but V1 still omitted a required diagnostic. Structural failure detected.</p></div>
      <div className={styles.diffGrid}>
        <article className={styles.diffCard}><span className={styles.miniLabel}>V2 / ADD_REQUIRED_CHECK</span><h3>Make verification non-negotiable.</h3>
          <div className={styles.removedLine}><span>−</span> Metrics → deployments → act</div>
          {addedChecks.map((tool) => <div className={styles.addedLine} key={tool}><span>+</span><code>{tool}</code><span className={styles.newTag}>REQUIRED</span></div>)}
          <p>A permanent workflow step before remediation. No need to recall the instruction again.</p></article>
        <article className={styles.diffCard}><span className={styles.miniLabel}>{best?.spec.version.toUpperCase()} / ADD_SAFETY_GATE</span><h3>Stop the dangerous action.</h3>
          {addedGates.map((rule) => <div key={rule.id}><div className={styles.addedLine}><span>+</span><code>{rule.id}</code></div><p>{rule.description}</p></div>)}
          <span className={styles.gateTag}>ENFORCED BY THE RUNNER</span></article>
      </div>
      <details className={styles.details}><summary>Inspect exact V1 → V2 / V3 AgentSpec diffs <span>+</span></summary>
        {candidates.map((c) => <div key={c.spec.version}><h3>V1 → {c.spec.version.toUpperCase()}</h3><p>{c.rationale}</p>
          {c.diff.map((d) => <div key={d.field}><h4>{d.field}</h4><pre>{`- ${JSON.stringify(d.before, null, 2)}\n+ ${JSON.stringify(d.after, null, 2)}`}</pre></div>)}</div>)}
      </details>
    </section>

    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>SAME TESTS. TWO REAL CANDIDATES.</p><h2>Choose with evidence.</h2></div><span className={styles.subtleBadge}>6 FIXED SCENARIOS</span></div>
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Candidate</th><th>Success</th><th>Completed</th><th>Unsafe</th><th>Regressions</th><th>Critical safety</th><th>Tool calls</th><th>Latency¹</th></tr></thead>
        <tbody>{candidates.map((c) => <tr key={c.spec.version} className={c.spec.version === selection.version ? styles.selectedRow : ""}>
          <td><strong>{c.spec.version.toUpperCase()}</strong>{c.spec.version === selection.version && <span className={styles.selectedTag}>SELECTED</span>}</td>
          <td>{c.metrics.success}/{c.metrics.total}</td><td>{c.metrics.completed}/{c.metrics.total}</td><td>{c.metrics.unsafeActions}</td><td>{c.metrics.regressions}</td><td>{c.metrics.criticalSafetyRegressions}</td><td>{c.metrics.toolCalls}</td><td>{c.metrics.latencyMs.toLocaleString("en-US")} ms</td>
        </tr>)}</tbody></table></div>
      <p className={styles.contextNote}>¹ Simulated latency, not wall-clock time. Completion ≠ success. Unsafe counts are trace records and can include multiple reasons per call. Tokens / cost unavailable; no model calls.</p>
      <div className={styles.selectionReason}><span className={styles.greenDot} /><p>{selection.reason}</p></div>
    </section>

    <section className={`${styles.section} ${styles.verificationGrid}`}>
      <article className={styles.verificationCard}><span className={styles.miniLabel}>01 / REGRESSION GUARD</span><h3>A repair must not break what works.</h3>
        {candidates.map((c) => <div className={styles.guardRow} key={c.spec.version}><strong>{c.spec.version.toUpperCase()}</strong><span className={c.regression.promotion === "PROMOTION BLOCKED" ? styles.redText : styles.greenText}>{c.regression.promotion}</span></div>)}
        <p>Any critical safety regression blocks promotion. Passing the regression guard is not certification.</p>
        <details className={styles.details}><summary>Fixed, preserved &amp; regressed <span>+</span></summary>{candidates.map((c) => <div key={c.spec.version}><h4>{c.spec.version}</h4><p>{c.regression.reason}</p><ul>
          <li>Fixed: {c.regression.fixedFailures.join(", ") || "none"}</li><li>Preserved: {c.regression.preservedSuccesses.join(", ") || "none"}</li><li>Regressions: {c.regression.regressions.join(", ") || "none"}</li><li>Critical safety regressions: {c.regression.criticalSafetyRegressions.join(", ") || "none"}</li></ul></div>)}</details>
      </article>
      <article className={styles.verificationCard}><span className={styles.miniLabel}>02 / FROZEN WINNER</span><h3>One spec. Locked before the test.</h3>
        <div className={styles.frozenLabel}><span aria-hidden="true">▣</span> {selection.version?.toUpperCase()} <span>{frozen?.status.toUpperCase() ?? "NOT FROZEN"}</span></div>
        <span className={styles.hashLabel}>SHA-256 / EXACT AGENTSPEC</span><code className={styles.hash}>{frozen?.hash ?? "No frozen candidate"}</code>
        <p>Deep-frozen. Hash checked before and after certification. No post-test retuning.</p>
      </article>
    </section>

    <section className={styles.certification}>
      <div><p className={styles.eyebrow}>THE TEST IT HADN&apos;T SEEN</p><h2>Sealed certification</h2><p>Better is not the same as safe.<br />The holdout exposes what still goes wrong.</p></div>
      <div className={styles.certVerdict}><span>{certification?.status ?? "NOT RUN"}</span><strong>{result.deploymentDecision}</strong></div>
      {certification && <div className={styles.certNumbers}><div><strong>{certification.success}/{certification.total}</strong><span>successful scenarios</span></div><div><strong>{certification.unsafeActions}</strong><span>unsafe actions</span></div><div><strong>{certification.policyViolationCount}</strong><span>policy violations</span></div><div><strong>{certification.attempts}</strong><span>sealed attempt</span></div></div>}
      <p className={styles.certNote}>Separate fixtures. Loaded only after selection and freeze. Not used for learning, reflection, mutation, or candidate selection. A local proof protocol—not external safety certification.</p>
    </section>

    <section className={styles.evidenceSection}>
      <h2>The receipts, not just the result.</h2><p className={styles.contextNote}>Detailed evidence stays inspectable. Nothing below runs a new experiment.</p>
      <details className={styles.details}><summary>Original failure trace, reflection &amp; learned memory <span>+</span></summary><h3>{structural.seed.trace.runId}</h3><Trajectory trace={structural.seed.trace} />
        <ul>{reflection.failureModes.map((m) => <li key={m.id}><strong>{m.id}</strong>: {m.detail}</li>)}</ul>
        {structural.memory.rules.map((r) => <p key={r.id}><code>{r.id}</code> · learned in {r.createdInRunId} · {r.statement}</p>)}
        <pre>{JSON.stringify(structural.seed, null, 2)}</pre></details>
      <details className={styles.details}><summary>Repeated structural failure &amp; recalled-memory evidence <span>+</span></summary><p>The replay uses the existing one-rule retrieval budget. Candidate comparison uses standalone specs without memory overlays.</p>
        {structural.observations.map((o) => <div key={o.executionId}><h3>{o.executionId}</h3><p>Recalled: {o.retrievedRules.map((r) => r.id).join(", ")}</p><pre>{JSON.stringify({ trace: o.trace, evaluation: o.evaluation }, null, 2)}</pre></div>)}</details>
      <details className={styles.details}><summary>Complete candidate regression traces <span>+</span></summary>{candidates.map((c) => <div key={c.spec.version}><h3>{c.spec.version}</h3><pre>{JSON.stringify(c.regression.rows, null, 2)}</pre></div>)}</details>
      <details className={styles.details}><summary>Sealed results: every evaluator check <span>+</span></summary><p>Policy violations count failed forbidden-action, required-check and tool-ordering checks. Every evaluator check must pass for certification PASS.</p>
        {certification?.suite.entries.map((e) => <div key={e.trace.runId}><h3>{e.trace.scenarioId} · {e.evaluation.passed ? "PASS" : "FAIL"}</h3><ul>{e.evaluation.checks.map((c) => <li key={c.id}><strong className={c.passed ? styles.greenText : styles.redText}>{c.passed ? "PASS" : "FAIL"}</strong> {c.id}: {c.detail}</li>)}</ul><pre>{JSON.stringify(e.trace, null, 2)}</pre></div>)}</details>
    </section>
    <footer className={styles.footer}><span>WINDTUNNEL <span className={styles.footerDim}>/ PROVE IT BEFORE YOU SHIP IT.</span></span><span>Executed {result.executedAt} · deterministic simulator</span></footer>
  </main>;
}
