import { existsSync, readFileSync } from "node:fs";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { buildApp, type LoomApp } from "./config";
import { branchCount, exploreStrategies, findGate, headOf, pickWinner, promoteAndApply, refs } from "./fork";
import { waitForGate } from "./gate";
import { reward } from "./strategies";
import { executedLabels } from "./trace";

/**
 * ACT 4b — "fork the gate it was parked at."
 *
 * The migration from `pnpm crash` / `pnpm resume` stopped at a human gate. At that gate
 * there were three ways to apply it. Go back to that exact point in the log, fork it three
 * ways, dry-run each on real state, compare, and promote a winner — without touching what
 * already happened. Because a branch is a shared log prefix, none of the work above the
 * gate is repeated: three branches cost three applies and zero model calls.
 */
async function main(): Promise<void> {
  const app = buildApp({ storage: sqliteStorage({ dir: ".data", branching: true }) });
  const parent = await parentExecution(app);
  const gate = await findGate(app, parent);
  const before = await headOf(app, parent);
  console.log(`   gate: event #${gate}   ·   parent head: #${before.sequence} (${before.status})\n`);

  console.log("🔮 PREDICTION: 3 branches → 3 lightning bolts, all SIMULATED applies.");
  console.log("   inspect and assess must NOT re-run. Zero model calls.\n");
  const boltsBefore = executedLabels().length;
  const outcomes = await exploreStrategies(app, parent, gate);
  const ran = executedLabels().slice(boltsBefore);
  const modelCalls = ran.filter((l) => l.includes("LLM")).length;
  console.log(`\n   steps that really executed for 3 branches: ${ran.length}   model calls: ${modelCalls}\n`);

  console.log("   strategy       lock     duration   reversible   score    branch");
  for (const o of outcomes) {
    const p = o.projection;
    console.log(
      `   ${o.strategy.padEnd(12)} ${`${p.lockSeconds}s`.padStart(6)}   ${`${p.durationMinutes}m`.padStart(7)}     ${p.reversible ? "yes" : "no "}        ${reward(p).toFixed(3)}    ${o.branchName} → ${o.executionId}`,
    );
  }

  const after = await headOf(app, parent);
  const untouched = after.sequence === before.sequence && after.status === before.status;
  console.log(`\n   parent ${parent}: head #${after.sequence} (${after.status}) — ${untouched ? "UNTOUCHED" : "CHANGED ?!"}`);

  const winner = pickWinner(outcomes);
  console.log(`\n🏆 promote ${winner.strategy}: fork a commit branch from the same gate, apply it FOR REAL, move main.\n`);
  const commit = await promoteAndApply(app, parent, gate, winner.strategy);
  console.log(`\n   ${commit.output.applied ? "applied" : "NOT applied"} —`, commit.output);

  console.log("\n   refs:");
  for (const r of await refs(app)) {
    const note = r.name === "main" ? "   ← the pointer move IS the promotion" : "";
    console.log(`     ${r.name.padEnd(18)} → ${r.executionId}  @${r.tip}${note}`);
  }
  console.log(`\n   lineage: ${await branchCount(app, parent)} branches forked from ${parent}.`);
  console.log("   The losers stay immutable and independently resumable. There is no merge —");
  console.log("   two divergent histories have no sound join, so loom refuses to fake one.\n");
  console.log(`Inspect a branch:  pnpm exec loom logs --db .data/events.db ${outcomes[0]?.executionId ?? ""}`);

  await app.close();
}

/** The execution the room just watched — or, if there is none, a fresh one run to its gate. */
async function parentExecution(app: LoomApp): Promise<string> {
  if (existsSync(".data/last-execution.txt")) {
    const id = readFileSync(".data/last-execution.txt", "utf8").trim();
    console.log(`▶  forking the execution from pnpm crash / pnpm resume: ${id}`);
    return id;
  }
  console.log("▶  no previous execution — running a fresh migration to its gate (orders / add-index)\n");
  const handle = await app.runtime.start(migrationGuardFlow, { table: "orders", change: "add-index" });
  await waitForGate(handle);
  return handle.executionId;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
