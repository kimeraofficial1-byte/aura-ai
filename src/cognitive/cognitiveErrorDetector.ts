import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { AdaptiveStrategy } from "./adaptiveLearningEngine";
import type { AuthorizationLedger } from "./authorizationLedger";
import {
  monitorCognitiveProcess,
  type CognitiveProcessMonitorResult,
  type ExplicitEvidenceInput,
  type MonitoredProcessStep,
} from "./cognitiveProcessMonitor";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import type { ExperienceSummary } from "./experienceAnalyzer";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type {
  CognitiveErrorCategory,
  CognitiveErrorFinding,
  CognitiveErrorSeverity,
  MetaCognitiveSafetyDecision,
  StrategyComparisonResult,
} from "./metaCognitiveTypes";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
} from "./selfLearningTypes";
import type { StrategyConstraintsInput } from "./strategyComparisonEngine";
import {
  evaluateUncertainty,
  MIN_EVIDENCE_FOR_RELIABILITY,
  type UncertaintyEvaluationResult,
} from "./uncertaintyEngine";

export const DEFAULT_STALE_EVIDENCE_DAYS = 14;

export type CognitiveErrorSubtype =
  | "information_contradiction"
  | "hypothesis_as_fact"
  | "missing_or_stale_information"
  | "goal_strategy_mismatch"
  | "unsupported_conclusion"
  | "epistemic_classification_error"
  | "human_verification_required"
  | "recurring_operational_error";

export interface DetectedCognitiveErrorFinding extends CognitiveErrorFinding {
  errorSubtype: CognitiveErrorSubtype;
  severityRationale: string;
  evidenceSummary: string;
  confidence: Confidence | null;
  clarificationQuestion?: string;
  advisoryOnly: true;
  autoApplied: false;
}

export interface CognitiveErrorDetectionResult {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  autoApplied: false;
  findings: DetectedCognitiveErrorFinding[];
  totalErrorsDetected: number;
  requiresHumanReview: boolean;
  confidence: Confidence | null;
  epistemicTag: EpistemicTag;
  summary: string;
  safetyDecision: MetaCognitiveSafetyDecision;
  processMonitor: CognitiveProcessMonitorResult;
  uncertaintyEvaluation: UncertaintyEvaluationResult;
}

export interface CognitiveErrorDetectionInput {
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  declaredGoal?: string;
  proposedStrategy?: AdaptiveStrategy;
  proposedConclusion?: string;
  conclusionMarkedAsFact?: boolean;
  constraints?: StrategyConstraintsInput;
  staleThresholdDays?: number;
  requiresHumanVerification?: boolean;
  strategyComparison?: StrategyComparisonResult;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  authorizationLedger?: AuthorizationLedger;
  experienceSummary?: ExperienceSummary;
  expectedInputs?: string[];
  availableInputs?: Record<string, unknown>;
  processSteps?: MonitoredProcessStep[];
  explicitEvidences?: ExplicitEvidenceInput[];
  processMonitorResult?: CognitiveProcessMonitorResult;
  uncertaintyResult?: UncertaintyEvaluationResult;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

function clampConfidence(value: number): Confidence {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function buildBlockedErrorDetection(
  reason: string,
  safetyDecision: MetaCognitiveSafetyDecision,
  processMonitor: CognitiveProcessMonitorResult,
  uncertaintyEvaluation: UncertaintyEvaluationResult
): CognitiveErrorDetectionResult {
  return {
    allowed: false,
    advisoryOnly: true,
    readOnly: true,
    autoApplied: false,
    findings: [],
    totalErrorsDetected: 0,
    requiresHumanReview: true,
    confidence: null,
    epistemicTag: "ipotesi_da_verificare",
    summary: reason,
    safetyDecision,
    processMonitor,
    uncertaintyEvaluation,
  };
}

/**
 * Cognitive Error Detection Engine V1.
 * Individua in sola lettura contraddizioni, ipotesi classificate come fatti,
 * informazioni mancanti o obsolete, incoerenze obiettivo/strategia, conclusioni
 * non supportate ed errori ricorrenti. Non applica mai correzioni automatiche.
 */
export function detectCognitiveErrors(
  input: CognitiveErrorDetectionInput
): CognitiveErrorDetectionResult {
  const nowIso = input?.nowIso ?? new Date().toISOString();
  const hasLearningSources = Boolean(
    input?.controlledLearning || input?.experienceSummary
  );
  const usesLearningData = hasLearningSources
    ? true
    : (input?.usesLearningData ?? true);

  const safetyDecision = evaluateMetaCognitiveSafety({
    operation: "detect_errors",
    consentState: input?.consentState,
    usesLearningData,
    crisisBlocked: input?.crisisBlocked,
    userTextForSafetyCheck: input?.userTextForSafetyCheck,
    storageAvailable: input?.storageAvailable,
    corruptedDataDetected: input?.corruptedDataDetected,
    nowIso,
  });

  const mergedAvailableInputs: Record<string, unknown> = {
    ...(input?.availableInputs ?? {}),
  };
  if (input?.declaredGoal?.trim() && mergedAvailableInputs.goal === undefined) {
    mergedAvailableInputs.goal = input.declaredGoal.trim();
  }

  const processMonitor =
    input?.processMonitorResult ??
    monitorCognitiveProcess({
      consentState: input?.consentState,
      usesLearningData,
      repository: input?.repository,
      timeline: input?.timeline,
      controlledLearning: input?.controlledLearning,
      experienceSummary: input?.experienceSummary,
      expectedInputs: input?.expectedInputs,
      availableInputs: mergedAvailableInputs,
      processSteps: input?.processSteps,
      explicitEvidences: input?.explicitEvidences,
      crisisBlocked: input?.crisisBlocked,
      userTextForSafetyCheck: input?.userTextForSafetyCheck,
      storageAvailable: input?.storageAvailable,
      corruptedDataDetected: input?.corruptedDataDetected,
      nowIso,
    });

  const uncertaintyEvaluation =
    input?.uncertaintyResult ??
    evaluateUncertainty({
      consentState: input?.consentState,
      usesLearningData,
      trace: processMonitor.trace,
      experienceSummary: input?.experienceSummary,
      crisisBlocked: input?.crisisBlocked,
      userTextForSafetyCheck: input?.userTextForSafetyCheck,
      storageAvailable: input?.storageAvailable,
      corruptedDataDetected: input?.corruptedDataDetected,
      nowIso,
    });

  if (
    !safetyDecision.allowed ||
    !processMonitor.allowed ||
    !uncertaintyEvaluation.allowed
  ) {
    const blockingDecision = !safetyDecision.allowed
      ? safetyDecision
      : !processMonitor.allowed
        ? processMonitor.safetyDecision
        : uncertaintyEvaluation.safetyDecision;
    return buildBlockedErrorDetection(
      blockingDecision.reason,
      blockingDecision,
      processMonitor,
      uncertaintyEvaluation
    );
  }

  try {
    const findings: DetectedCognitiveErrorFinding[] = [];
    const evidences = processMonitor.trace.evidences;
    const missingInfo = processMonitor.trace.missingInformation;
    const sufficiency = uncertaintyEvaluation.sufficiencyStatus;
    const reliability = uncertaintyEvaluation.assessment.reliabilityScore;
    const insufficientEvidence =
      sufficiency === "insufficient" || reliability === null;

    const addFinding = (params: {
      id: string;
      category: CognitiveErrorCategory;
      errorSubtype: CognitiveErrorSubtype;
      severity: CognitiveErrorSeverity;
      severityRationale: string;
      description: string;
      evidenceSource: string;
      evidenceSummary: string;
      confidence: Confidence | null;
      clarificationQuestion?: string;
      advisoryCorrection: string;
    }) => {
      findings.push({
        id: params.id,
        category: params.category,
        errorSubtype: params.errorSubtype,
        severity: params.severity,
        severityRationale: params.severityRationale,
        description: params.description,
        evidenceSource: params.evidenceSource,
        evidenceSummary: params.evidenceSummary,
        confidence: insufficientEvidence
          ? null
          : params.confidence === null
            ? null
            : clampConfidence(params.confidence),
        clarificationQuestion: params.clarificationQuestion,
        advisoryCorrection: params.advisoryCorrection,
        advisoryOnly: true,
        autoApplied: false,
      });
    };

    // 1. Ipotesi presentate erroneamente come fatti & errori di classificazione epistemica
    for (const ev of evidences) {
      if (
        ev.evidenceType === "hypothesis" &&
        ev.epistemicTag === "fatto_osservato"
      ) {
        addFinding({
          id: `err-hyp-fact-${ev.id}`,
          category: "epistemic_mismatch",
          errorSubtype: "hypothesis_as_fact",
          severity: "high",
          severityRationale:
            "Gravità alta: un'ipotesi non verificata è stata etichettata come fatto osservato, violando la distinzione epistemica.",
          description: `L'evidenza "${ev.id}" ha tipo "hypothesis" ma porta il tag epistemico "fatto_osservato".`,
          evidenceSource: ev.dataSource,
          evidenceSummary: ev.summary,
          confidence: insufficientEvidence ? null : 0.95,
          clarificationQuestion: `Confermi che "${ev.summary}" è un'ipotesi da verificare anziché un fatto confermato?`,
          advisoryCorrection:
            "Riclassificare manualmente l'elemento come ipotesi_da_verificare prima di usarlo per decisioni.",
        });
      } else if (
        (ev.epistemicTag === "fatto_osservato" && ev.confidence < 0.4) ||
        (ev.evidenceType === "explicit_feedback" &&
          ev.epistemicTag === "ipotesi_da_verificare")
      ) {
        addFinding({
          id: `err-epistemic-${ev.id}`,
          category: "epistemic_mismatch",
          errorSubtype: "epistemic_classification_error",
          severity: "medium",
          severityRationale:
            "Gravità media: la classificazione epistemica non è coerente con il tipo di evidenza o il livello di confidenza registrato.",
          description: `Classificazione epistemica incoerente sull'evidenza "${ev.id}" (tipo: ${ev.evidenceType}, tag: ${ev.epistemicTag}, confidenza: ${ev.confidence}).`,
          evidenceSource: ev.dataSource,
          evidenceSummary: ev.summary,
          confidence: insufficientEvidence ? null : 0.85,
          clarificationQuestion: `Puoi verificare l'affidabilità effettiva del segnale "${ev.summary}"?`,
          advisoryCorrection:
            "Rivedere il tag epistemico associato al segnale mantenendo la separazione tra fatti osservati e ipotesi.",
        });
      }
    }

    if (
      input?.proposedConclusion?.trim() &&
      input.conclusionMarkedAsFact === true &&
      (uncertaintyEvaluation.verifiedObservationCount <
        MIN_EVIDENCE_FOR_RELIABILITY ||
        uncertaintyEvaluation.unverifiedHypothesesCount > 0)
    ) {
      addFinding({
        id: "err-conclusion-as-fact",
        category: "epistemic_mismatch",
        errorSubtype: "hypothesis_as_fact",
        severity: "high",
        severityRationale:
          "Gravità alta: una conclusione basata su evidenze insufficienti o ipotesi non verificate viene presentata come fatto certo.",
        description: `La conclusione proposta ("${input.proposedConclusion.trim()}") è presentata come fatto ma poggia su ${uncertaintyEvaluation.verifiedObservationCount} osservazioni verificate e ${uncertaintyEvaluation.unverifiedHypothesesCount} ipotesi.`,
        evidenceSource: "UncertaintyEngine",
        evidenceSummary: `Osservazioni verificate: ${uncertaintyEvaluation.verifiedObservationCount}/${MIN_EVIDENCE_FOR_RELIABILITY}, ipotesi: ${uncertaintyEvaluation.unverifiedHypothesesCount}.`,
        confidence: null,
        clarificationQuestion:
          "Quali fatti verificati confermano questa conclusione prima di trattarla come certa?",
        advisoryCorrection:
          "Presentare la conclusione come ipotesi_da_verificare finché non siano raccolti almeno 3 riscontri osservati coerenti.",
      });
    }

    // 2. Contraddizioni tra informazioni
    const nonEpistemicInconsistencies = processMonitor.inconsistencies.filter(
      (msg) =>
        !msg.includes("Incongruenza epistemica") &&
        !msg.includes("Incongruenza confidenza")
    );
    nonEpistemicInconsistencies.forEach((msg, idx) => {
      addFinding({
        id: `err-contradiction-${idx + 1}`,
        category: "internal_contradiction",
        errorSubtype: "information_contradiction",
        severity: "high",
        severityRationale:
          "Gravità alta: la traccia del processo cognitivo evidenzia informazioni contrastanti o passaggi completati con lacune critiche.",
        description: msg,
        evidenceSource: "CognitiveProcessMonitor",
        evidenceSummary: msg,
        confidence: insufficientEvidence ? null : clampConfidence(reliability),
        clarificationQuestion:
          "Quale tra i segnali contrastanti riflette la tua situazione attuale?",
        advisoryCorrection:
          "Sospendere la valutazione automatica e chiedere conferma esplicita all'utente sui dati in conflitto.",
      });
    });

    const explicitAccepts = evidences.filter(
      (e) =>
        e.evidenceType === "explicit_feedback" &&
        e.summary.toLowerCase().includes("accepted")
    ).length;
    const explicitRejects = evidences.filter(
      (e) =>
        e.evidenceType === "explicit_feedback" &&
        e.summary.toLowerCase().includes("rejected")
    ).length;
    if (
      explicitAccepts > 0 &&
      explicitRejects > 0 &&
      nonEpistemicInconsistencies.length === 0
    ) {
      addFinding({
        id: "err-contradiction-feedback-mix",
        category: "internal_contradiction",
        errorSubtype: "information_contradiction",
        severity: "medium",
        severityRationale:
          "Gravità media: sono presenti feedback espliciti opposti che riducono la stabilità dell'interpretazione.",
        description: `Rilevati feedback espliciti contrastanti (${explicitAccepts} accettazioni e ${explicitRejects} rifiuti).`,
        evidenceSource: "ControlledLearningEngine",
        evidenceSummary: `Accettazioni: ${explicitAccepts}, rifiuti: ${explicitRejects}.`,
        confidence: insufficientEvidence ? null : clampConfidence(reliability),
        clarificationQuestion:
          "Le condizioni o preferenze rispetto alle proposte precedenti sono cambiate?",
        advisoryCorrection:
          "Verificare con l'utente quale orientamento preferisce mantenere prima di proporre strategie.",
      });
    }

    // 3. Informazioni mancanti o obsolete
    if (missingInfo.length > 0) {
      const hasHighImpact = missingInfo.some((m) => m.impact === "high");
      addFinding({
        id: "err-missing-information",
        category: "unsupported_conclusion",
        errorSubtype: "missing_or_stale_information",
        severity: hasHighImpact ? "high" : "medium",
        severityRationale: hasHighImpact
          ? "Gravità alta: mancano informazioni obbligatorie ad alto impatto per una valutazione affidabile."
          : "Gravità media: informazioni parzialmente assenti limitano la completezza dell'analisi.",
        description: `Informazioni mancanti rilevate (${missingInfo.length}): ${missingInfo.map((m) => m.field).join(", ")}.`,
        evidenceSource: "CognitiveProcessMonitor",
        evidenceSummary: missingInfo.map((m) => `${m.field}: ${m.reason}`).join(" | "),
        confidence: insufficientEvidence ? null : clampConfidence(reliability),
        clarificationQuestion:
          uncertaintyEvaluation.assessment.clarificationQuestions[0] ??
          `Puoi fornire il dato mancante "${missingInfo[0].field}"?`,
        advisoryCorrection:
          "Richiedere all'utente il completamento dei campi mancanti prima di formulare raccomandazioni operative.",
      });
    }

    const staleDays = Math.max(
      1,
      input?.staleThresholdDays ?? DEFAULT_STALE_EVIDENCE_DAYS
    );
    const nowMs = Date.parse(nowIso);
    if (!Number.isNaN(nowMs)) {
      const staleEvidences = evidences.filter((ev) => {
        const evMs = Date.parse(ev.timestamp);
        if (Number.isNaN(evMs)) return false;
        const diffDays = (nowMs - evMs) / (1000 * 60 * 60 * 24);
        return diffDays > staleDays;
      });

      if (staleEvidences.length > 0) {
        const allStale = staleEvidences.length === evidences.length;
        addFinding({
          id: "err-stale-evidences",
          category: "unsupported_conclusion",
          errorSubtype: "missing_or_stale_information",
          severity: allStale ? "high" : "medium",
          severityRationale: allStale
            ? `Gravità alta: tutte le evidenze disponibili (${staleEvidences.length}) superano la soglia di obsolescenza di ${staleDays} giorni.`
            : `Gravità media: ${staleEvidences.length} evidenze risultano più vecchie di ${staleDays} giorni.`,
          description: `Rilevate ${staleEvidences.length} evidenze potenzialmente obsolete (> ${staleDays} giorni).`,
          evidenceSource: staleEvidences.map((e) => e.dataSource).join("+"),
          evidenceSummary: staleEvidences
            .slice(0, 3)
            .map((e) => `${e.id} (${e.timestamp})`)
            .join(", "),
          confidence: insufficientEvidence
            ? null
            : clampConfidence(Math.max(0.3, reliability * 0.8)),
          clarificationQuestion:
            "Le osservazioni registrate in passato sono ancora valide per la tua situazione attuale?",
          advisoryCorrection:
            "Confermare manualmente con l'utente se i segnali datati restano attuali o vanno ignorati.",
        });
      }
    }

    // 4. Incoerenze tra obiettivi e strategie
    const declaredGoal = input?.declaredGoal?.trim() ?? "";
    const constraints = input?.constraints ?? {};
    const proposedStrategy = input?.proposedStrategy;

    if (proposedStrategy) {
      const lowEnergy = constraints.energyLevel === "low";
      const tightTime =
        typeof constraints.timeBudgetMinutes === "number" &&
        Number.isFinite(constraints.timeBudgetMinutes) &&
        constraints.timeBudgetMinutes <= 20;
      const overload = constraints.overloadDetected === true;
      const blockedProcess =
        processMonitor.processLifecycleState === "bloccato" ||
        processMonitor.processLifecycleState === "sospeso";

      if (!declaredGoal) {
        addFinding({
          id: "err-strategy-without-goal",
          category: "internal_contradiction",
          errorSubtype: "goal_strategy_mismatch",
          severity: "high",
          severityRationale:
            "Gravità alta: una strategia operativa è stata proposta senza un obiettivo dichiarato verificabile.",
          description: `La strategia "${proposedStrategy}" non è ancorata ad alcun obiettivo dichiarato.`,
          evidenceSource: "StrategyContext",
          evidenceSummary: `proposedStrategy=${proposedStrategy}, declaredGoal=""`,
          confidence: insufficientEvidence ? null : 0.85,
          clarificationQuestion:
            "Qual è l'obiettivo concreto a cui associare questa strategia?",
          advisoryCorrection:
            "Definire esplicitamente l'obiettivo con l'utente prima di selezionare una strategia.",
        });
      } else if (
        proposedStrategy === "STANDARD" &&
        (lowEnergy || tightTime || overload || blockedProcess)
      ) {
        addFinding({
          id: "err-goal-strategy-overload",
          category: "internal_contradiction",
          errorSubtype: "goal_strategy_mismatch",
          severity: "high",
          severityRationale:
            "Gravità alta: la strategia STANDARD entra in conflitto con i vincoli dichiarati di carico, tempo, energia o stato bloccato.",
          description: `Incoerenza tra obiettivo "${declaredGoal}" con strategia STANDARD e i vincoli attivi (energia: ${constraints.energyLevel ?? "n/d"}, tempo: ${constraints.timeBudgetMinutes ?? "n/d"} min, sovraccarico: ${overload}, processo: ${processMonitor.processLifecycleState}).`,
          evidenceSource: "StrategyContext+CognitiveProcessMonitor",
          evidenceSummary: `Strategia STANDARD incompatibile con vincoli dichiarati o stato processo ${processMonitor.processLifecycleState}.`,
          confidence: insufficientEvidence ? null : clampConfidence(reliability),
          clarificationQuestion:
            "Preferisci valutare una modalità LIGHT o rimandare (DEFERRED) finché i vincoli restano attivi?",
          advisoryCorrection:
            "Valutare con l'utente il passaggio consultivo a LIGHT o DEFERRED senza applicare modifiche automatiche.",
        });
      } else if (
        proposedStrategy === "DEFERRED" &&
        constraints.deadlineUrgent === true &&
        sufficiency === "sufficient" &&
        !overload &&
        !lowEnergy &&
        !blockedProcess
      ) {
        addFinding({
          id: "err-goal-strategy-urgent-deferred",
          category: "internal_contradiction",
          errorSubtype: "goal_strategy_mismatch",
          severity: "medium",
          severityRationale:
            "Gravità media: il rinvio totale contrasta con una scadenza urgente in presenza di dati sufficienti e assenza di sovraccarico.",
          description: `La strategia DEFERRED contrasta con l'urgenza dichiarata sull'obiettivo "${declaredGoal}".`,
          evidenceSource: "StrategyContext",
          evidenceSummary:
            "deadlineUrgent=true, sufficiencyStatus=sufficient, overloadDetected=false.",
          confidence: insufficientEvidence ? null : clampConfidence(reliability),
          clarificationQuestion:
            "Confermi di voler comunque rimandare nonostante la scadenza urgente e i dati disponibili?",
          advisoryCorrection:
            "Proporre all'utente una revisione tra LIGHT e STANDARD in base alla priorità reale.",
        });
      }
    }

    if (
      input?.strategyComparison &&
      proposedStrategy &&
      input.strategyComparison.selectedStrategy !== null &&
      input.strategyComparison.selectedStrategy !== proposedStrategy
    ) {
      addFinding({
        id: "err-strategy-comparison-divergence",
        category: "internal_contradiction",
        errorSubtype: "goal_strategy_mismatch",
        severity: "medium",
        severityRationale:
          "Gravità media: la strategia proposta diverge dall'esito consultivo del confronto strategie.",
        description: `La strategia proposta (${proposedStrategy}) diverge dalla strategia risultata più coerente nel confronto (${input.strategyComparison.selectedStrategy}).`,
        evidenceSource: "StrategyComparisonEngine",
        evidenceSummary: input.strategyComparison.selectionRationale,
        confidence: input.strategyComparison.confidence,
        clarificationQuestion: `Quale motivo ti porta a preferire ${proposedStrategy} rispetto a ${input.strategyComparison.selectedStrategy}?`,
        advisoryCorrection:
          "Mostrare all'utente il confronto tra le alternative lasciando a lui la scelta finale.",
      });
    }

    // 5. Conclusioni non supportate dalle evidenze
    if (
      input?.proposedConclusion?.trim() &&
      input.conclusionMarkedAsFact !== true &&
      insufficientEvidence
    ) {
      addFinding({
        id: "err-unsupported-conclusion",
        category: "unsupported_conclusion",
        errorSubtype: "unsupported_conclusion",
        severity:
          uncertaintyEvaluation.verifiedObservationCount === 0
            ? "high"
            : "medium",
        severityRationale:
          uncertaintyEvaluation.verifiedObservationCount === 0
            ? "Gravità alta: conclusione formulata con zero osservazioni verificate."
            : "Gravità media: conclusione formulata con evidenze inferiori alla soglia minima.",
        description: `Conclusione non sufficientemente supportata ("${input.proposedConclusion.trim()}"): ${uncertaintyEvaluation.verifiedObservationCount}/${MIN_EVIDENCE_FOR_RELIABILITY} osservazioni verificate.`,
        evidenceSource: "UncertaintyEngine",
        evidenceSummary: uncertaintyEvaluation.assessment.uncertaintyNote,
        confidence: null,
        clarificationQuestion:
          uncertaintyEvaluation.assessment.clarificationQuestions[0] ??
          "Puoi fornire almeno un riscontro diretto a supporto di questa conclusione?",
        advisoryCorrection:
          "Trattare la conclusione come ipotesi preliminare finché non siano disponibili evidenze verificate sufficienti.",
      });
    }

    // 6. Errori ricorrenti (in sola lettura da AuthorizationLedger, ControlledLearningEngine, DataRepository)
    if (input?.authorizationLedger) {
      const auditEvents = input.authorizationLedger.getAuditEvents();
      const problemEvents = auditEvents.filter(
        (ev) =>
          ev.eventType === "execution_blocked" ||
          ev.eventType === "authorization_rejected" ||
          ev.eventType === "execution_error" ||
          ev.eventType === "rollback_succeeded"
      );
      if (problemEvents.length >= 2) {
        addFinding({
          id: "err-recurring-audit",
          category: "recurring_error",
          errorSubtype: "recurring_operational_error",
          severity: problemEvents.length >= 3 ? "high" : "medium",
          severityRationale:
            problemEvents.length >= 3
              ? "Gravità alta: almeno 3 blocchi, errori esecutivi o rollback registrati nel ledger di audit."
              : "Gravità media: 2 eventi ripetuti di blocco o errore registrati nel ledger di audit.",
          description: `Rilevati ${problemEvents.length} eventi ricorrenti di blocco, errore o rollback nell'audit.`,
          evidenceSource: "AuthorizationLedger",
          evidenceSummary: problemEvents
            .slice(-3)
            .map((e) => `${e.eventType} (${e.timestamp})`)
            .join(", "),
          confidence: insufficientEvidence ? null : clampConfidence(reliability),
          clarificationQuestion:
            "Vuoi rivedere la configurazione delle proposte che hanno generato blocchi o rollback ripetuti?",
          advisoryCorrection:
            "Ispezionare con l'utente le azioni bloccate prima di autorizzare nuovi passaggi.",
        });
      }
    }

    if (input?.controlledLearning && usesLearningData) {
      const exported = input.controlledLearning.exportLearningData();
      const repeatedRejects = exported.interactions.filter(
        (i) => i.action === "rejected" || i.action === "suspended"
      );
      if (repeatedRejects.length >= 3) {
        addFinding({
          id: "err-recurring-rejections",
          category: "recurring_error",
          errorSubtype: "recurring_operational_error",
          severity: "medium",
          severityRationale:
            "Gravità media: almeno 3 rifiuti o sospensioni esplicite indicano un disallineamento ricorrente nelle proposte.",
          description: `Rilevati ${repeatedRejects.length} rifiuti o sospensioni ricorrenti nei feedback espliciti.`,
          evidenceSource: "ControlledLearningEngine",
          evidenceSummary: repeatedRejects
            .slice(-3)
            .map((r) => `${r.category}:${r.action}`)
            .join(", "),
          confidence: insufficientEvidence ? null : clampConfidence(reliability),
          clarificationQuestion:
            "Quale formato o frequenza di proposte sarebbe più utile per te?",
          advisoryCorrection:
            "Ridurre il dettaglio o la frequenza dei suggerimenti solo previa conferma dell'utente.",
        });
      }
    }

    if (input?.repository) {
      const snapshot = input.repository.loadSnapshot();
      let stalledTasks = 0;
      for (const plan of snapshot.plans) {
        for (const task of plan.tasks) {
          if (task.status === "paused" || task.status === "overdue") {
            stalledTasks += 1;
          }
        }
      }
      if (stalledTasks >= 3) {
        addFinding({
          id: "err-recurring-stalled-tasks",
          category: "recurring_error",
          errorSubtype: "recurring_operational_error",
          severity: "medium",
          severityRationale:
            "Gravità media: almeno 3 task risultano ripetutamente in pausa o in ritardo nei piani salvati.",
          description: `Rilevati ${stalledTasks} task in pausa o in ritardo nei piani operativi.`,
          evidenceSource: "DataRepository",
          evidenceSummary: `${stalledTasks} task in stato paused/overdue.`,
          confidence: insufficientEvidence ? null : clampConfidence(reliability),
          clarificationQuestion:
            "I task rimasti in sospeso sono ancora prioritari o richiedono una revisione manuale?",
          advisoryCorrection:
            "Suggerire all'utente una revisione manuale dei task sospesi o in ritardo.",
        });
      }
    }

    // 7. Decisioni che richiedono una verifica umana
    const needsHumanConfirmation =
      input?.requiresHumanVerification === true ||
      findings.some((f) => f.severity === "high") ||
      (Boolean(proposedStrategy || input?.proposedConclusion?.trim()) &&
        insufficientEvidence);

    if (needsHumanConfirmation) {
      addFinding({
        id: "err-human-verification-required",
        category: "unsupported_conclusion",
        errorSubtype: "human_verification_required",
        severity: findings.some((f) => f.severity === "high") ? "high" : "medium",
        severityRationale:
          findings.some((f) => f.severity === "high")
            ? "Gravità alta: sono presenti anomalie critiche o incertezze non risolvibili automaticamente."
            : "Gravità media: la decisione proposta richiede conferma esplicita prima di procedere.",
        description:
          "La decisione o valutazione corrente richiede una verifica umana esplicita prima di essere utilizzata.",
        evidenceSource: "CognitiveErrorDetector+UncertaintyEngine",
        evidenceSummary: `Errori rilevati: ${findings.length}, sufficienza: ${sufficiency}, verifica esplicita richiesta: ${Boolean(input?.requiresHumanVerification)}.`,
        confidence: insufficientEvidence ? null : clampConfidence(reliability),
        clarificationQuestion:
          uncertaintyEvaluation.assessment.clarificationQuestions[0] ??
          "Confermi manualmente come desideri procedere rispetto alle segnalazioni rilevate?",
        advisoryCorrection:
          "Attendere l'intervento o la conferma esplicita dell'utente senza eseguire alcuna correzione automatica.",
      });
    }

    const requiresHumanReview =
      findings.length > 0 || uncertaintyEvaluation.assessment.needsClarification;

    const epistemicTag: EpistemicTag = insufficientEvidence
      ? "ipotesi_da_verificare"
      : sufficiency === "sufficient" &&
          uncertaintyEvaluation.unverifiedHypothesesCount === 0
        ? "fatto_osservato"
        : "interpretazione_prudente";

    const overallConfidence: Confidence | null = insufficientEvidence
      ? null
      : reliability;

    const summary =
      findings.length === 0
        ? "Nessun errore cognitivo rilevato sulle evidenze disponibili (analisi consultiva in sola lettura)."
        : `Rilevate ${findings.length} segnalazioni cognitive consultive (nessuna correzione applicata automaticamente).`;

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      autoApplied: false,
      findings,
      totalErrorsDetected: findings.length,
      requiresHumanReview,
      confidence: overallConfidence,
      epistemicTag,
      summary,
      safetyDecision,
      processMonitor,
      uncertaintyEvaluation,
    };
  } catch {
    return buildBlockedErrorDetection(
      "Errore interno nel Cognitive Error Detector: blocco fail-closed senza impatto sui motori esistenti.",
      {
        ...safetyDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
      processMonitor,
      uncertaintyEvaluation
    );
  }
}
