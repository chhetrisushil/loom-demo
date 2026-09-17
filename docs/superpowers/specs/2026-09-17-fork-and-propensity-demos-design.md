# Fork-and-propensity demos — design

**Date:** 2026-09-17
**Status:** approved (brainstorm), ready for an implementation plan
**Context:** the Sip n Pitch concept deck (`../loom/docs/presentation/sip-n-pitch-concept-deck.md`,
slide "So what's actually left?") claims three unclaimed properties:

1. **Shape** — a dependency, not a control plane. Same core in a unit test and a browser tab.
2. **Forking a live execution** — simulate alternatives on real state, promote one.
3. **Decisions that carry their propensity** — so a choice can be scored counterfactually later,
   off real logs, without re-running anything.

The current demo (`pnpm crash` / `pnpm resume`, headless + React) proves durability and claim 1.
This design adds demonstrations of claims 2 and 3, **on both surfaces** (terminal and React), as
short scripted runs in Act V of the concept talk.

## Decisions taken during brainstorming

| Question | Decision |
|---|---|
| Where in the talk | Short scripted runs in Act V (~90–120 s each), predicted result stated before the run. Act V grows from 10 to ~13 min; the deck's Act IV cut order is the buffer. |
| Flow shape | Extend the existing `migration-guard` flow with a **strategy** concept. One concept serves both claims. No new flows. |
| UI depth | Interactive parity with the CLI: a branch board at the gate, and a learning panel. Both surfaces call the same helper modules; the UI is a renderer, not a second implementation. |
| Robustness | `pnpm fork` uses the crash demo's execution when present, else starts a fresh one to the gate. |

## 1. The flow: one new concept, "strategy"

### `src/strategies.ts` (new; shared by flow, scripts, UI)

```ts
export const STRATEGIES = ["direct-ddl", "online-ddl", "chunked"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export interface Projection { lockSeconds: number; durationMinutes: number; reversible: boolean }
export function project(rows: number, strategy: Strategy): Projection;   // deterministic cost model
export function reward(p: Projection): number;                           // 0..1, higher is better
```

The cost model is deliberately shaped so the best strategy **depends on table size**:

- `direct-ddl`: one statement, full lock proportional to rows, shortest duration, not reversible.
- `online-ddl`: tiny cutover lock, duration proportional to rows, reversible during copy.
- `chunked`: no lock, longest duration, reversible.

`reward` weights lock time heavily and duration lightly, so that: small tables → `direct-ddl`
wins; large → `online-ddl`; huge (backfill-class) → `chunked`. A test pins this ordering. This is
what makes a size-aware candidate policy genuinely better than a naive one in §2.

### Approval payload

```ts
const ApprovalDecision = z.object({
  approved: z.boolean(),
  approvedBy: z.string(),
  strategy: z.enum(STRATEGIES).optional(),   // the DBA may say HOW
  simulate: z.boolean().optional(),          // dry-run against a shadow schema (branches)
});
```

Still declared in `resumeSchemas`, so a malformed resume is refused before it is appended
(ADR 0077). Existing callers (`pnpm resume`, the UI Approve button, tests) keep sending
`{ approved, approvedBy }` and remain valid.

### Apply step

Input `{ table, strategy, simulate }`; output `{ applied: boolean } & Projection`. The stage-prop
label is `apply    (writes to prod)` for real runs and `apply    (SIMULATED — shadow schema)` when
`simulate` is true, so counting lightning bolts still tells the story. `applied` is `!simulate`.

### Runner tail (the live-coded part gets shorter)

```ts
let decision: ApprovalDecision | undefined;
if (verdict.risk !== "low") {
  ctx.ui.set("phase", "awaiting-approval");
  decision = await ctx.suspend<ApprovalDecision>({ on: "ApprovalGranted", correlationKey: input.table });
  if (!decision.approved) { ctx.ui.set("phase", "rejected"); return { applied: false, ... }; }
}
// How to apply: the DBA may say; otherwise a policy decides — and records how sure it was.
const chosenByPolicy = decision?.strategy === undefined;
const strategy = decision?.strategy
  ?? (await chooseStrategy(ctx, { change: input.change, rows: stats.rows, risk: verdict.risk }));
ctx.ui.set("phase", "applying");
const result = await ctx.run(applyStep, { table: input.table, strategy, simulate: decision?.simulate ?? false });
ctx.ui.merge("apply", { strategy, chosenByPolicy, ...result });
recordOutcome(ctx, { key: strategy, score: reward(result), ...(chosenByPolicy && { decisionId: "strategy" }) });
ctx.ui.set("phase", result.applied ? "applied" : "simulated");
return { applied: result.applied, simulated: !result.applied, risk: verdict.risk, approvedBy: decision?.approvedBy, strategy, ...projection };
```

`chooseStrategy` lives in `src/policy.ts` (§2) and wraps `decideWithPolicy` from `@loom/learning`.
The `decisionId` is only attached when the policy chose — a human's pick is not a policy decision
and must not be scored as one.

The output schema gains `strategy`, `simulated`, `lockSeconds`, `durationMinutes`, `reversible`.
The UI surface gains an `apply` key. The live-code stub (`flow.stub.txt`) and the Act 2 listing in
`DEMO_SCRIPT.md` are updated to the new runner; the three talk-track lines are unchanged.

**The crash act stays as it is.** `pnpm resume` (and `src/main.ts`) approve with an explicit
`strategy: "direct-ddl"` — the DBA says how — so no policy decision enters the crash demo's log
and Act 3/4 narration is unchanged. The only visible difference is that the completed output
gains `strategy` and the projection fields. The policy first appears in Act 4c (`pnpm
propensity`) and in the UI, where the Approve button sends no strategy and lets the policy
choose (that is what feeds the banner in §5).

## 2. `src/policy.ts` — the logging policy, the candidates, the blind toggle

- **Logging policy** `naive-eps` v1: ε-greedy with the greedy arm `direct-ddl` (what today's
  flow implicitly does) and ε = 0.3 uniform exploration over all three arms. It logs its **exact**
  propensity: `1 - ε + ε/3` for the greedy arm, `ε/3` otherwise. Randomness comes from a seeded
  PRNG (`mulberry32`) held at module level — a stage prop, commented as such, so numbers on stage
  are stable. `select` is otherwise pure and cheap, as the `Policy` SPI requires.
- **Candidates** (pure, deterministic, propensity 1):
  - `size-aware` v2 — `direct-ddl` below 5M rows, `online-ddl` below 100M, `chunked` above.
  - `always-chunked` — the control; must show a negative lift.
- **`chooseStrategy(ctx, context)`** — `decideWithPolicy(ctx, "strategy", loggingPolicy, context,
  STRATEGIES)` when learnable; when the **blind toggle** is on, the same choice through a bare
  `ctx.decide("strategy", () => loggingPolicy.select(context, STRATEGIES).action)` with no
  `context`, no `policy`, no `alternatives`. The toggle is a module-level `setBlind(boolean)` used
  only by the propensity demo (CLI and UI) to show what such a log costs. It defaults to
  learnable.
- **`resetPolicySeed()`** so each batch starts from the same seed on both surfaces.

## 3. Shared helpers (used by both surfaces)

### `src/fork.ts`

```ts
export interface BranchOutcome { strategy: Strategy; executionId: string; branchName: string; projection: Projection }
export async function findGate(app, executionId): Promise<number>;            // EXECUTION_SUSPENDED sequence
export async function exploreStrategies(app, parentId, gateSeq, onBranch?): Promise<BranchOutcome[]>;
export function pickWinner(outcomes): BranchOutcome;                           // lowest lock, then shortest duration
export async function promoteAndApply(app, parentId, gateSeq, winner): Promise<{ commitId, output }>;
export async function refs(app): Promise<{ name, executionId, tip }[]>;
```

- `exploreStrategies` puts `main` at `{parent, tip: gateSeq}` (once), forks `spec/<strategy>` per
  strategy via `app.runtime.fork(parentId, gateSeq, { branchName })`, resumes each with
  `{ approved: true, approvedBy: "explorer", strategy, simulate: true }`, waits for completion,
  moves the branch tip, and calls `onBranch` after each fork (the UI uses it to render cards as
  soon as an executionId exists). Branches run concurrently (`Promise.all`); results are returned
  in `STRATEGIES` order.
- `promoteAndApply` forks a `commit` branch from the same gate, resumes it with the winner's
  strategy and `simulate: false`, moves its tip, then `branchRegistry.promote("commit", "main")`.
  No promotion of the `spec/*` ref: the promotion IS the commit. There is no merge; the docstring
  says why (divergent `ExecutionState`s have no principled join).
- Requires `app.stores.branchRegistry`; throws a clear error otherwise.

### `src/learn.ts`

```ts
export async function serveBatch(app, n, opts: { blind: boolean; onProgress? }): Promise<void>;
export async function readLog(app): Promise<EventEnvelope[]>;               // listExecutions + read
export function coverage(events): CoverageReport;                          // same numbers as `loom learn report`
export function evaluate(events, policy): EvalReport;                      // trajectories + evaluatePolicy
export function formatCoverage(c): string; export { formatEvalReport } from "@loom/learning";
```

- `serveBatch` cycles the four change types (`orders`, `add-nullable-column` → … ) `n` times,
  starts each execution, and if it suspends, resumes it with `{ approved: true, approvedBy:
  "batch" }` — no strategy, so the policy chooses. It flips the blind toggle for the batch and
  restores it after. It resets the policy seed first.
- `coverage` reproduces the `loom learn report` coverage block from `trajectories`/`steps`
  (with context, with propensity, scored directly). The CLI prints this, and then also runs the
  real `loom learn report` in the cheat-sheet as the checkable version.

### `src/trace.ts`

Gains `quietTrace(boolean)`. The batch would otherwise print ~120 lightning lines.

### `src/config.ts`

`buildApp` unchanged. `src/browser/main.tsx` builds storage as `{ kind: "custom", eventStore:
new InMemoryAsyncEventStore(), snapshotStore: new InMemoryAsyncSnapshotStore(), branchRegistry:
new InMemoryBranchRegistry() }` (all from `@loom/event-runtime`, already a dependency) — the
`memory` preset wires no branch registry. A `memoryStorage()` helper in `src/browser/storage.ts`
keeps `main.tsx` one line.

## 4. CLI: two new scripts

### `pnpm fork` → `src/pitch-fork.ts` (Act 4b, ~2 min)

1. Reads `.data/last-execution.txt`; `findGate` locates the gate sequence. If the file is
   missing, starts a fresh `orders / add-index` migration to the gate and uses that.
2. Prints the prediction frame, then `exploreStrategies`. Per branch, one
   `⚡ apply (SIMULATED)` line. Prints a comparison table (strategy · lock · duration ·
   reversible · reward). Proof line: `3 branches, 3 bolts, 0 inspect, 0 assess, 0 model calls`.
3. Prints the parent's head sequence before and after, and its status — untouched.
4. `pickWinner`, `promoteAndApply` (one real `⚡ apply (writes to prod)`), then the ref table
   (`main → <commit id>`, `spec/* → …`) and `children(parent).length` as the alternatives-
   considered audit trail. Closing line names that there is no merge.

### `pnpm propensity` → `src/pitch-propensity.ts` (Act 4c, ~2 min)

Storage: `sqliteStorage({ dir: ".data/learn" })` and `.data/learn-blind`, so the crash demo's log
stays clean. Forces the offline provider (`delete process.env.GEMINI_API_KEY`, printed as a
note: the policy decision is not the model call) and `quietTrace(true)`.

1. `serveBatch(40)` → print coverage: `with propensity 40 (100%)`, arms table.
2. `evaluate(events, sizeAware)` → logged value, SNIPS estimate, lift, effective sample size.
   Line: *"nothing re-ran; the candidate never chose anything."*
3. `evaluate(events, alwaysChunked)` → negative lift. The estimator can say no.
4. `serveBatch(40, { blind: true })` into the second dir; `evaluate(blindEvents, sizeAware)` →
   `evaluated: 0`, `estimator: agreement-only`. Closing line: *"same executions, same rewards —
   you either wrote the propensity down at the time or you didn't."*
5. Prints the checkable command: `pnpm exec loom learn report --db .data/learn/events.db`.

`pnpm pitch:reset` also removes `.data/learn*`.

## 5. UI

`App.tsx` gains a two-tab header: **Migration** (today's form and view) and **Learning**.

### Branch board (Migration tab, at the gate)

- Next to Approve/Reject: **Explore strategies**. Click → `exploreStrategies(app, id, gateSeq,
  onBranch)`; `findGate` reads the gate from the event store.
- A `BranchBoard` renders one `BranchCard` per strategy as soon as `onBranch` fires. Each card
  is a `useProjection` on that branch's own `"ui"` surface: the same phase stepper, then the
  projection once `apply` lands. The parent's view stays at `awaiting-approval` above the board.
- When all three complete, the winner (via `pickWinner`) is highlighted and each card gets
  **Promote**. Click → `promoteAndApply`; the board shows the commit card (real apply) and a
  refs strip `main → <commit id>` read via `refs(app)`. Text under it: "losing branches stay
  immutable and resumable — no merge."

### Learning panel

- **Serve 40 migrations** button → `serveBatch(app, 40, { blind })` with a progress counter;
  a **log blind** checkbox controls `blind`.
- After the batch: coverage block, then two report cards (`size-aware v2`, `always-chunked`)
  from `evaluate` + `formatEvalReport` in a `<pre>`. In blind mode the cards read
  `evaluated: 0 · agreement-only`.
- Each batch uses a fresh executionId prefix (`learn-<n>-`), and reads only its own executions
  by prefix, so the learnable and blind batches do not pollute each other in the one memory
  store.

### Phases

`UiState.phase` and the stepper's `PHASES` gain `simulated` (terminal phase of a dry-run branch,
rendered like `applied` but labelled "simulated"). `apply` on the surface is typed as
`{ strategy, chosenByPolicy, applied, lockSeconds, durationMinutes, reversible, policy? }`.

### Applied banner

Shows strategy and projection; when `chosenByPolicy`, appends *"chosen by naive-eps v1 ·
propensity 0.77"* — read from `apply` on the surface. The propensity is written to the
surface by `chooseStrategy` via `ctx.ui.merge("apply", { policy })` so the banner needs no
log read.

## 6. Tests (vitest, memory storage, offline provider)

- `test/migration-guard.test.ts`: existing three cases updated for the new output shape; the
  approve case asserts `strategy` is present and the decision event carries `policy.propensity`.
- `test/strategies.test.ts`: `reward(project(rows, s))` ordering — small rows → direct wins,
  large → online, huge → chunked.
- `test/fork.test.ts`: run to gate; `exploreStrategies` → 3 outcomes; count `didRun` labels via
  `executedLabels()` — three simulated applies, no inspect/assess; parent head sequence and
  status unchanged; `promoteAndApply` → `refs` has `main` at the commit id; `children(parent)`
  is 4.
- `test/learn.test.ts`: `serveBatch(12)` learnable → `coverage.withPropensity === 12`,
  `evaluate(sizeAware).estimator === "snips"`; blind → `withPropensity === 0`, `evaluated === 0`,
  `estimator === "agreement-only"`. Also: `alwaysChunked` lift < `sizeAware` lift.

## 7. Docs and deck

- `DEMO_SCRIPT.md`: Act 4 gains **4b — Fork the gate** and **4c — Decisions carry their
  propensity**, each with SAY/DO/SEE and the prediction stated before the run; Act 5 gains the
  branch board and learning panel; pre-flight, "if something breaks", and the cheat-sheet updated;
  the Act 2 listing matches the new runner.
- `README.md`: run section gains `pnpm fork` and `pnpm propensity`; the "what each part
  demonstrates" table gains two rows; the memoization table gains the fork column.
- Concept deck (`../loom/docs/presentation/sip-n-pitch-concept-deck.md`): two Act V slides after
  "What the spike proved" — *"Fork the gate it was parked at"* and *"What would a different
  choice have scored?"* — each with a predicted result and a what-it-did-not-prove line; TIMING
  PLAN updated (Act V 13 min; note that cut #1 in Act IV is the buffer). Separate commit in the
  loom repo.

## Out of scope

- Recording the promotion as a `ctx.decide` inside a flow (the loom-examples pattern); here the
  promotion is a ref move and the script says so.
- Branch TTL / cleanup, per-branch placement, timers on forked gates (the gate has no timeout).
- Training a policy from the log (the learning-router example does that); this demo only
  evaluates candidates.
- Any change to the Gemini provider. The crash/resume scripts change only in passing an
  explicit strategy and in their printed output.
