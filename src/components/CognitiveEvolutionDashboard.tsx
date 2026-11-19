import { useMemo, useState } from "react";
import { Brain, Check, Download, ShieldCheck, Sliders, Trash2, X } from "lucide-react";
import {
  AdaptiveLearningEngine,
  type AdaptationHints,
} from "../cognitive/adaptiveLearningEngine";
import { AuthorizationLedger } from "../cognitive/authorizationLedger";
import {
  runCognitiveSelfEvaluation,
  type CognitiveSelfEvaluationReport,
} from "../cognitive/cognitiveSelfEvaluation";
import { CognitiveTimeline } from "../cognitive/cognitiveTimeline";
import { analyzeExperience } from "../cognitive/experienceAnalyzer";
import {
  KnowledgeEvolutionStore,
  type EvolvedKnowledgeEntry,
} from "../cognitive/knowledgeEvolutionStore";
import { evaluateLearningSafety } from "../cognitive/learningSafetyGuard";
import type { LearningConsentState } from "../cognitive/selfLearningTypes";
import { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { CognitiveSelfEvaluationPanel } from "./CognitiveSelfEvaluationPanel";
import { KnowledgeEvolutionPanel } from "./KnowledgeEvolutionPanel";

export const LEARNING_CONSENT_STORAGE_KEY = "aura_learning_consent_v1";

interface PersistedLearningConsent {
  learningConsent: boolean;
  revokedAt?: string;
}

function loadPersistedLearningConsent(): PersistedLearningConsent {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { learningConsent: false };
    }
    const raw = window.localStorage.getItem(LEARNING_CONSENT_STORAGE_KEY);
    if (!raw) return { learningConsent: false };
    const parsed = JSON.parse(raw) as Partial<PersistedLearningConsent>;
    return {
      learningConsent: parsed.learningConsent === true,
      revokedAt: typeof parsed.revokedAt === "string" ? parsed.revokedAt : undefined,
    };
  } catch {
    return { learningConsent: false };
  }
}

function savePersistedLearningConsent(next: PersistedLearningConsent): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(LEARNING_CONSENT_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Fail-closed: non interrompe mai chat o voce
  }
}

function triggerJsonDownload(filename: string, json: string): void {
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // Ignora errori di download su ambienti headless
  }
}

interface CognitiveEvolutionDashboardProps {
  aiMemoryConsent: boolean;
  crisisBlocked: boolean;
  controlledLearning: ControlledLearningEngine;
}

export function CognitiveEvolutionDashboard({
  aiMemoryConsent,
  crisisBlocked,
  controlledLearning,
}: CognitiveEvolutionDashboardProps) {
  const adaptiveEngine = useMemo(() => new AdaptiveLearningEngine(), []);
  const knowledgeStore = useMemo(() => new KnowledgeEvolutionStore(), []);
  const timeline = useMemo(() => new CognitiveTimeline(), []);
  const ledger = useMemo(() => new AuthorizationLedger(), []);
  const repository = useMemo(() => new DataRepository(), []);

  const [persistedConsent, setPersistedConsent] = useState<PersistedLearningConsent>(() =>
    loadPersistedLearningConsent()
  );
  const [evalReport, setEvalReport] = useState<CognitiveSelfEvaluationReport | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAdaptiveReset, setConfirmAdaptiveReset] = useState(false);

  const consentState: LearningConsentState = useMemo(
    () => ({
      learningConsent: persistedConsent.learningConsent,
      aiMemoryConsent,
      revokedAt: persistedConsent.revokedAt,
    }),
    [persistedConsent, aiMemoryConsent]
  );

  const guardStatus = useMemo(
    () =>
      evaluateLearningSafety({
        operation: "read",
        consentState,
        crisisBlocked,
      }),
    [consentState, crisisBlocked, refreshTick]
  );

  const knowledgeEntries: EvolvedKnowledgeEntry[] = useMemo(() => {
    if (!consentState.learningConsent || crisisBlocked) return [];
    const res = knowledgeStore.listEntries(consentState, {
      includeExpired: true,
      crisisBlocked,
    });
    return res.allowed ? (res.data ?? []) : [];
  }, [knowledgeStore, consentState, crisisBlocked, refreshTick]);

  const adaptationHints: AdaptationHints = useMemo(
    () =>
      adaptiveEngine.getAdaptationHints(consentState, {
        crisisBlocked,
      }),
    [adaptiveEngine, consentState, crisisBlocked, refreshTick]
  );

  const proposedCount = knowledgeEntries.filter((e) => e.status === "proposed").length;
  const validatedCount = knowledgeEntries.filter((e) => e.status === "validated").length;
  const rejectedCount = knowledgeEntries.filter((e) => e.status === "rejected").length;

  function handleToggleLearningConsent() {
    const nextEnabled = !persistedConsent.learningConsent;
    const nextState: PersistedLearningConsent = {
      learningConsent: nextEnabled,
      revokedAt: nextEnabled ? undefined : new Date().toISOString(),
    };
    setPersistedConsent(nextState);
    savePersistedLearningConsent(nextState);
    if (!nextEnabled) {
      setEvalReport(null);
      setNotice(
        "Apprendimento adattivo disattivato: letture e scritture bloccate immediatamente. I dati esistenti non sono stati cancellati."
      );
    } else {
      setNotice("Consenso all'apprendimento adattivo attivato (indipendente da Memoria AI).");
    }
    setRefreshTick((t) => t + 1);
  }

  function handleRunSelfEvaluation() {
    const experienceSummary = analyzeExperience({
      consentState,
      repository,
      timeline,
      controlledLearning,
      authorizationLedger: ledger,
      crisisBlocked,
    });
    const report = runCognitiveSelfEvaluation({
      consentState,
      experienceSummary,
      controlledLearning,
      adaptiveLearning: adaptiveEngine,
      authorizationLedger: ledger,
      timeline,
      crisisBlocked,
    });
    setEvalReport(report);
    setNotice(
      report.allowed
        ? "Autovalutazione cognitiva locale completata."
        : report.uncertaintyNote
    );
  }

  function handleApproveKnowledge(id: string) {
    const res = knowledgeStore.confirmEntry(consentState, id, true, { crisisBlocked });
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  function handleRejectKnowledge(id: string) {
    const res = knowledgeStore.rejectEntry(consentState, id, true, { crisisBlocked });
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  function handleReviseKnowledge(id: string, content: string, reason: string) {
    const res = knowledgeStore.reviseEntry(
      consentState,
      id,
      { content, changeReason: reason },
      { crisisBlocked }
    );
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  function handleRestoreRevision(id: string, version: number) {
    const res = knowledgeStore.restoreValidatedRevision(consentState, id, version, true, {
      crisisBlocked,
    });
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  function handleExportKnowledge() {
    const res = knowledgeStore.exportJson(consentState, { crisisBlocked });
    if (res.allowed && res.json) {
      triggerJsonDownload("aura-knowledge-evolution.json", res.json);
    }
    setNotice(res.reason);
  }

  function handleClearKnowledge() {
    const res = knowledgeStore.clear(
      { ...consentState, explicitClearRequested: true },
      true,
      { crisisBlocked }
    );
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  function handleExportAdaptive() {
    const res = adaptiveEngine.exportProfileJson(consentState, { crisisBlocked });
    if (res.allowed && res.json) {
      triggerJsonDownload("aura-adaptive-learning.json", res.json);
    }
    setNotice(res.reason);
  }

  function handleResetAdaptive() {
    const res = adaptiveEngine.resetProfile(
      { ...consentState, explicitClearRequested: true },
      { crisisBlocked }
    );
    setConfirmAdaptiveReset(false);
    setNotice(res.reason);
    setRefreshTick((t) => t + 1);
  }

  return (
    <section
      className="aura-evolution-dashboard"
      aria-label="Cognitive Evolution Dashboard"
    >
      <div className="aura-evolution-header">
        <div className="aura-evolution-title-inline">
          <Brain size={18} />
          <h3>Cognitive Evolution V1</h3>
        </div>
        <span
          className={`aura-evolution-status-pill ${
            crisisBlocked
              ? "danger"
              : consentState.learningConsent
                ? "active"
                : "off"
          }`}
        >
          {crisisBlocked
            ? "BLOCCATO (CRISI)"
            : consentState.learningConsent
              ? "APPRENDIMENTO ON"
              : "APPRENDIMENTO OFF"}
        </span>
      </div>

      {/* Controllo dedicato Learning Consent (indipendente da AI Memory) */}
      <div className="aura-evolution-consent-row">
        <div>
          <strong>Consenso Apprendimento Adattivo</strong>
          <p className="aura-evolution-muted">
            Indipendente da Memoria AI ({aiMemoryConsent ? "ON" : "OFF"}). Disattivandolo blocchi
            subito letture e scritture senza cancellare i dati salvati.
          </p>
        </div>
        <button
          type="button"
          className={`aura-evolution-btn ${
            consentState.learningConsent ? "aura-evolution-btn-primary" : ""
          }`}
          onClick={handleToggleLearningConsent}
          aria-pressed={consentState.learningConsent}
        >
          {consentState.learningConsent ? "Disattiva consenso" : "Attiva consenso"}
        </button>
      </div>

      {/* Stato Learning Safety Guard + Riepilogo */}
      <div className="aura-evolution-summary-grid">
        <div className="aura-evolution-stat-card">
          <span className="aura-evolution-stat-label">
            <ShieldCheck size={13} /> Safety Guard
          </span>
          <strong>{guardStatus.allowed ? "Attivo e conforme" : "Blocco fail-closed"}</strong>
        </div>
        <div className="aura-evolution-stat-card">
          <span className="aura-evolution-stat-label">Conoscenze</span>
          <strong>
            {consentState.learningConsent
              ? `${proposedCount} prop · ${validatedCount} val · ${rejectedCount} rif`
              : "Bloccato (OFF)"}
          </strong>
        </div>
        <div className="aura-evolution-stat-card">
          <span className="aura-evolution-stat-label">Ultima autovalutazione</span>
          <strong>
            {evalReport
              ? new Date(evalReport.timestamp).toLocaleTimeString("it-IT", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "Non eseguita"}
          </strong>
        </div>
      </div>

      {notice && (
        <div className="aura-evolution-notice" role="status">
          <span>{notice}</span>
        </div>
      )}

      {/* Adaptive Learning Panel */}
      <div className="aura-evolution-subpanel">
        <div className="aura-evolution-subpanel-header">
          <span className="aura-evolution-title-inline">
            <Sliders size={16} />
            <strong>Preferenze Adattive Locali</strong>
          </span>
          <div className="aura-evolution-actions-inline">
            <button
              type="button"
              className="aura-evolution-btn"
              onClick={handleExportAdaptive}
              disabled={!consentState.learningConsent || crisisBlocked}
            >
              <Download size={14} /> JSON
            </button>
            <button
              type="button"
              className="aura-evolution-btn aura-evolution-btn-danger"
              onClick={() => setConfirmAdaptiveReset(true)}
              disabled={crisisBlocked}
            >
              <Trash2 size={14} /> Reset
            </button>
          </div>
        </div>

        {confirmAdaptiveReset && (
          <div className="aura-evolution-confirm-box" role="alertdialog">
            <p>
              Confermi il reset del profilo di adattamento locale (<code>aura_adaptive_learning_v1</code>)?
            </p>
            <div className="aura-evolution-actions-inline">
              <button
                type="button"
                className="aura-evolution-btn aura-evolution-btn-primary"
                onClick={handleResetAdaptive}
              >
                <Check size={14} /> Conferma reset
              </button>
              <button
                type="button"
                className="aura-evolution-btn"
                onClick={() => setConfirmAdaptiveReset(false)}
              >
                <X size={14} /> Annulla
              </button>
            </div>
          </div>
        )}

        {adaptationHints.allowed ? (
          <div className="aura-evolution-adaptive-grid">
            <div className="aura-evolution-dim-card">
              <span className="aura-evolution-stat-label">Durata preferita</span>
              <strong>{adaptationHints.preferredDuration.toUpperCase()}</strong>
              <span className="aura-evolution-muted">
                S:{adaptationHints.durationWeights.short} · M:{adaptationHints.durationWeights.medium}{" "}
                · L:{adaptationHints.durationWeights.long}
              </span>
            </div>
            <div className="aura-evolution-dim-card">
              <span className="aura-evolution-stat-label">Livello dettaglio</span>
              <strong>{adaptationHints.preferredDetail.toUpperCase()}</strong>
              <span className="aura-evolution-muted">
                C:{adaptationHints.detailWeights.concise} · B:{adaptationHints.detailWeights.balanced}{" "}
                · D:{adaptationHints.detailWeights.detailed}
              </span>
            </div>
            <div className="aura-evolution-dim-card">
              <span className="aura-evolution-stat-label">Strategia consigliata</span>
              <strong>{adaptationHints.recommendedStrategy}</strong>
              <span className="aura-evolution-muted">
                STD:{adaptationHints.strategyWeights.STANDARD} · LGT:
                {adaptationHints.strategyWeights.LIGHT} · DEF:
                {adaptationHints.strategyWeights.DEFERRED}
              </span>
            </div>
          </div>
        ) : (
          <p className="aura-evolution-muted">{adaptationHints.uncertaintyNote}</p>
        )}
      </div>

      {/* Cognitive Self-Evaluation Panel */}
      <CognitiveSelfEvaluationPanel
        report={evalReport}
        learningConsent={consentState.learningConsent}
        crisisBlocked={crisisBlocked}
        onRunEvaluation={handleRunSelfEvaluation}
      />

      {/* Knowledge Evolution Panel */}
      <KnowledgeEvolutionPanel
        entries={knowledgeEntries}
        learningConsent={consentState.learningConsent}
        crisisBlocked={crisisBlocked}
        onApprove={handleApproveKnowledge}
        onReject={handleRejectKnowledge}
        onRevise={handleReviseKnowledge}
        onRestoreRevision={handleRestoreRevision}
        onExportJson={handleExportKnowledge}
        onClearAll={handleClearKnowledge}
      />
    </section>
  );
}
