import type { ExecutionHandle } from "@loom/workflow-runtime";

type ExecutionState = ReturnType<ExecutionHandle["getState"]>;

/**
 * Wait for the execution to reach its human gate — and *fail loudly* if it never
 * gets there. `waitForSuspend()` alone is a trap for a driver script: when a step
 * fails (or the flow completes without suspending), the runtime settles only
 * `waitForCompletion()`, the suspend promise stays pending forever, Node's event
 * loop drains, and the process exits 0 having printed nothing. Racing the two
 * turns that silent exit into the real error (e.g. a rejected Gemini key).
 */
export function waitForGate(handle: ExecutionHandle): Promise<ExecutionState> {
  return Promise.race([
    handle.waitForSuspend(),
    handle.waitForCompletion().then((state) => {
      throw new Error(
        `execution ${handle.executionId} finished with status "${state.status}" ` +
          `without reaching the approval gate (was the risk rated low?)`,
      );
    }),
  ]);
}
