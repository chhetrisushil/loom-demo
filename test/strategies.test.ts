import { describe, expect, it } from "vitest";
import { STRATEGIES, type Strategy, project, reward } from "../src/strategies";

// The four table sizes the demo's catalog produces (src ROWS in flow.ts).
const ROWS = { small: 1_200_000, medium: 9_000_000, large: 48_000_000, huge: 120_000_000 };

function ranked(rows: number): { strategy: Strategy; score: number }[] {
  return STRATEGIES.map((strategy) => ({ strategy, score: reward(project(rows, strategy)) })).sort(
    (a, b) => b.score - a.score,
  );
}

describe("strategy cost model", () => {
  it("the best strategy depends on table size", () => {
    expect(ranked(ROWS.small)[0]?.strategy).toBe("direct-ddl");
    expect(ranked(ROWS.medium)[0]?.strategy).toBe("online-ddl");
    expect(ranked(ROWS.large)[0]?.strategy).toBe("online-ddl");
    expect(ranked(ROWS.huge)[0]?.strategy).toBe("chunked");
  });

  it("every winner wins by a visible margin", () => {
    for (const rows of Object.values(ROWS)) {
      const [first, second] = ranked(rows);
      expect(first!.score - second!.score).toBeGreaterThanOrEqual(0.025);
    }
  });

  it("pins the scores the demo script prints", () => {
    expect(reward(project(ROWS.large, "direct-ddl"))).toBeCloseTo(0.41, 3);
    expect(reward(project(ROWS.large, "online-ddl"))).toBeCloseTo(0.756, 3);
    expect(reward(project(ROWS.large, "chunked"))).toBeCloseTo(0.7, 3);
  });

  it("chunked never locks; direct-ddl is never reversible; rewards stay in [0,1]", () => {
    for (const rows of Object.values(ROWS)) {
      expect(project(rows, "chunked").lockSeconds).toBe(0);
      expect(project(rows, "direct-ddl").reversible).toBe(false);
      for (const s of STRATEGIES) {
        const r = reward(project(rows, s));
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(1);
      }
    }
  });
});
