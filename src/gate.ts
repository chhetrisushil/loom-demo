import type { ExecutionHandle } from "@loom/workflow-runtime";

type ExecutionState = ReturnType<ExecutionHandle["getState"]>;

/**
 * Wait for the execution to reach its human gate — and *fail loudly* if it never
 * gets there. When a step fails (or the flow completes without suspending),
 * `waitForSuspend()` rejects with a generic `ExecutionTerminatedError` (loom ADR
 * 0135); racing it against `waitForCompletion()` surfaces the real error instead
 * (e.g. a rejected Gemini key), or says the gate was skipped.
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
