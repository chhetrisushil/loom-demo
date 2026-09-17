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
