import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { AdaptiveLearningEngine, AdaptiveStrategy } from "./adaptiveLearningEngine";
import type { AuthorizationLedger } from "./authorizationLedger";
import {
  detectCognitiveErrors,
  type CognitiveErrorDetectionResult,
  type DetectedCognitiveErrorFinding,
} from "./cognitiveErrorDetector";
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
  DecisionExplanation,
  MetaCognitiveEvidenceItem,
  MetaCognitiveSafetyDecision,
  MissingInformationItem,
  UncertaintyLevel,
} from "./metaCognitiveTypes";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
} from "./selfLearningTypes";
import {
  compareCognitiveStrategies,
  type StrategyComparisonOutput,
  type StrategyConstraintsInput,
  type StrategyOptionAnalysis,
} from "./strategyComparisonEngine";
import {
  evaluateUncertainty,
  type UncertaintyEvaluationResult,
} from "./uncertaintyEngine";

export interface EpistemicDistinctionSummary {
  facts: string[];
  observations: string[];
  hypotheses: string[];
  counts: {
    facts: number;
    observations: number;
    hypotheses: number;
  };
}

export interface StrategyComparisonSummaryItem {
  strategy: AdaptiveStrategy;
  operationalCost: "low" | "medium" | "high";
  accuracyScore: number | null;
  safetyScore: number;
  coherenceScore: number;
  advantages: string[];
  disadvantages: string[];
  rationale: string;
  rejectedReason?: string;
}

export interface ErrorExplanationItem {
  id: string;
  category: string;
  errorSubtype: string;
  severity: string;
  description: string;
  evidenceSource: string;
  confidence: Confidence | null;
  clarificationQuestion?: string;
  advisoryCorrection: string;
  autoApplied: false;
}

export interface CognitiveExplanationResult extends DecisionExplanation {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  autoApplied: false;
  insufficientData: boolean;
  evaluationId: string | null;
  evaluationTimestamp: string | null;
  analyzedGoal: string | null;
  evidenceDetails: MetaCognitiveEvidenceItem[];
  epistemicDistinction: EpistemicDistinctionSummary;
  missingInformation: MissingInformationItem[];
  missingInformationSummary: string[];
  uncertaintyLevel: UncertaintyLevel;
  reliabilityScore: Confidence | null;
  uncertaintyNote: string;
  strategiesCompared: StrategyComparisonSummaryItem[];
  recommendedStrategy: AdaptiveStrategy | null;
  detectedErrorsAndContradictions: ErrorExplanationItem[];
  clarificationQuestions: string[];
  safetyDecision: MetaCognitiveSafetyDecision;
}

export interface CognitiveExplanationInput {
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  evaluationId?: string;
  declaredGoal?: string;
  constraints?: StrategyConstraintsInput;
  availableResources?: string[];
  knownRisks?: string[];
  proposedStrategy?: AdaptiveStrategy;
  proposedConclusion?: string;
  conclusionMarkedAsFact?: boolean;
  includeStrategyComparison?: boolean;
  includeErrorDetection?: boolean;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  adaptiveLearning?: AdaptiveLearningEngine;
  authorizationLedger?: AuthorizationLedger;
  experienceSummary?: ExperienceSummary;
  expectedInputs?: string[];
  availableInputs?: Record<string, unknown>;
  processSteps?: MonitoredProcessStep[];
  explicitEvidences?: ExplicitEvidenceInput[];
  processMonitorResult?: CognitiveProcessMonitorResult;
  uncertaintyResult?: UncertaintyEvaluationResult;
  strategyComparisonResult?: StrategyComparisonOutput;
  errorDetectionResult?: CognitiveErrorDetectionResult;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

function buildBlockedExplanation(
  reason: string,
  safetyDecision: MetaCognitiveSafetyDecision,
  evaluationId: string | null,
  evaluationTimestamp: string | null,
  analyzedGoal: string | null
): CognitiveExplanationResult {
  return {
    allowed: false,
    advisoryOnly: true,
    readOnly: true,
    autoApplied: false,
    insufficientData: true,
    evaluationId,
    evaluationTimestamp,
    analyzedGoal,
    summary: `Spiegazione bloccata (fail-closed): ${reason}`,
    whyChosen:
      "Nessuna raccomandazione formulata perché i controlli di sicurezza hanno bloccato l'analisi.",
    evidencesUsed: [],
    evidenceDetails: [],
    epistemicDistinction: {
      facts: [],
      observations: [],
      hypotheses: [],
      counts: { facts: 0, observations: 0, hypotheses: 0 },
    },
    missingInformation: [],
    missingInformationSummary: [],
    uncertaintyLevel: "insufficient_evidence",
    reliabilityScore: null,
    uncertaintyNote: reason,
    strategiesCompared: [],
    recommendedStrategy: null,
    discardedAlternatives: [],
    detectedErrorsAndContradictions: [],
    uncertaintiesAndLimits: [
      reason,
      "Operatività esclusivamente consultiva e in sola lettura.",
    ],
    clarificationQuestions: [],
    epistemicTag: "ipotesi_da_verificare",
    safetyDecision,
  };
}

function classifyEvidences(
  evidences: MetaCognitiveEvidenceItem[]
): EpistemicDistinctionSummary {
  const facts: string[] = [];
  const observations: string[] = [];
  const hypotheses: string[] = [];

  for (const ev of evidences) {
    const label = `[${ev.dataSource}] ${ev.summary} (confidenza: ${ev.confidence})`;
    if (
      ev.evidenceType === "hypothesis" ||
      ev.epistemicTag === "ipotesi_da_verificare"
    ) {
      hypotheses.push(label);
    } else if (ev.epistemicTag === "fatto_osservato") {
      facts.push(label);
    } else {
      observations.push(label);
    }
  }

  return {
    facts,
    observations,
    hypotheses,
    counts: {
      facts: facts.length,
      observations: observations.length,
      hypotheses: hypotheses.length,
    },
  };
}

function mapStrategyOption(
  opt: StrategyOptionAnalysis
): StrategyComparisonSummaryItem {
  return {
    strategy: opt.strategy,
    operationalCost: opt.operationalCost,
    accuracyScore: opt.accuracyScore,
    safetyScore: opt.safetyScore,
    coherenceScore: opt.coherenceScore,
    advantages: [...opt.advantages],
    disadvantages: [...opt.disadvantages],
    rationale: opt.rationale,
    rejectedReason: opt.rejectedReason,
  };
}

function mapErrorFinding(
  finding: DetectedCognitiveErrorFinding
): ErrorExplanationItem {
  return {
    id: finding.id,
    category: finding.category,
    errorSubtype: finding.errorSubtype,
    severity: finding.severity,
    description: finding.description,
    evidenceSource: finding.evidenceSource,
    confidence: finding.confidence,
    clarificationQuestion: finding.clarificationQuestion,
    advisoryCorrection: finding.advisoryCorrection,
    autoApplied: false,
  };
}

/**
 * Explainability Engine V1.
 * Produce una spiegazione strutturata, deterministica, verificabile e in sola lettura
 * riconducendo ogni affermazione alle evidenze effettivamente disponibili.
 */
export function generateCognitiveExplanation(
  input: CognitiveExplanationInput
): CognitiveExplanationResult {
  const nowIso = input?.nowIso ?? null;
  const analyzedGoal = input?.declaredGoal?.trim() || null;

  const hasLearningSources = Boolean(
    input?.controlledLearning ||
      input?.adaptiveLearning ||
      input?.experienceSummary
  );
  const usesLearningData = hasLearningSources
    ? true
    : (input?.usesLearningData ?? true);

  const safetyDecision = evaluateMetaCognitiveSafety({
    operation: "explain",
    consentState: input?.consentState,
    usesLearningData,
    crisisBlocked: input?.crisisBlocked,
    userTextForSafetyCheck: input?.userTextForSafetyCheck,
    storageAvailable: input?.storageAvailable,
    corruptedDataDetected: input?.corruptedDataDetected,
    nowIso: nowIso ?? undefined,
  });

  if (!safetyDecision.allowed) {
    return buildBlockedExplanation(
      safetyDecision.reason,
      safetyDecision,
      input?.evaluationId?.trim() || null,
      nowIso,
      analyzedGoal
    );
  }

  try {
    const mergedAvailableInputs: Record<string, unknown> = {
      ...(input?.availableInputs ?? {}),
    };
    if (analyzedGoal && mergedAvailableInputs.goal === undefined) {
      mergedAvailableInputs.goal = analyzedGoal;
    }

    const processMonitor =
      input?.processMonitorResult ??
      monitorCognitiveProcess({
        traceId: input?.evaluationId,
        consentState: input.consentState,
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
        nowIso: nowIso ?? undefined,
      });

    const uncertaintyEvaluation =
      input?.uncertaintyResult ??
      evaluateUncertainty({
        consentState: input.consentState,
        usesLearningData,
        trace: processMonitor.trace,
        experienceSummary: input?.experienceSummary,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        storageAvailable: input?.storageAvailable,
        corruptedDataDetected: input?.corruptedDataDetected,
        nowIso: nowIso ?? undefined,
      });

    const strategyComparison =
      input?.strategyComparisonResult ??
      (input?.includeStrategyComparison !== false
        ? compareCognitiveStrategies({
            consentState: input.consentState,
            usesLearningData,
            declaredGoal: analyzedGoal ?? undefined,
            constraints: input?.constraints,
            availableResources: input?.availableResources,
            knownRisks: input?.knownRisks,
            adaptiveLearning: input?.adaptiveLearning,
            experienceSummary: input?.experienceSummary,
            processMonitorResult: processMonitor,
            uncertaintyResult: uncertaintyEvaluation,
            crisisBlocked: input?.crisisBlocked,
            userTextForSafetyCheck: input?.userTextForSafetyCheck,
            storageAvailable: input?.storageAvailable,
            corruptedDataDetected: input?.corruptedDataDetected,
            nowIso: nowIso ?? undefined,
          })
        : undefined);

    const errorDetection =
      input?.errorDetectionResult ??
      (input?.includeErrorDetection !== false
        ? detectCognitiveErrors({
            consentState: input.consentState,
            usesLearningData,
            declaredGoal: analyzedGoal ?? undefined,
            proposedStrategy: input?.proposedStrategy,
            proposedConclusion: input?.proposedConclusion,
            conclusionMarkedAsFact: input?.conclusionMarkedAsFact,
            constraints: input?.constraints,
            strategyComparison,
            authorizationLedger: input?.authorizationLedger,
            controlledLearning: input?.controlledLearning,
            repository: input?.repository,
            experienceSummary: input?.experienceSummary,
            processMonitorResult: processMonitor,
            uncertaintyResult: uncertaintyEvaluation,
            crisisBlocked: input?.crisisBlocked,
            userTextForSafetyCheck: input?.userTextForSafetyCheck,
            storageAvailable: input?.storageAvailable,
            corruptedDataDetected: input?.corruptedDataDetected,
            nowIso: nowIso ?? undefined,
          })
        : undefined);

    if (
      !processMonitor.allowed ||
      !uncertaintyEvaluation.allowed ||
      (strategyComparison && !strategyComparison.allowed) ||
      (errorDetection && !errorDetection.allowed)
    ) {
      const blocking = !processMonitor.allowed
        ? processMonitor.safetyDecision
        : !uncertaintyEvaluation.allowed
          ? uncertaintyEvaluation.safetyDecision
          : strategyComparison && !strategyComparison.allowed
            ? strategyComparison.safetyDecision
            : errorDetection!.safetyDecision;
      return buildBlockedExplanation(
        blocking.reason,
        blocking,
        input?.evaluationId?.trim() || processMonitor.trace.traceId || null,
        nowIso ?? processMonitor.trace.timestamp ?? null,
        analyzedGoal
      );
    }

    const evaluationId =
      input?.evaluationId?.trim() || processMonitor.trace.traceId || null;
    const evaluationTimestamp =
      nowIso ?? processMonitor.trace.timestamp ?? null;

    const evidenceDetails = [...processMonitor.trace.evidences];
    const evidencesUsed = evidenceDetails.map(
      (ev) => `[${ev.epistemicTag}] (${ev.dataSource}): ${ev.summary}`
    );
    const epistemicDistinction = classifyEvidences(evidenceDetails);

    const missingInformation = [...processMonitor.trace.missingInformation];
    const missingInformationSummary = missingInformation.map(
      (m) => `${m.field} (${m.impact}): ${m.reason}`
    );

    const strategiesCompared = (strategyComparison?.options ?? []).map(
      mapStrategyOption
    );
    const recommendedStrategy = strategyComparison?.selectedStrategy ?? null;
    const discardedAlternatives = strategyComparison
      ? [...strategyComparison.discardedAlternatives]
      : [];

    const detectedErrorsAndContradictions = (
      errorDetection?.findings ?? []
    ).map(mapErrorFinding);

    const sufficiency = uncertaintyEvaluation.sufficiencyStatus;
    const insufficientData =
      sufficiency === "insufficient" ||
      (evidenceDetails.length === 0 && missingInformation.length > 0);

    const whyChosen = recommendedStrategy
      ? strategyComparison!.selectionRationale
      : insufficientData
        ? `Nessuna strategia consigliata perché i dati verificati non sono sufficienti (${uncertaintyEvaluation.verifiedObservationCount} fatti/osservazioni verificati, ${epistemicDistinction.counts.hypotheses} ipotesi non verificate).`
        : strategyComparison
          ? strategyComparison.selectionRationale
          : "Confronto tra strategie non richiesto o non disponibile per questa spiegazione.";

    const questionSet = new Set<string>();
    for (const q of uncertaintyEvaluation.assessment.clarificationQuestions) {
      if (q.trim()) questionSet.add(q.trim());
    }
    for (const err of detectedErrorsAndContradictions) {
      if (err.clarificationQuestion?.trim()) {
        questionSet.add(err.clarificationQuestion.trim());
      }
    }

    const limitSet = new Set<string>([
      "Spiegazione consultiva generata localmente in sola lettura: non modifica strategie, piani, missioni, consensi o memorie.",
      "Analisi deterministica priva di chiamate a Gemini/LLM o esecuzione autonoma.",
    ]);
    for (const lf of uncertaintyEvaluation.assessment.limitingFactors) {
      if (lf.trim()) limitSet.add(lf.trim());
    }
    if (insufficientData) {
      limitSet.add(
        "Dati insufficienti: nessuna conclusione definitiva né percentuale arbitraria è stata generata."
      );
    }

    const summary = insufficientData
      ? `Dati insufficienti per formulare una valutazione conclusiva${analyzedGoal ? ` sull'obiettivo "${analyzedGoal}"` : ""}: disponibili ${epistemicDistinction.counts.facts} fatti, ${epistemicDistinction.counts.observations} osservazioni e ${epistemicDistinction.counts.hypotheses} ipotesi da verificare, con ${missingInformation.length} informazioni mancanti.`
      : `Valutazione consultiva completata${analyzedGoal ? ` per l'obiettivo "${analyzedGoal}"` : ""}: ${epistemicDistinction.counts.facts} fatti osservati, ${epistemicDistinction.counts.observations} osservazioni prudenti, ${epistemicDistinction.counts.hypotheses} ipotesi; incertezza ${uncertaintyEvaluation.assessment.level}${recommendedStrategy ? `; strategia consigliata: ${recommendedStrategy}` : ""}${detectedErrorsAndContradictions.length > 0 ? `; segnalazioni rilevate: ${detectedErrorsAndContradictions.length}` : ""}.`;

    const epistemicTag: EpistemicTag = insufficientData
      ? "ipotesi_da_verificare"
      : sufficiency === "sufficient" &&
          epistemicDistinction.counts.hypotheses === 0 &&
          epistemicDistinction.counts.observations === 0 &&
          epistemicDistinction.counts.facts >= 3 &&
          detectedErrorsAndContradictions.length === 0
        ? "fatto_osservato"
        : "interpretazione_prudente";

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      autoApplied: false,
      insufficientData,
      evaluationId,
      evaluationTimestamp,
      analyzedGoal,
      summary,
      whyChosen,
      evidencesUsed,
      evidenceDetails,
      epistemicDistinction,
      missingInformation,
      missingInformationSummary,
      uncertaintyLevel: uncertaintyEvaluation.assessment.level,
      reliabilityScore: uncertaintyEvaluation.assessment.reliabilityScore,
      uncertaintyNote: uncertaintyEvaluation.assessment.uncertaintyNote,
      strategiesCompared,
      recommendedStrategy,
      discardedAlternatives,
      detectedErrorsAndContradictions,
      uncertaintiesAndLimits: Array.from(limitSet),
      clarificationQuestions: Array.from(questionSet),
      epistemicTag,
      safetyDecision,
    };
  } catch {
    return buildBlockedExplanation(
      "Errore interno nell'Explainability Engine: blocco fail-closed senza impatto sui motori esistenti.",
      {
        ...safetyDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
      input?.evaluationId?.trim() || null,
      nowIso,
      analyzedGoal
    );
  }
}
