# Fork-and-Propensity Demos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate concept-deck claims 2 (fork a live execution, simulate, promote) and 3 (decisions carry their propensity, scored counterfactually off the log) on both the terminal and the React surface, using the existing migration-guard flow.

**Architecture:** One new concept, "strategy", enters the flow's approval payload and apply step. Two shared helper modules (`src/fork.ts`, `src/learn.ts`) do the work; `pnpm fork` / `pnpm propensity` print it in the terminal and `BranchBoard` / `LearningPanel` render it in the browser. The policy that picks a strategy records its propensity through `decideWithPolicy`; a module-level "blind" toggle shows what a bare `ctx.decide` costs.

**Tech Stack:** TypeScript 5 (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Loom kernel via `link:../loom/packages/*` (`@loom/workflow-runtime` fork API, `@loom/learning`, `@loom/analytics`), zod, vitest, React 18 + Vite, SQLite via `@loom/plugin-sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-17-fork-and-propensity-demos-design.md` — read it first.

## Global Constraints

- The crash act stays policy-free: `src/main.ts` and `src/pitch-resume.ts` approve with `strategy: "direct-ddl"`.
- The UI's Approve button sends **no** strategy; the policy chooses there.
- Cost model, verbatim from the spec (m = rows / 1e6): direct-ddl lock `m`, duration `max(1, m/2)`, not reversible · online-ddl lock `2 + m/20`, duration `10 + 3m`, reversible · chunked lock `0`, duration `60 + 8m`, reversible. `reward = 1 − 0.7·min(1, lock/60) − 0.3·min(1, duration/240)`, rounded to 4 places.
- Logging policy `naive-eps` v1: greedy `direct-ddl`, ε = 0.3, propensity `0.8` for the greedy arm and `0.1` for each other arm. Candidates: `size-aware` v2 (direct < 5M rows, online < 100M, chunked otherwise), `backwards` v0 (chunked < 5M, direct otherwise).
- Batch size is 48 (12 per change type) on both surfaces. Batch executions use an id prefix and are read back by prefix.
- Branch names: `main`, `spec/<strategy>`, `commit`. The winner is the highest `reward`. Promotion is `branchRegistry.promote("commit", "main")`. There is no merge.
- `.data/` is the crash demo's log. `pnpm propensity` uses `.data/learn/` and `.data/learn-blind/` and wipes them at start.
- Commits in this repo end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Loom-repo changes go on branch `demo/fork-and-propensity` (never `main`).
- All tests run with `pnpm test` (vitest, memory storage, offline LLM provider). Typecheck with `pnpm build`.

## File map

| File | Responsibility |
|---|---|
| `src/strategies.ts` (new) | `STRATEGIES`, `Strategy`, `Projection`, `project()`, `reward()` |
| `src/policy.ts` (new) | logging policy with propensity, candidates, `chooseStrategy`, blind toggle, seed reset |
| `app/flows/migration-guard/flow.ts` (modify) | strategy in the approval payload; apply step projects cost; runner tail |
| `app/flows/migration-guard/flow.stub.txt` (modify) | same header, runner still throws |
| `src/trace.ts` (modify) | `quietTrace()` |
| `src/main.ts`, `src/pitch-resume.ts` (modify) | approve with explicit `direct-ddl` |
| `src/memory-storage.ts` (new) | custom in-memory storage **with** a branch registry (tests + browser) |
| `src/fork.ts` (new) | `findGate`, `headOf`, `exploreStrategies`, `pickWinner`, `promoteAndApply`, `refs`, `branchCount` |
| `src/learn.ts` (new) | `serveBatch`, `readLog`, `coverage`, `formatCoverage`, `evaluate`, re-export `formatEvalReport` |
| `src/pitch-fork.ts`, `src/pitch-propensity.ts` (new) | the two terminal acts |
| `src/browser/main.tsx`, `vite.config.ts` (modify) | memory storage with branch registry; pre-bundle learning packages |
| `src/browser/App.tsx` (modify) | tabs, `simulated` phase, Explore button, applied banner with propensity |
| `src/browser/BranchBoard.tsx`, `src/browser/LearningPanel.tsx` (new) | the two UI panels |
| `test/strategies.test.ts`, `test/policy.test.ts`, `test/fork.test.ts`, `test/learn.test.ts` (new), `test/migration-guard.test.ts` (modify) | specs |
| `DEMO_SCRIPT.md`, `README.md` (modify) | Acts 4b/4c/5, cheat-sheet, output lines |
| `../loom/packages/event-runtime/memory.{js,d.ts}` (modify, loom branch) | export `InMemoryBranchRegistry` from the browser-safe subpath |
| `../loom/docs/presentation/sip-n-pitch-concept-deck.md` (modify, loom branch) | two Act V slides + timing |

---

### Task 1: Dependencies and the strategy cost model

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/strategies.ts`
- Test: `test/strategies.test.ts`

**Interfaces:**
- Produces: `STRATEGIES: readonly ["direct-ddl","online-ddl","chunked"]`, `type Strategy`, `interface Projection { lockSeconds: number; durationMinutes: number; reversible: boolean }`, `project(rows: number, strategy: Strategy): Projection`, `reward(p: Projection): number`.

- [ ] **Step 1: Add the two learning packages as link deps**

In `package.json` `dependencies`, add (keep alphabetical order):

```json
    "@loom/analytics": "link:../loom/packages/analytics",
    "@loom/learning": "link:../loom/packages/learning",
```

Run: `pnpm install`
Expected: completes; `ls node_modules/@loom/learning/dist/index.js` exists.

- [ ] **Step 2: Write the failing test**

Create `test/strategies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STRATEGIES, type Strategy, project, reward } from "../src/strategies";

// The four table sizes the demo's catalog produces (src ROWS in flow.ts).
const ROWS = { small: 1_200_000, medium: 9_000_000, large: 48_000_000, huge: 120_000_000 };

function ranked(rows: number): { strategy: Strategy; score: number }[] {
  return STRATEGIES.map((strategy) => ({ strategy, score: reward(project(rows, strategy)) })).sort(
    (a, b) => b.score - a.score,
  );
}

describe("strategy cost model", () => {
  it("the best strategy depends on table size", () => {
    expect(ranked(ROWS.small)[0]?.strategy).toBe("direct-ddl");
    expect(ranked(ROWS.medium)[0]?.strategy).toBe("online-ddl");
    expect(ranked(ROWS.large)[0]?.strategy).toBe("online-ddl");
    expect(ranked(ROWS.huge)[0]?.strategy).toBe("chunked");
  });

  it("every winner wins by a visible margin", () => {
    for (const rows of Object.values(ROWS)) {
      const [first, second] = ranked(rows);
      expect(first!.score - second!.score).toBeGreaterThanOrEqual(0.025);
    }
  });

  it("pins the scores the demo script prints", () => {
    expect(reward(project(ROWS.large, "direct-ddl"))).toBeCloseTo(0.41, 3);
    expect(reward(project(ROWS.large, "online-ddl"))).toBeCloseTo(0.756, 3);
    expect(reward(project(ROWS.large, "chunked"))).toBeCloseTo(0.7, 3);
  });

  it("chunked never locks; direct-ddl is never reversible; rewards stay in [0,1]", () => {
    for (const rows of Object.values(ROWS)) {
      expect(project(rows, "chunked").lockSeconds).toBe(0);
      expect(project(rows, "direct-ddl").reversible).toBe(false);
      for (const s of STRATEGIES) {
        const r = reward(project(rows, s));
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run test/strategies.test.ts`
Expected: FAIL — `Cannot find module '../src/strategies'`.

- [ ] **Step 4: Implement the cost model**

Create `src/strategies.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run test/strategies.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/strategies.ts test/strategies.test.ts
git commit -m "feat(demo): strategy cost model — the one concept claims 2 and 3 share

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The policy module (propensity, candidates, blind toggle)

**Files:**
- Create: `src/policy.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Consumes: `STRATEGIES`, `Strategy` from Task 1; `decideWithPolicy`, `Policy`, `PolicyContext` from `@loom/learning`; `WorkflowContext` from `@loom/workflow-runtime`.
- Produces: `type StrategyContext = { change: string; rows: number; risk: string }`; `loggingPolicy: Policy<Strategy> & { propensityOf(a: Strategy): number }`; `sizeAware: Policy<Strategy>`; `backwards: Policy<Strategy>`; `chooseStrategy(ctx, context): Promise<StrategyChoice>` where `interface StrategyChoice { strategy: Strategy; policy?: { id: string; version: string; propensity: number } }`; `setBlind(on: boolean)`, `isBlind()`, `resetPolicySeed()`.

- [ ] **Step 1: Write the failing test**

Create `test/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backwards, loggingPolicy, resetPolicySeed, sizeAware } from "../src/policy";
import { STRATEGIES } from "../src/strategies";

const ctx = { change: "add-index", rows: 48_000_000, risk: "high" };

describe("the logging policy (naive-eps v1)", () => {
  it("reports the exact probability it chose with", () => {
    expect(loggingPolicy.propensityOf("direct-ddl")).toBeCloseTo(0.8, 6);
    expect(loggingPolicy.propensityOf("online-ddl")).toBeCloseTo(0.1, 6);
    expect(loggingPolicy.propensityOf("chunked")).toBeCloseTo(0.1, 6);
    const sum = STRATEGIES.reduce((s, a) => s + loggingPolicy.propensityOf(a), 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("stamps each choice with that propensity", () => {
    resetPolicySeed();
    for (let i = 0; i < 20; i++) {
      const c = loggingPolicy.select(ctx, STRATEGIES);
      expect(c.propensity).toBeCloseTo(loggingPolicy.propensityOf(c.action), 6);
    }
  });

  it("is a seeded stage prop — the same sequence after a reset", () => {
    resetPolicySeed();
    const a = Array.from({ length: 30 }, () => loggingPolicy.select(ctx, STRATEGIES).action);
    resetPolicySeed();
    const b = Array.from({ length: 30 }, () => loggingPolicy.select(ctx, STRATEGIES).action);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(1); // it does explore
  });
});

describe("the candidates", () => {
  it("size-aware picks by table size, with propensity 1", () => {
    expect(sizeAware.select({ rows: 1_200_000 }, STRATEGIES)).toEqual({ action: "direct-ddl", propensity: 1 });
    expect(sizeAware.select({ rows: 48_000_000 }, STRATEGIES)).toEqual({ action: "online-ddl", propensity: 1 });
    expect(sizeAware.select({ rows: 120_000_000 }, STRATEGIES)).toEqual({ action: "chunked", propensity: 1 });
  });

  it("backwards is exactly the wrong way round", () => {
    expect(backwards.select({ rows: 1_200_000 }, STRATEGIES).action).toBe("chunked");
    expect(backwards.select({ rows: 120_000_000 }, STRATEGIES).action).toBe("direct-ddl");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/policy.test.ts`
Expected: FAIL — `Cannot find module '../src/policy'`.

- [ ] **Step 3: Implement the policy module**

Create `src/policy.ts`:

```ts
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
const EPSILON = 0.3;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/policy.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm build`
Expected: no errors.

```bash
git add src/policy.ts test/policy.test.ts
git commit -m "feat(demo): a logging policy that records its propensity, and two candidates to score

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Thread the strategy through the flow

**Files:**
- Modify: `app/flows/migration-guard/flow.ts` (whole file below)
- Modify: `app/flows/migration-guard/flow.stub.txt` (schemas + apply step + ApprovalDecision)
- Modify: `src/trace.ts`, `src/main.ts`, `src/pitch-resume.ts`
- Test: `test/migration-guard.test.ts` (whole file below)

**Interfaces:**
- Consumes: Task 1 (`project`, `reward`, `STRATEGIES`), Task 2 (`chooseStrategy`).
- Produces: `MigrationResult` type exported from flow.ts: `{ applied: boolean; simulated: boolean; risk: "low"|"medium"|"high"; approvedBy?: string; strategy?: Strategy; projected?: Projection }`. Approval payload `{ approved, approvedBy, strategy?, simulate? }`. UI surface keys: `phase` (now incl. `"simulated"`), `table`, `assessment`, `apply: { strategy, policy?, applied, lockSeconds, durationMinutes, reversible }`. `quietTrace(on: boolean)` in `src/trace.ts`.

- [ ] **Step 1: Write the failing tests**

Replace `test/migration-guard.test.ts` with:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { buildApp, type LoomApp } from "../src/config";
import { resetPolicySeed } from "../src/policy";
import { STRATEGIES, project } from "../src/strategies";
import { resetTrace } from "../src/trace";

// Force the deterministic offline provider (src/llm.ts falls back to it when no key
// is present) so these tests never depend on the network or an API key.
beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  (globalThis as { __GEMINI_API_KEY__?: string }).__GEMINI_API_KEY__ = "";
  resetPolicySeed();
  resetTrace();
});

interface UiSurface {
  phase?: string;
  table?: { name: string; rows: number; sizeGb: number; estLockSeconds: number };
  assessment?: { risk: string; rationale: string };
  apply?: { strategy: string; policy?: { id: string; propensity: number }; applied: boolean; lockSeconds: number };
}

function surface(app: LoomApp, executionId: string): UiSurface {
  return app.projectionRuntime.getState("ui", executionId) as UiSurface;
}

async function decisionEvents(app: LoomApp, executionId: string) {
  const events = await app.stores.eventStore.read(executionId);
  return events.filter((e) => e.eventType === "DECISION_RECORDED");
}

describe("Schema Migration Guard flow", () => {
  it("pauses a risky migration for a human; on approval a policy picks HOW and records its propensity", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-high";

    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" }, // 48M rows, ~95s lock → high risk
      { executionId: id },
    );

    await handle.waitForSuspend();
    const atGate = surface(app, id);
    expect(atGate.phase).toBe("awaiting-approval");
    expect(atGate.assessment?.risk).toBe("high");
    expect(atGate.table).toMatchObject({ name: "orders", rows: 48_000_000, estLockSeconds: 95 });

    // The DBA approves but does not say how — the policy decides.
    const resumed = await app.runtime.resume(id, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "dba@demo" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.status).toBe("completed");
    const out = done.variables._output as { applied: boolean; simulated: boolean; strategy: string; approvedBy: string };
    expect(out).toMatchObject({ applied: true, simulated: false, risk: "high", approvedBy: "dba@demo" });
    expect(STRATEGIES).toContain(out.strategy);
    expect(surface(app, id).phase).toBe("applied");
    expect(surface(app, id).apply?.policy).toMatchObject({ id: "naive-eps" });

    // The decision carries what the policy SAW and how likely it was to choose this.
    const [decision] = await decisionEvents(app, id);
    expect(decision?.payload).toMatchObject({
      decisionId: "strategy",
      choice: out.strategy,
      context: { change: "add-index", rows: 48_000_000, risk: "high" },
      alternatives: [...STRATEGIES],
    });
    const stamp = (decision?.payload as { policy: { id: string; propensity: number } }).policy;
    expect(stamp.id).toBe("naive-eps");
    expect(stamp.propensity).toBeGreaterThan(0);
    expect(stamp.propensity).toBeLessThanOrEqual(1);

    await app.close();
  });

  it("when the DBA names the strategy there is no policy decision, and the projection matches the model", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-named";
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" },
      { executionId: id },
    );
    await handle.waitForSuspend();

    const resumed = await app.runtime.resume(id, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "ada@example.com", strategy: "online-ddl" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.variables._output).toMatchObject({
      applied: true,
      strategy: "online-ddl",
      projected: project(48_000_000, "online-ddl"),
    });
    expect(await decisionEvents(app, id)).toHaveLength(0);
    expect(surface(app, id).apply?.policy).toBeUndefined();

    await app.close();
  });

  it("simulate: true dry-runs the strategy — nothing is applied, the phase is 'simulated'", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-sim";
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" },
      { executionId: id },
    );
    await handle.waitForSuspend();
    const resumed = await app.runtime.resume(id, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "explorer", strategy: "chunked", simulate: true },
    });
    const done = await resumed.waitForCompletion();
    expect(done.variables._output).toMatchObject({ applied: false, simulated: true, strategy: "chunked" });
    expect(surface(app, id).phase).toBe("simulated");
    await app.close();
  });

  it("refuses a malformed approval before it reaches the log", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-malformed";
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" },
      { executionId: id },
    );
    await handle.waitForSuspend();
    await expect(
      app.runtime.resume(id, {
        eventType: "ApprovalGranted",
        payload: { approved: true, approvedBy: "x", strategy: "yolo" },
      }),
    ).rejects.toThrow();
    await app.close();
  });

  it("does not apply when the human rejects", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-reject";

    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "drop-column" }, // risky → gate
      { executionId: id },
    );
    await handle.waitForSuspend();
    expect(surface(app, id).phase).toBe("awaiting-approval");

    const resumed = await app.runtime.resume(id, {
      eventType: "ApprovalGranted",
      payload: { approved: false, approvedBy: "dba@demo" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.variables._output).toMatchObject({ applied: false, simulated: false, approvedBy: "dba@demo" });
    expect(surface(app, id).phase).toBe("rejected");

    await app.close();
  });

  it("applies a low-risk migration without a gate — the policy still picks how", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-low";
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "users", change: "add-nullable-column" }, // metadata-only → low
      { executionId: id },
    );
    const done = await handle.waitForCompletion();
    expect(done.variables._output).toMatchObject({ applied: true, risk: "low" });
    expect(surface(app, id).phase).toBe("applied");
    expect(await decisionEvents(app, id)).toHaveLength(1);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/migration-guard.test.ts`
Expected: FAIL — several cases (no `strategy` in output, `apply` surface key missing, malformed approval accepted).

- [ ] **Step 3: Add `quietTrace` to the stage prop**

Replace `src/trace.ts` with:

```ts
/**
 * A stage prop, not a framework feature.
 *
 * Each step handler calls `didRun()` when it *actually executes*. Because a
 * replayed effect is served from the event log and its handler is never invoked,
 * these lines only appear for real work. That makes memoization visible: run the
 * flow to the approval gate in one process, kill it, resume in a *fresh* process,
 * and `inspect` / `assess` print nothing the second time — they were not re-run.
 *
 * Counting them is the whole proof. Nothing here is imported by the kernel.
 */
let executed: string[] = [];
let quiet = false;

export function didRun(label: string): void {
  executed.push(label);
  if (!quiet) console.log(`   ⚡ EXECUTED  ${label}   ← real work: time and money spent`);
}

export function executedLabels(): readonly string[] {
  return executed;
}

export function resetTrace(): void {
  executed = [];
}

/** Keep counting, stop printing — a 48-migration batch would otherwise print 150 lines. */
export function quietTrace(on: boolean): void {
  quiet = on;
}
```

- [ ] **Step 4: Rewrite the flow**

Replace `app/flows/migration-guard/flow.ts` with:

```ts
import { recordOutcome } from "@loom/analytics";
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { llm } from "../../../src/llm"; // export const llm — any LlmProvider works (Gemini here)
import { chooseStrategy } from "../../../src/policy"; // the strategy policy: records its propensity
import { STRATEGIES, type Projection, type Strategy, project, reward } from "../../../src/strategies";
import { didRun } from "../../../src/trace"; // stage prop: prints only when a handler REALLY runs

// ── Schemas ───────────────────────────────────────────────────────────────────
const MigrationInput = z.object({
  table: z.string(),
  change: z.enum(["add-nullable-column", "add-index", "drop-column", "backfill"]),
});
const ProjectionSchema = z.object({
  lockSeconds: z.number(),
  durationMinutes: z.number(),
  reversible: z.boolean(),
});
const MigrationOutput = z.object({
  applied: z.boolean(),
  simulated: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  approvedBy: z.string().optional(),
  strategy: z.enum(STRATEGIES).optional(),
  projected: ProjectionSchema.optional(),
});
type In = z.infer<typeof MigrationInput>;
type Out = z.infer<typeof MigrationOutput>;
export type MigrationResult = Out;

// A tiny simulated catalog so the demo needs no real database — the interesting
// part is the reasoning + the human gate, not the metrics source.
const ROWS = {
  "add-nullable-column": 1_200_000,
  "add-index": 48_000_000,
  "drop-column": 9_000_000,
  backfill: 120_000_000,
} as const;

// ── Steps (co-located handlers → auto-registered as effects) ──────────────────

// 1) TOOL: inspect the cloud DB table — the kind of read a real MCP/DB tool does.
const inspectStep = step$({
  id: "inspect",
  name: "Inspect table",
  inputSchema: MigrationInput,
  outputSchema: z.object({ rows: z.number(), sizeGb: z.number(), estLockSeconds: z.number() }),
  handler: handler$(async (input: In) => {
    didRun("inspect  (table scan)");
    const rows = ROWS[input.change];
    return {
      rows,
      sizeGb: Number((rows / 5e6).toFixed(1)),
      estLockSeconds: input.change === "add-index" ? 95 : 3,
    };
  }),
});

// 2) REASONING: a real Gemini call rates lock/downtime risk and returns strict JSON.
const assessStep = step$({
  id: "assess",
  name: "Assess risk (Gemini)",
  inputSchema: z.object({
    table: z.string(),
    change: z.string(),
    rows: z.number(),
    estLockSeconds: z.number(),
  }),
  outputSchema: z.object({ risk: z.enum(["low", "medium", "high"]), rationale: z.string() }),
  handler: handler$(
    async (i: { table: string; change: string; rows: number; estLockSeconds: number }) => {
      didRun("assess   (LLM call)");
      const res = await llm.complete({
        system:
          "You are a database migration safety reviewer. Reply ONLY with JSON " +
          '{"risk":"low|medium|high","rationale":"<one sentence>"}. ' +
          "High risk = long table locks or downtime on a large table.",
        messages: [
          {
            role: "user",
            content:
              `Table ${i.table}, ${i.rows} rows. Change: ${i.change}. ` +
              `Estimated lock ${i.estLockSeconds}s. Rate the risk.`,
          },
        ],
        maxTokens: 200,
        temperature: 0,
      });
      return JSON.parse(res.content) as { risk: "low" | "medium" | "high"; rationale: string };
    },
  ),
});

// 3) EFFECT: apply the migration one WAY (simulated). `simulate` = dry-run against a
//    shadow schema: same projection, nothing written — what a forked branch runs.
const applyStep = step$({
  id: "apply",
  name: "Apply migration",
  inputSchema: z.object({
    table: z.string(),
    rows: z.number(),
    strategy: z.enum(STRATEGIES),
    simulate: z.boolean(),
  }),
  outputSchema: z.object({ applied: z.boolean() }).merge(ProjectionSchema),
  handler: handler$(async (i: { table: string; rows: number; strategy: Strategy; simulate: boolean }) => {
    didRun(i.simulate ? `apply    (SIMULATED · ${i.strategy})` : `apply    (writes to prod · ${i.strategy})`);
    return { applied: !i.simulate, ...project(i.rows, i.strategy) };
  }),
});

// ── Runner: plain async orchestration — this IS the agent, and it drives the UI ──
// The approval gate's resume contract. Declared once: listed in `resumeSchemas` so the runtime
// parses a resume BEFORE appending it (loom ADR 0077) — a wrongly-shaped approval is refused
// rather than becoming a permanent fold input — and inferred back into the type the runner sees.
// The DBA may also say HOW (`strategy`) and whether to only dry-run it (`simulate`).
const ApprovalDecision = z.object({
  approved: z.boolean(),
  approvedBy: z.string(),
  strategy: z.enum(STRATEGIES).optional(),
  simulate: z.boolean().optional(),
});
type ApprovalDecision = z.infer<typeof ApprovalDecision>;

const runner: FlowRunner<In, Out> = async (ctx, input) => {
  ctx.ui.set("phase", "inspecting");
  const stats = await ctx.run(inspectStep, input);
  ctx.ui.merge("table", { name: input.table, ...stats });

  ctx.ui.set("phase", "assessing");
  const verdict = await ctx.run(assessStep, {
    table: input.table,
    change: input.change,
    rows: stats.rows,
    estLockSeconds: stats.estLockSeconds,
  });
  ctx.ui.merge("assessment", verdict);

  // Low-risk migrations ship straight through; everything else waits for a human.
  let decision: ApprovalDecision | undefined;
  if (verdict.risk !== "low") {
    // Durable human gate — persists to the log and hands control back until resumed.
    ctx.ui.set("phase", "awaiting-approval");
    decision = await ctx.suspend<ApprovalDecision>({
      on: "ApprovalGranted",
      correlationKey: input.table,
    });
    if (!decision.approved) {
      ctx.ui.set("phase", "rejected");
      return { applied: false, simulated: false, risk: verdict.risk, approvedBy: decision.approvedBy };
    }
  }

  // HOW to apply it: the DBA may say. Otherwise a policy decides — recorded with the
  // context it saw and the probability it chose with, so a different policy can be
  // scored against this log later without re-running anything.
  const choice =
    decision?.strategy !== undefined
      ? { strategy: decision.strategy }
      : await chooseStrategy(ctx, { change: input.change, rows: stats.rows, risk: verdict.risk });

  ctx.ui.set("phase", "applying");
  const result = await ctx.run(applyStep, {
    table: input.table,
    rows: stats.rows,
    strategy: choice.strategy,
    simulate: decision?.simulate ?? false,
  });
  ctx.ui.merge("apply", { ...choice, ...result });

  // How it turned out — named after the decision when a policy made it, so credit lands there.
  recordOutcome(ctx, {
    key: choice.strategy,
    score: reward(result),
    ...(choice.policy !== undefined && { decisionId: "strategy" }),
  });

  const { applied, ...projected } = result;
  ctx.ui.set("phase", applied ? "applied" : "simulated");
  return {
    applied,
    simulated: !applied,
    risk: verdict.risk,
    ...(decision !== undefined && { approvedBy: decision.approvedBy }),
    strategy: choice.strategy,
    projected: projected satisfies Projection,
  };
};

// Exported as a bare `RegisteredFlow` — the runtime treats every flow uniformly.
export const migrationGuardFlow = {
  definition: flow$({
    id: "migration-guard",
    name: "Schema Migration Guard",
    version: "1.1.0",
    inputSchema: MigrationInput,
    outputSchema: MigrationOutput,
    steps: [inspectStep, assessStep, applyStep],
    resumeSchemas: { ApprovalGranted: ApprovalDecision },
  }),
  runner,
} as RegisteredFlow;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/migration-guard.test.ts`
Expected: 6 passed. If `choice.policy` errors because `{ strategy: decision.strategy }` has no `policy` key, annotate: `const choice: StrategyChoice = …` importing `type StrategyChoice` from `../../../src/policy`.

- [ ] **Step 6: Keep the crash act policy-free**

In `src/main.ts` and `src/pitch-resume.ts`, change the resume payload to:

```ts
    payload: { approved: true, approvedBy: "ada@example.com", strategy: "direct-ddl" },
```

In `src/pitch-resume.ts`, after `console.log(\`\n🎉 ${done.status} —\`, done.variables._output);` nothing else changes — the printed object now includes `strategy: 'direct-ddl'` and `projected`.

- [ ] **Step 7: Sync the live-code stub**

In `app/flows/migration-guard/flow.stub.txt`: replace the import block, `MigrationOutput`, the apply step and `ApprovalDecision` with the versions from Step 4 (copy them verbatim), keep the `runner` throwing, and update the stub's live-code comment to:

```ts
// ⌨️  LIVE-CODE THIS in Act 2. The four beats:
//   1. inspect → ctx.ui.merge the table stats
//   2. assess (real Gemini) → ctx.ui.merge the verdict
//   3. risky? ctx.ui.set("phase","awaiting-approval") +
//      `decision = await ctx.suspend<ApprovalDecision>({ on: "ApprovalGranted", correlationKey: input.table })`
//      (rejected → return). The gate's contract is declared in `resumeSchemas` below.
//   4. strategy = decision?.strategy ?? await chooseStrategy(ctx, {…}) → ctx.run(applyStep) →
//      recordOutcome. A human's pick is not a policy decision; only a policy's gets a decisionId.
```

Verify the stub still typechecks in place:

```bash
cp app/flows/migration-guard/flow.ts /tmp/flow.bak && pnpm demo:stub && pnpm build; pnpm demo:restore && pnpm build
```
Expected: both `pnpm build` runs are clean (an unused-import warning is fine; `noUnusedLocals` is off).

- [ ] **Step 8: Run everything, then commit**

Run: `pnpm test && pnpm build`
Expected: strategies 4 + policy 5 + migration-guard 6 = 15 passed; build clean.

Run: `pnpm pitch:reset && pnpm crash; echo "exit=$?"; pnpm resume`
Expected: crash prints two ⚡ lines then exit=137; resume prints exactly one `⚡ EXECUTED  apply    (writes to prod · direct-ddl)` and `🎉 completed — { applied: true, simulated: false, risk: 'high', approvedBy: 'ada@example.com', strategy: 'direct-ddl', projected: { lockSeconds: 48, durationMinutes: 24, reversible: false } }`. Then `pnpm exec loom logs --db .data/events.db $(cat .data/last-execution.txt)` shows NO `DECISION_RECORDED` line.

```bash
git add app/flows/migration-guard src/trace.ts src/main.ts src/pitch-resume.ts test/migration-guard.test.ts
git commit -m "feat(demo): the approval says HOW — strategy + simulate on the gate, a policy when it doesn't

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: In-memory storage with a branch registry (loom subpath + demo helper)

**Files:**
- Modify (loom repo, branch `demo/fork-and-propensity`): `../loom/packages/event-runtime/memory.js`, `../loom/packages/event-runtime/memory.d.ts`
- Create: `src/memory-storage.ts`

**Interfaces:**
- Produces: `memoryStorage(): StorageOpt` — a `{ kind: "custom", eventStore, snapshotStore, branchRegistry }` with in-memory stores.

- [ ] **Step 1: Branch the loom repo and extend the browser-safe subpath**

```bash
cd ../loom && git checkout -b demo/fork-and-propensity
```

Replace `../loom/packages/event-runtime/memory.js` with:

```js
// Browser-safe subpath: only the in-memory stores, so importing it never pulls
// the SQLite store (better-sqlite3 / node:fs) that the package barrel re-exports.
// (These packages compile to CommonJS, which bundlers cannot tree-shake — hence a
// dedicated subpath rather than relying on `sideEffects`.)
// The in-memory branch registry is node-free too; a browser that forks needs it.
module.exports = {
  ...require("./dist/InMemoryAsyncEventStore"),
  ...require("./dist/InMemoryBranchRegistry"),
};
```

Replace `../loom/packages/event-runtime/memory.d.ts` with:

```ts
export * from "./dist/InMemoryAsyncEventStore";
export * from "./dist/InMemoryBranchRegistry";
```

Verify from the demo:

```bash
cd ../loom-demo && node -e 'console.log(Object.keys(require("@loom/event-runtime/memory")))'
```
Expected: includes `InMemoryAsyncEventStore` and `InMemoryBranchRegistry`.

Commit in loom (no Co-Authored-By rule there; keep loom's own conventions):

```bash
cd ../loom && git add packages/event-runtime/memory.js packages/event-runtime/memory.d.ts
git commit -m "feat(event-runtime): export InMemoryBranchRegistry from the browser-safe memory subpath

A browser that forks needs a branch registry; the in-memory one is node-free but was
reachable only through the barrel, which drags the SQLite store into the bundle."
cd ../loom-demo
```

- [ ] **Step 2: The demo helper**

Create `src/memory-storage.ts`:

```ts
import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime/memory";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime/memory";
import type { StorageOpt } from "./config";

/**
 * In-memory storage WITH a branch registry. `{ kind: "memory" }` wires only the event
 * and snapshot stores, and `fork()` needs somewhere to record lineage and refs. Used by
 * the browser (src/browser/main.tsx) and the tests; the terminal uses sqliteStorage().
 */
export function memoryStorage(): StorageOpt {
  return {
    kind: "custom",
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    branchRegistry: new InMemoryBranchRegistry(),
  };
}
```

Run: `pnpm build`
Expected: clean. If `StorageOpt`'s custom variant rejects `branchRegistry`, check `CustomStorage` in `../loom/packages/app/src/defineConfig.ts` (it accepts `branchRegistry?`) and fix the import, not the shape.

- [ ] **Step 3: Commit**

```bash
git add src/memory-storage.ts
git commit -m "feat(demo): in-memory storage that can fork (branch registry included)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `src/fork.ts` — fork, simulate, compare, promote

**Files:**
- Create: `src/fork.ts`
- Test: `test/fork.test.ts`

**Interfaces:**
- Consumes: `memoryStorage` (Task 4), `MigrationResult` (Task 3), `reward`/`STRATEGIES` (Task 1), `executedLabels`/`resetTrace` (trace).
- Produces:
  - `interface BranchOutcome { strategy: Strategy; branchName: string; executionId: string; projection: Projection }`
  - `findGate(app: LoomApp, executionId: string): Promise<number>`
  - `headOf(app, executionId): Promise<{ sequence: number; status: string }>`
  - `exploreStrategies(app, parentId, gateSeq, onBranch?: (b: { strategy: Strategy; executionId: string }) => void): Promise<BranchOutcome[]>`
  - `pickWinner(outcomes: readonly BranchOutcome[]): BranchOutcome`
  - `promoteAndApply(app, parentId, gateSeq, winner: Strategy): Promise<{ executionId: string; output: MigrationResult }>`
  - `refs(app): Promise<BranchRef[]>`, `branchCount(app, parentId): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `test/fork.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { buildApp } from "../src/config";
import {
  branchCount,
  exploreStrategies,
  findGate,
  headOf,
  pickWinner,
  promoteAndApply,
  refs,
} from "../src/fork";
import { memoryStorage } from "../src/memory-storage";
import { STRATEGIES } from "../src/strategies";
import { executedLabels, resetTrace } from "../src/trace";

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  (globalThis as { __GEMINI_API_KEY__?: string }).__GEMINI_API_KEY__ = "";
  resetTrace();
});

describe("fork → simulate → compare → promote", () => {
  it("forks the gate three ways, re-runs nothing above it, leaves the parent untouched, promotes one", async () => {
    const app = buildApp({ storage: memoryStorage() });
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" }, // 48M rows → gate
      { executionId: "parent" },
    );
    await handle.waitForSuspend();
    const gate = await findGate(app, "parent");
    const before = await headOf(app, "parent");
    expect(before.status).toBe("suspended");
    const boltsBefore = executedLabels().length; // inspect + assess
    expect(boltsBefore).toBe(2);

    const seen: string[] = [];
    const outcomes = await exploreStrategies(app, "parent", gate, (b) => seen.push(b.strategy));

    // Three branches, in STRATEGIES order, each with a projection.
    expect(outcomes.map((o) => o.strategy)).toEqual([...STRATEGIES]);
    expect(new Set(seen)).toEqual(new Set(STRATEGIES));
    expect(new Set(outcomes.map((o) => o.executionId)).size).toBe(3);

    // The proof: three SIMULATED applies and nothing else. inspect/assess were served from the log.
    const ran = executedLabels().slice(boltsBefore);
    expect(ran).toHaveLength(3);
    expect(ran.every((l) => l.includes("SIMULATED"))).toBe(true);

    // The parent is exactly where it was: same head, still parked.
    expect(await headOf(app, "parent")).toEqual(before);

    // One scoring rule, shared with the learning demo: online-ddl wins at 48M rows.
    const winner = pickWinner(outcomes);
    expect(winner.strategy).toBe("online-ddl");

    const commit = await promoteAndApply(app, "parent", gate, winner.strategy);
    expect(commit.output).toMatchObject({ applied: true, simulated: false, strategy: "online-ddl" });
    expect(executedLabels().at(-1)).toContain("writes to prod · online-ddl");

    const main = (await refs(app)).find((r) => r.name === "main");
    expect(main?.executionId).toBe(commit.executionId);
    expect(await branchCount(app, "parent")).toBe(4); // 3 spec + 1 commit
    expect((await headOf(app, "parent")).status).toBe("suspended"); // losers and parent stay resumable

    await app.close();
  });

  it("refuses to fork an execution that never reached the gate", async () => {
    const app = buildApp({ storage: memoryStorage() });
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "users", change: "add-nullable-column" }, // low risk → no gate
      { executionId: "nogate" },
    );
    await handle.waitForCompletion();
    await expect(findGate(app, "nogate")).rejects.toThrow(/never reached the approval gate/);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/fork.test.ts`
Expected: FAIL — `Cannot find module '../src/fork'`.

- [ ] **Step 3: Implement `src/fork.ts`**

```ts
import type { BranchRef, BranchRegistry } from "@loom/event-runtime";
import { type MigrationResult, migrationGuardFlow } from "../app/flows/migration-guard/flow";
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

// Referenced so the flow module is loaded wherever fork.ts is (the runtime resolves flows
// from the static registry in app/loom.gen.ts; this keeps the import graph honest).
void migrationGuardFlow;
```

If `void migrationGuardFlow;` reads as noise, delete it and the import — it is not required.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/fork.test.ts`
Expected: 2 passed. If `app.stores.eventStore.read` returns a readonly array and `.reverse()` complains, the spread `[...events]` already copies — check the import of `EventEnvelope` is not needed.

- [ ] **Step 5: Commit**

```bash
pnpm build && git add src/fork.ts test/fork.test.ts
git commit -m "feat(demo): fork the gate — simulate every strategy, promote one, merge nothing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `pnpm fork` — the terminal act

**Files:**
- Create: `src/pitch-fork.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: everything in `src/fork.ts`, `waitForGate` from `src/gate.ts`, `reward`, `executedLabels`.

- [ ] **Step 1: Add the script**

In `package.json` scripts, after `"resume"`:

```json
    "fork": "tsx src/pitch-fork.ts",
```

- [ ] **Step 2: Write the act**

Create `src/pitch-fork.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { buildApp, type LoomApp } from "./config";
import { branchCount, exploreStrategies, findGate, headOf, pickWinner, promoteAndApply, refs } from "./fork";
import { waitForGate } from "./gate";
import { reward } from "./strategies";
import { executedLabels } from "./trace";

/**
 * ACT 4b — "fork the gate it was parked at."
 *
 * The migration from `pnpm crash` / `pnpm resume` stopped at a human gate. At that gate
 * there were three ways to apply it. Go back to that exact point in the log, fork it three
 * ways, dry-run each on real state, compare, and promote a winner — without touching what
 * already happened. Because a branch is a shared log prefix, none of the work above the
 * gate is repeated: three branches cost three applies and zero model calls.
 */
async function main(): Promise<void> {
  const app = buildApp({ storage: sqliteStorage({ dir: ".data" }) });
  const parent = await parentExecution(app);
  const gate = await findGate(app, parent);
  const before = await headOf(app, parent);
  console.log(`   gate: event #${gate}   ·   parent head: #${before.sequence} (${before.status})\n`);

  console.log("🔮 PREDICTION: 3 branches → 3 lightning bolts, all SIMULATED applies.");
  console.log("   inspect and assess must NOT re-run. Zero model calls.\n");
  const boltsBefore = executedLabels().length;
  const outcomes = await exploreStrategies(app, parent, gate);
  const ran = executedLabels().slice(boltsBefore);
  const modelCalls = ran.filter((l) => l.includes("LLM")).length;
  console.log(`\n   steps that really executed for 3 branches: ${ran.length}   model calls: ${modelCalls}\n`);

  console.log("   strategy       lock     duration   reversible   score    branch");
  for (const o of outcomes) {
    const p = o.projection;
    console.log(
      `   ${o.strategy.padEnd(12)} ${`${p.lockSeconds}s`.padStart(6)}   ${`${p.durationMinutes}m`.padStart(7)}     ${p.reversible ? "yes" : "no "}        ${reward(p).toFixed(3)}    ${o.branchName} → ${o.executionId}`,
    );
  }

  const after = await headOf(app, parent);
  const untouched = after.sequence === before.sequence && after.status === before.status;
  console.log(`\n   parent ${parent}: head #${after.sequence} (${after.status}) — ${untouched ? "UNTOUCHED" : "CHANGED ?!"}`);

  const winner = pickWinner(outcomes);
  console.log(`\n🏆 promote ${winner.strategy}: fork a commit branch from the same gate, apply it FOR REAL, move main.\n`);
  const commit = await promoteAndApply(app, parent, gate, winner.strategy);
  console.log(`\n   ${commit.output.applied ? "applied" : "NOT applied"} —`, commit.output);

  console.log("\n   refs:");
  for (const r of await refs(app)) {
    const note = r.name === "main" ? "   ← the pointer move IS the promotion" : "";
    console.log(`     ${r.name.padEnd(18)} → ${r.executionId}  @${r.tip}${note}`);
  }
  console.log(`\n   lineage: ${await branchCount(app, parent)} branches forked from ${parent}.`);
  console.log("   The losers stay immutable and independently resumable. There is no merge —");
  console.log("   two divergent histories have no sound join, so loom refuses to fake one.\n");
  console.log(`Inspect a branch:  pnpm exec loom logs --db .data/events.db ${outcomes[0]?.executionId ?? ""}`);

  await app.close();
}

/** The execution the room just watched — or, if there is none, a fresh one run to its gate. */
async function parentExecution(app: LoomApp): Promise<string> {
  if (existsSync(".data/last-execution.txt")) {
    const id = readFileSync(".data/last-execution.txt", "utf8").trim();
    console.log(`▶  forking the execution from pnpm crash / pnpm resume: ${id}`);
    return id;
  }
  console.log("▶  no previous execution — running a fresh migration to its gate (orders / add-index)\n");
  const handle = await app.runtime.start(migrationGuardFlow, { table: "orders", change: "add-index" });
  await waitForGate(handle);
  return handle.executionId;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run it both ways and record the output**

Run: `pnpm pitch:reset && pnpm crash; pnpm resume && pnpm fork`
Expected (fork part):
```
▶  forking the execution from pnpm crash / pnpm resume: <id>
   gate: event #10   ·   parent head: #<N> (completed)

🔮 PREDICTION: 3 branches → 3 lightning bolts, all SIMULATED applies.
   ⚡ EXECUTED  apply    (SIMULATED · direct-ddl)   ← real work: time and money spent
   ⚡ EXECUTED  apply    (SIMULATED · online-ddl)   ← …
   ⚡ EXECUTED  apply    (SIMULATED · chunked)   ← …

   steps that really executed for 3 branches: 3   model calls: 0

   strategy       lock     duration   reversible   score    branch
   direct-ddl       48s       24m     no         0.410    spec/direct-ddl → …
   online-ddl      4.4s      154m     yes        0.756    spec/online-ddl → …
   chunked           0s      444m     yes        0.700    spec/chunked → …

   parent <id>: head #<N> (completed) — UNTOUCHED

🏆 promote online-ddl: …
   ⚡ EXECUTED  apply    (writes to prod · online-ddl)   ← …
   applied — { applied: true, simulated: false, risk: 'high', approvedBy: 'operator', strategy: 'online-ddl', projected: {…} }

   refs:
     commit             → <commit id>  @<seq>
     main               → <commit id>  @<seq>   ← the pointer move IS the promotion
     spec/chunked       → …
     spec/direct-ddl    → …
     spec/online-ddl    → …

   lineage: 4 branches forked from <id>.
```
Then: `pnpm pitch:reset && pnpm fork` — Expected: starts with `▶  no previous execution — running a fresh migration…`, two ⚡ lines (inspect, assess), then the same shape with parent status `suspended`.

Paste the real output of the first run into the commit message body if it differs materially from the above, and fix the plan's Task 9 SEE block to match.

- [ ] **Step 4: Commit**

```bash
git add package.json src/pitch-fork.ts
git commit -m "feat(demo): pnpm fork — branch the gate three ways on real state, promote one

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `src/learn.ts` — serve a batch, mine the log, score candidates

**Files:**
- Create: `src/learn.ts`
- Test: `test/learn.test.ts`

**Interfaces:**
- Consumes: `resetPolicySeed`, `setBlind`, `sizeAware`, `backwards` (Task 2); `migrationGuardFlow`; `quietTrace`.
- Produces:
  - `BATCH_CHANGES`, `serveBatch(app, n, opts?: { blind?: boolean; prefix?: string; onProgress?: (done: number, total: number) => void }): Promise<string[]>`
  - `readLog(app, prefix?: string): Promise<EventEnvelope[]>`
  - `interface Coverage { executions; decisions; withContext; withPropensity; scoredDirectly; arms: { strategy: string; meanReward: number; n: number }[] }`, `coverage(events): Coverage`, `formatCoverage(c): string`
  - `evaluate(events, policy: Policy<Strategy>): EvalReport`, re-export `formatEvalReport`.

- [ ] **Step 1: Write the failing test**

Create `test/learn.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/config";
import { coverage, evaluate, readLog, serveBatch } from "../src/learn";
import { memoryStorage } from "../src/memory-storage";
import { backwards, sizeAware } from "../src/policy";
import { quietTrace } from "../src/trace";

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  (globalThis as { __GEMINI_API_KEY__?: string }).__GEMINI_API_KEY__ = "";
  quietTrace(true);
});

describe("decisions that carry their propensity", () => {
  it("a learnable batch records context + propensity and scores a candidate without running it", async () => {
    const app = buildApp({ storage: memoryStorage() });
    const ids = await serveBatch(app, 12, { prefix: "L-" });
    expect(ids).toHaveLength(12);

    const events = await readLog(app, "L-");
    const c = coverage(events);
    expect(c).toMatchObject({ executions: 12, decisions: 12, withContext: 12, withPropensity: 12, scoredDirectly: 12 });
    expect(c.arms.length).toBeGreaterThan(1); // it explored

    const r = evaluate(events, sizeAware);
    expect(r.estimator).toBe("snips");
    expect(r.evaluated).toBe(12);
    expect(r.estimatedValue).toBeDefined();
    await app.close();
  });

  it("the same batch logged blind teaches nothing", async () => {
    const app = buildApp({ storage: memoryStorage() });
    await serveBatch(app, 12, { blind: true, prefix: "B-" });
    const events = await readLog(app, "B-");
    const c = coverage(events);
    expect(c).toMatchObject({ executions: 12, decisions: 12, withContext: 0, withPropensity: 0, scoredDirectly: 0 });

    const r = evaluate(events, sizeAware);
    expect(r.evaluated).toBe(0);
    expect(r.estimator).toBe("agreement-only");
    expect(r.estimatedValue).toBeUndefined();
    await app.close();
  });

  it("the size-aware candidate beats the log; the backwards one loses to it", async () => {
    const app = buildApp({ storage: memoryStorage() });
    await serveBatch(app, 48, { prefix: "E-" });
    const events = await readLog(app, "E-");
    const good = evaluate(events, sizeAware);
    const bad = evaluate(events, backwards);
    expect(good.lift ?? 0).toBeGreaterThan(0);
    expect(bad.lift ?? 0).toBeLessThan(0);
    await app.close();
  });

  it("reads only its own prefix", async () => {
    const app = buildApp({ storage: memoryStorage() });
    await serveBatch(app, 4, { prefix: "one-" });
    await serveBatch(app, 4, { prefix: "two-" });
    expect(coverage(await readLog(app, "one-")).executions).toBe(4);
    expect(coverage(await readLog(app)).executions).toBe(8);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run test/learn.test.ts`
Expected: FAIL — `Cannot find module '../src/learn'`.

- [ ] **Step 3: Implement `src/learn.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/learn.test.ts`
Expected: 4 passed. If the third case fails on the sign of `lift`, print both reports (`formatEvalReport`) — the expected values are roughly logged ≈ 0.66, size-aware ≈ 0.85, backwards ≈ 0.61; a wrong sign means the cost model or `propensityOf` drifted from Task 1/2, not that the test is wrong.

- [ ] **Step 5: Commit**

```bash
pnpm build && git add src/learn.ts test/learn.test.ts
git commit -m "feat(demo): serve a batch, read the log as a dataset, score a candidate off it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `pnpm propensity` — the terminal act

**Files:**
- Create: `src/pitch-propensity.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the script**

In `package.json` scripts, after `"fork"`:

```json
    "propensity": "tsx src/pitch-propensity.ts",
```

- [ ] **Step 2: Write the act**

Create `src/pitch-propensity.ts`:

```ts
import { rmSync } from "node:fs";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { buildApp } from "./config";
import { coverage, evaluate, formatCoverage, formatEvalReport, readLog, serveBatch } from "./learn";
import { backwards, sizeAware } from "./policy";
import { quietTrace } from "./trace";

/**
 * ACT 4c — "what would a different choice have scored?"
 *
 * Everyone can replay what the model said. The claim here is narrower and checkable:
 * because each strategy decision was logged WITH the probability it was chosen with,
 * a policy that never ran can be scored against this log — and the same executions
 * logged without that number cannot be. You either wrote it down at the time or you didn't.
 */
const N = 48;
const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n");

async function main(): Promise<void> {
  // The decision under study is the STRATEGY, not the risk rating — use the offline reviewer.
  delete process.env.GEMINI_API_KEY;
  quietTrace(true);
  rmSync(".data/learn", { recursive: true, force: true });
  rmSync(".data/learn-blind", { recursive: true, force: true });

  console.log(`▶  serving ${N} migrations through the live policy — naive-eps v1: greedy direct-ddl, ε = 0.3`);
  console.log("   (offline reviewer, no Gemini; the flow, the gate and the log are the real ones)\n");
  const app = buildApp({ storage: sqliteStorage({ dir: ".data/learn" }) });
  await serveBatch(app, N, { prefix: "learn-" });
  const events = await readLog(app, "learn-");
  console.log(formatCoverage(coverage(events)));
  console.log("\n   Every decision carries the observation it was made on AND the probability the");
  console.log("   policy assigned to it. That second number cannot be reconstructed later.\n");

  console.log("🔮 PREDICTION: a size-aware policy scores HIGHER than what we ran — without running it.\n");
  console.log(indent(formatEvalReport(evaluate(events, sizeAware))));
  console.log("\n   Nothing re-ran. The candidate never chose anything. The estimate comes from the");
  console.log("   steps where it AGREES with the log, reweighted by 1/propensity (SNIPS).\n");

  console.log("🔮 PREDICTION: a backwards policy — chunk the small tables, lock the big ones — scores LOWER.\n");
  console.log(indent(formatEvalReport(evaluate(events, backwards))));

  console.log(`\n▶  the contrast: the same ${N} migrations, decided by a bare ctx.decide — no context, no propensity\n`);
  const blindApp = buildApp({ storage: sqliteStorage({ dir: ".data/learn-blind" }) });
  await serveBatch(blindApp, N, { blind: true, prefix: "blind-" });
  const blind = await readLog(blindApp, "blind-");
  console.log(formatCoverage(coverage(blind)));
  console.log("");
  console.log(indent(formatEvalReport(evaluate(blind, sizeAware))));
  console.log("\n   Same executions, same rewards, same dashboard. evaluated: 0.");
  console.log("   You either wrote the propensity down at the time, or you didn't.\n");
  console.log("Checkable:  pnpm exec loom learn report --db .data/learn/events.db");

  await app.close();
  await blindApp.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run it and check it against the CLI**

Run: `pnpm propensity`
Expected shape:
```
▶  serving 48 migrations through the live policy — naive-eps v1: …
   Learning report — 48 execution(s), 48 decision(s)
     with context      48 (100%)
     with propensity   48 (100%)
     scored directly   48 (100%)
   Arms (mean reward, best first)
     …
🔮 PREDICTION: a size-aware policy scores HIGHER …
   Policy size-aware@2 — off-policy evaluation
     steps evaluated     48
     agreement with log  …
     logged value        0.6xxx
     estimated value     0.8xxx (snips)
     lift                +0.1xxx
     effective samples   …
🔮 PREDICTION: a backwards policy … scores LOWER.
     lift                -0.0xxx
▶  the contrast …
     with context      0 (0%)
     with propensity   0 (0%)
     scored directly   0 (0%)
   Policy size-aware@2 — off-policy evaluation
     steps evaluated     0
     estimated value     — (agreement-only)
```
Then: `pnpm exec loom learn report --db .data/learn/events.db` — Expected: the same coverage numbers (48 / 48 / 48). And `pnpm exec loom learn report --db .data/learn-blind/events.db` shows the three "Blocking gaps" lines.

Run it twice in a row: the second run must not fail on duplicate ids (the dirs are wiped).

- [ ] **Step 4: Commit**

```bash
git add package.json src/pitch-propensity.ts
git commit -m "feat(demo): pnpm propensity — score a policy that never ran, then show the blind log can't

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The React surface — storage, tabs, banner, branch board, learning panel

**Files:**
- Modify: `src/browser/main.tsx`, `vite.config.ts`, `src/browser/App.tsx`
- Create: `src/browser/BranchBoard.tsx`, `src/browser/LearningPanel.tsx`

**Interfaces:**
- Consumes: `memoryStorage` (Task 4), `src/fork.ts` (Task 5), `src/learn.ts` (Task 7), `sizeAware`/`backwards` (Task 2), `reward`/`Strategy` (Task 1), `quietTrace`.
- Produces: `UiState` (exported from App.tsx) with `phase` incl. `"simulated"` and `apply?`; `BranchBoard({ app, parentId })`; `LearningPanel({ app })`.

- [ ] **Step 1: Storage and pre-bundling**

Replace the `buildApp` line in `src/browser/main.tsx`:

```tsx
import { LoomProvider } from "@loom/plugin-renderer-react";
import { createRoot } from "react-dom/client";
import { buildApp } from "../config";
import { memoryStorage } from "../memory-storage";
import { App } from "./App";

// The SAME composition root the headless driver (src/main.ts) uses — only the
// storage differs (in-memory in the browser, with a branch registry so the tab can
// fork). No flow code changes; we just wrap the runtime in <LoomProvider> and render
// its agent surface with React.
const app = buildApp({ storage: memoryStorage() });

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={app.runtime} projectionRuntime={app.projectionRuntime}>
    <App app={app} />
  </LoomProvider>,
);
```

In `vite.config.ts` `optimizeDeps.include`, add (alphabetical):

```ts
      "@loom/analytics",
      "@loom/learning",
```

- [ ] **Step 2: The branch board**

Create `src/browser/BranchBoard.tsx`:

```tsx
import type { BranchRef } from "@loom/event-runtime";
import { useProjection } from "@loom/plugin-renderer-react";
import React, { useEffect, useRef, useState } from "react";
import type { LoomApp } from "../config";
import { type BranchOutcome, branchCount, exploreStrategies, findGate, pickWinner, promoteAndApply, refs } from "../fork";
import { type Strategy, reward } from "../strategies";
import type { UiState } from "./App";

// ── Fork → simulate → compare → promote, as a board ───────────────────────────
// Each card subscribes to ITS OWN branch's surface — a branch is a full execution,
// so the phase stepper and the projection stream in per branch with the same
// projection hook the migration view already uses. Nothing here is UI-only state:
// executionIds come from fork(), refs from the registry, the winner from reward().

interface Card {
  strategy: Strategy;
  executionId: string;
  label: string;
}

export function BranchBoard({ app, parentId }: { app: LoomApp; parentId: string }) {
  const started = useRef(false);
  const [gate, setGate] = useState<number | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [outcomes, setOutcomes] = useState<BranchOutcome[] | null>(null);
  const [commit, setCommit] = useState<Card | null>(null);
  const [refList, setRefList] = useState<BranchRef[]>([]);
  const [lineage, setLineage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const g = await findGate(app, parentId);
      setGate(g);
      const out = await exploreStrategies(app, parentId, g, (b) =>
        setCards((c) => [...c, { strategy: b.strategy, executionId: b.executionId, label: `spec/${b.strategy}` }]),
      );
      setOutcomes(out);
      setRefList(await refs(app));
      setLineage(await branchCount(app, parentId));
    })().catch((e: unknown) => setError(String(e)));
  }, [app, parentId]);

  const winner = outcomes ? pickWinner(outcomes).strategy : null;

  const promote = async (strategy: Strategy) => {
    if (gate === null) return;
    try {
      const c = await promoteAndApply(app, parentId, gate, strategy);
      setCommit({ strategy, executionId: c.executionId, label: "commit (real apply)" });
      setRefList(await refs(app));
      setLineage(await branchCount(app, parentId));
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  return (
    <div style={styles.board} data-testid="branch-board">
      <div style={styles.boardTitle}>
        Forked at the gate{gate !== null ? ` (event #${gate})` : ""} — three dry runs on real state. The parent above is untouched.
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.cards}>
        {cards.map((c) => (
          <BranchCard
            key={c.executionId}
            app={app}
            card={c}
            winner={winner === c.strategy}
            onPromote={outcomes && !commit ? () => promote(c.strategy) : undefined}
          />
        ))}
        {commit && <BranchCard app={app} card={commit} winner={false} />}
      </div>
      {refList.length > 0 && (
        <div style={styles.refs}>
          {refList.map((r) => (
            <div key={r.name} style={styles.ref}>
              <span style={{ ...styles.refName, ...(r.name === "main" ? styles.refMain : {}) }}>{r.name}</span>
              <span style={styles.refTarget}>→ {r.executionId} @{r.tip}</span>
            </div>
          ))}
          <div style={styles.note}>
            {lineage} branches forked from the parent. {commit ? "main now names the applied migration. " : ""}
            Losers stay immutable and resumable — there is no merge.
          </div>
        </div>
      )}
    </div>
  );
}

function BranchCard({
  app,
  card,
  winner,
  onPromote,
}: {
  app: LoomApp;
  card: Card;
  winner: boolean;
  onPromote?: () => void;
}) {
  const ui = useProjection<UiState>(app.projectionRuntime, "ui", card.executionId);
  const apply = ui.apply;
  return (
    <div style={{ ...styles.card, ...(winner ? styles.cardWinner : {}) }} data-testid={`branch-${card.strategy}`}>
      <div style={styles.cardHead}>
        <span style={styles.cardLabel}>{card.label}</span>
        <span style={styles.cardPhase}>{ui.phase ?? "forking"}</span>
      </div>
      <div style={styles.cardId}>{card.executionId}</div>
      {apply ? (
        <div style={styles.cardMetrics}>
          <span>lock <b>{apply.lockSeconds}s</b></span>
          <span>duration <b>{apply.durationMinutes}m</b></span>
          <span>{apply.reversible ? "reversible" : "not reversible"}</span>
          <span>score <b>{reward(apply).toFixed(3)}</b></span>
          <span style={styles.cardMode}>{apply.applied ? "APPLIED" : "simulated"}</span>
        </div>
      ) : (
        <div style={styles.cardMetrics}>…</div>
      )}
      {onPromote && apply && (
        <button type="button" style={styles.promote} onClick={onPromote}>
          {winner ? "Promote (best score)" : "Promote"}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  board: { display: "flex", flexDirection: "column", gap: 12, padding: "14px 18px", borderRadius: 10, background: "#0f1620", border: "1px solid #232c3b" },
  boardTitle: { fontSize: 13, color: "#cbd5e0", fontWeight: 700 },
  cards: { display: "flex", gap: 12, flexWrap: "wrap" },
  card: { flex: "1 1 200px", padding: 12, borderRadius: 8, background: "#141a24", border: "1px solid #2b3546", display: "flex", flexDirection: "column", gap: 6 },
  cardWinner: { border: "1px solid #38a169", boxShadow: "0 0 0 3px rgba(56,161,105,0.15)" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  cardLabel: { fontWeight: 700, color: "#9ecbff", fontSize: 13 },
  cardPhase: { fontSize: 11, color: "#6b7d95", textTransform: "uppercase", letterSpacing: 0.5 },
  cardId: { fontSize: 10, color: "#4a5568", fontFamily: "monospace", overflowWrap: "anywhere" },
  cardMetrics: { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#cbd5e0" },
  cardMode: { color: "#b7791f", fontWeight: 700 },
  promote: { marginTop: 6, padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer", background: "#3182ce", color: "#fff", fontWeight: 700, fontSize: 13 },
  refs: { display: "flex", flexDirection: "column", gap: 4, fontFamily: "monospace", fontSize: 12 },
  ref: { display: "flex", gap: 10 },
  refName: { minWidth: 140, color: "#a9b7c9" },
  refMain: { color: "#9ae6b4", fontWeight: 700 },
  refTarget: { color: "#6b7d95", overflowWrap: "anywhere" },
  note: { fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6b7d95", marginTop: 6 },
  error: { color: "#feb2b2", fontSize: 12 },
};
```

- [ ] **Step 3: The learning panel**

Create `src/browser/LearningPanel.tsx`:

```tsx
import React, { useState } from "react";
import type { LoomApp } from "../config";
import { coverage, evaluate, formatCoverage, formatEvalReport, readLog, serveBatch } from "../learn";
import { backwards, sizeAware } from "../policy";
import { quietTrace } from "../trace";

// ── Decisions that carry their propensity, in the tab ─────────────────────────
// Same helpers as `pnpm propensity`; the browser's in-memory log is the dataset.

const N = 48;

interface Result {
  blind: boolean;
  coverage: string;
  candidate: string;
  control: string;
}

export function LearningPanel({ app }: { app: LoomApp }) {
  const [blind, setBlind] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [batch, setBatch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const serve = async () => {
    const prefix = `learn-${batch}-`;
    setBatch((b) => b + 1);
    setResult(null);
    setError(null);
    quietTrace(true);
    try {
      await serveBatch(app, N, { blind, prefix, onProgress: (d, t) => setProgress([d, t]) });
      const events = await readLog(app, prefix);
      setResult({
        blind,
        coverage: formatCoverage(coverage(events)),
        candidate: formatEvalReport(evaluate(events, sizeAware)),
        control: formatEvalReport(evaluate(events, backwards)),
      });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      quietTrace(false);
      setProgress(null);
    }
  };

  return (
    <div style={styles.panel} data-testid="learning-panel">
      <div style={styles.intro}>
        When the DBA approves without saying how, a policy picks the strategy — and records the probability it
        picked it with. Serve a batch, then score policies that <b>never ran</b> against that log.
      </div>
      <div style={styles.controls}>
        <button type="button" style={styles.runBtn} onClick={serve} disabled={progress !== null}>
          {progress ? `Serving ${progress[0]} / ${progress[1]}…` : `Serve ${N} migrations`}
        </button>
        <label style={styles.check}>
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} disabled={progress !== null} />
          log blind (bare ctx.decide — no context, no propensity)
        </label>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {result && (
        <div style={styles.reports}>
          <Report title={result.blind ? "What a blind log can teach" : "What the log can teach"} body={result.coverage} />
          <Report title="Candidate: size-aware v2 — never ran" body={result.candidate} />
          <Report title="Control: backwards v0 — never ran" body={result.control} />
          <div style={styles.moral}>
            {result.blind
              ? "Same executions, same rewards, same dashboard. evaluated: 0. You either wrote the propensity down at the time, or you didn't."
              : "Nothing re-ran. Each candidate was only asked what it would have chosen; the estimate reweights the steps it agrees with by 1/propensity (SNIPS)."}
          </div>
        </div>
      )}
    </div>
  );
}

function Report({ title, body }: { title: string; body: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <pre style={styles.pre}>{body}</pre>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { display: "flex", flexDirection: "column", gap: 14 },
  intro: { fontSize: 14, color: "#cbd5e0", lineHeight: 1.5, maxWidth: 680 },
  controls: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" },
  runBtn: { padding: "10px 20px", borderRadius: 8, border: "none", cursor: "pointer", background: "#3182ce", color: "#fff", fontWeight: 700, fontSize: 14 },
  check: { display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#a9b7c9" },
  reports: { display: "flex", flexDirection: "column", gap: 12 },
  card: { padding: "14px 18px", borderRadius: 10, background: "#0f1620", border: "1px solid #232c3b" },
  cardTitle: { fontSize: 13, fontWeight: 700, color: "#cbd5e0", marginBottom: 8 },
  pre: { margin: 0, fontSize: 12, color: "#e2e8f0", whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace" },
  moral: { fontSize: 13, color: "#9ae6b4", lineHeight: 1.5 },
  error: { color: "#feb2b2", fontSize: 12 },
};
```

- [ ] **Step 4: App.tsx — tabs, phases, Explore button, applied banner**

Make these edits to `src/browser/App.tsx`:

(a) Imports: add
```tsx
import { BranchBoard } from "./BranchBoard";
import { LearningPanel } from "./LearningPanel";
```

(b) Replace the `UiState` interface with an exported one:
```tsx
// The shape the flow writes to the "ui" surface via ctx.ui.set / ctx.ui.merge.
export interface UiState {
  phase?: "inspecting" | "assessing" | "awaiting-approval" | "applying" | "applied" | "simulated" | "rejected";
  table?: { name: string; rows: number; sizeGb: number; estLockSeconds: number };
  assessment?: { risk: "low" | "medium" | "high"; rationale: string };
  apply?: {
    strategy: string;
    policy?: { id: string; version: string; propensity: number };
    applied: boolean;
    lockSeconds: number;
    durationMinutes: number;
    reversible: boolean;
  };
}
```

(c) In `App`, add tab state after `const [seq, setSeq] = useState(0);`:
```tsx
  const [tab, setTab] = useState<"migration" | "learning">("migration");
```
and replace the `<header>` subtitle block's closing so the header ends with tabs:
```tsx
        <div style={styles.tabs}>
          <button type="button" style={{ ...styles.tab, ...(tab === "migration" ? styles.tabActive : {}) }} onClick={() => setTab("migration")}>
            Migration
          </button>
          <button type="button" style={{ ...styles.tab, ...(tab === "learning" ? styles.tabActive : {}) }} onClick={() => setTab("learning")}>
            Learning
          </button>
        </div>
      </header>
```
Wrap the form + `MigrationView` in `{tab === "migration" && (<>…</>)}` and add `{tab === "learning" && <LearningPanel app={app} />}` after it.

(d) In `MigrationView`, add state `const [exploring, setExploring] = useState(false);`, change `done` in the stepper to
```tsx
          const done = phase === "applied" || phase === "simulated" || (activeIdx > i && phase !== "rejected");
```
add a third button to the approval bar after Reject:
```tsx
          <button
            type="button"
            style={{ ...styles.secondaryBtn, background: "#2b4c7e", color: "#fff" }}
            onClick={() => setExploring(true)}
            disabled={exploring}
          >
            Explore strategies
          </button>
```
and after the approval bar block:
```tsx
      {exploring && <BranchBoard app={app} parentId={executionId} />}
```

(e) Replace the applied banner:
```tsx
      {phase === "applied" && ui.apply && (
        <div style={styles.banner}>
          ✅ Migration applied via <b>{ui.apply.strategy}</b> — lock {ui.apply.lockSeconds}s, {ui.apply.durationMinutes}m,{" "}
          {ui.apply.reversible ? "reversible" : "not reversible"}
          {ui.apply.policy && (
            <span style={styles.policyTag}>
              chosen by {ui.apply.policy.id} v{ui.apply.policy.version} · propensity {ui.apply.policy.propensity.toFixed(2)}
            </span>
          )}
        </div>
      )}
```

(f) Add styles:
```tsx
  tabs: { display: "flex", gap: 6, marginTop: 12 },
  tab: { padding: "6px 14px", borderRadius: 8, border: "1px solid #2b3546", background: "#141a24", color: "#a9b7c9", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  tabActive: { background: "#1f2b3d", color: "#9ecbff", borderColor: "#3182ce" },
  policyTag: { display: "block", marginTop: 6, fontSize: 12, color: "#9ecbff", fontWeight: 500 },
```

- [ ] **Step 5: Typecheck and build the bundle**

Run: `pnpm build && pnpm build:ui`
Expected: both clean. A Rollup error naming `InMemoryBranchRegistry` means Task 4 Step 1 was not applied in `../loom`.

- [ ] **Step 6: Drive it in the browser**

Run `pnpm dev` and open http://127.0.0.1:5173 (use the `run` skill or claude-in-chrome). Check, in order:

1. Migration tab, `orders` / `add-index`, **Run migration** → stepper reaches `awaiting-approval`; three buttons: Approve, Reject, Explore strategies.
2. **Explore strategies** → a board appears with three cards; each shows its own executionId, phase moving to `simulated`, lock/duration/score; the `spec/online-ddl` card is outlined green with "Promote (best score)". The parent stepper above still says `awaiting-approval`.
3. **Promote (best score)** → a fourth card "commit (real apply)" reaches `applied`; the refs strip shows `main → <commit id>`; note says 4 branches, no merge.
4. **New run**, run again, **Approve** → banner: "Migration applied via <strategy> … chosen by naive-eps v1 · propensity 0.80" (or 0.10).
5. Learning tab, **Serve 48 migrations** → progress counts to 48; three reports: coverage 48/48/48, size-aware with `(snips)` and a positive lift, backwards with a negative lift.
6. Tick **log blind**, serve again → coverage 0/0/0, candidate `steps evaluated 0`, `(agreement-only)`, the blind moral line.

Fix anything that does not match before committing. Check the browser console has no red errors.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts src/browser
git commit -m "feat(demo): the same two claims in the tab — a branch board at the gate and a learning panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: DEMO_SCRIPT and README

**Files:**
- Modify: `DEMO_SCRIPT.md`, `README.md`

- [ ] **Step 1: DEMO_SCRIPT — sync the lines Task 3 changed**

- Title line: `(~14 min)` → `(~19 min)`.
- Pre-flight step 0: append `The loom checkout must contain branch demo/fork-and-propensity (or its merge) — it exports the in-memory branch registry the UI needs.`
- Act 2 code listing: replace the runner block with the runner from Task 3 Step 4 (from `const ApprovalDecision` through the closing `};` of `runner`). Add a fourth talk-track bullet:
  > - On `chooseStrategy(...)` / `recordOutcome(...)`: *"If the DBA doesn't say how, a policy picks — through `ctx.decide`, so it's recorded once and replayed. The extra thing it writes down is the probability it picked with. Hold that thought; Act 4c is about why."*
- Act 3 SEE block: `✅ completed — { applied: true, simulated: false, risk: 'high', approvedBy: 'ada@example.com', strategy: 'direct-ddl', projected: { lockSeconds: 48, durationMinutes: 24, reversible: false } }`; the `loom logs` line list gains nothing (no decision — the driver named the strategy).
- Act 4 SEE blocks: `⚡ EXECUTED  apply    (writes to prod · direct-ddl)` and the same `🎉 completed — {…}` object as above.
- `pnpm test` line: `# 15 green` → count from `pnpm test` (strategies 4 + policy 5 + migration-guard 6 + fork 2 + learn 4 = 21).

- [ ] **Step 2: DEMO_SCRIPT — Act 4b**

Insert after Act 4 (before `## Act 5`):

````markdown
## Act 4b — 🌿 Fork the gate it was parked at · 11:30–13:30

**SAY:** *"That migration was applied one way — the DBA said direct-ddl. But at the gate there were
three ways to do it. A branch here is just a shared log prefix. So: go back to event #10 — the gate —
fork it three ways, dry-run each on real state, and promote one. Prediction first: three branches,
three lightning bolts, all simulated applies. If inspect or assess run again, the claim is false."*

**DO** (terminal A — same `.data` the crash act just wrote):
```bash
pnpm fork
```
**SEE:**
```
▶  forking the execution from pnpm crash / pnpm resume: 01M2…
   gate: event #10   ·   parent head: #17 (completed)

🔮 PREDICTION: 3 branches → 3 lightning bolts, all SIMULATED applies.
   ⚡ EXECUTED  apply    (SIMULATED · direct-ddl)
   ⚡ EXECUTED  apply    (SIMULATED · online-ddl)
   ⚡ EXECUTED  apply    (SIMULATED · chunked)

   steps that really executed for 3 branches: 3   model calls: 0

   strategy       lock     duration   reversible   score    branch
   direct-ddl       48s       24m     no         0.410    spec/direct-ddl → …
   online-ddl      4.4s      154m     yes        0.756    spec/online-ddl → …
   chunked           0s      444m     yes        0.700    spec/chunked → …

   parent 01M2…: head #17 (completed) — UNTOUCHED

🏆 promote online-ddl: fork a commit branch from the same gate, apply it FOR REAL, move main.
   ⚡ EXECUTED  apply    (writes to prod · online-ddl)
   refs:
     main               → <commit id>  @…   ← the pointer move IS the promotion
     spec/…
   lineage: 4 branches forked from 01M2….
```

**SAY (point at the counts):** *"Three bolts, zero model calls. The branches never re-inspected, never
re-asked Gemini — they inherited the prefix. The parent's log didn't move. And there is no merge: two
divergent histories have no sound join, so it refuses to fake one. You pick a winner by moving a
pointer."*

> 🎯 *"Isn't this just running the flow three times?"* — No: three runs would be nine bolts and three
> model calls. Point at `model calls: 0`. The branches share everything above the gate.

---

## Act 4c — 🎲 Decisions that carry their propensity · 13:30–15:30

**SAY:** *"Everyone can replay what the model said. Here's the narrow claim I'd defend: when the DBA
approves without saying how, a policy picks the strategy — and writes down the probability it picked
it with. That number lets me ask, later, off logs I already have, what a different policy would have
scored. Without running it. Prediction: a size-aware policy scores higher than what ran; a backwards
one scores lower; and the same batch logged without the propensity can't be scored at all."*

**DO:**
```bash
pnpm propensity
```
**SEE:**
```
▶  serving 48 migrations through the live policy — naive-eps v1: greedy direct-ddl, ε = 0.3
   Learning report — 48 execution(s), 48 decision(s)
     with context      48 (100%)
     with propensity   48 (100%)
     scored directly   48 (100%)

🔮 PREDICTION: a size-aware policy scores HIGHER than what we ran — without running it.
   Policy size-aware@2 — off-policy evaluation
     steps evaluated     48
     logged value        0.6…
     estimated value     0.8… (snips)
     lift                +0.1…
     effective samples   …

🔮 PREDICTION: a backwards policy … scores LOWER.
     lift                -0.0…

▶  the contrast: the same 48 migrations, decided by a bare ctx.decide — no context, no propensity
     with context      0 (0%)
     with propensity   0 (0%)
   Policy size-aware@2 — off-policy evaluation
     steps evaluated     0
     estimated value     — (agreement-only)
```

**SAY:** *"Same executions, same rewards, same dashboard — and `evaluated: 0`. You either wrote the
propensity down at the time, or you didn't. That's the whole argument, and it's checkable:"*

**DO:**
```bash
pnpm exec loom learn report --db .data/learn/events.db
```
**SEE:** the same coverage block, from loom's own CLI.

> 🎯 *"Why does that matter?"* — *"Because otherwise you can only learn from what you did, never from
> what you didn't."* — 🎯 *"How big is the sample really?"* — point at `effective samples`; it's small
> and the report says so. The estimator refuses to look more confident than the log allows.

---
````

- [ ] **Step 3: DEMO_SCRIPT — Act 5 additions and cheat-sheet**

Retitle `## Act 5 — Same brain, now a UI · 11:30–14:00` → `· 15:30–19:00` and append to its DO list:

````markdown
**DO** (the fork, in the tab): run `orders / add-index` → at the gate click **Explore strategies**.
**SEE:** three cards fill in live — each is a real branch with its own execution id — the parent
stepper above stays at `awaiting-approval`; `spec/online-ddl` is outlined as best. Click **Promote
(best score)** → a fourth card applies for real; the refs strip shows `main → <commit id>`.
**SAY:** *"Same `fork.ts` the terminal just ran. The cards are three `useProjection`s — a branch is a
whole execution, so the component I already had renders it."*

**DO** (the propensity, in the tab): **Learning** tab → **Serve 48 migrations**.
**SEE:** coverage 48/48/48, size-aware `(snips)` with a positive lift, backwards negative.
**DO:** tick **log blind** → serve again. **SEE:** `steps evaluated 0 · (agreement-only)`.
**SAY:** *"Same helper as `pnpm propensity`, same numbers, in a browser tab. That's claim 1 again —
a dependency, not a control plane — applied to claims 2 and 3."*
````

Cheat-sheet: add `pnpm fork`, `pnpm propensity`, `pnpm exec loom learn report --db .data/learn/events.db`, and `pnpm exec loom logs --db .data/events.db <branch id>`.

"If something breaks": add
- `pnpm fork` says *never reached the approval gate* → the last execution was low-risk; `pnpm pitch:reset && pnpm fork` runs a fresh one.
- Explore strategies errors with *fork needs a branch registry* → `../loom` is not on `demo/fork-and-propensity`.

- [ ] **Step 4: README**

- "Run it" section: after the crash block add
```bash
# ── Fork the gate, simulate three strategies, promote one (no merge) ─
pnpm fork
# ── Score a policy that never ran, off the log; then show a blind log can't ─
pnpm propensity
pnpm exec loom learn report --db .data/learn/events.db
```
- Update the `pnpm resume` comment lines: `⚡ EXECUTED apply (writes to prod · direct-ddl)`.
- "What each part demonstrates" table: add rows
  `| **Fork a live execution, simulate on real state, promote** | src/fork.ts → pnpm fork · Explore strategies in the tab |`
  `| **Decisions carry their propensity → counterfactual scoring** | src/policy.ts (decideWithPolicy) + src/learn.ts → pnpm propensity · Learning tab |`
- Memoization table: add a row `| pnpm fork (3 branches + commit) | — | — | ⚡⚡⚡ + ⚡ |`.
- Setup: note the loom branch requirement in one line.

- [ ] **Step 5: Check for stale strings and commit**

Run: `grep -n "writes to prod)" DEMO_SCRIPT.md README.md; grep -n "3 green\|~14 min" DEMO_SCRIPT.md`
Expected: no matches.

```bash
git add DEMO_SCRIPT.md README.md
git commit -m "docs(demo): Acts 4b/4c (fork the gate, propensity) on both surfaces; sync outputs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The concept deck (loom repo)

**Files:**
- Modify (loom, branch `demo/fork-and-propensity`): `../loom/docs/presentation/sip-n-pitch-concept-deck.md`

- [ ] **Step 1: Timing plan**

In the TIMING PLAN comment near the top, change:
```
 15:00  Act V    THE SPIKE          10 min  → loom-demo/DEMO_SCRIPT.md
 25:00  Act VI   Unknowns + the ask  4 min  → "What I still don't know"
 29:00  Q&A
```
to
```
 15:00  Act V    THE SPIKE          13 min  → loom-demo/DEMO_SCRIPT.md (Acts 4, 4b, 4c)
 28:00  Act VI   Unknowns + the ask  2 min  → "What I still don't know" — the ask only, if tight
 30:00  Q&A
```
and add to the CUT ORDER list, first: `0. Act 4c "What would a different choice have scored" (keep 4b — it is the visual one)`. Add to the never-cut note: `The three demos map to the three "still unclaimed" claims; if you cut one, say which claim goes undemonstrated.`

- [ ] **Step 2: Two slides after "What the spike proved — and what it didn't"**

Insert before `## Act VI — What I still don't know`:

````markdown
---

## Claim 2, run: fork the gate it was parked at

```
   main   ──●──●──●──●─ #10 suspended at the approval gate
                     ├──○   spec/direct-ddl   lock 48s   score 0.41
                     ├──○   spec/online-ddl   lock 4.4s  score 0.76   ← promote
                     └──○   spec/chunked      lock 0s    score 0.70
   bolts: 3 · model calls: 0 · parent log: untouched · merge: none
```

**Predicted, then run:** three branches cost three simulated applies and **zero** model calls.
The branches inherited everything above the gate. Promotion is a pointer move.

**Did *not* prove:** that branch storage stays cheap (N branches = N × the prefix), or that a
fork inside a fork is something anyone needs.

<!--
loom-demo Act 4b: `pnpm fork`. Predict OUT LOUD before enter: "three bolts, none of them
inspect or assess". Point at `model calls: 0`.
THE QUESTION: "isn't this just running it three times?" — three runs = nine bolts, three model
calls. The prefix is shared; that's the whole mechanism.
WHY NO MERGE — say it before they ask. Refusing to ship the unsound thing is the credibility.
-->

---

## Claim 3, run: what would a different choice have scored?

| | logged with propensity | logged blind (bare `ctx.decide`) |
|---|---|---|
| decisions | 48 | 48 |
| with propensity | **48** | **0** |
| size-aware policy, never run | est. 0.8x · lift **+0.1x** (SNIPS) | **evaluated: 0** |
| backwards policy, never run | lift **−0.0x** | evaluated: 0 |

Same executions, same rewards, same dashboard. **You either wrote the propensity down at the
time, or you didn't.** Checkable: `loom learn report --db .data/learn/events.db`.

**Did *not* prove:** that the estimate is tight — effective sample size is small and the report
says so. It proves the *question can be asked* off real logs, not that 48 runs answer it.

<!--
loom-demo Act 4c: `pnpm propensity`, then the loom CLI for the same numbers.
This is the load-bearing claim of the deck now; slow down here.
"why does it matter?" → "otherwise you learn only from what you did, never from what you didn't."
"how big is the sample?" → point at effective samples. The estimator refuses to look more
confident than the log allows — that's a feature, say so.
-->
````

- [ ] **Step 3: Commit in loom**

```bash
cd ../loom && git add docs/presentation/sip-n-pitch-concept-deck.md
git commit -m "docs(deck): run claims 2 and 3 in Act V — fork the gate, score a policy that never ran"
cd ../loom-demo
```

Then tell the user the loom branch `demo/fork-and-propensity` has two commits and needs a PR (loom's rules), and that the demo depends on it until merged.

---

## Self-review (done while writing)

- **Spec coverage:** §1 flow → Task 3; §2 policy → Task 2; §3 helpers → Tasks 4, 5, 7 (trace quiet in Task 3; memory storage + loom shim in Task 4); §4 scripts → Tasks 6, 8; §5 UI → Task 9 (phases, board, panel, banner, storage); §6 tests → Tasks 1, 2, 3, 5, 7; §7 docs/deck → Tasks 10, 11. Out-of-scope items untouched.
- **Types:** `StrategyChoice.policy.propensity` is required (number) — the UI banner and the flow test rely on it; `MigrationResult.projected` optional (absent on rejection) and checked in `exploreStrategies`. `headOf` returns `{ sequence, status }` and is compared with `toEqual` in the fork test. `serveBatch` returns ids; `readLog(app, prefix)` filters by `startsWith`.
- **Known judgment calls:** `void migrationGuardFlow` in fork.ts is optional; the cost-model numbers in SEE blocks are from the spec's table and must be re-checked against the real run in Task 6 Step 3 / Task 8 Step 3.
