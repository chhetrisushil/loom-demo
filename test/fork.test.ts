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
