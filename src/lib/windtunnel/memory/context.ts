/**
 * Builds the ObservedContext that retrieval matches against.
 *
 * This is a read-only probe: it calls only the three diagnostic tools against a
 * throwaway simulator, so it can never mutate the world or produce an unsafe
 * action. It feeds *retrieval* only — the agent still has to run its own
 * diagnostics during the scored run to know any of this.
 */

import { createVirtualClock } from "../clock";
import { candidateDeployments, DEFAULT_CORRELATION_WINDOW_MINUTES } from "../safety";
import { IncidentSimulator } from "../simulator";
import type { DeploymentsResult, LogsResult, MetricsResult, Scenario } from "../types";
import type { ObservedContext } from "./types";

/** Memory above this reads as memory pressure to a first-pass runbook. */
const MEMORY_PRESSURE_PCT = 90;

export function probeContext(scenario: Scenario): ObservedContext {
  const simulator = new IncidentSimulator(scenario, createVirtualClock());
  const service = scenario.service;

  const metrics = simulator.callTool("query_metrics", { service }).result as MetricsResult;
  const logs = simulator.callTool("inspect_logs", { service }).result as LogsResult;
  const deployments = simulator.callTool("get_recent_deployments", { service })
    .result as DeploymentsResult;

  const candidates = candidateDeployments({
    deployments,
    metrics,
    alertFiredAt: scenario.alert.firedAt,
    windowMinutes: DEFAULT_CORRELATION_WINDOW_MINUTES,
    applyCausalityFilter: false,
  });
  const candidate = candidates[0] ?? null;

  return {
    service,
    serviceStateful: metrics.stateful,
    alertSeverity: scenario.alert.severity,
    metricsStatus: metrics.status,
    metricsSelfRecovered: metrics.status === "healthy" && metrics.recoveredAt !== null,
    hasDegradedDependency: metrics.upstreamDependencies.some((d) => d.status !== "healthy"),
    memoryPressure: metrics.memoryPct >= MEMORY_PRESSURE_PCT,
    logsComplete: logs.complete,
    logCoverage: logs.coverage,
    dominantErrorPresent: logs.dominantError !== null,
    errorSignatureCount: logs.entries.filter((e) => e.level === "error").length,
    candidateDeploymentId: candidate?.id ?? null,
    targetDeploymentRollbackSafe: candidate?.rollbackSafe ?? null,
    deploymentCountInWindow: candidates.length,
  };
}
