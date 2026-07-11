# Schema Migration Guard — Loom live-demo

A cloud-database agentic app in one flow, shown on **two surfaces**:

> A migration request arrives → an **agent inspects** the table (rows / size / lock time)
> → **Gemini** rates the lock/downtime risk → **risky migrations pause for a human DBA**
> (durable `ctx.suspend`) → on approval the migration is applied.

The whole agent is `app/flows/migration-guard/flow.ts` — plain async TypeScript. Everything
else is composition: `src/config.ts` (`defineConfig`), `src/main.ts` (headless driver),
`src/browser/` (React surface). The **same flow and same durable log** drive both surfaces.

## Setup

This project lives next to the Loom repo and consumes it via `link:` deps
(`../loom/packages/*`), so the layout must be:

```
workspace/
  loom/            # the Loom kernel (built: run `pnpm install && pnpm build` there once)
  loom-demo/       # ← this project
```

```bash
cd loom-demo
pnpm install       # links the sibling ../loom packages
```

## Run it

```bash
# ── Headless (terminal) ─────────────────────────────────────────────
export GEMINI_API_KEY=...          # optional — omit to use the offline provider
pnpm start
#   ⏸  suspended at #10 — { phase: "awaiting-approval", assessment: { risk: "high", … } }
#   ✅ completed — { applied: true, risk: "high", approvedBy: "ada@example.com" }

# Time-travel the durable log (the run above persisted to SQLite):
pnpm exec loom logs   --db .data/events.db <executionId>
pnpm exec loom debug  --db .data/events.db <executionId> --at 6
pnpm exec loom inspect --db .data/events.db          # web timeline

# ── UI (React) — same core, different renderer ──────────────────────
pnpm dev                           # → http://localhost:5173
#   Pick a migration → watch phases stream → click Approve → it applies live.
#   Paste a Gemini key in the form for a real call; leave empty for the offline demo.
```

## The LLM seam (Gemini)

Loom ships `AnthropicProvider` / `OpenAiProvider`; Gemini is a ~25-line
`GeminiProvider implements LlmProvider` in `src/llm.ts`. The flow imports one `llm` — nothing
downstream changes. It resolves the key per call:

- **Headless:** `GEMINI_API_KEY` env var.
- **Browser:** the key pasted into the form (sets `window.__GEMINI_API_KEY__`).
- **No key:** a deterministic `ScriptedLlmProvider` so the demo always works offline.

## What each part demonstrates

| loom idea | where |
|---|---|
| Plain-TS flow, no DSL (`P4`) | `app/flows/migration-guard/flow.ts` |
| Durable human gate, survives restarts (`P3`) | `ctx.suspend({ on: "ApprovalGranted" })` |
| The event log is the moat | `loom logs` / `loom debug --at N` / `loom inspect` |
| One brain, two surfaces (`P8`) | `src/main.ts` (terminal) vs `src/browser/` (React), same `buildApp` |
| Provider-agnostic LLM edge (`P8`) | `src/llm.ts` — Gemini drop-in |
| A2UI surface updates | `ctx.ui.set/merge` → `useProjection(runtime, "ui", executionId)` |
