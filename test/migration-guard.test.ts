import { beforeEach, describe, expect, it } from "vitest";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { buildApp, type LoomApp } from "../src/config";

// Force the deterministic offline provider (src/llm.ts falls back to it when no key
// is present) so these tests never depend on the network or an API key.
beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  (globalThis as { __GEMINI_API_KEY__?: string }).__GEMINI_API_KEY__ = "";
});

interface UiSurface {
  phase?: string;
  table?: { name: string; rows: number; sizeGb: number; estLockSeconds: number };
  assessment?: { risk: string; rationale: string };
}

function surface(app: LoomApp, executionId: string): UiSurface {
  return app.projectionRuntime.getState("ui", executionId) as UiSurface;
}

describe("Schema Migration Guard flow", () => {
  it("pauses a risky migration for a human, then applies it on approval", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-high";

    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "orders", change: "add-index" }, // 48M rows, ~95s lock → high risk
      { executionId: id },
    );

    // inspect → assess → suspend at the human gate.
    await handle.waitForSuspend();
    const atGate = surface(app, id);
    expect(atGate.phase).toBe("awaiting-approval");
    expect(atGate.assessment?.risk).toBe("high");
    expect(atGate.table).toMatchObject({ name: "orders", rows: 48_000_000, estLockSeconds: 95 });

    // A human approves → resume from the durable checkpoint → apply.
    const resumed = await app.runtime.resume(id, {
      eventType: "ApprovalGranted",
      payload: { approved: true, approvedBy: "dba@demo" },
    });
    const done = await resumed.waitForCompletion();

    expect(done.status).toBe("completed");
    expect(done.variables._output).toMatchObject({
      applied: true,
      risk: "high",
      approvedBy: "dba@demo",
    });
    expect(surface(app, id).phase).toBe("applied");

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

    expect(done.variables._output).toMatchObject({ applied: false, approvedBy: "dba@demo" });
    expect(surface(app, id).phase).toBe("rejected");

    await app.close();
  });

  it("ships a low-risk migration straight through — no human gate", async () => {
    const app = buildApp({ storage: { kind: "memory" } });
    const id = "test-low";

    // add-nullable-column: metadata-only, ~3s lock → low risk → auto-applies.
    const handle = await app.runtime.start(
      migrationGuardFlow,
      { table: "users", change: "add-nullable-column" },
      { executionId: id },
    );
    const done = await handle.waitForCompletion();

    expect(done.status).toBe("completed");
    const output = done.variables._output as { applied: boolean; risk: string; approvedBy?: string };
    expect(output).toMatchObject({ applied: true, risk: "low" });
    expect(output.approvedBy).toBeUndefined();
    expect(surface(app, id).phase).toBe("applied");

    await app.close();
  });
});
