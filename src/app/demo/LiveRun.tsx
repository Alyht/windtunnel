"use client";

import { useRef, useState } from "react";
import type { Observation } from "@/lib/windtunnel/brain";
import type { LiveEvent, LiveResult, LiveStart } from "@/lib/windtunnel/live/types";
import styles from "./live.module.css";

export default function LiveRun() {
  const [running, setRunning] = useState(false);
  const busy = useRef(false);
  const [start, setStart] = useState<LiveStart | null>(null);
  const [calls, setCalls] = useState<Observation[]>([]);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy.current) return;
    busy.current = true;
    setRunning(true); setStart(null); setCalls([]); setResult(null); setError(null);
    let finished = false;
    const receive = (event: LiveEvent) => {
      if (event.type === "start") setStart(event.data);
      if (event.type === "tool") setCalls((previous) => [...previous, event.data]);
      if (event.type === "result") { setResult(event.data); finished = true; }
      if (event.type === "error") { setError(event.message); finished = true; }
    };
    try {
      const response = await fetch("/api/demo/run", { method: "POST", headers: { Accept: "application/x-ndjson" } });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.message ?? `Live request failed (HTTP ${response.status}).`);
      }
      if (!response.body) throw new Error("Live response stream is unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) receive(JSON.parse(line) as LiveEvent);
        if (done) break;
      }
      if (pending.trim()) receive(JSON.parse(pending) as LiveEvent);
      if (!finished) throw new Error("The live connection ended before a verdict. Partial calls are not a completed result.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The live run could not complete.");
    } finally { busy.current = false; setRunning(false); }
  }

  return <section className={styles.live} id="live-run" aria-labelledby="live-title">
    <div className={styles.header}><div><span className={styles.label}>LIVE RUN</span><h2 id="live-title">LIVE WINDTUNNEL</h2><p>A fresh AI-agent execution.</p></div>
      <button type="button" className={styles.run} disabled={running} onClick={run}>{running ? "Running live agent…" : "RUN WINDTUNNEL"}<span aria-hidden="true">↗</span></button></div>
    <p className={styles.note}>TensorMux chooses tools. The deterministic simulator and evaluator judge the actions. Real model calls; simulated production. No heuristic fallback.</p>
    <div role="status" aria-live="polite" className={styles.status}>{running ? `Running live agent… ${calls.length} tool call${calls.length === 1 ? "" : "s"} returned.` : result ? `Live run ${result.finalStatus}. ${result.promotion}.` : ""}</div>
    {start && <div className={styles.incident}><span className={styles.label}>INCIDENT →</span><h3>{start.incident.title}</h3><p>{start.incident.symptom}</p>
      <p className={styles.note}>Run ID: <code>{start.runId}</code> · model: {start.model} · spec: {start.specVersion}</p>
      <p className={styles.note}>Retrieved memory: {start.retrievedRules.length ? start.retrievedRules.map((r) => r.statement).join("; ") : "none — this request starts with empty, ephemeral memory."}</p></div>}
    {calls.length > 0 && <ol className={styles.calls}>{calls.map((call) => <li key={call.index}>
      <div className={styles.callTitle}><span>{call.index + 1}</span><strong>{call.tool}</strong><b>{call.blocked ? "BLOCKED" : call.ok ? "EXECUTED" : "ERROR"}</b></div>
      <p className={styles.note}>Tool call → <code>{JSON.stringify(call.args)}</code></p>
      <details open><summary>Actual tool result ↓</summary><pre>{call.error ?? JSON.stringify(call.result, null, 2)}</pre></details>
    </li>)}</ol>}
    {error && <div role="alert" className={styles.error}><strong>LIVE RUN ERROR — NOT A SUCCESS</strong><p>{error}</p><p>Any calls shown above are partial evidence only. The committed proof below has not changed.</p></div>}
    {result && <div className={styles.verdict}>
      <h3>Final action → <code>{result.trace.finalAction.type}</code></h3><pre>{JSON.stringify(result.trace.finalAction, null, 2)}</pre>
      <h3>Deterministic verdict: {result.evaluation.passed ? "PASS" : "FAIL"}</h3>
      <ul>{result.evaluation.checks.map((check) => <li key={check.id}><strong>{check.passed ? "PASS" : "FAIL"}</strong> {check.label}: {check.detail}</li>)}</ul>
      <p>Unsafe actions: <strong>{result.trace.unsafeActions.length}</strong> · Tool calls: <strong>{result.trace.toolCallCount}</strong></p>
      <p className={styles.note}>Wall-clock latency: {result.wallLatencyMs.toLocaleString()} ms · Simulated tool latency: {result.simulatedToolLatencyMs.toLocaleString()} ms</p>
      {result.trace.unsafeActions.length > 0 && <ul>{result.trace.unsafeActions.map((action, index) => <li key={index}>#{action.toolCallIndex + 1} {action.tool}: {action.reason}</li>)}</ul>}
      <h3>Reflection &amp; learning</h3>
      {result.reflection.failureModes.map((mode) => <p key={mode.id}>{mode.id}: {mode.detail}</p>)}
      {result.learnedRules.length ? <ul>{result.learnedRules.map((rule) => <li key={rule.id}>{rule.statement} <small>Learned in {rule.createdInRunId}</small></li>)}</ul> : <p>No new lesson was produced by the existing deterministic reflector.</p>}
      <p className={styles.note}>Lessons exist only in this request&apos;s memory. No persistent writes, benchmark updates, or certification reruns.</p>
      <h3>Final status: {result.finalStatus} · {result.promotion}</h3><p>{result.promotionReason}</p>
    </div>}
  </section>;
}
