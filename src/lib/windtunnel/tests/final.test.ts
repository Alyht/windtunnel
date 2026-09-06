import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SPEC_V1 } from "../specs/v1";
import { deriveCandidates, selectCandidate } from "../final/candidates";
import { assertFrozen, freezeSpec, specHash, stableSerialize } from "../final/freeze";
import { certifyFrozenSpec } from "../final/certification";
import { detectStructuralFailures } from "../structural/mutation";
import type { FinalDemoResult } from "../final/demo";

const proof = JSON.parse(readFileSync("artifacts/final-demo.json", "utf8")) as FinalDemoResult;

test("two distinct specs are derived from the same evidence without scenario identity", () => {
  const observations = structuredClone(proof.structural.observations);
  const before = deriveCandidates(SPEC_V1, detectStructuralFailures(SPEC_V1, observations), observations);
  assert.equal(before.length, 2);
  assert.notDeepEqual(before[0]!.spec, before[1]!.spec);
  for (const o of observations) {
    o.trace.scenarioId = o.evaluation.scenarioId = "not-a-training-id";
    o.trace.runId = o.evaluation.runId = "opaque";
    for (const r of o.retrievedRules) r.originScenarioId = "opaque-origin";
  }
  assert.deepEqual(deriveCandidates(SPEC_V1, detectStructuralFailures(SPEC_V1, observations), observations), before);
  assert.throws(() => deriveCandidates(SPEC_V1, [], observations), /No repeated/);
  assert.throws(() => deriveCandidates(SPEC_V1, detectStructuralFailures(SPEC_V1, observations),
    observations.map((o) => ({ ...o, failureModes: [] }))), /second candidate/);
});

test("candidate metrics are computed from actual entries on the same fixed suite", () => {
  assert.equal(proof.candidates.length, 2);
  const ids = proof.candidates[0]!.regression.rows.map((r) => r.scenarioId);
  for (const c of proof.candidates) {
    assert.deepEqual(c.regression.rows.map((r) => r.scenarioId), ids);
    assert.equal(c.metrics.success, c.regression.rows.filter((r) => r.v2.evaluation.passed).length);
    assert.equal(c.metrics.unsafeActions, c.regression.rows.reduce((n, r) => n + r.v2.trace.unsafeActions.length, 0));
    assert.equal(c.metrics.toolCalls, c.regression.rows.reduce((n, r) => n + r.v2.trace.toolCallCount, 0));
    assert.equal(c.metrics.latencyMs, c.regression.rows.reduce((n, r) => n + r.v2.trace.latencyMs, 0));
    assert.ok(!c.regression.rows.some((r) => r.v2.trace.specVersion.includes("+mem")));
  }
});

test("selection enforces safety veto, then unsafe minimum, success and completion", () => {
  const candidates = structuredClone(proof.candidates);
  assert.equal(selectCandidate(candidates).selected?.spec.version, "v3");
  candidates[1]!.metrics.criticalSafetyRegressions = 1;
  assert.equal(selectCandidate(candidates).selected?.spec.version, "v2");
  candidates[0]!.metrics.criticalSafetyRegressions = 1;
  assert.equal(selectCandidate(candidates).selected, null);
  for (const c of candidates) { c.metrics.criticalSafetyRegressions = 0; c.metrics.unsafeActions = 0; }
  candidates[0]!.metrics.success = 6;
  assert.equal(selectCandidate(candidates).selected?.spec.version, "v2");
  candidates[1]!.metrics.success = 6;
  candidates[0]!.metrics.completed = 5;
  assert.equal(selectCandidate(candidates).selected?.spec.version, "v3");
});

test("freeze uses stable SHA-256, isolates candidate changes, and rejects nested mutation", () => {
  const candidate = structuredClone(SPEC_V1);
  const frozen = freezeSpec(candidate);
  assert.match(frozen.hash, /^[a-f0-9]{64}$/);
  assert.equal(specHash(candidate), specHash(Object.fromEntries(Object.entries(candidate).reverse()) as typeof candidate));
  assert.equal(stableSerialize({ z: 1, a: { y: 2, b: 3 } }), stableSerialize({ a: { b: 3, y: 2 }, z: 1 }));
  assert.throws(() => stableSerialize({ x: undefined }), /finite JSON/);
  assert.throws(() => frozen.spec.requiredChecks.push("inspect_logs"), TypeError);
  assert.throws(() => { frozen.spec.escalationPolicy.defaultRoute = "changed"; }, TypeError);
  candidate.version = "changed";
  assert.equal(frozen.spec.version, "v1");
  assert.notEqual(specHash(candidate), frozen.hash);
  assertFrozen(frozen);
  assert.throws(() => assertFrozen(JSON.parse(JSON.stringify(frozen))), /authentic/);
});

test("sealed certification requires freeze, is one-shot even on FAIL, and preserves hash", async () => {
  const frozen = freezeSpec(proof.candidates[1]!.spec);
  const result = await certifyFrozenSpec(frozen);
  assert.equal(result.status, "FAIL");
  assert.equal(result.success, 2);
  assert.equal(result.unsafeActions, 1);
  assert.equal(result.policyViolationCount, 1);
  assert.equal(result.frozenHash, specHash(frozen.spec));
  await assert.rejects(() => certifyFrozenSpec(frozen), /already attempted/);
  await assert.rejects(() => certifyFrozenSpec(JSON.parse(JSON.stringify(frozen))), /authentic/);
});

test("stored proof keeps heldout results separate and never turns certification FAIL into promotion", () => {
  const sealed = proof.certification!;
  const developmentIds = new Set(proof.baseline.entries.map((e) => e.trace.scenarioId));
  for (const o of proof.structural.observations) developmentIds.add(o.trace.scenarioId);
  for (const e of sealed.suite.entries) assert.equal(developmentIds.has(e.trace.scenarioId), false);
  assert.equal(sealed.frozenHash, proof.frozen!.hash);
  assert.equal(specHash(proof.frozen!.spec), proof.frozen!.hash);
  assert.deepEqual(proof.frozen!.spec, proof.candidates.find((c) => c.spec.version === proof.selection.version)!.spec);
  assert.equal(proof.deploymentDecision, "PROMOTION BLOCKED");
  assert.equal(sealed.status, "FAIL");
  assert.equal(sealed.attempts, 1);
});
