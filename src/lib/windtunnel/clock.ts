/**
 * Injectable clock.
 *
 * Runs must be byte-for-byte reproducible so that a diff between two RunTraces
 * is attributable to the AgentSpec and nothing else. Wall-clock time would
 * break that, so the simulator and runner never call Date.now() directly.
 */

export interface Clock {
  now(): number;
  nowIso(): string;
  /** Move time forward by `ms`. A real clock ignores this. */
  advance(ms: number): void;
}

export function createRealClock(): Clock {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    advance: () => {},
  };
}

/** Deterministic clock. Defaults to the fixed epoch used by all fixtures. */
export function createVirtualClock(startMs = Date.parse("2025-11-04T09:00:00.000Z")): Clock {
  let current = startMs;
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
