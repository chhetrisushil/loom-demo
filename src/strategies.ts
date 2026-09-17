// ── The one new concept: HOW a migration is applied ───────────────────────────
//
// Three mutually exclusive ways to run the same schema change. They are what the
// fork demo simulates on branches, and what the policy in src/policy.ts chooses
// between — one concept, two claims.

export const STRATEGIES = ["direct-ddl", "online-ddl", "chunked"] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** What a strategy is projected to cost on a given table. */
export interface Projection {
  lockSeconds: number;
  durationMinutes: number;
  reversible: boolean;
}

/**
 * A tiny simulated cost model (m = rows in millions). Deliberately shaped so the
 * best strategy DEPENDS on table size — direct for small, online for large, chunked
 * for huge — which is what makes a size-aware policy genuinely better than a naive
 * one, and what a shadow-schema dry run would measure for real.
 */
export function project(rows: number, strategy: Strategy): Projection {
  const m = rows / 1_000_000;
  switch (strategy) {
    case "direct-ddl": // one statement: full table lock for the whole run
      return { lockSeconds: round(m), durationMinutes: round(Math.max(1, m / 2)), reversible: false };
    case "online-ddl": // copy + cutover: tiny lock, long copy
      return { lockSeconds: round(2 + m / 20), durationMinutes: round(10 + 3 * m), reversible: true };
    case "chunked": // batched: no lock, longest of all
      return { lockSeconds: 0, durationMinutes: round(60 + 8 * m), reversible: true };
  }
}

/** 0..1, higher is better. A minute of lock is as bad as it gets; so is a 4-hour run. */
export function reward(p: Projection): number {
  const lock = Math.min(1, p.lockSeconds / 60);
  const duration = Math.min(1, p.durationMinutes / 240);
  return Number((1 - 0.7 * lock - 0.3 * duration).toFixed(4));
}

function round(n: number): number {
  return Number(n.toFixed(1));
}
