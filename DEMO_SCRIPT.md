# Live-Demo Script — Loom "Schema Migration Guard" (~18 min)

Follow top to bottom. **SAY** = what you tell the room · **DO** = what you run/type ·
**SEE** = what should appear. Everything here is verified working.

---

## ✅ Pre-flight (do this BEFORE you walk on)

```bash
# 0. Layout: this project (loom-demo) sits next to the loom repo and links to it.
#    Build loom once, off-camera:  cd ../loom && pnpm install && pnpm build
#    The loom checkout must contain branch demo/fork-and-propensity (or its merge) —
#    it exports the in-memory branch registry the UI needs.

# 1. Everything installed & building (run once, off-camera)
cd /Users/such/workspace/loom-demo
pnpm install                                    # links ../loom packages
pnpm build                                      # headless typecheck — must be clean

# 2. Real Gemini call ready
export GEMINI_API_KEY=<your Google AI Studio key>
pnpm start                                      # warms the HTTP session; note the latency

# 3. Act 0 scaffolding tools on PATH (nothing here is published to npm — it all runs
#    from the sibling loom checkout, so this works offline)
export PATH="/Users/such/workspace/loom-demo/node_modules/.bin:$PATH"   # the `loom` CLI
alias create-loom-app="node /Users/such/workspace/loom/tools/create-loom-app/dist/index.js"

# 4. Reset so the CLI section starts clean
rm -rf /Users/such/workspace/loom-demo/.data

# 5. Terminals: (A) in loom-demo for headless+CLI, (B) free for vite.
#    Browser tab ready on localhost:5173. Bump font sizes.
#    Ports are pinned so an SSH tunnel is stable: inspector 35789, vite 5173 (strict —
#    it errors instead of drifting to 5174). Both bind 127.0.0.1. Presenting remotely:
#      ssh -L 35789:127.0.0.1:35789 -L 5173:127.0.0.1:5173 <demo-box>

# 6. Paste buffer: keep the finished app/flows/migration-guard/flow.ts handy in case
#    you fat-finger the live-code section. Start that file from the STUB below.
```

**Stub for the live-code section.** The repo ships the *finished* `flow.ts` (so a fresh
clone runs green). To go live, swap in the stub — schemas + the three steps are there, only
the `runner` is left for you to type:

```bash
pnpm demo:stub       # cp flow.stub.txt → flow.ts  (runner throws "live-code me")
# …give the talk, type the runner during Act 2…
pnpm demo:restore    # git checkout flow.ts  → back to the finished version
```

> Keep the finished `flow.ts` open in another tab (or `git show HEAD:app/flows/migration-guard/flow.ts`)
> as your paste buffer. You're only typing the `runner` in Act 2.

---

## Act 0 — The DX wow · 0:00–1:30  *(cuttable)*

**SAY:** *"Loom is a durable kernel for agentic apps. The idea in one line: every action an
agent takes is an event in a log. Once that's true, you get resume, replay, time-travel
debugging, and a UI — for free. Let me show you how fast you build one."*

**DO** (in a throwaway dir — scaffolding show-and-tell, not the app we run):
```bash
cd /tmp/loom-scratch                       # empty dir
create-loom-app my-app                     # 11 files: config, a greet flow, middleware, tests
cd my-app
loom new flow migration-guard --dir app    # scaffolds app/flows/migration-guard/flow.ts
loom gen --dir app                         # regenerates app/loom.gen.ts (static wiring)
```

> ⚠️ **Do not run `npm create loom-app`.** That name on npm belongs to an unrelated project
> (a React/Vue/Svelte scaffolder) and would generate someone else's app on stage. Loom's own
> scaffolder is unpublished — use the `create-loom-app` alias from pre-flight step 3.
>
> Both commands need the pre-flight `PATH`/alias exports. `--dir app` is required on
> `loom new`; without it the flow lands somewhere the later `loom gen` won't see.

**SAY:** *"Ten seconds, and the wiring is done — now the interesting part is the agent itself."*
(Roll straight into Act 1.)

> 🚫 **`loom appgen` is deliberately not in this script.** An earlier draft opened with it
> ("that sentence compiled to a flow with a suspend gate and a UI surface"). It does not fail
> loudly when it can't deliver that — it falls back to a deterministic parser, exit 0, and
> emits a *generic* scaffold whose flow is named `app`: no suspend gate, no UI surface. Both
> routes into the fallback are verified: exporting a key without `--model` never calls the
> model at all (and prints no warning); `--model` with a bad key prints `produced no valid
> plan — used the deterministic parser`. Whether a valid key delivers the narrated result was
> never confirmed. Don't reintroduce the line without checking the output for `[deterministic]`.

---

## Act 1 — Frame the app · (rolls straight into Act 2)

**DO:** open the real project `loom-demo/app/flows/migration-guard/flow.ts`
(showing the stub: schemas + the three steps, empty runner).

**SAY:** *"Here's our actual app — a Schema Migration Guard. Someone requests a DB migration.
We inspect the table, ask Gemini how risky it is, and if it's dangerous we pause for a human
DBA before touching production. Three steps are already here — inspect, assess, apply. The
interesting part is the orchestration, so let's write that live."*

Point at the three steps as you name them:
- `inspectStep` — *"a tool: reads table size and estimated lock time."*
- `assessStep` — *"a real Gemini call — returns strict JSON: risk + one-sentence rationale."*
- `applyStep` — *"applies the migration."*

---

## Act 2 — Live-code the runner · 1:30–6:30

**DO:** type the `runner` (narrate each loom concept as it lands):

```typescript
// The gate's contract — already in the stub, alongside `resumeSchemas` on the flow below it.
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
```

**Talk track — hit these three lines:**
- On `ctx.run(...)`: *"A step is a durable unit of work. It's recorded to the log — on replay
  it's served from the log, never re-run. Exactly-once, for free."*
- On `assessStep` / `ctx.run(assessStep, …)`: *"This is a real Gemini call. But notice loom
  doesn't know it's Gemini — it's just an effect the kernel records. Loom ships Anthropic,
  OpenAI and Gemini providers; I wrote this one myself in ~35 lines, by implementing one
  `complete()` method* (flash the `src/llm.ts` file) *— and the flow didn't change a
  character. That's the whole seam."*
- On `ctx.suspend(...)`: *"This is the whole human-in-the-loop story. One line. It writes a
  checkpoint to the log and hands control back. The process can restart, redeploy, move
  machines — when the approval arrives, it resumes from exactly here."*
- On the `<ApprovalDecision>` type argument, if asked: *"That types what comes back at the gate.
  The enforcement is the matching `resumeSchemas` entry on the flow — the runtime parses the
  resume payload before it's appended, so a malformed approval is refused instead of becoming a
  permanent part of the log. The type argument alone is erased; it's a claim, the schema is the
  check."* (ADR 0077.)
- On `decision?.strategy` / `chooseStrategy(...)`: *"There are three ways to apply a migration:
  lock the table and just do it, copy-and-swap, or batch it slowly. The DBA can say which. If
  they don't, a policy picks — through `ctx.decide`, so it's recorded once and replayed — and it
  writes down one extra thing: how sure it was. Hold that thought."*

**DO:** point out there's no `try/catch`, no state machine, no queue. *"It reads like a script
because it is one. That's loom's bet: plain async code, durability underneath."*

---

## Act 3 — Run it headless + time-travel the log · 6:30–9:00

**DO** (terminal A, in `loom-demo`):
```bash
pnpm start
```
**SEE:**
```
⏸  suspended at #10 — { phase: 'awaiting-approval',
     table: { name:'orders', rows:48000000, sizeGb:9.6, estLockSeconds:95 },
     assessment: { risk:'high', rationale:'…' } }
✅ completed — { applied: true, simulated: false, risk: 'high', approvedBy: 'ada@example.com', strategy: 'direct-ddl', projected: { lockSeconds: 48, durationMinutes: 24, reversible: false } }
Inspect it:  loom logs --db .data/events.db <executionId>
```
**SAY:** *"It ran, hit the gate, suspended. My driver then approved it and it resumed to
'applied'. Gemini rated an index build on a 48-million-row table as high risk — so it waited
for a human. Now the payoff: everything that happened is in a durable log."*

**DO** (copy the executionId it printed):
```bash
pnpm exec loom logs   --db .data/events.db <executionId>
```
**SEE:** the event timeline — `STEP_STARTED/COMPLETED inspect`, `assess`, then
`⏸ #10 EXECUTION_SUSPENDED on ApprovalGranted`, `ApprovalGranted`, `EXECUTION_RESUMED`,
`apply`, `EXECUTION_COMPLETED`.

**SAY:** *"I added zero observability code. This is the same log the flow already writes."*

**DO** *(optional — proof it's all real & repeatable):*
```bash
pnpm test        # 22 green: strategies 4 · policy 5 · migration-guard 6 · fork 2 · learn 5
```

**DO** (the wow — time-travel):
```bash
pnpm exec loom debug --db .data/events.db <executionId> --at 6
```
**SEE:** `status: running · sequence: 6 · frames: inspect: completed, assess: running`
**SAY:** *"That's the execution's exact state at step 6 — reconstructed by folding the log. A
debugger for a distributed, days-long workflow."*  *(Optional: `pnpm inspect` → the web
timeline + slider on http://localhost:35789.)*

---

## Act 4 — 💀 Kill the process · 9:00–11:30

**This is the act that wins the room. Everything before it was a claim; this is the proof.**

**SAY:** *"Everything so far ran in one process. Any framework can look durable if nothing
ever dies. So let's kill it."*

**DO** (terminal A):
```bash
pnpm pitch:reset      # rm -rf .data — start from an empty log
pnpm crash
```
**SEE:**
```
   ⚡ EXECUTED  inspect  (table scan)   ← real work: time and money spent
   ⚡ EXECUTED  assess   (LLM call)     ← real work: time and money spent

⏸  SUSPENDED at event #10 — waiting for a human DBA
   steps that really executed in THIS process: 2
   executionId: 01M2...
💀 SIGKILL — this process is going away now. Nothing gets to clean up.
```

**SAY:** *"Two steps really ran — note the lightning bolts, those only print when a handler
actually executes. Then I sent this process `SIGKILL`. Not a graceful shutdown — signal 9.
No cleanup handler, no flush, no `finally`. The process is gone."*

**DO** — prove it's really dead, and that the state is on disk, not in RAM:
```bash
echo $?                 # 137  = 128 + 9. It was killed, not exited.
ls -la .data/           # events.db — this is the entire state of that migration
```

**SAY:** *"Now a completely different process is going to finish the job. It never saw the
migration start. All it gets is that file and an id."*

**DO:**
```bash
pnpm resume
```
**SEE:**
```
🆕 COLD START — new process, empty memory.
✅ DBA approves. Resuming…

   ⚡ EXECUTED  apply    (writes to prod · direct-ddl)   ← real work: time and money spent

🎉 completed — { applied: true, simulated: false, risk: 'high', approvedBy: 'ada@example.com', strategy: 'direct-ddl', projected: { lockSeconds: 48, durationMinutes: 24, reversible: false } }
   steps that really executed in THIS process: 1
   inspect + assess did NOT re-run — they were served from the log.
```

**SAY (land it slowly — point at the counts):** *"Two lightning bolts in the first process.
**One** in the second. `inspect` and `assess` did not re-run — they were served from the log.
The model call was paid for exactly once, across a process death. And look at the result: it
still knows the risk was high and why — that assessment was written by a process that no
longer exists, and rebuilt by folding the log."*

**SAY:** *"That's the whole pitch in one command. I didn't write a checkpoint. I didn't write
a retry. I didn't write a state machine. I wrote `await ctx.run(...)` and `await
ctx.suspend(...)`."*

> ⚠️ **Do not skip the `echo $?`.** Engineers will assume you caught a signal and shut down
> cleanly. `137` is what proves you didn't.

> 🎯 **"So who calls `resume` in production?"** — the sharpest question this act attracts, and
> you should have the honest answer ready rather than improvising it:
>
> *"Here, me — I'm playing the supervisor. In a real deployment the dispatcher does it: a
> worker that dies or wedges past its deadline is redispatched automatically, and the worker
> resumes from durable state without re-running committed steps. That's ADR 0004 and it's
> tested. What that doesn't cover is the supervisor itself dying, because the detection lives
> in its process. For that, loom ships `recoverAbandoned()` — a maintenance pass you run from
> a cron or a Kubernetes Job — and it makes you supply the 'is this orphaned?' predicate,
> because a running execution on a healthy node looks identical in the log to an orphaned one.
> Only your cluster knows the difference."*
>
> Do **not** claim the demo shows automatic recovery. It shows the *resume* is possible from a
> cold process, which is the durability claim. Who triggers it is a separate, answerable
> question — and answering it precisely is worth more than dodging it.

---

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
   gate: event #10   ·   parent head: #24 (completed)

🔮 PREDICTION: 3 branches → 3 lightning bolts, all SIMULATED applies.
   ⚡ EXECUTED  apply    (SIMULATED · direct-ddl)
   ⚡ EXECUTED  apply    (SIMULATED · online-ddl)
   ⚡ EXECUTED  apply    (SIMULATED · chunked)

   steps that really executed for 3 branches: 3   model calls: 0

   strategy       lock     duration   reversible   score    branch
   direct-ddl      48s       24m     no         0.410    spec/direct-ddl → 01M2QBV70BJ4CWQ562XXTPFWMT
   online-ddl     4.4s      154m     yes        0.756    spec/online-ddl → 01M2QBV70BR85MFJK84E5J6EAZ
   chunked          0s      444m     yes        0.700    spec/chunked → 01M2QBV70BJ21GFJ16VCKY21MP

   parent 01M2QBV66WTKKDBAP5WS01XQ8C: head #24 (completed) — UNTOUCHED

🏆 promote online-ddl: fork a commit branch from the same gate, apply it FOR REAL, move main.
   ⚡ EXECUTED  apply    (writes to prod · online-ddl)

   refs:
     commit             → 01M2QBV70KJ3TFCJTTE73KCW2P  @24
     main               → 01M2QBV70KJ3TFCJTTE73KCW2P  @24   ← the pointer move IS the promotion
     spec/chunked       → 01M2QBV70BJ21GFJ16VCKY21MP  @24
     spec/direct-ddl    → 01M2QBV70BJ4CWQ562XXTPFWMT  @24
     spec/online-ddl    → 01M2QBV70BR85MFJK84E5J6EAZ  @24

   lineage: 4 branches forked from 01M2QBV66WTKKDBAP5WS01XQ8C.
   The losers stay immutable and independently resumable. There is no merge —
   two divergent histories have no sound join, so loom refuses to fake one.
```

**SAY (point at the counts):** *"Three bolts, zero model calls. The branches never re-inspected, never
re-asked Gemini — they inherited the prefix. The parent's log didn't move. And there is no merge: two
divergent histories have no sound join, so it refuses to fake one. You pick a winner by moving a
pointer."*

> 🎯 *"Isn't this just running the flow three times?"* — No: three runs would be nine bolts and three
> model calls. Point at `model calls: 0`. The branches share everything above the gate.

---

## Act 4c — 🎲 Decisions that carry their propensity · 13:30–15:00

**Shape: prediction → one candidate, three numbers → the same batch blind → nothing.** Do not read
the reports; point at three numbers. Say "how sure it was" throughout; say "propensity" once, at the end.

**SAY:** *"Everyone can replay what the model said. Here's the narrow claim I'd defend. When the DBA
approves without saying how, a policy picks the strategy — and writes down how sure it was. That one
number lets me ask, later, off logs I already have: what would a different policy have scored? Without
running it. Prediction: a size-aware policy, which never ran, scores higher than what did. Then I'll
log the same batch without that number and show you what's left."*

**DO:**
```bash
pnpm propensity
```
**SEE:**
```
▶  48 migrations. The DBA approves but never says HOW — a policy picks the strategy,
   and writes down how sure it was.
   48 executions · 48 decisions · 48 carry how-sure-it-was

🔮 PREDICTION: a size-aware policy — one that NEVER RAN — scores higher than what did.
     steps evaluated     48
     estimated value     0.8328   (what actually ran: 0.6712)
     lift                +0.1616

▶  the same 48 migrations, same choices, same rewards — logged WITHOUT how sure it was
   48 executions · 48 decisions · 0 carry how-sure-it-was
     steps evaluated     0
     estimated value     — cannot be estimated (no propensity in the log)
     lift                —
```

**SAY (point at the two `steps evaluated` lines):** *"Forty-eight, then zero. Same executions, same
rewards, same dashboard — and nothing can be learned from the second log. That number is the
propensity. You either wrote it down at the time, or you didn't. It's checkable:"*

**DO:**
```bash
pnpm exec loom learn report --db .data/learn/events.db
```
**SEE:** `with propensity 48 (100%)`, from loom's own CLI.

> 🎯 *"Why does that matter?"* — *"Because otherwise you can only learn from what you did, never from
> what you didn't."*
> 🎯 *"An estimator that only says yes is useless."* — `pnpm propensity --verbose` adds a backwards
> policy (chunk the small tables, lock the big ones); its lift is negative. Run it if asked, not before.
> 🎯 *"How big is the sample really?"* — `--verbose` shows `effective samples`; it's small and the
> report says so. The estimator refuses to look more confident than the log allows.

---

## Act 5 — Same brain, now a UI · 15:00–18:30

**DO** (terminal B, in `loom-demo`):
```bash
pnpm dev                                           # → http://localhost:5173
```
Switch to the browser tab.

**SAY:** *"Same flow. Same durable log. I did not rewrite anything for the UI —"*
**DO:** flash `src/browser/main.tsx`.
**SAY:** *"— it's the same `buildApp` from the headless version, wrapped in `<LoomProvider>`.
The React screen just subscribes to the surface the flow already emits with `useProjection`."*

**DO:** in the browser — pick `add-index` on table `orders`, (paste your Gemini key in the
form for a real call), click **Run migration**.
**SEE:** phases stream — inspecting → assessing → **awaiting-approval**; the table metrics and
Gemini's risk verdict render live.

**SAY:** *"Same suspend. In the terminal a human approved from a script; here it's a button."*
**DO:** click **Approve**.
**SEE:** phase → applying → **applied**, green banner.

**DO** (the fork, in the tab): run `orders / add-index` → at the gate click **Explore strategies**.
**SEE:** three cards fill in live — each is a real branch with its own execution id — the parent
stepper above stays at `awaiting-approval`; `spec/online-ddl` is outlined as best. Click **Promote
(best score)** → a fourth card applies for real; the refs strip shows `main → <commit id>`.
**SAY:** *"Same `fork.ts` the terminal just ran. The cards are three `useProjection`s — a branch is a
whole execution, so the component I already had renders it."*

**DO** (the propensity, in the tab): **Learning** tab → **Serve 48 migrations**.
**SEE:** `48 carry how-sure-it-was`, then three big numbers: 48 evaluated, an estimate above what ran, a positive lift.
**DO:** tick **log blind** → serve again. **SEE:** `0 carry how-sure-it-was` · `steps evaluated 0` · `cannot be estimated`.
(The full reports and the control policy are one click away under "for Q&A".)
**SAY:** *"Same helper as `pnpm propensity`, same numbers, in a browser tab. That's claim 1 again —
a dependency, not a control plane — applied to claims 2 and 3."*

**SAY (close):** *"One flow of plain TypeScript. Headless in CI, a React app for an operator,
a durable log you can replay and time-travel — and swapping the model was one file. That's
loom: you write the agent, the kernel gives you durability, observability, and a UI for free."*

---

## 🔧 If something breaks

- **`pnpm start` / `pnpm crash` prints `assess` four times, then `Error: Gemini 400/403/404 …`
  and no `⏸ suspended` line:** the key in `GEMINI_API_KEY` is rejected (or the model name in
  `src/llm.ts` is gone). The retry middleware tried 4× and the execution *failed* — it never
  reached the gate. Fix the key, or use the next bullet.
- **Gemini errors / network down:** clear the API-key field (UI) or `unset GEMINI_API_KEY`
  (headless) → the deterministic offline provider takes over and the demo still completes.
  Say: *"loom's provider is pluggable — I'll flip to the offline reviewer."*
- **Live-code typo:** paste the finished `flow.ts` from your buffer, keep moving.
- **Vite shows 'new deps optimized' reload:** normal on first load; just wait for the re-render.
- **Running long:** cut Act 0 (scaffolding) first, then the `loom inspect` web view in Act 3,
  then Act 5 (the UI). **Never cut Act 4** — the crash/resume is the single most persuasive
  90 seconds in the talk, and the deck's closing slide asserts it happened.
- **`pnpm resume` dies with `ENOENT … .data/last-execution.txt`:** you ran `pnpm pitch:reset`
  after `pnpm crash` instead of before. Re-run `pnpm crash`, then `pnpm resume`.
- **`pnpm fork` says *never reached the approval gate*:** the last execution was low-risk;
  `pnpm pitch:reset && pnpm fork` runs a fresh one.
- **Explore strategies errors with *fork needs a branch registry*:** `../loom` is not on
  `demo/fork-and-propensity`.
- **`fork needs a branch registry` from a headless script:** the script must call
  `sqliteStorage({ dir, branching: true })`.

## Command cheat-sheet  (run from `loom-demo/`)

```bash
pnpm pitch:reset                               # wipe .data — always before `pnpm crash`
pnpm crash                                     # run → suspend → SIGKILL (exit 137)
pnpm resume                                    # COLD process finishes it from the log
pnpm start                                     # headless run (suspend→resume→applied)
pnpm fork                                      # fork the gate 3 ways, promote one
pnpm propensity                                # score a policy that never ran, off the log
pnpm propensity --verbose                      # + backwards control policy (Q&A only)
pnpm exec loom logs   --db .data/events.db <id>
pnpm exec loom debug  --db .data/events.db <id> --at 6
pnpm exec loom learn report --db .data/learn/events.db
pnpm exec loom logs   --db .data/events.db <branch id>
pnpm inspect                                   # web timeline on :35789
pnpm dev                                       # UI on :5173 (strict)
```
