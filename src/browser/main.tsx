import { LoomProvider } from "@loom/renderer-react";
import { createRoot } from "react-dom/client";
import { buildApp } from "../config";
import { App } from "./App";

// The SAME composition root the headless driver (src/main.ts) uses — only the
// storage differs (in-memory in the browser). No flow code changes; we just wrap
// the runtime in <LoomProvider> and render its A2UI surface with React.
const app = buildApp({ storage: { kind: "memory" } });

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

createRoot(root).render(
  <LoomProvider workflowRuntime={app.runtime} projectionRuntime={app.projectionRuntime}>
    <App app={app} />
  </LoomProvider>,
);
