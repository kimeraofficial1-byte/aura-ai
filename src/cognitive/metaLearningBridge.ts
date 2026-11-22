import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type {
  AdaptationHints,
  AdaptiveLearningEngine,
  AdaptiveSignalInput,
  AdaptiveStrategy,
} from "./adaptiveLearningEngine";
import type { AuthorizationLedger } from "./authorizationLedger";
import {
  detectCognitiveErrors,
  type CognitiveErrorDetectionResult,
} from "./cognitiveErrorDetector";
import {
  monitorCognitiveProcess,
  type CognitiveProcessMonitorResult,
  type ExplicitEvidenceInput,
  type MonitoredProcessStep,
} from "./cognitiveProcessMonitor";
import {
  runCognitiveSelfEvaluation,
  type CognitiveSelfEvaluationReport,
  type DurationAccuracySample,
} from "./cognitiveSelfEvaluation";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import {
  analyzeExperience,
  type ExperienceSummary,
} from "./experienceAnalyzer";
import {
  generateCognitiveExplanation,
  type CognitiveExplanationResult,
} from "./explainabilityEngine";
import type {
  EvolvedKnowledgeEntry,
  KnowledgeEvolutionStore,
  ProposeKnowledgeInput,
} from "./knowledgeEvolutionStore";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type {
  MetaCognitiveSafetyDecision,
  MissingInformationItem,
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
} from "./strategyComparisonEngine";
import {
  evaluateUncertainty,
  type UncertaintyEvaluationResult,
} from "./uncertaintyEngine";

export type MetaLearningTargetArea =
  | "data_completeness"
  | "epistemic_hygiene"
  | "strategy_calibration"
  | "operational_accuracy"
  | "knowledge_validation";

export interface MetaLearningImprovementSuggestion {
  id: string;
  title: string;
  description: string;
  targetArea: MetaLearningTargetArea;
  supportingDataSources: string[];
  supportingEvidence: string[];
  epistemicTag: EpistemicTag;
  confidence: Confidence | null;
  advisoryOnly: true;
  autoApplied: false;
}

export interface MetaLearningProposal {
  id: string;
  targetEngine: "KnowledgeEvolutionStore" | "AdaptiveLearningEngine";
  status: "proposed";
  requiresExplicitUserApproval: true;
  userExplicitApproval: false;
  autoApplied: false;
  title: string;
  rationale: string;
  supportingDataSources: string[];
  supportingEvidence: string[];
  epistemicTag: EpistemicTag;
  confidence: Confidence | null;
  /** Payload pronto per KnowledgeEvolutionStore.proposeEntry solo previa azione esplicita utente. */
  knowledgeProposalPayload?: ProposeKnowledgeInput;
  /** Bozza di segnale adattivo; i pesi non vengono mai aggiornati automaticamente dal bridge. */
  adaptiveSignalDraft?: AdaptiveSignalInput;
}

export interface MetaLearningBridgeResult {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  autoApplied: false;
  learningConsentActive: boolean;
  aiMemoryConsentIndependent: true;
  connectedModules: string[];
  verifiedEvidencesCount: number;
  unverifiedHypothesesCount: number;
  informationGaps: MissingInformationItem[];
  insufficientDataDimensions: string[];
  improvementSuggestions: MetaLearningImprovementSuggestion[];
  proposals: MetaLearningProposal[];
  limits: string[];
  confidence: Confidence | null;
  epistemicTag: EpistemicTag;
  safetyDecision: MetaCognitiveSafetyDecision;
  experienceSummary?: ExperienceSummary;
  selfEvaluation?: CognitiveSelfEvaluationReport;
  adaptationHints?: AdaptationHints;
  knowledgeEntries?: EvolvedKnowledgeEntry[];
  processMonitor: CognitiveProcessMonitorResult;
  uncertaintyEvaluation: UncertaintyEvaluationResult;
  strategyComparison: StrategyComparisonOutput;
  errorDetection: CognitiveErrorDetectionResult;
  explanation: CognitiveExplanationResult;
}

export interface MetaLearningBridgeInput {
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
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  authorizationLedger?: AuthorizationLedger;
  adaptiveLearning?: AdaptiveLearningEngine;
  knowledgeStore?: KnowledgeEvolutionStore;
  durationSamples?: DurationAccuracySample[];
  experienceSummary?: ExperienceSummary;
  selfEvaluationReport?: CognitiveSelfEvaluationReport;
  adaptationHints?: AdaptationHints;
  knowledgeEntries?: EvolvedKnowledgeEntry[];
  expectedInputs?: string[];
  availableInputs?: Record<string, unknown>;
  processSteps?: MonitoredProcessStep[];
  explicitEvidences?: ExplicitEvidenceInput[];
  processMonitorResult?: CognitiveProcessMonitorResult;
  uncertaintyResult?: UncertaintyEvaluationResult;
  strategyComparisonResult?: StrategyComparisonOutput;
  errorDetectionResult?: CognitiveErrorDetectionResult;
  explanationResult?: CognitiveExplanationResult;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

function buildBlockedBridge(
  reason: string,
  safetyDecision: MetaCognitiveSafetyDecision,
  consentState: LearningConsentState,
  nowIso: string
): MetaLearningBridgeResult {
  const effectiveConsent: LearningConsentState =
    safetyDecision.blockedBy === "consent"
      ? {
          learningConsent: false,
          aiMemoryConsent: consentState?.aiMemoryConsent ?? false,
          revokedAt: consentState?.revokedAt,
        }
      : consentState;
  const blockFlags = {
    consentState: effectiveConsent,
    usesLearningData: true,
    crisisBlocked: safetyDecision.blockedBy === "crisis",
    storageAvailable: safetyDecision.blockedBy !== "storage_unavailable",
    corruptedDataDetected: safetyDecision.blockedBy === "corrupted_data",
    nowIso,
  };

  const blockedMonitor = monitorCognitiveProcess(blockFlags);
  const blockedUncertainty = evaluateUncertainty(blockFlags);
  const blockedStrategy = compareCognitiveStrategies(blockFlags);
  const blockedErrors = detectCognitiveErrors(blockFlags);
  const blockedExplanation = generateCognitiveExplanation(blockFlags);

  return {
    allowed: false,
    advisoryOnly: true,
    readOnly: true,
    autoApplied: false,
    learningConsentActive: Boolean(
      consentState?.learningConsent && !consentState?.revokedAt
    ),
    aiMemoryConsentIndependent: true,
    connectedModules: [],
    verifiedEvidencesCount: 0,
    unverifiedHypothesesCount: 0,
    informationGaps: [],
    insufficientDataDimensions: [],
    improvementSuggestions: [],
    proposals: [],
    limits: [
      reason,
      "Bridge bloccato in modalità fail-closed senza alcuna modifica ai motori collegati.",
    ],
    confidence: null,
    epistemicTag: "ipotesi_da_verificare",
    safetyDecision,
    processMonitor: blockedMonitor,
    uncertaintyEvaluation: blockedUncertainty,
    strategyComparison: blockedStrategy,
    errorDetection: blockedErrors,
    explanation: blockedExplanation,
  };
}

/**
 * Meta-Learning Bridge V1.
 * Integra in sola lettura i motori cognitivi delle Fasi 9.1–9.3 e 10.1–10.4.
 * Non modifica mai direttamente i motori collegati, non conferma automaticamente
 * voci di conoscenza, non aggiorna pesi adattivi e rispetta la separazione tra
 * learningConsent e aiMemoryConsent.
 */
export function runMetaLearningBridge(
  input: MetaLearningBridgeInput
): MetaLearningBridgeResult {
  const nowIso = input?.nowIso ?? new Date().toISOString();

  const hasLearningSources = Boolean(
    input?.controlledLearning ||
      input?.adaptiveLearning ||
      input?.knowledgeStore ||
      input?.experienceSummary ||
      input?.selfEvaluationReport ||
      input?.adaptationHints ||
      input?.knowledgeEntries
  );
  const usesLearningData = hasLearningSources
    ? true
    : (input?.usesLearningData ?? true);

  const safetyDecision = evaluateMetaCognitiveSafety({
    operation: "analyze",
    consentState: input?.consentState,
    usesLearningData,
    crisisBlocked: input?.crisisBlocked,
    userTextForSafetyCheck: input?.userTextForSafetyCheck,
    storageAvailable: input?.storageAvailable,
    corruptedDataDetected: input?.corruptedDataDetected,
    nowIso,
  });

  if (!safetyDecision.allowed) {
    return buildBlockedBridge(
      safetyDecision.reason,
      safetyDecision,
      input?.consentState,
      nowIso
    );
  }

  try {
    const connectedModules: string[] = [];

    // 1. Experience Analyzer (sola lettura)
    let experienceSummary = input?.experienceSummary;
    if (
      !experienceSummary &&
      usesLearningData &&
      (input?.repository ||
        input?.timeline ||
        input?.controlledLearning ||
        input?.authorizationLedger)
    ) {
      experienceSummary = analyzeExperience({
        consentState: input.consentState,
        repository: input.repository,
        timeline: input.timeline,
        controlledLearning: input.controlledLearning,
        authorizationLedger: input.authorizationLedger,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck,
        storageAvailable: input.storageAvailable,
        corruptedDataDetected: input.corruptedDataDetected,
        nowIso,
      });
    }
    if (experienceSummary) {
      if (!experienceSummary.allowed) {
        return buildBlockedBridge(
          experienceSummary.uncertaintyNote,
          {
            ...safetyDecision,
            allowed: false,
            failClosed: true,
            blockedBy: experienceSummary.guardDecision.blockedBy ?? "consent",
            reason: experienceSummary.uncertaintyNote,
            learningGuardDecision: experienceSummary.guardDecision,
          },
          input.consentState,
          nowIso
        );
      }
      connectedModules.push("ExperienceAnalyzer");
    }

    // 2. Adaptive Learning Engine (sola lettura tramite getAdaptationHints)
    let adaptationHints = input?.adaptationHints;
    if (!adaptationHints && input?.adaptiveLearning && usesLearningData) {
      adaptationHints = input.adaptiveLearning.getAdaptationHints(
        input.consentState,
        {
          crisisBlocked: input.crisisBlocked,
          userTextForSafetyCheck: input.userTextForSafetyCheck,
          nowIso,
        }
      );
    }
    if (adaptationHints) {
      if (!adaptationHints.allowed) {
        return buildBlockedBridge(
          adaptationHints.uncertaintyNote,
          {
            ...safetyDecision,
            allowed: false,
            failClosed: true,
            blockedBy: adaptationHints.guardDecision.blockedBy ?? "consent",
            reason: adaptationHints.uncertaintyNote,
            learningGuardDecision: adaptationHints.guardDecision,
          },
          input.consentState,
          nowIso
        );
      }
      connectedModules.push("AdaptiveLearningEngine");
    }

    // 3. Knowledge Evolution Store (sola lettura tramite listEntries)
    let knowledgeEntries = input?.knowledgeEntries;
    if (!knowledgeEntries && input?.knowledgeStore && usesLearningData) {
      const listRes = input.knowledgeStore.listEntries(input.consentState, {
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck,
        nowIso,
      });
      if (!listRes.allowed) {
        return buildBlockedBridge(
          listRes.reason,
          {
            ...safetyDecision,
            allowed: false,
            failClosed: true,
            blockedBy: listRes.guardDecision.blockedBy ?? "consent",
            reason: listRes.reason,
            learningGuardDecision: listRes.guardDecision,
          },
          input.consentState,
          nowIso
        );
      }
      knowledgeEntries = listRes.data ?? [];
    }
    if (knowledgeEntries !== undefined) {
      connectedModules.push("KnowledgeEvolutionStore");
    }

    // 4. Cognitive Self-Evaluation (sola lettura)
    let selfEvaluation = input?.selfEvaluationReport;
    if (
      !selfEvaluation &&
      usesLearningData &&
      (experienceSummary ||
        input?.controlledLearning ||
        input?.adaptiveLearning ||
        input?.authorizationLedger ||
        input?.timeline ||
        (input?.durationSamples?.length ?? 0) > 0)
    ) {
      selfEvaluation = runCognitiveSelfEvaluation({
        consentState: input.consentState,
        experienceSummary,
        controlledLearning: input.controlledLearning,
        adaptiveLearning: input.adaptiveLearning,
        authorizationLedger: input.authorizationLedger,
        timeline: input.timeline,
        durationSamples: input.durationSamples,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck,
        storageAvailable: input.storageAvailable,
        corruptedDataDetected: input.corruptedDataDetected,
        nowIso,
      });
    }
    if (selfEvaluation) {
      if (!selfEvaluation.allowed) {
        return buildBlockedBridge(
          selfEvaluation.uncertaintyNote,
          {
            ...safetyDecision,
            allowed: false,
            failClosed: true,
            blockedBy: selfEvaluation.guardDecision.blockedBy ?? "consent",
            reason: selfEvaluation.uncertaintyNote,
            learningGuardDecision: selfEvaluation.guardDecision,
          },
          input.consentState,
          nowIso
        );
      }
      connectedModules.push("CognitiveSelfEvaluation");
    }

    // 5. Livello Metacognitivo Fase 10.2–10.4 (sola lettura)
    const mergedAvailableInputs: Record<string, unknown> = {
      ...(input?.availableInputs ?? {}),
    };
    if (input?.declaredGoal?.trim() && mergedAvailableInputs.goal === undefined) {
      mergedAvailableInputs.goal = input.declaredGoal.trim();
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
        experienceSummary,
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
    connectedModules.push("CognitiveProcessMonitor");

    const uncertaintyEvaluation =
      input?.uncertaintyResult ??
      evaluateUncertainty({
        consentState: input.consentState,
        usesLearningData,
        trace: processMonitor.trace,
        experienceSummary,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        storageAvailable: input?.storageAvailable,
        corruptedDataDetected: input?.corruptedDataDetected,
        nowIso,
      });
    connectedModules.push("UncertaintyEngine");

    const strategyComparison =
      input?.strategyComparisonResult ??
      compareCognitiveStrategies({
        consentState: input.consentState,
        usesLearningData,
        declaredGoal: input?.declaredGoal,
        constraints: input?.constraints,
        availableResources: input?.availableResources,
        knownRisks: input?.knownRisks,
        experienceSummary,
        adaptationHints,
        processMonitorResult: processMonitor,
        uncertaintyResult: uncertaintyEvaluation,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        storageAvailable: input?.storageAvailable,
        corruptedDataDetected: input?.corruptedDataDetected,
        nowIso,
      });
    connectedModules.push("StrategyComparisonEngine");

    const errorDetection =
      input?.errorDetectionResult ??
      detectCognitiveErrors({
        consentState: input.consentState,
        usesLearningData,
        declaredGoal: input?.declaredGoal,
        proposedStrategy: input?.proposedStrategy,
        proposedConclusion: input?.proposedConclusion,
        conclusionMarkedAsFact: input?.conclusionMarkedAsFact,
        constraints: input?.constraints,
        strategyComparison,
        repository: input?.repository,
        timeline: input?.timeline,
        controlledLearning: input?.controlledLearning,
        authorizationLedger: input?.authorizationLedger,
        experienceSummary,
        processMonitorResult: processMonitor,
        uncertaintyResult: uncertaintyEvaluation,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        storageAvailable: input?.storageAvailable,
        corruptedDataDetected: input?.corruptedDataDetected,
        nowIso,
      });
    connectedModules.push("CognitiveErrorDetector");

    const explanation =
      input?.explanationResult ??
      generateCognitiveExplanation({
        consentState: input.consentState,
        usesLearningData,
        evaluationId: input?.evaluationId,
        declaredGoal: input?.declaredGoal,
        constraints: input?.constraints,
        availableResources: input?.availableResources,
        knownRisks: input?.knownRisks,
        proposedStrategy: input?.proposedStrategy,
        proposedConclusion: input?.proposedConclusion,
        conclusionMarkedAsFact: input?.conclusionMarkedAsFact,
        processMonitorResult: processMonitor,
        uncertaintyResult: uncertaintyEvaluation,
        strategyComparisonResult: strategyComparison,
        errorDetectionResult: errorDetection,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        storageAvailable: input?.storageAvailable,
        corruptedDataDetected: input?.corruptedDataDetected,
        nowIso,
      });
    connectedModules.push("ExplainabilityEngine");

    if (
      !processMonitor.allowed ||
      !uncertaintyEvaluation.allowed ||
      !strategyComparison.allowed ||
      !errorDetection.allowed ||
      !explanation.allowed
    ) {
      const blocking = !processMonitor.allowed
        ? processMonitor.safetyDecision
        : !uncertaintyEvaluation.allowed
          ? uncertaintyEvaluation.safetyDecision
          : !strategyComparison.allowed
            ? strategyComparison.safetyDecision
            : !errorDetection.allowed
              ? errorDetection.safetyDecision
              : explanation.safetyDecision;
      return buildBlockedBridge(
        blocking.reason,
        blocking,
        input.consentState,
        nowIso
      );
    }

    // 6. Aggregazione lacune informative, suggerimenti consultivi e proposte non auto-applicate
    const informationGaps = [...processMonitor.trace.missingInformation];
    const insufficientDataDimensions = [
      ...(selfEvaluation?.insufficientDataDimensions ?? []),
    ];

    const improvementSuggestions: MetaLearningImprovementSuggestion[] = [];
    const proposals: MetaLearningProposal[] = [];

    const verifiedCount = uncertaintyEvaluation.verifiedObservationCount;
    const reliability = uncertaintyEvaluation.assessment.reliabilityScore;

    if (informationGaps.length > 0) {
      improvementSuggestions.push({
        id: "ml-sugg-missing-inputs",
        title: "Colmare le informazioni mancanti prima delle prossime valutazioni",
        description: `Mancano ${informationGaps.length} informazioni attese (${informationGaps.map((g) => g.field).join(", ")}).`,
        targetArea: "data_completeness",
        supportingDataSources: ["CognitiveProcessMonitor"],
        supportingEvidence: informationGaps.map((g) => `${g.field}: ${g.reason}`),
        epistemicTag: "fatto_osservato",
        confidence: reliability,
        advisoryOnly: true,
        autoApplied: false,
      });
    }

    if (errorDetection.findings.length > 0) {
      improvementSuggestions.push({
        id: "ml-sugg-error-review",
        title: "Verificare con l'utente gli errori o incoerenze rilevati",
        description: `Individuate ${errorDetection.findings.length} segnalazioni cognitive che richiedono revisione umana prima di aggiornare preferenze o strategie.`,
        targetArea: "epistemic_hygiene",
        supportingDataSources: ["CognitiveErrorDetector"],
        supportingEvidence: errorDetection.findings.map(
          (f) => `[${f.category}] ${f.description}`
        ),
        epistemicTag: errorDetection.epistemicTag,
        confidence: errorDetection.confidence,
        advisoryOnly: true,
        autoApplied: false,
      });
    }

    if (
      selfEvaluation?.allowed &&
      selfEvaluation.metrics.operationalAccuracy.evaluable &&
      (selfEvaluation.metrics.operationalAccuracy.meanAbsoluteErrorMinutes ?? 0) >=
        10
    ) {
      const mae =
        selfEvaluation.metrics.operationalAccuracy.meanAbsoluteErrorMinutes!;
      improvementSuggestions.push({
        id: "ml-sugg-duration-calibration",
        title: "Rivedere la stima delle durate operative",
        description: `Lo scostamento medio tra durata stimata ed effettiva è di ${mae} minuti.`,
        targetArea: "operational_accuracy",
        supportingDataSources: ["CognitiveSelfEvaluation"],
        supportingEvidence: [selfEvaluation.metrics.operationalAccuracy.note],
        epistemicTag: "interpretazione_prudente",
        confidence: selfEvaluation.metrics.operationalAccuracy.reliability,
        advisoryOnly: true,
        autoApplied: false,
      });

      proposals.push({
        id: "ml-prop-duration-calibration",
        targetEngine: "KnowledgeEvolutionStore",
        status: "proposed",
        requiresExplicitUserApproval: true,
        userExplicitApproval: false,
        autoApplied: false,
        title: "Proposta calibrazione stime di durata",
        rationale: `Scostamento medio rilevato pari a ${mae} minuti su ${selfEvaluation.metrics.operationalAccuracy.sampleCount} campioni confrontabili.`,
        supportingDataSources: ["CognitiveSelfEvaluation"],
        supportingEvidence: [selfEvaluation.metrics.operationalAccuracy.note],
        epistemicTag: "interpretazione_prudente",
        confidence: selfEvaluation.metrics.operationalAccuracy.reliability,
        knowledgeProposalPayload: {
          title: "Calibrazione prudente delle stime di durata",
          content: `Considerare un margine correttivo medio di ~${mae} minuti nelle prossime pianificazioni, previa conferma utente.`,
          evidenceType: "observed_behavior",
          epistemicTag: "interpretazione_prudente",
          confidence:
            selfEvaluation.metrics.operationalAccuracy.reliability ?? 0.6,
          dataSource: "CognitiveSelfEvaluation",
          uncertaintyNote:
            "Proposta consultiva generata dal Meta-Learning Bridge: richiede conferma esplicita utente.",
          targetSubsystem: "planning",
          nowIso,
        },
      });
    }

    if (experienceSummary && !experienceSummary.insufficientData) {
      const existingTitles = new Set(
        (knowledgeEntries ?? []).map((e) => e.title.toLowerCase())
      );
      for (const pat of experienceSummary.patterns) {
        if (pat.evidenceType === "hypothesis") continue;
        if (existingTitles.has(pat.title.toLowerCase())) continue;

        proposals.push({
          id: `ml-prop-exp-${pat.id}`,
          targetEngine: "KnowledgeEvolutionStore",
          status: "proposed",
          requiresExplicitUserApproval: true,
          userExplicitApproval: false,
          autoApplied: false,
          title: pat.title,
          rationale: `Pattern osservato in ${pat.dataSource} (${pat.observationCount} osservazioni).`,
          supportingDataSources: ["ExperienceAnalyzer", pat.dataSource],
          supportingEvidence: [pat.description],
          epistemicTag: pat.epistemicTag,
          confidence: pat.confidence,
          knowledgeProposalPayload: {
            title: pat.title,
            content: pat.description,
            evidenceType: pat.evidenceType,
            epistemicTag: pat.epistemicTag,
            confidence: pat.confidence,
            dataSource: pat.dataSource,
            uncertaintyNote: pat.uncertaintyNote,
            targetSubsystem: "cognitive",
            nowIso,
          },
        });
      }
    }

    if (
      strategyComparison.allowed &&
      strategyComparison.selectedStrategy !== null &&
      adaptationHints?.allowed &&
      !adaptationHints.insufficientData &&
      strategyComparison.selectedStrategy !== adaptationHints.recommendedStrategy
    ) {
      improvementSuggestions.push({
        id: "ml-sugg-strategy-alignment",
        title: "Segnalato disallineamento tra strategia contestuale e profilo adattivo",
        description: `Il confronto contestuale suggerisce ${strategyComparison.selectedStrategy} mentre il profilo adattivo favorisce ${adaptationHints.recommendedStrategy}.`,
        targetArea: "strategy_calibration",
        supportingDataSources: [
          "StrategyComparisonEngine",
          "AdaptiveLearningEngine",
        ],
        supportingEvidence: [
          strategyComparison.selectionRationale,
          adaptationHints.uncertaintyNote,
        ],
        epistemicTag: "interpretazione_prudente",
        confidence: strategyComparison.confidence,
        advisoryOnly: true,
        autoApplied: false,
      });

      proposals.push({
        id: "ml-prop-adaptive-review",
        targetEngine: "AdaptiveLearningEngine",
        status: "proposed",
        requiresExplicitUserApproval: true,
        userExplicitApproval: false,
        autoApplied: false,
        title: `Valutare preferenza strategica verso ${strategyComparison.selectedStrategy}`,
        rationale:
          "Il confronto contestuale differisce dal profilo adattivo storico: nessuna modifica ai pesi viene eseguita senza feedback esplicito.",
        supportingDataSources: [
          "StrategyComparisonEngine",
          "AdaptiveLearningEngine",
        ],
        supportingEvidence: [strategyComparison.selectionRationale],
        epistemicTag: "interpretazione_prudente",
        confidence: strategyComparison.confidence,
        adaptiveSignalDraft: {
          evidenceType: "explicit_feedback",
          strategy: strategyComparison.selectedStrategy,
          direction: "positive",
          dataSource: "MetaLearningBridge",
          summary: `Conferma utente richiesta per allineare strategia a ${strategyComparison.selectedStrategy}`,
          uncertaintyNote:
            "Bozza non applicata automaticamente: i pesi di AdaptiveLearningEngine restano intatti fino a consenso esplicito.",
          nowIso,
        },
      });
    }

    const pendingKnowledgeCount = (knowledgeEntries ?? []).filter(
      (e) => e.status === "proposed"
    ).length;
    if (pendingKnowledgeCount > 0) {
      improvementSuggestions.push({
        id: "ml-sugg-pending-knowledge",
        title: "Voci di conoscenza in attesa di conferma esplicita",
        description: `Sono presenti ${pendingKnowledgeCount} proposte in KnowledgeEvolutionStore con stato "proposed" che attendono decisione esplicita dell'utente.`,
        targetArea: "knowledge_validation",
        supportingDataSources: ["KnowledgeEvolutionStore"],
        supportingEvidence: (knowledgeEntries ?? [])
          .filter((e) => e.status === "proposed")
          .slice(0, 3)
          .map((e) => `${e.id}: ${e.title}`),
        epistemicTag: "fatto_osservato",
        confidence: reliability,
        advisoryOnly: true,
        autoApplied: false,
      });
    }

    const limits: string[] = [
      "Integrazione esclusivamente in sola lettura e consultiva: nessun peso adattivo, conoscenza, piano, missione o consenso è stato modificato.",
      "Le eventuali proposte generate hanno stato 'proposed' con userExplicitApproval=false e richiedono conferma esplicita dell'utente.",
      "learningConsent è gestito in modo indipendente da aiMemoryConsent.",
      ...explanation.uncertaintiesAndLimits.filter(
        (l) => !l.startsWith("Spiegazione consultiva generata localmente")
      ),
    ];

    const confidence: Confidence | null =
      uncertaintyEvaluation.sufficiencyStatus === "insufficient"
        ? null
        : reliability;

    const epistemicTag: EpistemicTag =
      uncertaintyEvaluation.sufficiencyStatus === "insufficient"
        ? "ipotesi_da_verificare"
        : uncertaintyEvaluation.sufficiencyStatus === "sufficient" &&
            uncertaintyEvaluation.unverifiedHypothesesCount === 0
          ? "fatto_osservato"
          : "interpretazione_prudente";

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      autoApplied: false,
      learningConsentActive: Boolean(
        input.consentState.learningConsent && !input.consentState.revokedAt
      ),
      aiMemoryConsentIndependent: true,
      connectedModules,
      verifiedEvidencesCount: verifiedCount,
      unverifiedHypothesesCount: uncertaintyEvaluation.unverifiedHypothesesCount,
      informationGaps,
      insufficientDataDimensions,
      improvementSuggestions,
      proposals,
      limits: Array.from(new Set(limits)),
      confidence,
      epistemicTag,
      safetyDecision,
      experienceSummary,
      selfEvaluation,
      adaptationHints,
      knowledgeEntries,
      processMonitor,
      uncertaintyEvaluation,
      strategyComparison,
      errorDetection,
      explanation,
    };
  } catch {
    return buildBlockedBridge(
      "Errore interno nel Meta-Learning Bridge: blocco fail-closed senza impatto sui motori esistenti.",
      {
        ...safetyDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
      input?.consentState,
      nowIso
    );
  }
}
