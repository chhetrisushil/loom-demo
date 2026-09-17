import { decideWithPolicy } from "@loom/learning";
import type { Policy, PolicyContext } from "@loom/learning";
import type { WorkflowContext } from "@loom/workflow-runtime";
import { STRATEGIES, type Strategy } from "./strategies";

// ── Decisions that carry their propensity (ADR 0079 / 0080) ───────────────────
//
// When the DBA approves a migration without saying HOW, a policy picks the
// strategy. The choice goes through `ctx.decide`, so it is recorded once and served
// from the log on every replay. What `decideWithPolicy` adds is the part no one
// can reconstruct later: the observation the policy saw, and the probability it
// assigned to what it picked. That is what lets a DIFFERENT policy be scored
// against this log without re-running anything.

/** The observation — kept small; it is written to the durable log on every decision. */
export type StrategyContext = { change: string; rows: number; risk: string };

export interface StrategyChoice {
  strategy: Strategy;
  /** Present when a policy chose (and the log is learnable). Absent for a human's pick or a blind decision. */
  policy?: { id: string; version: string; propensity: number };
}

// ── Seeded PRNG: a stage prop, so the numbers on stage are stable ──────────────
const SEED = 20260917;
let rand = mulberry32(SEED);
export function resetPolicySeed(): void {
  rand = mulberry32(SEED);
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The LIVE policy: ε-greedy around what the flow used to do implicitly ───────
const EPSILON = 0.5;
const GREEDY: Strategy = "direct-ddl";

export const loggingPolicy: Policy<Strategy> & { propensityOf(action: Strategy): number } = {
  id: "naive-eps",
  version: "1",
  /** P(action | context) under this policy — exact, and the same for every context. */
  propensityOf(action) {
    const explore = EPSILON / STRATEGIES.length;
    return action === GREEDY ? 1 - EPSILON + explore : explore;
  },
  select(_context: PolicyContext, actions: readonly Strategy[]) {
    const r = rand();
    const action = r < EPSILON ? actions[Math.floor((r / EPSILON) * actions.length)]! : GREEDY;
    return { action, propensity: this.propensityOf(action) };
  },
};

// ── Candidates: never run live; only ever SCORED against the log ──────────────
function rowsOf(context: PolicyContext): number {
  return typeof context.rows === "number" ? context.rows : 0;
}

export const sizeAware: Policy<Strategy> = {
  id: "size-aware",
  version: "2",
  select(context) {
    const rows = rowsOf(context);
    const action: Strategy = rows < 5_000_000 ? "direct-ddl" : rows < 100_000_000 ? "online-ddl" : "chunked";
    return { action, propensity: 1 };
  },
};

/** The control: chunk the small tables, lock the big ones. Must score worse than the log. */
export const backwards: Policy<Strategy> = {
  id: "backwards",
  version: "0",
  select(context) {
    const action: Strategy = rowsOf(context) < 5_000_000 ? "chunked" : "direct-ddl";
    return { action, propensity: 1 };
  },
};

// ── The blind toggle: the "before" case, kept only to show what it costs ───────
let blind = false;
export function setBlind(on: boolean): void {
  blind = on;
}
export function isBlind(): boolean {
  return blind;
}

/**
 * Resolve the strategy through the live policy as a durable decision.
 *
 * Learnable (default): `decideWithPolicy` records context + policy + propensity +
 * alternatives. Blind: the SAME choice through a bare `ctx.decide` — it completes,
 * it replays, a dashboard can count it, and nothing can ever be learned from it.
 */
export async function chooseStrategy(ctx: WorkflowContext, context: StrategyContext): Promise<StrategyChoice> {
  if (blind) {
    const strategy = (await ctx.decide<Strategy>("strategy", () => loggingPolicy.select(context, STRATEGIES).action));
    return { strategy };
  }
  const strategy = await decideWithPolicy<Strategy>(ctx, "strategy", loggingPolicy, context, STRATEGIES);
  // The propensity of the RECORDED choice (not of a fresh draw — on replay `select` is
  // consulted and discarded, so its draw may differ from what the log says ran).
  return {
    strategy,
    policy: { id: loggingPolicy.id, version: loggingPolicy.version, propensity: loggingPolicy.propensityOf(strategy) },
  };
}
