import { writeFileSync, mkdirSync } from "node:fs";
import { migrationGuardFlow } from "../app/flows/migration-guard/flow";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { buildApp, type LoomApp } from "./config";
import { executedLabels } from "./trace";
import { waitForGate } from "./gate";

/**
 * ACT 3a — "the pod dies."
 *
 * Starts the migration, lets it reach the durable human gate, and then kills this
 * process with SIGKILL: uncatchable, no cleanup handler, no graceful shutdown, no
 * chance to flush anything in userland. Whatever survives is what the log already
 * committed.
 *
 * Then run `pnpm resume` — a brand-new process — and it continues from here.
 */
async function main(): Promise<void> {
  const app = buildApp({ storage: sqliteStorage({ dir: ".data" }) });

  console.log("▶  starting migration  orders / add-index  (48M rows)\n");

  const handle = await app.runtime.start(migrationGuardFlow, {
    table: "orders",
    change: "add-index",
  });

  const suspended = await waitForGate(handle);

  console.log(`\n⏸  SUSPENDED at event #${suspended.sequence} — waiting for a human DBA`);
  console.log("   surface:", surface(app, handle.executionId));
  console.log(`\n   steps that really executed in THIS process: ${executedLabels().length}`);
  for (const l of executedLabels()) console.log(`     • ${l}`);

  // Hand the id to the next process the way a real system would: it's in the log.
  mkdirSync(".data", { recursive: true });
  writeFileSync(".data/last-execution.txt", handle.executionId);

  console.log(`\n   executionId: ${handle.executionId}`);
  console.log("   the log is on disk at .data/events.db — that IS the state\n");
  console.log("💀 SIGKILL — this process is going away now. Nothing gets to clean up.");
  console.log("   Next:  pnpm resume\n");

  // Uncatchable. No finally block, no close(), no flush. A pod being reclaimed.
  process.kill(process.pid, "SIGKILL");
}

function surface(app: LoomApp, executionId: string): unknown {
  return app.projectionRuntime.getState("ui", executionId);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
