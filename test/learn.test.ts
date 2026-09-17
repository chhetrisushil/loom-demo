import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/config";
import { coverage, evaluate, headline, readLog, serveBatch } from "../src/learn";
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

  it("headline is three lines, and says so when there is nothing to estimate", () => {
    const three = headline({
      policy: { id: "x", version: "1" }, evaluated: 48, skipped: { noContext: 0, noActions: 0, noReward: 0 },
      agreement: 0.5, loggedValue: 0.66, estimatedValue: 0.85, estimator: "snips", lift: 0.19,
      effectiveSampleSize: 9, warnings: [],
    });
    expect(three.split("\n")).toHaveLength(3);
    expect(three).toContain("+0.1900");
    const none = headline({
      policy: { id: "x", version: "1" }, evaluated: 0, skipped: { noContext: 48, noActions: 0, noReward: 0 },
      agreement: 0, loggedValue: 0, estimator: "agreement-only", warnings: [],
    });
    expect(none).toContain("steps evaluated     0");
    expect(none).toContain("cannot be estimated");
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
