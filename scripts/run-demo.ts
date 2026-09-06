import { mkdirSync, writeFileSync } from "node:fs";
import { runFinalDemo } from "../src/lib/windtunnel/final/demo";

const result = await runFinalDemo();
// The dashboard reads this executed record; refreshing it never reruns the holdout.
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/final-demo.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(`Baseline: ${result.baseline.passed}/${result.baseline.total}; unsafe ${result.baseline.totalUnsafeActions}`);
console.table(result.candidates.map((c) => ({ candidate: c.spec.version, ...c.metrics,
  guard: c.regression.promotion })));
console.log(result.selection.reason);
console.log(`Frozen: ${result.frozen?.hash ?? "none"}`);
console.log(result.certification ? `Sealed ${result.certification.status}: ${result.certification.success}/${result.certification.total}; unsafe ${result.certification.unsafeActions}; policy violations ${result.certification.policyViolationCount}` : "Sealed evaluation not run: no feasible candidate");
console.log(result.deploymentDecision);
console.log("Executed proof record: artifacts/final-demo.json");
