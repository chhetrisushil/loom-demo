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
