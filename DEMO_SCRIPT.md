# Live-Demo Script — Loom "Schema Migration Guard" (~15 min)

Follow top to bottom. **SAY** = what you tell the room · **DO** = what you run/type ·
**SEE** = what should appear. Everything here is verified working.

---

## ✅ Pre-flight (do this BEFORE you walk on)

```bash
# 0. Layout: this project (loom-demo) sits next to the loom repo and links to it.
#    Build loom once, off-camera:  cd ../loom && pnpm install && pnpm build

# 1. Everything installed & building (run once, off-camera)
cd /Users/such/workspace/loom-demo
pnpm install                                    # links ../loom packages
pnpm build                                      # headless typecheck — must be clean

# 2. Real Gemini call ready
export GEMINI_API_KEY=<your Google AI Studio key>
pnpm start                                      # warms the HTTP session; note the latency

# 3. Reset so the CLI section starts clean
rm -rf /Users/such/workspace/loom-demo/.data

# 4. Terminals: (A) in loom-demo for headless+CLI, (B) free for vite.
#    Browser tab ready on localhost:5173. Bump font sizes.

# 5. Paste buffer: keep the finished app/flows/migration-guard/flow.ts handy in case
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

## Act 0 — The pitch + the DX wow · 0:00–2:00

**SAY:** *"Loom is a durable kernel for agentic apps. The idea in one line: every action an
agent takes is an event in a log. Once that's true, you get resume, replay, time-travel
debugging, and a UI — for free. Let me show you how fast you build one."*

**DO** (in a throwaway dir — scaffolding show-and-tell, not the app we run):
```bash
cd /tmp/loom-scratch                                    # empty dir
npm create loom-app@latest my-app                       # ~10 files: config, a flow, tests
cd my-app
pnpm exec loom new flow migration-guard                  # scaffolds app/flows/migration-guard/flow.ts
pnpm exec loom gen --dir app                             # regenerates app/loom.gen.ts (static wiring)
```

**SAY:** *"And because loom is AI-native, you don't even have to start from a blank file —"*

**DO** (the flourish):
```bash
pnpm exec loom appgen "Guard database migrations. Inspect the table. Use Gemini. Pause for approval. Generate UI."
```
Open one generated file.
**SAY:** *"That sentence compiled to real, plain TypeScript — a flow with a suspend gate and
a UI surface. No runtime magic, no DSL. You own this code."*

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

## Act 2 — Live-code the runner · 2:00–9:00

**DO:** type the `runner` (narrate each loom concept as it lands):

```typescript
const runner: FlowRunner<In, Out> = async (ctx, input) => {
  ctx.ui.set("phase", "inspecting");
  const stats = await ctx.run(inspectStep, input);
  ctx.ui.merge("table", { name: input.table, ...stats });

  ctx.ui.set("phase", "assessing");
  const verdict = await ctx.run(assessStep, {
    table: input.table, change: input.change,
    rows: stats.rows, estLockSeconds: stats.estLockSeconds,
  });
  ctx.ui.merge("assessment", verdict);

  if (verdict.risk === "low") {
    ctx.ui.set("phase", "applying");
    await ctx.run(applyStep, { table: input.table });
    ctx.ui.set("phase", "applied");
    return { applied: true, risk: verdict.risk };
  }

  ctx.ui.set("phase", "awaiting-approval");
  const decision = (await ctx.suspend({
    on: "ApprovalGranted", correlationKey: input.table, timeout: 24 * 60 * 60 * 1000,
  })) as { approved: boolean; approvedBy: string };

  if (!decision.approved) {
    ctx.ui.set("phase", "rejected");
    return { applied: false, risk: verdict.risk, approvedBy: decision.approvedBy };
  }
  ctx.ui.set("phase", "applying");
  await ctx.run(applyStep, { table: input.table });
  ctx.ui.set("phase", "applied");
  return { applied: true, risk: verdict.risk, approvedBy: decision.approvedBy };
};
```

**Talk track — hit these three lines:**
- On `ctx.run(...)`: *"A step is a durable unit of work. It's recorded to the log — on replay
  it's served from the log, never re-run. Exactly-once, for free."*
- On `assessStep` / `ctx.run(assessStep, …)`: *"This is a real Gemini call. But notice loom
  doesn't know it's Gemini — it's just an effect the kernel records. Loom ships Anthropic and
  OpenAI; I added Gemini in ~25 lines by implementing one `complete()` method* (flash the
  `src/llm.ts` file) *— and the flow didn't change a character."*
- On `ctx.suspend(...)`: *"This is the whole human-in-the-loop story. One line. It writes a
  checkpoint to the log and hands control back. The process can restart, redeploy, move
  machines — when the approval arrives, it resumes from exactly here."*

**DO:** point out there's no `try/catch`, no state machine, no queue. *"It reads like a script
because it is one. That's loom's bet: plain async code, durability underneath."*

---

## Act 3 — Run it headless + time-travel the log · 9:00–12:00

**DO** (terminal A, in `loom-demo`):
```bash
pnpm start
```
**SEE:**
```
⏸  suspended at #10 — { phase: 'awaiting-approval',
     table: { name:'orders', rows:48000000, sizeGb:9.6, estLockSeconds:95 },
     assessment: { risk:'high', rationale:'…' } }
✅ completed — { applied: true, risk: 'high', approvedBy: 'ada@example.com' }
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

**DO** (the wow — time-travel):
```bash
pnpm exec loom debug --db .data/events.db <executionId> --at 6
```
**SEE:** `status: running · sequence: 6 · frames: inspect: completed, assess: running`
**SAY:** *"That's the execution's exact state at step 6 — reconstructed by folding the log. A
debugger for a distributed, days-long workflow."*  *(Optional: `pnpm exec loom inspect --db
.data/events.db` for the web timeline + slider.)*

---

## Act 4 — Same brain, now a UI · 12:00–15:00

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

**SAY (close):** *"One flow of plain TypeScript. Headless in CI, a React app for an operator,
a durable log you can replay and time-travel — and swapping the model was one file. That's
loom: you write the agent, the kernel gives you durability, observability, and a UI for free."*

---

## 🔧 If something breaks

- **Gemini errors / network down:** clear the API-key field (UI) or `unset GEMINI_API_KEY`
  (headless) → the deterministic offline provider takes over and the demo still completes.
  Say: *"loom's provider is pluggable — I'll flip to the offline reviewer."*
- **Live-code typo:** paste the finished `flow.ts` from your buffer, keep moving.
- **Vite shows 'new deps optimized' reload:** normal on first load; just wait for the re-render.
- **Running long:** cut the `loom appgen` line (Act 0) and the `loom inspect` web view (Act 3);
  the headline beats are the live-coded suspend and the Approve button.

## Command cheat-sheet  (run from `loom-demo/`)

```bash
pnpm start                                     # headless run (suspend→resume→applied)
pnpm exec loom logs   --db .data/events.db <id>
pnpm exec loom debug  --db .data/events.db <id> --at 6
pnpm exec loom inspect --db .data/events.db
pnpm dev                                       # UI on :5173
```
