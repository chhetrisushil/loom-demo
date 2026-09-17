/**
 * A stage prop, not a framework feature.
 *
 * Each step handler calls `didRun()` when it *actually executes*. Because a
 * replayed effect is served from the event log and its handler is never invoked,
 * these lines only appear for real work. That makes memoization visible: run the
 * flow to the approval gate in one process, kill it, resume in a *fresh* process,
 * and `inspect` / `assess` print nothing the second time — they were not re-run.
 *
 * Counting them is the whole proof. Nothing here is imported by the kernel.
 */
let executed: string[] = [];
let quiet = false;

export function didRun(label: string): void {
  executed.push(label);
  if (!quiet) console.log(`   ⚡ EXECUTED  ${label}   ← real work: time and money spent`);
}

export function executedLabels(): readonly string[] {
  return executed;
}

export function resetTrace(): void {
  executed = [];
}

/** Keep counting, stop printing — a 48-migration batch would otherwise print 150 lines. */
export function quietTrace(on: boolean): void {
  quiet = on;
}
