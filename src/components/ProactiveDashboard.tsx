import { useMemo, useState } from "react";
import {
  Bell,
  Check,
  Clock,
  Download,
  Lightbulb,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import { generateContextualSuggestions } from "../proactive/contextualSuggestionEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import {
  generatePriorityProposals,
  transitionPriorityProposalStatus,
} from "../proactive/dynamicPriorityEngine";
import { analyzeHabitPatterns } from "../proactive/habitPatternEngine";
import { runPredictiveAnalysis } from "../proactive/predictiveEngine";
import {
  snoozeSuggestion,
  transitionSuggestionStatus,
} from "../proactive/proactiveEngine";
import {
  loadPersistedProactiveMode,
  ProactiveScheduler,
  savePersistedProactiveMode,
} from "../proactive/proactiveScheduler";
import type {
  EpistemicTag,
  HabitPattern,
  PredictiveAnalysisResult,
  PriorityProposal,
  ProactiveMode,
  ProactiveSuggestion,
} from "../proactive/types";
import { AutonomousIntelligencePanel } from "./AutonomousIntelligencePanel";
import { CognitiveContinuitySection } from "./CognitiveContinuitySection";
import { CognitiveEvolutionDashboard } from "./CognitiveEvolutionDashboard";
import { MetaCognitiveDashboard } from "./MetaCognitiveDashboard";
import { UnifiedProactivePanel } from "./UnifiedProactivePanel";

interface ProactiveDashboardProps {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  consent: boolean;
  crisisBlocked: boolean;
}

const EPISTEMIC_LABELS: Record<EpistemicTag, string> = {
  fatto_osservato: "Fatto osservato",
  interpretazione_prudente: "Interpretazione prudente",
  ipotesi_da_verificare: "Ipotesi da verificare",
};

const PRIORITY_COLORS: Record<string, string> = {
  alta: "#ef4444",
  media: "#f59e0b",
  bassa: "#10b981",
};

function getCategoryFromKey(dedupeKey: string): string {
  const idx = dedupeKey.indexOf(":");
  return idx > 0 ? dedupeKey.slice(0, idx) : "general";
}

export function ProactiveDashboard({
  plans,
  missions,
  growthGoals,
  consent,
  crisisBlocked,
}: ProactiveDashboardProps) {
  const [mode, setMode] = useState<ProactiveMode>(() => loadPersistedProactiveMode());
  const scheduler = useMemo(() => new ProactiveScheduler({ mode }), []);
  const learningEngine = useMemo(() => new ControlledLearningEngine(true), []);

  const [suspended, setSuspended] = useState(false);
  const [learningEnabled, setLearningEnabled] = useState(true);
  const [learningCount, setLearningCount] = useState(0);

  const [suggestions, setSuggestions] = useState<ProactiveSuggestion[]>([]);
  const [predictive, setPredictive] = useState<PredictiveAnalysisResult | null>(null);
  const [habits, setHabits] = useState<HabitPattern[]>([]);
  const [priorityProposals, setPriorityProposals] = useState<PriorityProposal[]>([]);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function handleChangeMode(nextMode: ProactiveMode) {
    scheduler.setMode(nextMode);
    savePersistedProactiveMode(nextMode);
    setMode(nextMode);
    setNotice(
      nextMode === "PASSIVE"
        ? "Modalità PASSIVE attiva: AURA analizza solo quando lo richiedi."
        : nextMode === "ASSISTED"
        ? "Modalità ASSISTED attiva: suggerimenti preparati solo all'apertura controllata dell'app."
        : "Modalità USER-AUTHORIZED selezionata: eventuali azioni controllate richiedono comunque permesso granulare esplicito."
    );
  }

  function handleToggleSuspend() {
    if (suspended) {
      scheduler.resume();
      setSuspended(false);
      setNotice("Motore proattivo riattivato.");
    } else {
      scheduler.suspend();
      setSuspended(true);
      setNotice("Suggerimenti proattivi sospesi completamente.");
    }
  }

  function handleToggleLearning() {
    const next = !learningEnabled;
    learningEngine.setEnabled(next);
    setLearningEnabled(next);
    setNotice(
      next
        ? "Apprendimento controllato attivato (solo locale, nessun profilo psicologico)."
        : "Apprendimento controllato disattivato."
    );
  }

  function handleExportLearning() {
    const json = learningEngine.exportLearningJson();
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aura-apprendimento-proattivo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function handleClearLearning() {
    learningEngine.clearLearningData();
    setLearningCount(0);
    setNotice("Dati di apprendimento controllato eliminati.");
  }

  function handleRunAnalysis() {
    if (crisisBlocked) return;
    if (suspended) {
      setNotice("Il motore proattivo è sospeso. Riattivalo per generare analisi.");
      return;
    }

    const input = {
      plans,
      missions,
      growthGoals,
      consentEnabled: consent,
      crisisBlocked,
      existingSuggestions: suggestions,
    };

    const contextual = generateContextualSuggestions(input, learningEngine);
    const predRes = runPredictiveAnalysis(input);
    const habitRes = analyzeHabitPatterns(input);
    const prioRes = generatePriorityProposals(input);

    setPredictive(predRes);
    setHabits(habitRes);
    setPriorityProposals(prioRes);
    setLastAnalyzedAt(predRes.generatedAt);

    if (contextual.length > 0) {
      setSuggestions((prev) => [...contextual, ...prev]);
      setNotice(
        `Analisi V1.1 completata: ${contextual.length} nuovi suggerimenti, ${predRes.alerts.length} previsioni, ${prioRes.length} proposte di priorità.`
      );
    } else {
      setNotice("Analisi V1.1 completata: nessun nuovo suggerimento duplicato.");
    }
  }

  function handleSuggestionAction(
    sug: ProactiveSuggestion,
    action: "accepted" | "rejected" | "completed" | "snoozed"
  ) {
    learningEngine.recordInteraction(getCategoryFromKey(sug.dedupeKey), action);
    setLearningCount(learningEngine.getInteractionCount());
    if (action === "snoozed") {
      setSuggestions((prev) => snoozeSuggestion(prev, sug.id, 4));
    } else {
      setSuggestions((prev) => transitionSuggestionStatus(prev, sug.id, action));
    }
  }

  const activeCount = suggestions.filter(
    (s) => s.status === "proposed" || s.status === "accepted"
  ).length;
  const completedCount = suggestions.filter((s) => s.status === "completed").length;

  return (
    <section className="content" aria-label="AURA Proactive V1.1">
      <div className="page-heading">
        <span className="eyebrow">AURA PROACTIVE V1.1 / PREDITTIVITÀ E PRIORITÀ</span>
        <h1>Intelligenza proattiva.</h1>
        <p>
          Previsioni locali, schemi ricorrenti, proposte di priorità e suggerimenti contestuali — sempre sotto il tuo controllo, senza modifiche automatiche ai piani.
        </p>
        <div className="aura-meta-jump-row">
          <button
            type="button"
            className="aura-meta-btn"
            onClick={() =>
              document
                .getElementById("aura-metacognitive-section")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            Vai a Meta-Cognitive Intelligence V1
          </button>
        </div>
      </div>

      {crisisBlocked && (
        <div className="safety-box" role="alert">
          <ShieldCheck size={18} />
          <span>
            Il Safety Engine ha la priorità: l&apos;intelligenza proattiva e predittiva è sospesa in questa sessione.
          </span>
        </div>
      )}

      {/* Controlli proattività e apprendimento */}
      <div className="panel" style={{ display: "grid", gap: "12px" }}>
        <div className="panel-head">
          <div>
            <span className="eyebrow">CONTROLLO UTENTE · MODALITÀ {mode}</span>
            <h2>Configura proattività e apprendimento</h2>
          </div>
          <span className="panel-icon"><Bell size={19} /></span>
        </div>

        <div className="aura-mode-group" role="group" aria-label="Modalità di autonomia proattiva">
          {(["PASSIVE", "ASSISTED", "USER-AUTHORIZED"] as ProactiveMode[]).map((m) => {
            const isSelected = mode === m;
            return (
              <button
                key={m}
                type="button"
                className={`aura-mode-btn ${isSelected ? "is-selected" : ""}`}
                aria-pressed={isSelected}
                data-selected={isSelected ? "true" : "false"}
                onClick={() => handleChangeMode(m)}
              >
                {m}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            className="primary-btn"
            disabled={crisisBlocked || suspended}
            onClick={handleRunAnalysis}
          >
            <RefreshCw size={15} /> Analizza ora
          </button>

          <button type="button" className="mood" onClick={handleToggleSuspend}>
            {suspended ? (
              <>
                <Play size={14} /> Riattiva suggerimenti
              </>
            ) : (
              <>
                <Pause size={14} /> Sospendi suggerimenti
              </>
            )}
          </button>

          <button type="button" className="mood" onClick={handleToggleLearning}>
            Apprendimento: {learningEnabled ? "ON" : "OFF"} ({learningCount})
          </button>

          <button type="button" className="text-btn" onClick={handleExportLearning}>
            <Download size={14} /> Esporta apprendimento
          </button>

          {learningCount > 0 && (
            <button type="button" className="text-btn" onClick={handleClearLearning}>
              <Trash2 size={14} /> Cancella apprendimento
            </button>
          )}
        </div>

        <span style={{ fontSize: "12px", opacity: 0.8 }}>
          Attivi: {activeCount} · Completati: {completedCount} · Memoria AI:{" "}
          {consent ? "Attiva" : "Disattivata (analisi 100% locale)"}
          {lastAnalyzedAt
            ? ` · Ultima analisi: ${new Date(lastAnalyzedAt).toLocaleTimeString("it-IT")}`
            : ""}
        </span>

        {notice && (
          <p style={{ margin: 0, fontSize: "13px", opacity: 0.9 }}>{notice}</p>
        )}
      </div>

      {/* Previsioni + Schemi ricorrenti */}
      {(predictive || habits.length > 0) && (
        <div className="grid two">
          <div className="panel" style={{ display: "grid", gap: "8px" }}>
            <span className="eyebrow">PREVISIONI DETERMINISTICHE</span>
            {predictive?.insufficientData ? (
              <p style={{ margin: 0, fontSize: "13px", opacity: 0.85 }}>
                {predictive.statusMessage}
              </p>
            ) : predictive && predictive.alerts.length > 0 ? (
              predictive.alerts.map((alert) => (
                <div
                  key={alert.id}
                  style={{
                    padding: "8px 10px",
                    borderRadius: "8px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                    <strong>{alert.title}</strong>
                    <span style={{ fontSize: "11px", color: PRIORITY_COLORS[alert.riskLevel] }}>
                      {EPISTEMIC_LABELS[alert.epistemicTag]} · {Math.round(alert.confidence * 100)}%
                    </span>
                  </div>
                  <p style={{ margin: "3px 0 0", opacity: 0.85, fontSize: "12px" }}>
                    {alert.description}
                  </p>
                  <span style={{ fontSize: "11px", opacity: 0.7 }}>{alert.dataSource}</span>
                </div>
              ))
            ) : (
              <p style={{ margin: 0, fontSize: "13px", opacity: 0.85 }}>
                Nessun rischio rilevante nei dati attuali.
              </p>
            )}
          </div>

          <div className="panel" style={{ display: "grid", gap: "8px" }}>
            <span className="eyebrow">SCHEMI RICORRENTI (HABIT PATTERNS)</span>
            {habits.map((h) => (
              <div
                key={h.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  fontSize: "13px",
                }}
              >
                <strong>{h.label}</strong>
                <p style={{ margin: "3px 0 0", opacity: 0.85, fontSize: "12px" }}>
                  {h.description}
                </p>
                <span style={{ fontSize: "11px", opacity: 0.7 }}>
                  Origine: {h.dataSource} · Osservazioni: {h.observationCount} · Affidabilità:{" "}
                  {Math.round(h.confidence * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Priorità suggerite */}
      {priorityProposals.length > 0 && (
        <div className="panel" style={{ display: "grid", gap: "10px" }}>
          <span className="eyebrow">PRIORITÀ SUGGERITE (NESSUNA MODIFICA AUTOMATICA)</span>
          {priorityProposals.map((prop) => (
            <div
              key={prop.id}
              style={{
                padding: "10px 12px",
                borderRadius: "10px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.1)",
                display: "grid",
                gap: "6px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                <strong>
                  {prop.taskTitle} ({prop.planTitle})
                </strong>
                <span style={{ fontSize: "12px" }}>
                  Priorità: <strong>{prop.previousPriority}</strong> →{" "}
                  <strong style={{ color: PRIORITY_COLORS[prop.suggestedPriority] }}>
                    {prop.suggestedPriority}
                  </strong>{" "}
                  · {prop.status}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: "12px", opacity: 0.85 }}>{prop.reason}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <button
                  type="button"
                  className="mood selected"
                  onClick={() =>
                    setPriorityProposals((prev) =>
                      transitionPriorityProposalStatus(prev, prop.id, "accepted")
                    )
                  }
                >
                  Accetta proposta
                </button>
                <button
                  type="button"
                  className="mood"
                  onClick={() =>
                    setPriorityProposals((prev) =>
                      transitionPriorityProposalStatus(prev, prop.id, "snoozed")
                    )
                  }
                >
                  Posticipa
                </button>
                <button
                  type="button"
                  className="mood"
                  onClick={() =>
                    setPriorityProposals((prev) =>
                      transitionPriorityProposalStatus(prev, prop.id, "rejected")
                    )
                  }
                >
                  Rifiuta
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Elenco suggerimenti contestuali */}
      {suggestions.length === 0 ? (
        <div className="panel">
          <p style={{ margin: 0, opacity: 0.85 }}>
            Nessun suggerimento generato finora. Tocca &ldquo;Analizza ora&rdquo; per eseguire l&apos;analisi predittiva, gli schemi ricorrenti, le priorità e i suggerimenti contestuali sui tuoi dati reali.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "12px" }}>
          {suggestions.map((sug) => (
            <div key={sug.id} className="panel" style={{ display: "grid", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", flexWrap: "wrap" }}>
                <div>
                  <span className="eyebrow">
                    {EPISTEMIC_LABELS[sug.epistemicTag]} · AFFIDABILITÀ {Math.round(sug.confidence * 100)}%
                  </span>
                  <h3 style={{ margin: "4px 0 0" }}>{sug.title}</h3>
                </div>
                <span
                  style={{
                    fontSize: "11px",
                    padding: "3px 8px",
                    borderRadius: "999px",
                    border: `1px solid ${PRIORITY_COLORS[sug.priority] ?? "#94a3b8"}`,
                    color: PRIORITY_COLORS[sug.priority] ?? "#94a3b8",
                  }}
                >
                  Priorità {sug.priority} · {sug.status}
                </span>
              </div>

              <p style={{ margin: 0, fontSize: "13px", opacity: 0.9 }}>{sug.description}</p>

              <div style={{ fontSize: "12px", opacity: 0.8, display: "grid", gap: "3px" }}>
                <span><strong>Motivazione:</strong> {sug.rationale}</span>
                <span><strong>Origine dati:</strong> {sug.dataSource}</span>
                <span>
                  <Lightbulb size={13} style={{ display: "inline", marginRight: "4px" }} />
                  <strong>Prossima azione consigliata:</strong> {sug.proposedAction}
                  {sug.estimatedMinutes ? ` (~${sug.estimatedMinutes} min)` : ""}
                </span>
                {sug.snoozedUntil && (
                  <span>
                    <Clock size={12} style={{ display: "inline", marginRight: "4px" }} />
                    Rimandato fino alle {new Date(sug.snoozedUntil).toLocaleTimeString("it-IT")}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
                {sug.status === "proposed" && (
                  <button
                    type="button"
                    className="mood selected"
                    onClick={() => handleSuggestionAction(sug, "accepted")}
                  >
                    <Check size={13} /> Accetta
                  </button>
                )}

                {sug.status !== "completed" && sug.status !== "rejected" && (
                  <button
                    type="button"
                    className="mood"
                    onClick={() => handleSuggestionAction(sug, "completed")}
                  >
                    Completa
                  </button>
                )}

                {sug.status === "proposed" && (
                  <button
                    type="button"
                    className="mood"
                    onClick={() => handleSuggestionAction(sug, "snoozed")}
                  >
                    Rimanda
                  </button>
                )}

                {sug.status !== "rejected" && sug.status !== "completed" && (
                  <button
                    type="button"
                    className="mood"
                    onClick={() => handleSuggestionAction(sug, "rejected")}
                  >
                    <X size={13} /> Rifiuta
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <UnifiedProactivePanel
        plans={plans}
        missions={missions}
        growthGoals={growthGoals}
        availableMinutes={20}
        energyLevel="media"
        consent={consent}
        crisisBlocked={crisisBlocked}
        learningEngine={learningEngine}
        onDecisionRecorded={() => setLearningCount(learningEngine.getInteractionCount())}
      />

      <CognitiveContinuitySection
        plans={plans}
        missions={missions}
        growthGoals={growthGoals}
        consent={consent}
        crisisBlocked={crisisBlocked}
        availableMinutes={20}
        energyLevel="media"
        learningEngine={learningEngine}
      />

      <AutonomousIntelligencePanel
        mode={mode}
        plans={plans}
        missions={missions}
        growthGoals={growthGoals}
        consent={consent}
        crisisBlocked={crisisBlocked}
        availableMinutes={20}
        energyLevel="media"
        learningEngine={learningEngine}
      />

      <CognitiveEvolutionDashboard
        aiMemoryConsent={consent}
        crisisBlocked={crisisBlocked}
        controlledLearning={learningEngine}
      />

      <MetaCognitiveDashboard
        plans={plans}
        missions={missions}
        growthGoals={growthGoals}
        aiMemoryConsent={consent}
        crisisBlocked={crisisBlocked}
        controlledLearning={learningEngine}
      />
    </section>
  );
}
