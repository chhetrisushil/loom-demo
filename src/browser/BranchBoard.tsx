import type { BranchRef } from "@loom/event-runtime";
import { useProjection } from "@loom/plugin-renderer-react";
import React, { useEffect, useRef, useState } from "react";
import type { LoomApp } from "../config";
import { type BranchOutcome, branchCount, exploreStrategies, findGate, pickWinner, promoteAndApply, refs } from "../fork";
import { type Strategy, reward } from "../strategies";
import type { UiState } from "./App";

// ── Fork → simulate → compare → promote, as a board ───────────────────────────
// Each card subscribes to ITS OWN branch's surface — a branch is a full execution,
// so the phase stepper and the projection stream in per branch with the same
// projection hook the migration view already uses. Nothing here is UI-only state:
// executionIds come from fork(), refs from the registry, the winner from reward().

interface Card {
  strategy: Strategy;
  executionId: string;
  label: string;
}

export function BranchBoard({
  app,
  parentId,
  onPromoted,
}: {
  app: LoomApp;
  parentId: string;
  /** Fires with the commit branch's executionId once `main` has been moved onto it. */
  onPromoted?: ((commitExecutionId: string) => void) | undefined;
}) {
  const started = useRef(false);
  const [gate, setGate] = useState<number | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [outcomes, setOutcomes] = useState<BranchOutcome[] | null>(null);
  const [commit, setCommit] = useState<Card | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [refList, setRefList] = useState<BranchRef[]>([]);
  const [lineage, setLineage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const g = await findGate(app, parentId);
      setGate(g);
      const out = await exploreStrategies(app, parentId, g, (b) =>
        setCards((c) => [...c, { strategy: b.strategy, executionId: b.executionId, label: `spec/${b.strategy}` }]),
      );
      setOutcomes(out);
      setRefList(await refs(app));
      setLineage(await branchCount(app, parentId));
    })().catch((e: unknown) => setError(String(e)));
  }, [app, parentId]);

  const winner = outcomes ? pickWinner(outcomes).strategy : null;

  const promote = async (strategy: Strategy) => {
    if (gate === null || promoting) return;
    setPromoting(true);
    try {
      const c = await promoteAndApply(app, parentId, gate, strategy);
      setCommit({ strategy, executionId: c.executionId, label: "commit (real apply)" });
      onPromoted?.(c.executionId);
      setRefList(await refs(app));
      setLineage(await branchCount(app, parentId));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div style={styles.board} data-testid="branch-board">
      <div style={styles.boardTitle}>
        Forked at the gate{gate !== null ? ` (event #${gate})` : ""} — three dry runs on real state. The parent above is untouched.
      </div>
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.cards}>
        {cards.map((c) => (
          <BranchCard
            key={c.executionId}
            app={app}
            card={c}
            winner={winner === c.strategy}
            onPromote={outcomes && !commit && !promoting ? () => promote(c.strategy) : undefined}
            disabled={promoting}
          />
        ))}
        {commit && <BranchCard app={app} card={commit} winner={false} />}
      </div>
      {refList.length > 0 && (
        <div style={styles.refs}>
          {refList.map((r) => (
            <div key={r.name} style={styles.ref}>
              <span style={{ ...styles.refName, ...(r.name === "main" ? styles.refMain : {}) }}>{r.name}</span>
              <span style={styles.refTarget}>→ {r.executionId} @{r.tip}</span>
            </div>
          ))}
          <div style={styles.note}>
            {lineage} branches forked from the parent. {commit ? "main now names the applied migration. " : ""}
            Losers stay immutable and resumable — there is no merge.
          </div>
        </div>
      )}
    </div>
  );
}

function BranchCard({
  app,
  card,
  winner,
  onPromote,
  disabled,
}: {
  app: LoomApp;
  card: Card;
  winner: boolean;
  // `| undefined` explicitly: exactOptionalPropertyTypes is on, and the board passes
  // `undefined` for "not promotable yet" rather than omitting the prop.
  onPromote?: (() => void) | undefined;
  disabled?: boolean | undefined;
}) {
  const ui = useProjection<UiState>(app.projectionRuntime, "ui", card.executionId);
  const apply = ui.apply;
  return (
    <div style={{ ...styles.card, ...(winner ? styles.cardWinner : {}) }} data-testid={`branch-${card.strategy}`}>
      <div style={styles.cardHead}>
        <span style={styles.cardLabel}>{card.label}</span>
        <span style={styles.cardPhase}>{ui.phase ?? "forking"}</span>
      </div>
      <div style={styles.cardId}>{card.executionId}</div>
      {apply ? (
        <div style={styles.cardMetrics}>
          <span>lock <b>{apply.lockSeconds}s</b></span>
          <span>duration <b>{apply.durationMinutes}m</b></span>
          <span>{apply.reversible ? "reversible" : "not reversible"}</span>
          <span>score <b>{reward(apply).toFixed(3)}</b></span>
          <span style={styles.cardMode}>{apply.applied ? "APPLIED" : "simulated"}</span>
        </div>
      ) : (
        <div style={styles.cardMetrics}>…</div>
      )}
      {onPromote && apply && (
        <button type="button" style={styles.promote} onClick={onPromote} disabled={disabled}>
          {winner ? "Promote (best score)" : "Promote"}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  board: { display: "flex", flexDirection: "column", gap: 12, padding: "14px 18px", borderRadius: 10, background: "#0f1620", border: "1px solid #232c3b" },
  boardTitle: { fontSize: 13, color: "#cbd5e0", fontWeight: 700 },
  cards: { display: "flex", gap: 12, flexWrap: "wrap" },
  card: { flex: "1 1 200px", padding: 12, borderRadius: 8, background: "#141a24", border: "1px solid #2b3546", display: "flex", flexDirection: "column", gap: 6 },
  cardWinner: { border: "1px solid #38a169", boxShadow: "0 0 0 3px rgba(56,161,105,0.15)" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  cardLabel: { fontWeight: 700, color: "#9ecbff", fontSize: 13 },
  cardPhase: { fontSize: 11, color: "#6b7d95", textTransform: "uppercase", letterSpacing: 0.5 },
  cardId: { fontSize: 10, color: "#4a5568", fontFamily: "monospace", overflowWrap: "anywhere" },
  cardMetrics: { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, color: "#cbd5e0" },
  cardMode: { color: "#b7791f", fontWeight: 700 },
  promote: { marginTop: 6, padding: "8px 12px", borderRadius: 8, border: "none", cursor: "pointer", background: "#3182ce", color: "#fff", fontWeight: 700, fontSize: 13 },
  refs: { display: "flex", flexDirection: "column", gap: 4, fontFamily: "monospace", fontSize: 12 },
  ref: { display: "flex", gap: 10 },
  refName: { minWidth: 140, color: "#a9b7c9" },
  refMain: { color: "#9ae6b4", fontWeight: 700 },
  refTarget: { color: "#6b7d95", overflowWrap: "anywhere" },
  note: { fontFamily: "system-ui, sans-serif", fontSize: 12, color: "#6b7d95", marginTop: 6 },
  error: { color: "#feb2b2", fontSize: 12 },
};
