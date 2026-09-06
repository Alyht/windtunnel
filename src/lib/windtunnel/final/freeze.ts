import { createHash } from "node:crypto";
import type { AgentSpec } from "../types";

/** Canonical JSON: sorted object keys, preserved array order; reject non-JSON values. */
export function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
  }
  throw new Error("Frozen specs must contain only finite JSON data");
}

export function specHash(spec: AgentSpec): string {
  return createHash("sha256").update(stableSerialize(spec), "utf8").digest("hex");
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

export interface FrozenAgentSpec {
  readonly status: "frozen";
  readonly hashAlgorithm: "SHA-256";
  readonly hash: string;
  readonly serializedSpec: string;
  readonly spec: AgentSpec;
}

const issued = new WeakMap<FrozenAgentSpec, { attempted: boolean }>();

export function freezeSpec(candidate: AgentSpec): FrozenAgentSpec {
  const spec = structuredClone(candidate);
  const artifact: FrozenAgentSpec = { status: "frozen", hashAlgorithm: "SHA-256",
    hash: specHash(spec), serializedSpec: stableSerialize(spec), spec };
  deepFreeze(artifact);
  issued.set(artifact, { attempted: false });
  return artifact;
}

export function assertFrozen(artifact: FrozenAgentSpec): void {
  if (!issued.has(artifact) || !Object.isFrozen(artifact.spec) ||
      specHash(artifact.spec) !== artifact.hash || stableSerialize(artifact.spec) !== artifact.serializedSpec) {
    throw new Error("Certification requires an authentic, unchanged frozen AgentSpec");
  }
}

/** Mark consumed before loading sealed fixtures. Failures cannot trigger a retry. */
export function beginCertification(artifact: FrozenAgentSpec): void {
  assertFrozen(artifact);
  const state = issued.get(artifact)!;
  if (state.attempted) throw new Error("This frozen artifact has already attempted sealed certification");
  state.attempted = true;
}
