import assert from "node:assert/strict";
import { test } from "node:test";
import { runRefundProof } from "../final/refund-proof";

test("second tool schema learns in order A and reuses memory to prevent an invalid refund in B", async () => {
  const result = await runRefundProof();
  assert.equal(result.first.evaluation.passed, false);
  assert.equal(result.first.refundedCents, 1200);
  assert.equal(result.later.evaluation.passed, true);
  assert.equal(result.later.refundedCents, 0);
  assert.deepEqual(result.later.calls.map((c) => c.tool), ["check_refund_eligibility"]);
  assert.deepEqual(result.later.recalled, [{ ruleId: "rule-1", learnedFrom: "refund-run-1", reusedIn: "refund-run-2" }]);
  assert.equal(result.control.evaluation.passed, false);
  assert.equal(result.control.refundedCents, 750);
  assert.deepEqual(result.control.recalled, []);
  assert.equal(result.memory.rules.length, 1);
  assert.equal(result.later.evaluation.checks.length, 6);
  assert.deepEqual(await runRefundProof(), result);
});
