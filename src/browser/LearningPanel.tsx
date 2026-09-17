import React, { useState } from "react";
import type { LoomApp } from "../config";
import { coverage, evaluate, formatCoverage, formatEvalReport, headline, readLog, serveBatch } from "../learn";
import { backwards, sizeAware } from "../policy";
import { quietTrace } from "../trace";

// ── Decisions that carry their propensity, in the tab ─────────────────────────
// Same helpers as `pnpm propensity`; the browser's in-memory log is the dataset.

const N = 48;

interface Result {
  blind: boolean;
  carry: number;
  headline: string;
  coverage: string;
  candidate: string;
  control: string;
}

export function LearningPanel({ app }: { app: LoomApp }) {
  const [blind, setBlind] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [batch, setBatch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const serve = async () => {
    const prefix = `learn-${batch}-`;
    setBatch((b) => b + 1);
    setResult(null);
    setError(null);
    quietTrace(true);
    try {
      await serveBatch(app, N, { blind, prefix, onProgress: (d, t) => setProgress([d, t]) });
      const events = await readLog(app, prefix);
      const cov = coverage(events);
      const candidate = evaluate(events, sizeAware);
      setResult({
        blind,
        carry: cov.withPropensity,
        headline: headline(candidate),
        coverage: formatCoverage(cov),
        candidate: formatEvalReport(candidate),
        control: formatEvalReport(evaluate(events, backwards)),
      });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      quietTrace(false);
      setProgress(null);
    }
  };

  return (
    <div style={styles.panel} data-testid="learning-panel">
      <div style={styles.intro}>
        When the DBA approves without saying how, a policy picks the strategy — and writes down how sure it was.
        Serve a batch, then score a policy that <b>never ran</b> against that log.
      </div>
      <div style={styles.controls}>
        <button type="button" style={styles.runBtn} onClick={serve} disabled={progress !== null}>
          {progress ? `Serving ${progress[0]} / ${progress[1]}…` : `Serve ${N} migrations`}
        </button>
        <label style={styles.check}>
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} disabled={progress !== null} />
          log blind — same choices, without how sure it was
        </label>
      </div>
      {error && <div style={styles.error}>{error}</div>}
      {result && (
        <div style={styles.reports}>
          <div style={styles.card}>
            <div style={styles.cardTitle}>
              {N} decisions · <b>{result.carry}</b> carry how-sure-it-was
            </div>
            <div style={styles.cardTitle}>Size-aware policy — never ran</div>
            <pre style={styles.headline}>{result.headline}</pre>
            <div style={styles.moral}>
              {result.blind
                ? "Same executions, same rewards, same dashboard. Nothing can be learned from it. That number is the propensity — you either wrote it down at the time, or you didn't."
                : "Nothing re-ran. The candidate was only asked what it would have chosen; the estimate reweights the steps it agrees with by 1/propensity."}
            </div>
          </div>
          <details style={styles.details}>
            <summary style={styles.summary}>Full reports and the control policy (for Q&A)</summary>
            <Report title={result.blind ? "What a blind log can teach" : "What the log can teach"} body={result.coverage} />
            <Report title="Candidate: size-aware v2 — never ran" body={result.candidate} />
            <Report title="Control: backwards v0 — never ran (must score lower)" body={result.control} />
          </details>
        </div>
      )}
    </div>
  );
}

function Report({ title, body }: { title: string; body: string }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <pre style={styles.pre}>{body}</pre>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { display: "flex", flexDirection: "column", gap: 14 },
  intro: { fontSize: 14, color: "#cbd5e0", lineHeight: 1.5, maxWidth: 680 },
  controls: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" },
  runBtn: { padding: "10px 20px", borderRadius: 8, border: "none", cursor: "pointer", background: "#3182ce", color: "#fff", fontWeight: 700, fontSize: 14 },
  check: { display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "#a9b7c9" },
  reports: { display: "flex", flexDirection: "column", gap: 12 },
  card: { padding: "14px 18px", borderRadius: 10, background: "#0f1620", border: "1px solid #232c3b", display: "flex", flexDirection: "column", gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: 700, color: "#cbd5e0" },
  headline: { margin: 0, fontSize: 18, color: "#e2e8f0", whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 },
  pre: { margin: 0, fontSize: 12, color: "#e2e8f0", whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace" },
  moral: { fontSize: 13, color: "#9ae6b4", lineHeight: 1.5 },
  details: { display: "flex", flexDirection: "column", gap: 10 },
  summary: { cursor: "pointer", fontSize: 12, color: "#6b7d95" },
  error: { color: "#feb2b2", fontSize: 12 },
};
