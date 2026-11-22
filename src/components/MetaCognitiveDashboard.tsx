import { useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  Download,
  FileSearch,
  GitBranch,
  HelpCircle,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AdaptiveLearningEngine } from "../cognitive/adaptiveLearningEngine";
import { AuthorizationLedger } from "../cognitive/authorizationLedger";
import type { ProcessLifecycleState } from "../cognitive/cognitiveProcessMonitor";
import { CognitiveTimeline } from "../cognitive/cognitiveTimeline";
import {
  KnowledgeEvolutionStore,
  type KnowledgeStoreOperationResult,
} from "../cognitive/knowledgeEvolutionStore";
import {
  runMetaLearningBridge,
  type MetaLearningBridgeResult,
  type MetaLearningProposal,
} from "../cognitive/metaLearningBridge";
import type {
  CognitiveErrorCategory,
  CognitiveErrorSeverity,
  UncertaintyLevel,
} from "../cognitive/metaCognitiveTypes";
import type {
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
} from "../cognitive/selfLearningTypes";
import type { StrategyConstraintsInput } from "../cognitive/strategyComparisonEngine";
import type { InformationSufficiency } from "../cognitive/uncertaintyEngine";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import { DataRepository } from "../persistence/dataManagement";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { LEARNING_CONSENT_STORAGE_KEY } from "./CognitiveEvolutionDashboard";

export type MetaDashboardStatus =
  | "idle"
  | "analyzing"
  | "completed"
  | "insufficient_data"
  | "blocked"
  | "error";

export interface MetaDashboardSectionOpenState {
  overview: boolean;
  processMonitor: boolean;
  uncertainty: boolean;
  strategyComparison: boolean;
  errorDetection: boolean;
  explainability: boolean;
  metaLearning: boolean;
}

export interface MetaDashboardControllerState {
  status: MetaDashboardStatus;
  result: MetaLearningBridgeResult | null;
  lastUpdatedAt: string | null;
  errorMessage: string | null;
  notice: string | null;
  learningConsentActive: boolean;
}

export interface PersistedLearningConsentRead {
  learningConsent: boolean;
  revokedAt?: string;
}

export function loadPersistedLearningConsentReadOnly(
  storage?: Pick<Storage, "getItem"> | null
): PersistedLearningConsentRead {
  try {
    const targetStorage =
      storage !== undefined
        ? storage
        : typeof window !== "undefined" && window.localStorage
          ? window.localStorage
          : null;
    if (!targetStorage) return { learningConsent: false };
    const raw = targetStorage.getItem(LEARNING_CONSENT_STORAGE_KEY);
    if (!raw) return { learningConsent: false };
    const parsed = JSON.parse(raw) as Partial<PersistedLearningConsentRead>;
    return {
      learningConsent: parsed.learningConsent === true,
      revokedAt: typeof parsed.revokedAt === "string" ? parsed.revokedAt : undefined,
    };
  } catch {
    return { learningConsent: false };
  }
}

export function buildInitialMetaDashboardState(
  initialLearningConsent = false
): MetaDashboardControllerState {
  return {
    status: "idle",
    result: null,
    lastUpdatedAt: null,
    errorMessage: null,
    notice: null,
    learningConsentActive: initialLearningConsent,
  };
}

export interface ExecuteManualMetaAnalysisParams {
  aiMemoryConsent: boolean;
  crisisBlocked: boolean;
  controlledLearning?: ControlledLearningEngine;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  authorizationLedger?: AuthorizationLedger;
  adaptiveLearning?: AdaptiveLearningEngine;
  knowledgeStore?: KnowledgeEvolutionStore;
  declaredGoal?: string;
  constraints?: StrategyConstraintsInput;
  plans?: PersonalPlan[];
  missions?: AdaptiveMission[];
  growthGoals?: GrowthGoal[];
  persistedConsent?: PersistedLearningConsentRead;
  nowIso?: string;
}

/**
 * Esegue manualmente l'analisi metacognitiva completa in sola lettura.
 * Non modifica mai piani, missioni, obiettivi, pesi adattivi, conoscenze o consensi.
 */
export function executeManualMetaAnalysis(
  params: ExecuteManualMetaAnalysisParams
): MetaDashboardControllerState {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const persisted =
    params.persistedConsent ?? loadPersistedLearningConsentReadOnly();

  const consentState: LearningConsentState = {
    learningConsent: persisted.learningConsent,
    aiMemoryConsent: params.aiMemoryConsent,
    revokedAt: persisted.revokedAt,
  };

  try {
    const activeGoals = (params.growthGoals ?? [])
      .filter((g) => g.status === "attivo")
      .map((g) => g.title);
    const activePlans = (params.plans ?? []).filter((p) => p.status === "active");
    const acceptedMissions = (params.missions ?? []).filter(
      (m) => m.status === "accettata" || m.status === "completata"
    );

    const availableInputs: Record<string, unknown> = {};
    const cleanGoal = params.declaredGoal?.trim();
    if (cleanGoal) {
      availableInputs.goal = cleanGoal;
    }
    if (params.constraints?.energyLevel) {
      availableInputs.energyLevel = params.constraints.energyLevel;
    }
    if (typeof params.constraints?.timeBudgetMinutes === "number") {
      availableInputs.timeBudgetMinutes = params.constraints.timeBudgetMinutes;
    }
    if (activePlans.length > 0) {
      availableInputs.activePlansCount = activePlans.length;
    }
    if (acceptedMissions.length > 0) {
      availableInputs.activeMissionsCount = acceptedMissions.length;
    }
    if (activeGoals.length > 0) {
      availableInputs.activeGoalsCount = activeGoals.length;
    }

    const availableResources: string[] = [];
    if (activePlans.length > 0) {
      availableResources.push(`${activePlans.length} piani attivi locali`);
    }
    if (activeGoals.length > 0) {
      availableResources.push(`${activeGoals.length} obiettivi attivi`);
    }
    if (acceptedMissions.length > 0) {
      availableResources.push(`${acceptedMissions.length} missioni tracciate`);
    }

    const expectedInputs = ["goal", "energyLevel", "timeBudgetMinutes"];

    const result = runMetaLearningBridge({
      consentState,
      usesLearningData: true,
      declaredGoal: cleanGoal || undefined,
      constraints: params.constraints,
      availableResources: availableResources.length > 0 ? availableResources : undefined,
      expectedInputs,
      availableInputs,
      repository: params.repository,
      timeline: params.timeline,
      controlledLearning: params.controlledLearning,
      authorizationLedger: params.authorizationLedger,
      adaptiveLearning: params.adaptiveLearning,
      knowledgeStore: params.knowledgeStore,
      crisisBlocked: params.crisisBlocked,
      nowIso,
    });

    if (!result.allowed) {
      const isInternalError =
        result.safetyDecision.blockedBy === "internal_error";
      return {
        status: isInternalError ? "error" : "blocked",
        result: isInternalError ? null : result,
        lastUpdatedAt: nowIso,
        errorMessage: isInternalError ? result.safetyDecision.reason : null,
        notice: isInternalError ? null : result.safetyDecision.reason,
        learningConsentActive: result.learningConsentActive,
      };
    }

    const isInsufficient =
      result.uncertaintyEvaluation.sufficiencyStatus === "insufficient" ||
      result.uncertaintyEvaluation.assessment.reliabilityScore === null ||
      result.strategyComparison.insufficientData;

    return {
      status: isInsufficient ? "insufficient_data" : "completed",
      result,
      lastUpdatedAt: nowIso,
      errorMessage: null,
      notice: isInsufficient
        ? "Analisi completata con dati insufficienti: nessuna percentuale di affidabilità o strategia vincente è stata inventata."
        : "Analisi metacognitiva locale completata in sola lettura.",
      learningConsentActive: result.learningConsentActive,
    };
  } catch {
    return {
      status: "error",
      result: null,
      lastUpdatedAt: nowIso,
      errorMessage:
        "Errore imprevisto durante l'analisi metacognitiva: esecuzione interrotta in modalità fail-closed senza alcuna modifica ai dati.",
      notice: null,
      learningConsentActive: persisted.learningConsent && !persisted.revokedAt,
    };
  }
}

export function formatReliabilityLabel(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return "Dati insufficienti";
  }
  return `${Math.round(score * 100)}%`;
}

export function buildMetaReportExportJson(
  state: MetaDashboardControllerState
): string {
  return JSON.stringify(
    {
      exportType: "aura_metacognitive_report",
      version: 1,
      exportedAt: new Date().toISOString(),
      readOnly: true,
      advisoryOnly: true,
      status: state.status,
      lastUpdatedAt: state.lastUpdatedAt,
      learningConsentActive: state.learningConsentActive,
      report: state.result,
    },
    null,
    2
  );
}

export function formatMetaReportAsText(state: MetaDashboardControllerState): string {
  if (!state.result) {
    return "AURA AI — Rapporto Meta-Cognitivo V1\nStato: Analisi non ancora eseguita.";
  }
  const r = state.result;
  const lines: string[] = [
    "AURA AI — Rapporto Meta-Cognitivo V1 (Sola lettura)",
    `Aggiornamento: ${state.lastUpdatedAt ?? "N/D"}`,
    `Stato: ${state.status} · Consenso apprendimento: ${r.learningConsentActive ? "ON" : "OFF"}`,
    `Sicurezza: ${r.safetyDecision.allowed ? "Conforme" : "Bloccata"} — ${r.safetyDecision.reason}`,
    `Affidabilità: ${formatReliabilityLabel(r.uncertaintyEvaluation.assessment.reliabilityScore)} (${r.uncertaintyEvaluation.sufficiencyStatus})`,
    `Strategia consigliata: ${r.strategyComparison.selectedStrategy ?? "Nessuna strategia selezionabile (dati insufficienti)"}`,
    `Errori cognitivi rilevati: ${r.errorDetection.totalErrorsDetected} (autoApplied: false)`,
    `Spiegazione: ${r.explanation.summary}`,
    `Proposte Meta-Learning (status: proposed): ${r.proposals.length}`,
  ];
  return lines.join("\n");
}

export function submitProposalToKnowledgeStoreOnly(
  store: KnowledgeEvolutionStore,
  consentState: LearningConsentState,
  proposal: MetaLearningProposal,
  crisisBlocked: boolean
): KnowledgeStoreOperationResult {
  if (!proposal.knowledgeProposalPayload) {
    return {
      allowed: false,
      reason: "La proposta selezionata non contiene un payload registrabile in KnowledgeEvolutionStore.",
      guardDecision: {
        allowed: false,
        failClosed: true,
        reason: "Payload proposta mancante.",
        auditEvent: {
          id: `guard-missing-payload-${Date.now()}`,
          timestamp: new Date().toISOString(),
          operation: "propose",
          allowed: false,
          reason: "Payload proposta mancante.",
          blockedBy: "invalid_payload",
        },
      },
    };
  }
  // Chiama ESCLUSIVAMENTE proposeEntry: mantiene status="proposed", non conferma e non applica automaticamente.
  return store.proposeEntry(consentState, proposal.knowledgeProposalPayload, {
    crisisBlocked,
  });
}

const LIFECYCLE_LABELS: Record<ProcessLifecycleState, string> = {
  iniziato: "Iniziato",
  in_elaborazione: "In elaborazione",
  completato: "Completato",
  sospeso: "Sospeso",
  bloccato: "Bloccato",
};

const UNCERTAINTY_LABELS: Record<UncertaintyLevel, string> = {
  low: "Incertezza bassa",
  moderate: "Incertezza moderata",
  high: "Incertezza elevata",
  insufficient_evidence: "Evidenze insufficienti",
};

const SUFFICIENCY_LABELS: Record<InformationSufficiency, string> = {
  sufficient: "Sufficiente",
  partial: "Parziale",
  insufficient: "Insufficiente",
};

const EPISTEMIC_LABELS: Record<EpistemicTag, string> = {
  fatto_osservato: "Fatto osservato",
  interpretazione_prudente: "Interpretazione prudente",
  ipotesi_da_verificare: "Ipotesi da verificare",
};

const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  explicit_feedback: "Feedback esplicito",
  observed_behavior: "Comportamento osservato",
  hypothesis: "Ipotesi non verificata",
};

const ERROR_CATEGORY_LABELS: Record<CognitiveErrorCategory, string> = {
  internal_contradiction: "Contraddizione interna",
  unsupported_conclusion: "Conclusione non supportata",
  recurring_error: "Errore ricorrente",
  epistemic_mismatch: "Disallineamento epistemico",
};

const SEVERITY_LABELS: Record<CognitiveErrorSeverity, string> = {
  low: "Bassa",
  medium: "Media",
  high: "Alta",
};

const COST_LABELS: Record<"low" | "medium" | "high", string> = {
  low: "Basso",
  medium: "Medio",
  high: "Alto",
};

interface MetaCognitiveDashboardProps {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  aiMemoryConsent: boolean;
  crisisBlocked: boolean;
  controlledLearning: ControlledLearningEngine;
}

export function MetaCognitiveDashboard({
  plans,
  missions,
  growthGoals,
  aiMemoryConsent,
  crisisBlocked,
  controlledLearning,
}: MetaCognitiveDashboardProps) {
  const repository = useMemo(() => new DataRepository(), []);
  const timeline = useMemo(() => new CognitiveTimeline(), []);
  const ledger = useMemo(() => new AuthorizationLedger(), []);
  const adaptiveEngine = useMemo(() => new AdaptiveLearningEngine(), []);
  const knowledgeStore = useMemo(() => new KnowledgeEvolutionStore(), []);

  const [dashboardState, setDashboardState] = useState<MetaDashboardControllerState>(() =>
    buildInitialMetaDashboardState(
      loadPersistedLearningConsentReadOnly().learningConsent
    )
  );
  const [declaredGoal, setDeclaredGoal] = useState<string>("");
  const [energyLevel, setEnergyLevel] = useState<"" | "low" | "medium" | "high">("");
  const [timeBudget, setTimeBudget] = useState<string>("");
  const [sectionsOpen, setSectionsOpen] = useState<MetaDashboardSectionOpenState>({
    overview: true,
    processMonitor: true,
    uncertainty: true,
    strategyComparison: true,
    errorDetection: true,
    explainability: true,
    metaLearning: true,
  });
  const [expandedEvidenceIds, setExpandedEvidenceIds] = useState<Record<string, boolean>>({});
  const [savedProposalIds, setSavedProposalIds] = useState<Record<string, boolean>>({});
  const [pendingProposalToSave, setPendingProposalToSave] =
    useState<MetaLearningProposal | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const analyzingRef = useRef(false);

  const goalSuggestions = useMemo(() => {
    const items: string[] = [];
    for (const p of plans) {
      if (p.status === "active" && p.declaredGoal.trim()) {
        items.push(p.declaredGoal.trim());
      }
    }
    for (const g of growthGoals) {
      if (g.status === "attivo" && g.title.trim() && !items.includes(g.title.trim())) {
        items.push(g.title.trim());
      }
    }
    return items.slice(0, 6);
  }, [plans, growthGoals]);

  function toggleSection(key: keyof MetaDashboardSectionOpenState) {
    setSectionsOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleEvidenceDetail(id: string) {
    setExpandedEvidenceIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleAnalyzeNow() {
    if (analyzingRef.current || dashboardState.status === "analyzing") return;
    analyzingRef.current = true;
    setActionFeedback(null);
    setPendingProposalToSave(null);

    try {
      const parsedBudget =
        timeBudget.trim() !== "" && Number.isFinite(Number(timeBudget))
          ? Math.max(1, Math.min(480, Math.round(Number(timeBudget))))
          : undefined;

      const constraints: StrategyConstraintsInput | undefined =
        energyLevel !== "" || parsedBudget !== undefined
          ? {
              ...(energyLevel !== "" ? { energyLevel } : {}),
              ...(parsedBudget !== undefined ? { timeBudgetMinutes: parsedBudget } : {}),
            }
          : undefined;

      const nextState = executeManualMetaAnalysis({
        aiMemoryConsent,
        crisisBlocked,
        controlledLearning,
        repository,
        timeline,
        authorizationLedger: ledger,
        adaptiveLearning: adaptiveEngine,
        knowledgeStore,
        declaredGoal,
        constraints,
        plans,
        missions,
        growthGoals,
      });
      setDashboardState(nextState);
    } finally {
      analyzingRef.current = false;
    }
  }

  async function handleCopyReport() {
    const text = formatMetaReportAsText(dashboardState);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setActionFeedback("Rapporto copiato negli appunti.");
      } else {
        setActionFeedback("Appunti non disponibili in questo browser: usa Esporta JSON.");
      }
    } catch {
      setActionFeedback("Impossibile copiare negli appunti: usa Esporta JSON.");
    }
  }

  function handleExportJson() {
    try {
      const json = buildMetaReportExportJson(dashboardState);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aura-metacognitive-report-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setActionFeedback("Rapporto JSON esportato localmente.");
    } catch {
      setActionFeedback("Esportazione JSON non riuscita in questo ambiente.");
    }
  }

  function handleConfirmSaveProposal() {
    if (!pendingProposalToSave) return;
    const persisted = loadPersistedLearningConsentReadOnly();
    const consentState: LearningConsentState = {
      learningConsent: persisted.learningConsent,
      aiMemoryConsent,
      revokedAt: persisted.revokedAt,
    };
    const res = submitProposalToKnowledgeStoreOnly(
      knowledgeStore,
      consentState,
      pendingProposalToSave,
      crisisBlocked
    );
    if (res.allowed) {
      setSavedProposalIds((prev) => ({
        ...prev,
        [pendingProposalToSave.id]: true,
      }));
      setActionFeedback(
        "Proposta salvata in Knowledge Evolution con stato 'proposed'. Vai nella sezione Knowledge Evolution per approvarla o rifiutarla."
      );
    } else {
      setActionFeedback(res.reason);
    }
    setPendingProposalToSave(null);
  }

  const result = dashboardState.result;
  const currentConsentRead =
    result !== null
      ? result.learningConsentActive
      : loadPersistedLearningConsentReadOnly().learningConsent;

  const statusBadgeClass =
    dashboardState.status === "blocked" || dashboardState.status === "error" || crisisBlocked
      ? "danger"
      : dashboardState.status === "completed"
        ? "active"
        : dashboardState.status === "insufficient_data"
          ? "warn"
          : "off";

  const statusBadgeText =
    crisisBlocked
      ? "BLOCCATO (CRISI)"
      : dashboardState.status === "idle"
        ? "NON ESEGUITA"
        : dashboardState.status === "analyzing"
          ? "ANALISI IN CORSO"
          : dashboardState.status === "blocked"
            ? "BLOCCATO"
            : dashboardState.status === "error"
              ? "ERRORE FAIL-CLOSED"
              : dashboardState.status === "insufficient_data"
                ? "DATI INSUFFICIENTI"
                : "ANALISI COMPLETATA";

  return (
    <section
      id="aura-metacognitive-section"
      className="aura-meta-dashboard"
      aria-label="Meta-Cognitive Intelligence V1"
    >
      {/* Intestazione */}
      <div className="aura-meta-header">
        <div className="aura-meta-title-wrap">
          <span className="eyebrow">FASE 10.5 · MONITORAGGIO E SPIEGAZIONE LOCALE</span>
          <div className="aura-meta-title-inline">
            <Brain size={19} />
            <h3>Meta-Cognitive Intelligence V1</h3>
          </div>
        </div>

        <div className="aura-meta-badges">
          <span
            className={`aura-meta-pill ${statusBadgeClass}`}
            data-testid="meta-status-badge"
          >
            {statusBadgeText}
          </span>
          <span
            className={`aura-meta-pill ${currentConsentRead ? "active" : "off"}`}
            data-testid="meta-consent-badge"
          >
            APPRENDIMENTO: {currentConsentRead ? "ON" : "OFF"}
          </span>
        </div>
      </div>

      <p className="aura-meta-muted">
        Analisi esclusivamente locale, deterministica e in sola lettura. Nessun invio a Gemini,
        nessun timer in background e nessuna modifica automatica a piani, missioni, obiettivi,
        pesi adattivi o autorizzazioni.
      </p>

      {/* Parametri contestuali opzionali di sola lettura */}
      <div className="aura-meta-context-grid">
        <label className="aura-meta-field">
          <span>Obiettivo contestuale (opzionale)</span>
          <input
            type="text"
            className="aura-meta-input"
            value={declaredGoal}
            onChange={(e) => setDeclaredGoal(e.target.value)}
            placeholder="Es. Riordinare le attività della settimana"
            aria-label="Obiettivo contestuale per l'analisi metacognitiva"
          />
        </label>

        <label className="aura-meta-field">
          <span>Energia attuale (opzionale)</span>
          <select
            className="aura-meta-select"
            value={energyLevel}
            onChange={(e) =>
              setEnergyLevel(e.target.value as "" | "low" | "medium" | "high")
            }
            aria-label="Livello di energia per confronto strategie"
          >
            <option value="">Non specificata</option>
            <option value="low">Bassa</option>
            <option value="medium">Media</option>
            <option value="high">Alta</option>
          </select>
        </label>

        <label className="aura-meta-field">
          <span>Tempo disponibile in min (opzionale)</span>
          <input
            type="number"
            min={1}
            max={480}
            className="aura-meta-input"
            value={timeBudget}
            onChange={(e) => setTimeBudget(e.target.value)}
            placeholder="Es. 25"
            aria-label="Minuti disponibili per confronto strategie"
          />
        </label>
      </div>

      {goalSuggestions.length > 0 && (
        <div className="aura-meta-quick-goals" aria-label="Obiettivi rapidi disponibili">
          <span className="aura-meta-micro-label">Obiettivi attivi:</span>
          {goalSuggestions.map((g) => (
            <button
              key={g}
              type="button"
              className={`aura-meta-chip-btn ${declaredGoal === g ? "selected" : ""}`}
              onClick={() => setDeclaredGoal(g)}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      {/* Pulsanti azione */}
      <div className="aura-meta-actions">
        <button
          type="button"
          className="aura-meta-btn aura-meta-btn-primary"
          onClick={handleAnalyzeNow}
          disabled={dashboardState.status === "analyzing"}
          aria-busy={dashboardState.status === "analyzing"}
        >
          <RefreshCw size={15} />
          {result ? "Aggiorna analisi" : "Analizza ora"}
        </button>

        <button
          type="button"
          className="aura-meta-btn"
          onClick={() => void handleCopyReport()}
          disabled={!result}
        >
          <Copy size={14} /> Copia rapporto
        </button>

        <button
          type="button"
          className="aura-meta-btn"
          onClick={handleExportJson}
          disabled={!result}
        >
          <Download size={14} /> Esporta JSON
        </button>
      </div>

      {dashboardState.errorMessage && (
        <div className="aura-meta-alert aura-meta-alert-danger" role="alert">
          <ShieldAlert size={16} />
          <span>{dashboardState.errorMessage}</span>
        </div>
      )}

      {dashboardState.notice && !dashboardState.errorMessage && (
        <div
          className={`aura-meta-alert ${
            dashboardState.status === "blocked" ? "aura-meta-alert-danger" : ""
          }`}
          role="status"
        >
          {dashboardState.status === "blocked" ? (
            <ShieldAlert size={16} />
          ) : (
            <ShieldCheck size={16} />
          )}
          <span>{dashboardState.notice}</span>
        </div>
      )}

      {actionFeedback && (
        <div className="aura-meta-alert" role="status">
          <CheckCircle2 size={15} />
          <span>{actionFeedback}</span>
        </div>
      )}

      {/* Stato iniziale prima di "Analizza ora" */}
      {dashboardState.status === "idle" && !result && (
        <div className="aura-meta-empty-card" data-testid="meta-idle-card">
          <strong>Analisi metacognitiva non ancora avviata.</strong>
          <p className="aura-meta-muted">
            Premi &ldquo;Analizza ora&rdquo; per ispezionare in sola lettura lo stato cognitivo, la
            traccia del processo, il livello di incertezza, il confronto tra strategie, gli errori
            rilevati, la spiegazione strutturata e i suggerimenti del Meta-Learning Bridge.
          </p>
        </div>
      )}

      {/* Sezioni A-G quando è presente un risultato */}
      {result && (
        <div className="aura-meta-sections">
          {/* A. Stato cognitivo generale */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("overview")}
              aria-expanded={sectionsOpen.overview}
            >
              <span className="aura-meta-title-inline">
                <ShieldCheck size={16} />
                <strong>A. Stato cognitivo generale</strong>
              </span>
              {sectionsOpen.overview ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {sectionsOpen.overview && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-summary-grid">
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Stato sistema</span>
                    <strong>{statusBadgeText}</strong>
                    <span className="aura-meta-muted">Sola lettura · Consultivo</span>
                  </div>
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Controlli sicurezza</span>
                    <strong>
                      {result.safetyDecision.allowed ? "Autorizzato" : "Bloccato (fail-closed)"}
                    </strong>
                    <span className="aura-meta-muted">
                      {result.safetyDecision.blockedBy
                        ? `Motivo: ${result.safetyDecision.blockedBy}`
                        : "Nessun blocco attivo"}
                    </span>
                  </div>
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Evidenze disponibili</span>
                    <strong>
                      {result.verifiedEvidencesCount} verificate ·{" "}
                      {result.unverifiedHypothesesCount} ipotesi
                    </strong>
                    <span className="aura-meta-muted">
                      Moduli: {result.connectedModules.length}
                    </span>
                  </div>
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Ultimo aggiornamento</span>
                    <strong>
                      {dashboardState.lastUpdatedAt
                        ? new Date(dashboardState.lastUpdatedAt).toLocaleTimeString("it-IT", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })
                        : "N/D"}
                    </strong>
                    <span className="aura-meta-muted">
                      Memoria AI ({aiMemoryConsent ? "ON" : "OFF"}) indipendente
                    </span>
                  </div>
                </div>

                {result.limits.length > 0 && (
                  <div className="aura-meta-box">
                    <strong>Blocchi e limitazioni attive</strong>
                    <ul className="aura-meta-list">
                      {result.limits.map((lim, i) => (
                        <li key={i}>{lim}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </article>

          {/* B. Cognitive Process Monitor */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("processMonitor")}
              aria-expanded={sectionsOpen.processMonitor}
            >
              <span className="aura-meta-title-inline">
                <Activity size={16} />
                <strong>B. Cognitive Process Monitor</strong>
              </span>
              {sectionsOpen.processMonitor ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {sectionsOpen.processMonitor && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-meta-row">
                  <span className="aura-meta-tag">
                    Ciclo: {LIFECYCLE_LABELS[result.processMonitor.processLifecycleState]}
                  </span>
                  <span className="aura-meta-tag">
                    Feedback esplicito: {result.processMonitor.evidenceCounts.explicit_feedback}
                  </span>
                  <span className="aura-meta-tag">
                    Comportamento osservato: {result.processMonitor.evidenceCounts.observed_behavior}
                  </span>
                  <span className="aura-meta-tag">
                    Ipotesi: {result.processMonitor.evidenceCounts.hypothesis}
                  </span>
                  <span className="aura-meta-tag">
                    Contraddizioni: {result.processMonitor.trace.contradictionsDetected}
                  </span>
                </div>

                <div className="aura-meta-box">
                  <strong>Traccia leggibile del processo</strong>
                  {result.processMonitor.readableTrace.length === 0 ? (
                    <p className="aura-meta-muted">Nessuna traccia disponibile.</p>
                  ) : (
                    <ul className="aura-meta-list">
                      {result.processMonitor.readableTrace.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>

                {result.processMonitor.incompleteSteps.length > 0 && (
                  <div className="aura-meta-box aura-meta-box-warn">
                    <strong>Passaggi incompleti</strong>
                    <ul className="aura-meta-list">
                      {result.processMonitor.incompleteSteps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.processMonitor.inconsistencies.length > 0 && (
                  <div className="aura-meta-box aura-meta-box-danger">
                    <strong>Incongruenze rilevate</strong>
                    <ul className="aura-meta-list">
                      {result.processMonitor.inconsistencies.map((inc, i) => (
                        <li key={i}>{inc}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="aura-meta-box">
                  <strong>Evidenze raccolte ({result.processMonitor.trace.evidences.length})</strong>
                  {result.processMonitor.trace.evidences.length === 0 ? (
                    <p className="aura-meta-muted">
                      Nessuna evidenza registrata nella sessione corrente.
                    </p>
                  ) : (
                    <div className="aura-meta-card-list">
                      {result.processMonitor.trace.evidences.map((ev) => {
                        const open = Boolean(expandedEvidenceIds[ev.id]);
                        return (
                          <div key={ev.id} className="aura-meta-item-card">
                            <div className="aura-meta-item-head">
                              <div>
                                <span className="aura-meta-tag">
                                  {EVIDENCE_TYPE_LABELS[ev.evidenceType]} ·{" "}
                                  {EPISTEMIC_LABELS[ev.epistemicTag]}
                                </span>
                                <p className="aura-meta-item-title">{ev.summary}</p>
                              </div>
                              <button
                                type="button"
                                className="aura-meta-mini-btn"
                                onClick={() => toggleEvidenceDetail(ev.id)}
                                aria-expanded={open}
                              >
                                {open ? "Nascondi" : "Dettagli"}
                              </button>
                            </div>
                            {open && (
                              <div className="aura-meta-detail-row">
                                <span>Fonte: {ev.dataSource}</span>
                                <span>Affidabilità: {formatReliabilityLabel(ev.confidence)}</span>
                                <span>
                                  Timestamp:{" "}
                                  {new Date(ev.timestamp).toLocaleString("it-IT")}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </article>

          {/* C. Uncertainty Engine */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("uncertainty")}
              aria-expanded={sectionsOpen.uncertainty}
            >
              <span className="aura-meta-title-inline">
                <HelpCircle size={16} />
                <strong>C. Uncertainty Engine</strong>
              </span>
              {sectionsOpen.uncertainty ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {sectionsOpen.uncertainty && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-summary-grid">
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Livello incertezza</span>
                    <strong>
                      {UNCERTAINTY_LABELS[result.uncertaintyEvaluation.assessment.level]}
                    </strong>
                  </div>
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Sufficienza informativa</span>
                    <strong>
                      {SUFFICIENCY_LABELS[result.uncertaintyEvaluation.sufficiencyStatus]}
                    </strong>
                  </div>
                  <div className="aura-meta-stat-card">
                    <span className="aura-meta-stat-label">Punteggio affidabilità</span>
                    <strong data-testid="meta-reliability-value">
                      {formatReliabilityLabel(
                        result.uncertaintyEvaluation.assessment.reliabilityScore
                      )}
                    </strong>
                  </div>
                </div>

                <p className="aura-meta-text">
                  {result.uncertaintyEvaluation.assessment.uncertaintyNote}
                </p>

                {result.processMonitor.trace.missingInformation.length > 0 && (
                  <div className="aura-meta-box aura-meta-box-warn">
                    <strong>
                      Informazioni mancanti (
                      {result.processMonitor.trace.missingInformation.length})
                    </strong>
                    <ul className="aura-meta-list">
                      {result.processMonitor.trace.missingInformation.map((m, i) => (
                        <li key={i}>
                          <strong>{m.field}</strong> ({m.impact}): {m.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.uncertaintyEvaluation.assessment.clarificationQuestions.length > 0 && (
                  <div className="aura-meta-box">
                    <strong>Domande di chiarimento</strong>
                    <ul className="aura-meta-list">
                      {result.uncertaintyEvaluation.assessment.clarificationQuestions.map(
                        (q, i) => (
                          <li key={i}>{q}</li>
                        )
                      )}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </article>

          {/* D. Strategy Comparison */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("strategyComparison")}
              aria-expanded={sectionsOpen.strategyComparison}
            >
              <span className="aura-meta-title-inline">
                <Compass size={16} />
                <strong>D. Strategy Comparison (STANDARD / LIGHT / DEFERRED)</strong>
              </span>
              {sectionsOpen.strategyComparison ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>

            {sectionsOpen.strategyComparison && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-box" data-testid="meta-strategy-summary">
                  <strong>
                    Strategia consigliata:{" "}
                    {result.strategyComparison.selectedStrategy !== null
                      ? result.strategyComparison.selectedStrategy
                      : "Nessuna strategia selezionabile (dati insufficienti)"}
                  </strong>
                  <p className="aura-meta-text">
                    {result.strategyComparison.selectionRationale}
                  </p>
                  <div className="aura-meta-meta-row">
                    <span>
                      Fatti: {result.strategyComparison.epistemicBreakdown.factsCount}
                    </span>
                    <span>
                      Osservazioni:{" "}
                      {result.strategyComparison.epistemicBreakdown.observationsCount}
                    </span>
                    <span>
                      Ipotesi: {result.strategyComparison.epistemicBreakdown.hypothesesCount}
                    </span>
                    <span>
                      Affidabilità:{" "}
                      {formatReliabilityLabel(result.strategyComparison.confidence)}
                    </span>
                  </div>
                </div>

                {result.strategyComparison.options.length === 0 ? (
                  <p className="aura-meta-muted">
                    Confronto non disponibile perché i controlli di sicurezza hanno bloccato
                    l&apos;operazione.
                  </p>
                ) : (
                  <div className="aura-meta-strategy-grid">
                    {result.strategyComparison.options.map((opt) => {
                      const isWinner =
                        result.strategyComparison.selectedStrategy !== null &&
                        result.strategyComparison.selectedStrategy === opt.strategy;
                      return (
                        <div
                          key={opt.strategy}
                          className={`aura-meta-item-card ${
                            isWinner ? "aura-meta-item-recommended" : ""
                          }`}
                        >
                          <div className="aura-meta-item-head">
                            <strong>{opt.strategy}</strong>
                            <span className="aura-meta-tag">
                              {isWinner
                                ? "Consigliata"
                                : `Costo: ${COST_LABELS[opt.operationalCost]}`}
                            </span>
                          </div>
                          <p className="aura-meta-text">{opt.rationale}</p>
                          <div className="aura-meta-detail-row">
                            <span>
                              Accuratezza:{" "}
                              {opt.accuracyScore !== null
                                ? `${Math.round(opt.accuracyScore * 100)}%`
                                : "Dati insufficienti"}
                            </span>
                            <span>Sicurezza: {Math.round(opt.safetyScore * 100)}%</span>
                            <span>Coerenza: {Math.round(opt.coherenceScore * 100)}%</span>
                          </div>
                          {opt.advantages.length > 0 && (
                            <div>
                              <span className="aura-meta-micro-label">Vantaggi:</span>
                              <ul className="aura-meta-list">
                                {opt.advantages.map((a, i) => (
                                  <li key={i}>{a}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {opt.disadvantages.length > 0 && (
                            <div>
                              <span className="aura-meta-micro-label">Svantaggi:</span>
                              <ul className="aura-meta-list">
                                {opt.disadvantages.map((d, i) => (
                                  <li key={i}>{d}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {opt.risks.length > 0 && (
                            <div>
                              <span className="aura-meta-micro-label">Rischi:</span>
                              <ul className="aura-meta-list">
                                {opt.risks.map((rk, i) => (
                                  <li key={i}>{rk}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {opt.tradeoffs.length > 0 && (
                            <div>
                              <span className="aura-meta-micro-label">Tradeoff:</span>
                              <ul className="aura-meta-list">
                                {opt.tradeoffs.map((t, i) => (
                                  <li key={i}>{t}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {opt.rejectedReason && (
                            <p className="aura-meta-muted">
                              Motivo non selezione: {opt.rejectedReason}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </article>

          {/* E. Cognitive Error Detection */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("errorDetection")}
              aria-expanded={sectionsOpen.errorDetection}
            >
              <span className="aura-meta-title-inline">
                <AlertTriangle size={16} />
                <strong>
                  E. Cognitive Error Detection ({result.errorDetection.totalErrorsDetected})
                </strong>
              </span>
              {sectionsOpen.errorDetection ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>

            {sectionsOpen.errorDetection && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-meta-row">
                  <span className="aura-meta-tag">
                    Segnalazioni: {result.errorDetection.totalErrorsDetected}
                  </span>
                  <span className="aura-meta-tag">
                    Revisione umana:{" "}
                    {result.errorDetection.requiresHumanReview ? "Richiesta" : "Opzionale"}
                  </span>
                  <span className="aura-meta-tag">
                    Nessuna correzione automatica applicata
                  </span>
                </div>

                <p className="aura-meta-text">{result.errorDetection.summary}</p>

                {result.errorDetection.findings.length === 0 ? (
                  <p className="aura-meta-muted">
                    Nessun errore o contraddizione rilevata nei dati disponibili.
                  </p>
                ) : (
                  <div className="aura-meta-card-list">
                    {result.errorDetection.findings.map((finding) => (
                      <div key={finding.id} className="aura-meta-item-card">
                        <div className="aura-meta-item-head">
                          <strong>{ERROR_CATEGORY_LABELS[finding.category]}</strong>
                          <span className="aura-meta-tag">
                            Gravità: {SEVERITY_LABELS[finding.severity]}
                          </span>
                        </div>
                        <p className="aura-meta-text">{finding.description}</p>
                        <p className="aura-meta-muted">
                          <strong>Motivazione gravità:</strong> {finding.severityRationale}
                        </p>
                        <p className="aura-meta-muted">
                          <strong>Evidenza ({finding.evidenceSource}):</strong>{" "}
                          {finding.evidenceSummary}
                        </p>
                        {finding.clarificationQuestion && (
                          <p className="aura-meta-text">
                            <strong>Verifica utente:</strong> {finding.clarificationQuestion}
                          </p>
                        )}
                        <p className="aura-meta-text">
                          <strong>Intervento umano suggerito (non applicato):</strong>{" "}
                          {finding.advisoryCorrection}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </article>

          {/* F. Explainability Engine */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("explainability")}
              aria-expanded={sectionsOpen.explainability}
            >
              <span className="aura-meta-title-inline">
                <FileSearch size={16} />
                <strong>F. Explainability Engine</strong>
              </span>
              {sectionsOpen.explainability ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>

            {sectionsOpen.explainability && (
              <div className="aura-meta-section-body">
                <div className="aura-meta-box">
                  <strong>Sintesi della spiegazione</strong>
                  <p className="aura-meta-text">{result.explanation.summary}</p>
                  <p className="aura-meta-muted">
                    <strong>Motivazione:</strong> {result.explanation.whyChosen}
                  </p>
                  <div className="aura-meta-meta-row">
                    <span>
                      Obiettivo: {result.explanation.analyzedGoal ?? "Non specificato"}
                    </span>
                    <span>
                      Tag: {EPISTEMIC_LABELS[result.explanation.epistemicTag]}
                    </span>
                    {result.explanation.evaluationId && (
                      <span>ID: {result.explanation.evaluationId}</span>
                    )}
                  </div>
                </div>

                {/* Separazione Fatti vs Osservazioni vs Ipotesi */}
                <div className="aura-meta-epistemic-grid">
                  <div className="aura-meta-item-card">
                    <strong>
                      Fatti ({result.explanation.epistemicDistinction.counts.facts})
                    </strong>
                    {result.explanation.epistemicDistinction.facts.length === 0 ? (
                      <p className="aura-meta-muted">Nessun fatto esplicito verificato.</p>
                    ) : (
                      <ul className="aura-meta-list">
                        {result.explanation.epistemicDistinction.facts.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="aura-meta-item-card">
                    <strong>
                      Osservazioni (
                      {result.explanation.epistemicDistinction.counts.observations})
                    </strong>
                    {result.explanation.epistemicDistinction.observations.length === 0 ? (
                      <p className="aura-meta-muted">Nessun comportamento osservato.</p>
                    ) : (
                      <ul className="aura-meta-list">
                        {result.explanation.epistemicDistinction.observations.map(
                          (item, i) => (
                            <li key={i}>{item}</li>
                          )
                        )}
                      </ul>
                    )}
                  </div>

                  <div className="aura-meta-item-card">
                    <strong>
                      Ipotesi da verificare (
                      {result.explanation.epistemicDistinction.counts.hypotheses})
                    </strong>
                    {result.explanation.epistemicDistinction.hypotheses.length === 0 ? (
                      <p className="aura-meta-muted">Nessuna ipotesi pendente.</p>
                    ) : (
                      <ul className="aura-meta-list">
                        {result.explanation.epistemicDistinction.hypotheses.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {result.explanation.uncertaintiesAndLimits.length > 0 && (
                  <div className="aura-meta-box">
                    <strong>Limiti e incertezze dichiarate</strong>
                    <ul className="aura-meta-list">
                      {result.explanation.uncertaintiesAndLimits.map((lim, i) => (
                        <li key={i}>{lim}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.explanation.clarificationQuestions.length > 0 && (
                  <div className="aura-meta-box">
                    <strong>Domande utili per chiarire</strong>
                    <ul className="aura-meta-list">
                      {result.explanation.clarificationQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </article>

          {/* G. Meta-Learning Bridge */}
          <article className="aura-meta-subpanel">
            <button
              type="button"
              className="aura-meta-collapse-btn"
              onClick={() => toggleSection("metaLearning")}
              aria-expanded={sectionsOpen.metaLearning}
            >
              <span className="aura-meta-title-inline">
                <GitBranch size={16} />
                <strong>
                  G. Meta-Learning Bridge ({result.improvementSuggestions.length} suggerimenti ·{" "}
                  {result.proposals.length} proposte)
                </strong>
              </span>
              {sectionsOpen.metaLearning ? (
                <ChevronUp size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>

            {sectionsOpen.metaLearning && (
              <div className="aura-meta-section-body">
                {pendingProposalToSave && (
                  <div
                    className="aura-meta-confirm-box"
                    role="alertdialog"
                    aria-label="Conferma registrazione proposta"
                  >
                    <p>
                      Registrare &ldquo;{pendingProposalToSave.title}&rdquo; in Knowledge
                      Evolution con stato <strong>proposed</strong>? Nessun dato sarà validato
                      automaticamente: potrai poi approvarla o rifiutarla manualmente nel pannello
                      Knowledge Evolution.
                    </p>
                    <div className="aura-meta-actions">
                      <button
                        type="button"
                        className="aura-meta-btn aura-meta-btn-primary"
                        onClick={handleConfirmSaveProposal}
                      >
                        Conferma registrazione proposta
                      </button>
                      <button
                        type="button"
                        className="aura-meta-btn"
                        onClick={() => setPendingProposalToSave(null)}
                      >
                        Annulla
                      </button>
                    </div>
                  </div>
                )}

                {/* Suggerimenti di miglioramento */}
                <div className="aura-meta-box">
                  <strong>
                    Suggerimenti di miglioramento ({result.improvementSuggestions.length})
                  </strong>
                  {result.improvementSuggestions.length === 0 ? (
                    <p className="aura-meta-muted">
                      Nessun suggerimento aggiuntivo rilevato dai dati attuali.
                    </p>
                  ) : (
                    <div className="aura-meta-card-list">
                      {result.improvementSuggestions.map((sugg) => (
                        <div key={sugg.id} className="aura-meta-item-card">
                          <div className="aura-meta-item-head">
                            <strong>{sugg.title}</strong>
                            <span className="aura-meta-tag">
                              {EPISTEMIC_LABELS[sugg.epistemicTag]} ·{" "}
                              {formatReliabilityLabel(sugg.confidence)}
                            </span>
                          </div>
                          <p className="aura-meta-text">{sugg.description}</p>
                          <p className="aura-meta-muted">
                            Fonti: {sugg.supportingDataSources.join(", ")}
                          </p>
                          {sugg.supportingEvidence.length > 0 && (
                            <ul className="aura-meta-list">
                              {sugg.supportingEvidence.map((ev, i) => (
                                <li key={i}>{ev}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Proposte generate (solo stato proposed, mai auto-approvate) */}
                <div className="aura-meta-box">
                  <strong>
                    Proposte generate ({result.proposals.length}) · Nessuna approvazione
                    automatica
                  </strong>
                  {result.proposals.length === 0 ? (
                    <p className="aura-meta-muted">
                      Nessuna nuova proposta di conoscenza o segnale adattivo generata.
                    </p>
                  ) : (
                    <div className="aura-meta-card-list">
                      {result.proposals.map((prop) => {
                        const alreadySaved = Boolean(savedProposalIds[prop.id]);
                        return (
                          <div key={prop.id} className="aura-meta-item-card">
                            <div className="aura-meta-item-head">
                              <div>
                                <span className="aura-meta-tag">
                                  <Layers size={12} /> {prop.targetEngine} · Stato:{" "}
                                  {prop.status.toUpperCase()}
                                </span>
                                <p className="aura-meta-item-title">{prop.title}</p>
                              </div>
                              <span className="aura-meta-tag">
                                Approvazione esplicita richiesta
                              </span>
                            </div>

                            <p className="aura-meta-text">{prop.rationale}</p>
                            <p className="aura-meta-muted">
                              Fonti: {prop.supportingDataSources.join(", ")} · Affidabilità:{" "}
                              {formatReliabilityLabel(prop.confidence)}
                            </p>

                            {prop.knowledgeProposalPayload && (
                              <div className="aura-meta-actions">
                                <button
                                  type="button"
                                  className="aura-meta-btn"
                                  disabled={
                                    alreadySaved ||
                                    !result.learningConsentActive ||
                                    crisisBlocked
                                  }
                                  onClick={() => setPendingProposalToSave(prop)}
                                >
                                  <Sparkles size={14} />
                                  {alreadySaved
                                    ? "Inviata come proposta (in attesa)"
                                    : "Invia come proposta da confermare"}
                                </button>
                              </div>
                            )}

                            {prop.adaptiveSignalDraft && (
                              <p className="aura-meta-muted">
                                Bozza segnale adattivo ({prop.adaptiveSignalDraft.strategy}): i
                                pesi di AdaptiveLearningEngine restano invariati senza conferma
                                utente esplicita.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
