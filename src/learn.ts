import type { EventEnvelope } from "@loom/core";
import { type EvalReport, type Policy, evaluatePolicy, steps, trajectories } from "@loom/learning";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import type { LoomApp } from "./config";
import { resetPolicySeed, setBlind } from "./policy";
import type { Strategy } from "./strategies";

// ── The offline half of claim 3 ───────────────────────────────────────────────
//
// Serve real traffic through the live policy, then read the log back the way an
// offline job would and ask: "what would a DIFFERENT policy have scored?" — without
// running it. `@loom/learning` does the maths (trajectories + SNIPS); this module
// only drives the flow and shapes the numbers. Both surfaces call exactly this.

export { formatEvalReport } from "@loom/learning";

export const BATCH_CHANGES = ["add-nullable-column", "drop-column", "add-index", "backfill"] as const;

export interface BatchOptions {
  /** Make the same choices through a bare ctx.decide — no context, no propensity. */
  blind?: boolean;
  /** executionId prefix; the batch is read back by it. */
  prefix?: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Serve `n` migrations, cycling the four change types. Gated ones are approved
 * WITHOUT a strategy — that is the policy's decision, and the point of the batch.
 * The policy seed is reset first so a learnable batch and a blind one make the
 * same choices.
 */
export async function serveBatch(app: LoomApp, n: number, opts: BatchOptions = {}): Promise<string[]> {
  const prefix = opts.prefix ?? "learn-";
  resetPolicySeed();
  setBlind(opts.blind ?? false);
  const ids: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const change = BATCH_CHANGES[i % BATCH_CHANGES.length]!;
      const executionId = `${prefix}${i}`;
      const handle = await app.runtime.start(migrationGuardFlow, { table: "orders", change }, { executionId });
      // waitForSuspend never settles for a flow that completes, and vice versa — race them.
      const state = await Promise.race([handle.waitForSuspend(), handle.waitForCompletion()]);
      if (state.status === "suspended") {
        const resumed = await app.runtime.resume(executionId, {
          eventType: "ApprovalGranted",
          payload: { approved: true, approvedBy: "batch" },
        });
        await resumed.waitForCompletion();
      } else if (state.status !== "completed") {
        throw new Error(`${executionId} ended with status "${state.status}" before it could be served`);
      }
      ids.push(executionId);
      opts.onProgress?.(i + 1, n);
    }
  } finally {
    setBlind(false);
  }
  return ids;
}

/** Every event of every execution whose id starts with `prefix` — the log as a dataset. */
export async function readLog(app: LoomApp, prefix = ""): Promise<EventEnvelope[]> {
  const store = app.stores.eventStore;
  if (store.listExecutions === undefined) {
    throw new Error("this event store cannot enumerate executions");
  }
  const ids = (await store.listExecutions()).filter((id) => id.startsWith(prefix));
  const logs = await Promise.all(ids.map((id) => store.read(id)));
  return logs.flat();
}

export interface Coverage {
  executions: number;
  decisions: number;
  withContext: number;
  withPropensity: number;
  scoredDirectly: number;
  arms: { strategy: string; meanReward: number; n: number }[];
}

/** The same numbers `loom learn report` prints — what the log can and cannot teach. */
export function coverage(events: readonly EventEnvelope[]): Coverage {
  const ts = trajectories<Strategy>(events);
  const all = steps(ts);
  const arms = new Map<string, { n: number; sum: number }>();
  for (const s of all) {
    if (s.reward === undefined) continue;
    const cur = arms.get(s.action) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += s.reward;
    arms.set(s.action, cur);
  }
  return {
    executions: ts.length,
    decisions: all.length,
    withContext: all.filter((s) => s.context !== undefined).length,
    withPropensity: all.filter((s) => s.policy?.propensity !== undefined).length,
    scoredDirectly: all.filter((s) => s.rewardSource === "direct").length,
    arms: [...arms.entries()]
      .map(([strategy, v]) => ({ strategy, meanReward: v.sum / v.n, n: v.n }))
      .sort((a, b) => b.meanReward - a.meanReward),
  };
}

export function formatCoverage(c: Coverage): string {
  const pct = (n: number) => (c.decisions === 0 ? "0%" : `${((n / c.decisions) * 100).toFixed(0)}%`);
  const lines = [
    `   Learning report — ${c.executions} execution(s), ${c.decisions} decision(s)`,
    `     with context      ${c.withContext} (${pct(c.withContext)})`,
    `     with propensity   ${c.withPropensity} (${pct(c.withPropensity)})`,
    `     scored directly   ${c.scoredDirectly} (${pct(c.scoredDirectly)})`,
    "   Arms (mean reward, best first)",
  ];
  for (const a of c.arms) lines.push(`     ${a.strategy.padEnd(12)} ${a.meanReward.toFixed(4)}  n=${a.n}`);
  if (c.arms.length === 0) lines.push("     (nothing scored)");
  return lines.join("\n");
}

/** Score a candidate against the log. The candidate never runs; it is only ASKED. */
export function evaluate(events: readonly EventEnvelope[], policy: Policy<Strategy>): EvalReport {
  return evaluatePolicy(trajectories<Strategy>(events), policy);
}

/**
 * The three lines a room can read from a stage. `formatEvalReport` has the full
 * eight-plus-warnings version — keep that for Q&A (`pnpm propensity --verbose`).
 */
export function headline(r: EvalReport): string {
  const stepsLine = `  steps evaluated     ${r.evaluated}`;
  if (r.estimatedValue === undefined || r.lift === undefined) {
    return [stepsLine, "  estimated value     — cannot be estimated (no propensity in the log)", "  lift                —"].join("\n");
  }
  return [
    stepsLine,
    `  estimated value     ${r.estimatedValue.toFixed(4)}   (what actually ran: ${r.loggedValue.toFixed(4)})`,
    `  lift                ${r.lift >= 0 ? "+" : ""}${r.lift.toFixed(4)}`,
  ].join("\n");
}
