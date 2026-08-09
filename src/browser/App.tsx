import { useProjection } from "@loom/plugin-renderer-react";
import React, { useCallback, useState } from "react";
import { migrationGuardFlow } from "../../app/flows/migration-guard/flow";
import type { LoomApp } from "../config";

// The shape the flow writes to the "ui" surface via ctx.ui.set / ctx.ui.merge.
interface UiState {
  phase?: "inspecting" | "assessing" | "awaiting-approval" | "applying" | "applied" | "rejected";
  table?: { name: string; rows: number; sizeGb: number; estLockSeconds: number };
  assessment?: { risk: "low" | "medium" | "high"; rationale: string };
}

const CHANGES = ["add-nullable-column", "add-index", "drop-column", "backfill"] as const;
type Change = (typeof CHANGES)[number];

const PHASES: UiState["phase"][] = [
  "inspecting",
  "assessing",
  "awaiting-approval",
  "applying",
  "applied",
];

export function App({ app }: { app: LoomApp }) {
  const [table, setTable] = useState("orders");
  const [change, setChange] = useState<Change>("add-index");
  const [apiKey, setApiKey] = useState("");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [seq, setSeq] = useState(0); // bumps executionId suffix so each run is fresh

  const run = useCallback(() => {
    // The presenter can paste a Gemini key to make a REAL call; empty → offline
    // scripted provider (the demo still works with no network).
    (globalThis as { __GEMINI_API_KEY__?: string }).__GEMINI_API_KEY__ = apiKey.trim();
    const id = `mig-${seq}`;
    setExecutionId(id);
    app.runtime
      .start(migrationGuardFlow, { table, change }, { executionId: id })
      .catch((err: unknown) => console.error(err));
  }, [app, table, change, apiKey, seq]);

  const reset = useCallback(() => {
    setExecutionId(null);
    setSeq((n) => n + 1);
  }, []);

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <h1 style={styles.title}>Schema Migration Guard</h1>
        <div style={styles.subtitle}>
          Inspect → Gemini rates risk → human gate on risky changes → apply · same flow as the
          headless CLI, only the renderer changed
        </div>
      </header>

      <div style={styles.form}>
        <label style={styles.field}>
          <span style={styles.label}>Table</span>
          <input
            style={styles.input}
            value={table}
            onChange={(e) => setTable(e.target.value)}
            disabled={!!executionId}
          />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>Migration</span>
          <select
            style={styles.input}
            value={change}
            onChange={(e) => setChange(e.target.value as Change)}
            disabled={!!executionId}
          >
            {CHANGES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.label}>Gemini API key (optional)</span>
          <input
            style={styles.input}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="empty = offline demo"
            type="password"
            disabled={!!executionId}
          />
        </label>
        {executionId ? (
          <button type="button" style={styles.secondaryBtn} onClick={reset}>
            New run
          </button>
        ) : (
          <button type="button" style={styles.runBtn} onClick={run}>
            Run migration
          </button>
        )}
      </div>

      {executionId && (
        <MigrationView
          app={app}
          executionId={executionId}
          onDecide={(approved) =>
            app.runtime
              .resume(executionId, {
                eventType: "ApprovalGranted",
                payload: { approved, approvedBy: "you@demo" },
              })
              .catch((err: unknown) => console.error(err))
          }
        />
      )}
    </div>
  );
}

function MigrationView({
  app,
  executionId,
  onDecide,
}: {
  app: LoomApp;
  executionId: string;
  onDecide: (approved: boolean) => void;
}) {
  // Subscribes to the durable "ui" surface — the exact patches the flow emits.
  const ui = useProjection<UiState>(app.projectionRuntime, "ui", executionId);
  const phase = ui.phase;
  const activeIdx = PHASES.indexOf(phase);

  return (
    <div style={styles.panel}>
      <div style={styles.stepper}>
        {PHASES.map((p, i) => {
          const done = phase === "applied" || (activeIdx > i && phase !== "rejected");
          const active = p === phase;
          return (
            <div key={p} style={styles.step}>
              <div
                style={{
                  ...styles.dot,
                  ...(active ? styles.dotActive : {}),
                  ...(done ? styles.dotDone : {}),
                }}
              />
              <span style={{ ...styles.stepLabel, ...(active ? styles.stepLabelActive : {}) }}>
                {p}
              </span>
            </div>
          );
        })}
      </div>

      {ui.table && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Table inspected</div>
          <div style={styles.metrics}>
            <Metric label="table" value={ui.table.name} />
            <Metric label="rows" value={ui.table.rows.toLocaleString()} />
            <Metric label="size" value={`${ui.table.sizeGb} GB`} />
            <Metric label="est. lock" value={`${ui.table.estLockSeconds}s`} />
          </div>
        </div>
      )}

      {ui.assessment && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>
            Gemini assessment
            <span style={{ ...styles.riskTag, ...riskTagStyle(ui.assessment.risk) }}>
              {ui.assessment.risk} risk
            </span>
          </div>
          <div style={styles.rationale}>{ui.assessment.rationale}</div>
        </div>
      )}

      {phase === "awaiting-approval" && (
        <div style={styles.approvalBar} data-testid="approval-bar">
          <div style={{ flex: 1, fontSize: 14 }}>
            A human DBA must sign off before this migration is applied.
          </div>
          <button
            type="button"
            style={{ ...styles.runBtn, background: "#38a169" }}
            onClick={() => onDecide(true)}
          >
            Approve
          </button>
          <button
            type="button"
            style={{ ...styles.secondaryBtn, background: "#4a5568", color: "#fff" }}
            onClick={() => onDecide(false)}
          >
            Reject
          </button>
        </div>
      )}

      {phase === "applied" && <div style={styles.banner}>✅ Migration applied.</div>}
      {phase === "rejected" && (
        <div style={{ ...styles.banner, background: "#3b1c1c", color: "#feb2b2" }}>
          ✋ Migration rejected — nothing was applied.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <div style={styles.metricValue}>{value}</div>
      <div style={styles.metricLabel}>{label}</div>
    </div>
  );
}

function riskTagStyle(risk: "low" | "medium" | "high"): React.CSSProperties {
  const bg = risk === "high" ? "#9b2c2c" : risk === "medium" ? "#b7791f" : "#276749";
  return { background: bg };
}

const styles: Record<string, React.CSSProperties> = {
  shell: { maxWidth: 820, margin: "0 auto" },
  header: { borderBottom: "1px solid #232c3b", paddingBottom: 16, marginBottom: 20 },
  title: { fontSize: 24, fontWeight: 800, color: "#9ecbff" },
  subtitle: { fontSize: 13, color: "#6b7d95", marginTop: 4, maxWidth: 640 },
  form: {
    display: "flex",
    gap: 12,
    alignItems: "flex-end",
    flexWrap: "wrap",
    marginBottom: 22,
  },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 11, color: "#6b7d95", textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #232c3b",
    background: "#0f1620",
    color: "#e2e8f0",
    fontSize: 14,
    minWidth: 180,
  },
  runBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: "#3182ce",
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
  },
  secondaryBtn: {
    padding: "10px 18px",
    borderRadius: 8,
    border: "1px solid #2b3546",
    cursor: "pointer",
    background: "#141a24",
    color: "#a9b7c9",
    fontWeight: 600,
    fontSize: 14,
  },
  panel: { display: "flex", flexDirection: "column", gap: 16 },
  stepper: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 },
  step: { display: "flex", alignItems: "center", gap: 8, marginRight: 14 },
  dot: { width: 12, height: 12, borderRadius: "50%", background: "#232c3b" },
  dotActive: { background: "#3182ce", boxShadow: "0 0 0 4px rgba(49,130,206,0.2)" },
  dotDone: { background: "#38a169" },
  stepLabel: { fontSize: 12, color: "#6b7d95" },
  stepLabelActive: { color: "#9ecbff", fontWeight: 700 },
  card: {
    padding: "14px 18px",
    borderRadius: 10,
    background: "#0f1620",
    border: "1px solid #232c3b",
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#cbd5e0",
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  metrics: { display: "flex", gap: 24, flexWrap: "wrap" },
  metric: {},
  metricValue: { fontSize: 20, fontWeight: 700, color: "#e2e8f0" },
  metricLabel: { fontSize: 11, color: "#6b7d95", textTransform: "uppercase", letterSpacing: 0.5 },
  rationale: { fontSize: 14, color: "#cbd5e0", lineHeight: 1.5 },
  riskTag: {
    color: "#fff",
    borderRadius: 10,
    padding: "2px 9px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  approvalBar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px 18px",
    borderRadius: 10,
    background: "#2b210e",
    border: "1px solid #b7791f",
  },
  banner: {
    padding: "12px 18px",
    borderRadius: 10,
    background: "#12241a",
    color: "#9ae6b4",
    fontSize: 15,
    fontWeight: 600,
  },
};
