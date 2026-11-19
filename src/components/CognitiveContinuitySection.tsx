import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  History,
  Info,
  Trash2,
} from "lucide-react";
import { CognitiveTimeline } from "../cognitive/cognitiveTimeline";
import { buildContinuitySnapshot } from "../cognitive/continuityEngine";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";

interface CognitiveContinuitySectionProps {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  consent: boolean;
  crisisBlocked: boolean;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  learningEngine: ControlledLearningEngine;
}

export function CognitiveContinuitySection({
  plans,
  missions,
  growthGoals,
  consent,
  crisisBlocked,
  availableMinutes = 20,
  energyLevel = "media",
  learningEngine,
}: CognitiveContinuitySectionProps) {
  const timeline = useMemo(() => new CognitiveTimeline(), []);
  const [timelineVersion, setTimelineVersion] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const snapshot = useMemo(
    () =>
      buildContinuitySnapshot({
        plans,
        missions,
        growthGoals,
        consentEnabled: consent,
        crisisBlocked,
        availableMinutes,
        energyLevel,
        timeline,
        learningEngine,
      }),
    [
      plans,
      missions,
      growthGoals,
      consent,
      crisisBlocked,
      availableMinutes,
      energyLevel,
      timeline,
      learningEngine,
      timelineVersion,
    ]
  );

  function handleExportTimeline() {
    const json = timeline.exportTimelineJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aura-cognitive-timeline-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice("Cronologia cognitiva esportata in JSON.");
  }

  function handleConfirmClearTimeline() {
    timeline.clearTimeline(true);
    setConfirmClear(false);
    setTimelineVersion((v) => v + 1);
    setNotice("Cronologia cognitiva locale cancellata (i dati operativi restano intatti).");
  }

  return (
    <div className="panel" aria-label="Continuità Cognitiva">
      <div className="panel-head">
        <div>
          <span className="eyebrow">CONTINUITÀ COGNITIVA</span>
          <h2>Evoluzione e contesto tra sessioni</h2>
        </div>
        <span className="panel-icon">
          <History size={18} />
        </span>
      </div>

      <p style={{ fontSize: "0.9rem", marginBottom: "0.6rem" }}>
        {snapshot.statusMessage}
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          fontSize: "0.82rem",
          opacity: 0.85,
          marginBottom: "0.75rem",
        }}
      >
        <span>
          Affidabilità media:{" "}
          <strong>{Math.round(snapshot.averageReliability * 100)}%</strong>
        </span>
        <span>
          Eventi in cronologia: <strong>{snapshot.timelineEventsCount}</strong>
        </span>
        <span>
          Memoria AI: <strong>{consent ? "ON" : "OFF (dati operativi separati)"}</strong>
        </span>
      </div>

      {notice && (
        <p style={{ fontSize: "0.84rem", marginBottom: "0.6rem", opacity: 0.9 }}>
          {notice}
        </p>
      )}

      {snapshot.needsClarification && snapshot.clarificationQuestion && (
        <div
          className="safety-box"
          style={{ marginBottom: "0.75rem", fontSize: "0.86rem" }}
        >
          <AlertTriangle size={16} />
          <span>{snapshot.clarificationQuestion}</span>
        </div>
      )}

      {snapshot.goalEvolution.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.35rem" }}>
            Evoluzione obiettivi
          </strong>
          {snapshot.goalEvolution.slice(0, 4).map((g) => (
            <div
              key={g.goalId}
              style={{
                fontSize: "0.84rem",
                padding: "0.45rem 0.6rem",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                marginBottom: "0.35rem",
              }}
            >
              <div>
                <strong>{g.title}</strong> · {g.progressPercent}% ({g.trend.replace(/_/g, " ")})
              </div>
              <div style={{ fontSize: "0.76rem", opacity: 0.78 }}>
                FATTO OSSERVATO · Affidabilità {Math.round(g.reliability * 100)}%
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshot.recentProgress.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.35rem" }}>
            Progressi recenti
          </strong>
          {snapshot.recentProgress.slice(0, 3).map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                fontSize: "0.84rem",
                marginBottom: "0.25rem",
              }}
            >
              <CheckCircle2 size={14} />
              <span>
                <strong>{p.title}:</strong> {p.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      {snapshot.recurringDifficulties.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.35rem" }}>
            Difficoltà individuate
          </strong>
          {snapshot.recurringDifficulties.map((d) => (
            <div
              key={d.id}
              style={{
                fontSize: "0.84rem",
                padding: "0.45rem 0.6rem",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                marginBottom: "0.35rem",
              }}
            >
              <div>
                <strong>{d.label}</strong> ({d.occurrences}) — {d.description}
              </div>
              <div style={{ fontSize: "0.76rem", opacity: 0.78 }}>
                {d.epistemicTag.replace(/_/g, " ").toUpperCase()} · Affidabilità{" "}
                {Math.round(d.reliability * 100)}%
              </div>
            </div>
          ))}
        </div>
      )}

      {showDetails && (
        <div
          style={{
            fontSize: "0.82rem",
            padding: "0.6rem",
            borderRadius: "8px",
            background: "rgba(255,255,255,0.03)",
            marginBottom: "0.75rem",
          }}
        >
          <div style={{ marginBottom: "0.4rem" }}>
            <strong>Contesto recuperato:</strong>
            {snapshot.recoveredOperationalContext.length === 0 ? (
              <span> Nessun elemento operativo attivo.</span>
            ) : (
              <ul style={{ margin: "0.25rem 0 0 1.1rem", padding: 0 }}>
                {snapshot.recoveredOperationalContext.slice(0, 5).map((ctx, idx) => (
                  <li key={idx}>{ctx}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <strong>Opportunità suggerite:</strong>{" "}
            {snapshot.suggestedOpportunities.length > 0
              ? snapshot.suggestedOpportunities
                  .slice(0, 3)
                  .map((o) => o.title)
                  .join(" · ")
              : "Nessuna opportunità prioritaria al momento."}
          </div>
        </div>
      )}

      <div className="aura-continuity-actions">
        <button
          type="button"
          className="aura-continuity-button aura-continuity-button--details"
          onClick={() => setShowDetails((prev) => !prev)}
        >
          <Info size={15} /> {showDetails ? "Nascondi dettagli" : "Mostra dettagli"}
        </button>
        <button
          type="button"
          className="aura-continuity-button aura-continuity-button--export"
          onClick={handleExportTimeline}
        >
          <Download size={15} /> Esporta cronologia
        </button>
        {!confirmClear ? (
          <button
            type="button"
            className="aura-continuity-button aura-continuity-button--delete"
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={15} /> Cancella cronologia
          </button>
        ) : (
          <>
            <button
              type="button"
              className="aura-continuity-button aura-continuity-button--confirm"
              onClick={handleConfirmClearTimeline}
            >
              Conferma cancellazione
            </button>
            <button
              type="button"
              className="aura-continuity-button aura-continuity-button--cancel"
              onClick={() => setConfirmClear(false)}
            >
              Annulla
            </button>
          </>
        )}
      </div>
    </div>
  );
}
