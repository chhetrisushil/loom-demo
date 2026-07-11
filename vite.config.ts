import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The @loom/* packages are linked (link:../loom/packages/*) and ship CommonJS.
// Vite pre-bundles them in dev via optimizeDeps; `vite build` hands them to Rollup,
// whose CommonJS interop needs transformMixedEsModules to trace the named exports
// through the re-export chain.
export default defineConfig({
  plugins: [react()],
  // The linked packages live in the sibling ../loom repo — let Vite read them, and
  // dedupe React so the app and @loom/renderer-react share one copy (no hook errors).
  server: { fs: { allow: [".", "../loom"] } },
  resolve: { conditions: ["require", "default"], dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "@loom/app",
      "@loom/core",
      "@loom/dispatcher",
      "@loom/effect-runtime",
      // Browser-safe subpaths only — the package barrels eagerly re-export the
      // SQLite stores (better-sqlite3 / node:fs), which must never enter a browser
      // bundle. This app only uses in-memory storage.
      "@loom/event-runtime/memory",
      "@loom/event-runtime/sequence",
      "@loom/llm",
      "@loom/middleware",
      "@loom/projection-runtime",
      "@loom/renderer-react",
      "@loom/snapshot-runtime/memory",
      "@loom/worker-runtime-local",
      "@loom/workflow-runtime",
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/],
    },
  },
});
