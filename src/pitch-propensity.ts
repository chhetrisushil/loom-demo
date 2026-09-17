import { rmSync } from "node:fs";
import { sqliteStorage } from "@loom/plugin-sqlite";
import { buildApp } from "./config";
import { coverage, evaluate, formatCoverage, formatEvalReport, headline, readLog, serveBatch } from "./learn";
import { backwards, sizeAware } from "./policy";
import { quietTrace } from "./trace";

/**
 * ACT 4c — "what would a different choice have scored?"
 *
 * Everyone can replay what the model said. The claim here is narrower and checkable:
 * because each strategy decision was logged WITH how sure the policy was, a policy that
 * never ran can be scored against this log — and the same executions logged without
 * that number cannot be. You either wrote it down at the time or you didn't.
 *
 * Default output is the stage version: one candidate, three numbers, then the blind
 * contrast. `--verbose` adds the full reports and the backwards control, for Q&A.
 */
const N = 48;
const VERBOSE = process.argv.includes("--verbose");
const indent = (s: string) => s.split("\n").map((l) => `   ${l}`).join("\n");

async function main(): Promise<void> {
  // The decision under study is the STRATEGY, not the risk rating — use the offline reviewer.
  delete process.env.GEMINI_API_KEY;
  quietTrace(true);
  rmSync(".data/learn", { recursive: true, force: true });
  rmSync(".data/learn-blind", { recursive: true, force: true });

  console.log(`▶  ${N} migrations. The DBA approves but never says HOW — a policy picks the strategy,`);
  console.log("   and writes down how sure it was. (offline reviewer, no Gemini; the flow, gate and log are real)\n");
  const app = buildApp({ storage: sqliteStorage({ dir: ".data/learn" }) });
  await serveBatch(app, N, { prefix: "learn-" });
  const events = await readLog(app, "learn-");
  const cov = coverage(events);
  console.log(`   ${cov.executions} executions · ${cov.decisions} decisions · ${cov.withPropensity} carry how-sure-it-was\n`);
  if (VERBOSE) console.log(`${formatCoverage(cov)}\n`);

  console.log("🔮 PREDICTION: a size-aware policy — one that NEVER RAN — scores higher than what did.\n");
  const candidate = evaluate(events, sizeAware);
  console.log(indent(VERBOSE ? formatEvalReport(candidate) : headline(candidate)));
  console.log("\n   Nothing re-ran. The candidate was only asked what it would have chosen.\n");

  if (VERBOSE) {
    console.log("   (control) a backwards policy — chunk the small tables, lock the big ones — must score LOWER:\n");
    console.log(indent(formatEvalReport(evaluate(events, backwards))));
    console.log("");
  }

  console.log(`▶  the same ${N} migrations, same choices, same rewards — logged WITHOUT how sure it was\n`);
  const blindApp = buildApp({ storage: sqliteStorage({ dir: ".data/learn-blind" }) });
  await serveBatch(blindApp, N, { blind: true, prefix: "blind-" });
  const blind = await readLog(blindApp, "blind-");
  const blindCov = coverage(blind);
  console.log(`   ${blindCov.executions} executions · ${blindCov.decisions} decisions · ${blindCov.withPropensity} carry how-sure-it-was\n`);
  const blindReport = evaluate(blind, sizeAware);
  console.log(indent(VERBOSE ? formatEvalReport(blindReport) : headline(blindReport)));
  console.log("\n   Same executions. Same rewards. Same dashboard. Nothing can be learned from it.");
  console.log("   That number is the propensity. You either wrote it down at the time, or you didn't.\n");
  console.log("Checkable:  pnpm exec loom learn report --db .data/learn/events.db");
  if (!VERBOSE) console.log("Full reports + the control policy:  pnpm propensity --verbose");

  await app.close();
  await blindApp.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
