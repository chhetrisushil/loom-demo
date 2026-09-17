import { InMemoryAsyncEventStore, InMemoryBranchRegistry } from "@loom/event-runtime/memory";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime/memory";
import type { StorageOpt } from "./config";

/**
 * In-memory storage WITH a branch registry. `{ kind: "memory" }` wires only the event
 * and snapshot stores, and `fork()` needs somewhere to record lineage and refs. Used by
 * the browser (src/browser/main.tsx) and the tests; the terminal uses sqliteStorage().
 */
export function memoryStorage(): StorageOpt {
  return {
    kind: "custom",
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    branchRegistry: new InMemoryBranchRegistry(),
  };
}
