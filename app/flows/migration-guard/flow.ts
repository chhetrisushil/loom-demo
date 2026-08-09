import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { llm } from "../../../src/llm"; // export const llm — any LlmProvider works (Gemini here)

// ── Schemas ───────────────────────────────────────────────────────────────────
const MigrationInput = z.object({
  table: z.string(),
  change: z.enum(["add-nullable-column", "add-index", "drop-column", "backfill"]),
});
const MigrationOutput = z.object({
  applied: z.boolean(),
  risk: z.enum(["low", "medium", "high"]),
  approvedBy: z.string().optional(),
});
type In = z.infer<typeof MigrationInput>;
type Out = z.infer<typeof MigrationOutput>;

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

// 3) EFFECT: apply the migration (simulated).
const applyStep = step$({
  id: "apply",
  name: "Apply migration",
  inputSchema: z.object({ table: z.string() }),
  outputSchema: z.object({ applied: z.boolean() }),
  handler: handler$(async () => ({ applied: true })),
});

// ── Runner: plain async orchestration — this IS the agent, and it drives the UI ──
// The approval gate's resume contract. Declared once: listed in `resumeSchemas` so the runtime
// parses a resume BEFORE appending it (loom ADR 0077) — a wrongly-shaped approval is refused
// rather than becoming a permanent fold input — and inferred back into the type the runner sees.
const ApprovalDecision = z.object({ approved: z.boolean(), approvedBy: z.string() });
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
  if (verdict.risk === "low") {
    ctx.ui.set("phase", "applying");
    await ctx.run(applyStep, { table: input.table });
    ctx.ui.set("phase", "applied");
    return { applied: true, risk: verdict.risk };
  }

  // Durable human gate — persists to the log and hands control back until resumed.
  ctx.ui.set("phase", "awaiting-approval");
  const decision = await ctx.suspend<ApprovalDecision>({
    on: "ApprovalGranted",
    correlationKey: input.table,
    timeout: 24 * 60 * 60 * 1000,
  });

  if (!decision.approved) {
    ctx.ui.set("phase", "rejected");
    return { applied: false, risk: verdict.risk, approvedBy: decision.approvedBy };
  }

  ctx.ui.set("phase", "applying");
  await ctx.run(applyStep, { table: input.table });
  ctx.ui.set("phase", "applied");
  return { applied: true, risk: verdict.risk, approvedBy: decision.approvedBy };
};

// Exported as a bare `RegisteredFlow` — the runtime treats every flow uniformly.
export const migrationGuardFlow = {
  definition: flow$({
    id: "migration-guard",
    name: "Schema Migration Guard",
    version: "1.0.0",
    inputSchema: MigrationInput,
    outputSchema: MigrationOutput,
    steps: [inspectStep, assessStep, applyStep],
    resumeSchemas: { ApprovalGranted: ApprovalDecision },
  }),
  runner,
} as RegisteredFlow;
