import type { BranchRef, BranchRegistry } from "@loom/event-runtime";
import type { MigrationResult } from "../app/flows/migration-guard/flow";
import type { LoomApp } from "./config";
import { type Projection, STRATEGIES, type Strategy, reward } from "./strategies";

// ── Fork → simulate → compare → promote ───────────────────────────────────────
//
// A branch is a shared log prefix. Forking a suspended execution copies its log up
// to the gate and seeds a snapshot there, so a branch resumes as cheaply as the
// parent would — inspect and assess are served from the copied prefix, never
// re-run. Each branch is its own executionId with its own surface, which is why the
// React board can stream three of them at once with the component it already had.
//
// There is deliberately no merge: two divergent ExecutionStates have no principled
// join. We pick a winner by moving a ref. Both surfaces call exactly this module.

export interface BranchOutcome {
  strategy: Strategy;
  branchName: string;
  executionId: string;
  projection: Projection;
}

function registry(app: LoomApp): BranchRegistry {
  const r = app.stores.branchRegistry;
  if (r === undefined) {
    throw new Error("fork needs a branch registry — use sqliteStorage() or memoryStorage()");
  }
  return r;
}

/** The sequence of the durable gate — the fork point. */
export async function findGate(app: LoomApp, executionId: string): Promise<number> {
  const events = await app.stores.eventStore.read(executionId);
  const gate = [...events].reverse().find((e) => e.eventType === "EXECUTION_SUSPENDED");
  if (gate === undefined) throw new Error(`${executionId} never reached the approval gate`);
  return gate.sequence;
}

/** Where an execution's log ends and what state that folds to — the "untouched" check. */
export async function headOf(app: LoomApp, executionId: string): Promise<{ sequence: number; status: string }> {
  const events = await app.stores.eventStore.read(executionId);
  const state = await app.runtime.loadState(executionId);
  if (state === null) throw new Error(`${executionId} has no folded state`);
  return { sequence: events[events.length - 1]?.sequence ?? 0, status: state.status };
}

/**
 * Fork one branch per strategy from the gate and dry-run each. `main` is pointed at the
 * parent's gate first, so there is something to promote onto. Branches run concurrently;
 * results come back in STRATEGIES order.
 */
export async function exploreStrategies(
  app: LoomApp,
  parentId: string,
  gateSeq: number,
  onBranch?: (b: { strategy: Strategy; executionId: string }) => void,
): Promise<BranchOutcome[]> {
  const reg = registry(app);
  const now = Date.now();
  await reg.putRef({ name: "main", executionId: parentId, tip: gateSeq, createdAt: now, updatedAt: now });

  return Promise.all(
    STRATEGIES.map(async (strategy): Promise<BranchOutcome> => {
      const branchName = `spec/${strategy}`;
      const fork = await app.runtime.fork(parentId, gateSeq, { branchName });
      onBranch?.({ strategy, executionId: fork.executionId });
      const resumed = await app.runtime.resume(fork.executionId, {
        eventType: "ApprovalGranted",
        payload: { approved: true, approvedBy: "explorer", strategy, simulate: true },
      });
      const done = await resumed.waitForCompletion();
      await reg.moveTip(branchName, done.sequence);
      const out = done.variables._output as MigrationResult;
      if (out.projected === undefined) throw new Error(`branch ${branchName} produced no projection`);
      return { strategy, branchName, executionId: fork.executionId, projection: out.projected };
    }),
  );
}

/** Highest reward wins — the same scoring rule the learning demo uses. */
export function pickWinner(outcomes: readonly BranchOutcome[]): BranchOutcome {
  const [best] = [...outcomes].sort((a, b) => reward(b.projection) - reward(a.projection));
  if (best === undefined) throw new Error("no branches to pick from");
  return best;
}

/**
 * Commit the winner: a fresh branch from the same gate, resumed FOR REAL with the winning
 * strategy, then `main` is moved onto it. The pointer move is the whole promotion. The
 * spec/* branches and the parent are left exactly as they were.
 */
export async function promoteAndApply(
  app: LoomApp,
  parentId: string,
  gateSeq: number,
  winner: Strategy,
): Promise<{ executionId: string; output: MigrationResult }> {
  const reg = registry(app);
  const fork = await app.runtime.fork(parentId, gateSeq, { branchName: "commit" });
  const resumed = await app.runtime.resume(fork.executionId, {
    eventType: "ApprovalGranted",
    payload: { approved: true, approvedBy: "operator", strategy: winner, simulate: false },
  });
  const done = await resumed.waitForCompletion();
  await reg.moveTip("commit", done.sequence);
  await reg.promote("commit", "main");
  return { executionId: fork.executionId, output: done.variables._output as MigrationResult };
}

export async function refs(app: LoomApp): Promise<BranchRef[]> {
  return registry(app).listRefs();
}

/** How many branches were forked from this execution — the alternatives-considered trail. */
export async function branchCount(app: LoomApp, parentId: string): Promise<number> {
  return (await registry(app).children(parentId)).length;
}
