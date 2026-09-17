import { readFileSync } from "node:fs";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { buildApp, type LoomApp } from "./config";
import { executedLabels } from "./trace";

/**
 * ACT 3b — "a different process finishes the job."
 *
 * This process never saw the migration start. It has no memory, no handle, no
 * in-flight promise — the previous one was SIGKILLed. All it has is the event log
 * on disk and an id. It approves the gate and the execution continues from exactly
 * where it stopped.
 *
 * The proof is what does NOT print: `inspect` and `assess` emit no ⚡ line here,
 * because completed effects are served from the log, not re-run. Only `apply` —
 * the work that hadn't happened yet — actually executes.
 */
async function main(): Promise<void> {
  const executionId = readFileSync(".data/last-execution.txt", "utf8").trim();

  console.log("🆕 COLD START — new process, empty memory.");
  console.log(`   All it was given: the log at .data/events.db + id ${executionId}\n`);

  const app = buildApp({ storage: sqliteStorage({ dir: ".data" }) });

  console.log("✅ DBA approves. Resuming…\n");

  const resumed = await app.runtime.resume(executionId, {
    eventType: "ApprovalGranted",
    payload: { approved: true, approvedBy: "ada@example.com", strategy: "direct-ddl" },
  });
  const done = await resumed.waitForCompletion();

  console.log(`\n🎉 ${done.status} —`, done.variables._output);
  console.log("   surface:", surface(app, executionId));

  const ran = executedLabels();
  console.log(`\n   steps that really executed in THIS process: ${ran.length}`);
  for (const l of ran) console.log(`     • ${l}`);
  console.log("   inspect + assess did NOT re-run — they were served from the log.");
  console.log("   The expensive model call was paid for exactly once.\n");
  console.log(`Now look at the whole story:  pnpm exec loom logs --db .data/events.db ${executionId}`);

  await app.close();
}

function surface(app: LoomApp, executionId: string): unknown {
  return app.projectionRuntime.getState("ui", executionId);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
