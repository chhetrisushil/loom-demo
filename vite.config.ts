import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The @loomwork/* packages are linked from the sibling ../loom checkout and ship CommonJS.
// Vite pre-bundles them in dev via optimizeDeps; `vite build` hands them to Rollup,
// whose CommonJS interop needs transformMixedEsModules to trace the named exports
// through the re-export chain.
export default defineConfig({
  plugins: [react()],
  // The linked packages live in the sibling ../loom repo — let Vite read them, and dedupe
  // React so the app and @loomwork/plugin-renderer-react share one copy (no hook errors).
  // Pinned for the presenter's SSH tunnel: fixed port, fail (don't drift to 5174) if it's
  // busy, and bind IPv4 loopback — Vite's default "localhost" lands on [::1] only, so a
  // tunnel aimed at 127.0.0.1 would reach the inspector (127.0.0.1:35789) but not the UI.
  server: { host: "127.0.0.1", port: 5173, strictPort: true, fs: { allow: [".", "../loom"] } },
  resolve: { conditions: ["require", "default"], dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "@loomwork/analytics",
      "@loomwork/app",
      "@loomwork/core",
      "@loomwork/dispatcher",
      "@loomwork/effect-runtime",
      // Browser-safe subpaths only — the package barrels eagerly re-export the
      // SQLite stores (better-sqlite3 / node:fs), which must never enter a browser
      // bundle. This app only uses in-memory storage.
      "@loomwork/event-runtime/memory",
      "@loomwork/event-runtime/sequence",
      "@loomwork/learning",
      "@loomwork/llm",
      "@loomwork/middleware",
      "@loomwork/projection-runtime",
      "@loomwork/plugin-renderer-react",
      "@loomwork/snapshot-runtime/memory",
      "@loomwork/worker-runtime-local",
      "@loomwork/workflow-runtime",
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      // BOTH trees: 1P plugins live under `plugins/` (ADR 0043), not `packages/`, so a
      // pattern covering only `packages/*/dist` silently stops transforming the renderer and
      // Rollup fails with "useProjection is not exported by …/plugins/renderer-react/dist".
      // The browser-safe subpaths (`@loomwork/event-runtime/memory`, `.../sequence`,
      // `@loomwork/snapshot-runtime/memory`) are hand-written CommonJS shims that sit BESIDE
      // `dist/`, not inside it, so the two dist patterns miss them and Rollup reports
      // "InMemoryAsyncEventStore is not exported by …/event-runtime/memory.js".
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/, /packages\/[^/]+\/[^/]+\.js$/],
    },
  },
});
