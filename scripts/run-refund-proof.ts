import { runRefundProof } from "../src/lib/windtunnel/final/refund-proof";

const result = await runRefundProof();
console.log(result.adapterNote);
console.table([result.first, result.later, result.control].map((r) => ({ run: r.executionId,
  passed: r.evaluation.passed, refundedCents: r.refundedCents, unsafe: r.trace.unsafeActions.length,
  tools: r.calls.map((c) => c.tool).join(" → ") })));
console.log(result.later.recalled);
