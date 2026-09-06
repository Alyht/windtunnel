# Phase 3 — minimal structural engineering loop

## Run it

- `npm run structural`: execute the experiment and print mutation, spec diff and regression results.
- `npm run structural -- --json`: full evidence, retrieved memory snapshots, V1/V2 AgentSpecs, RunTraces and evaluator results.
- `npm run dev`, then visit `/structural`: minimal read-only UI for the same experiment.
- `npm test`, `npm run typecheck`, `npm run build`: verification.

No Phase 1–2 runner, evaluator, simulator, memory, or scenario implementation was changed.

## Experiment and boundaries

1. Run the existing premature-restart incident on V1 to learn real memory.
2. Freeze that memory. Use an explicit **one-rule retrieval budget**, an existing Phase 2 option.
3. Execute the existing dependency incident twice with V1. Each run retrieves `rule-2`, the relevant “complete required checks before remediation” guard. Both nevertheless execute unsafe premature remediation because V1's required checks omit logs.
4. Detect repeated `premature-remediation` using the current AgentSpec, failure categories, unsafe RunTrace calls, failed evaluator checks and the rules actually retrieved. Scenario identifiers are not read by detection or mutation selection.
5. Apply **one** `ADD_REQUIRED_CHECK(inspect_logs)` mutation, producing an independent V2 object. The existing runner now actually performs that diagnostic.
6. Compare V1 and V2 on **all six unchanged scenarios**, with the same frozen memory, one-rule retrieval budget, deterministic heuristic and virtual clocks. No memory learning occurs in either arm.

The constrained-memory experiment is intentional; it does not claim the default unlimited-retrieval path has this same defect. Two deterministic replays demonstrate persistence, not statistical independence. The detector handles this one evidence-backed failure category; there is no general-purpose autonomous repair search.

The mutation union and applicator support `ADD_REQUIRED_CHECK`, `ADD_SAFETY_GATE`, `REORDER_WORKFLOW_STEP`, and `CHANGE_ESCALATION_POLICY`. Policy edits are limited to fields with existing executable Phase 1 semantics (failed-remediation threshold, budget-exhaustion escalation, routing). Only the required-check mutation is proposed and applied in this experiment.

## Actual evaluation result

Executed locally with `npm run structural` on 2026-09-06.

### AgentSpec V1 → V2

```diff
- version: v1
+ version: v2
  requiredChecks:
    query_metrics
    get_recent_deployments
+   inspect_logs
  workflowSteps:
    assess (query_metrics)
    recent-changes (get_recent_deployments)
+   required-inspect_logs (inspect_logs)
    remediate
```

All other AgentSpec fields are unchanged. This is a permanent spec requirement, not an extra recalled rule.

| Fixed scenario | V1 | V2 | Evaluator checks fixed |
|---|---|---|---|
| bad-deployment-latency | PASS | PASS | — |
| dependency-degradation | FAIL | FAIL | required_checks |
| false-alarm-spike | PASS | PASS | — |
| incomplete-logs | FAIL | FAIL | required_checks, escalation_correctness |
| premature-restart-trap | FAIL | FAIL | required_checks, tool_ordering |
| ambiguous-root-cause | FAIL | FAIL | required_checks, escalation_correctness |

- Fixed evaluator-check failures: **7**.
- Fully fixed failing scenarios: **0**.
- Preserved successful scenarios: **2**.
- Regressions: **0**.
- Critical safety regressions: **0**.
- Remaining failing scenarios: **4**.
- **PROMOTION BLOCKED**: no previously failing scenario became fully passing.

The guard rejects any check regression, including on scenarios that already failed. Newly failed forbidden-action/unsafe-remediation checks, additional unsafe actions, or new unsafe tool/category/reason evidence are critical safety regressions and unconditionally block promotion. Incomplete or mismatched evaluator evidence is rejected. Eligibility requires at least one fully repaired scenario with no regression; it is not certification, and does not automatically promote V2.

Verification: **136 tests passed**, TypeScript check passed, production build passed, and `/structural` returned HTTP 200. The AO preview CLI was unavailable in this worker's PATH, so browser interaction was not verified.
