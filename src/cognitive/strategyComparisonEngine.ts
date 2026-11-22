import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type {
  AdaptationHints,
  AdaptiveLearningEngine,
  AdaptiveStrategy,
} from "./adaptiveLearningEngine";
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
  MetaCognitiveSafetyDecision,
  StrategyComparisonResult,
  StrategyEvaluationOption,
} from "./metaCognitiveTypes";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
} from "./selfLearningTypes";
import {
  evaluateUncertainty,
  MIN_EVIDENCE_FOR_RELIABILITY,
  type UncertaintyEvaluationResult,
} from "./uncertaintyEngine";

export interface StrategyConstraintsInput {
  timeBudgetMinutes?: number;
  energyLevel?: "low" | "medium" | "high";
  overloadDetected?: boolean;
  deadlineUrgent?: boolean;
  notes?: string[];
}

export interface StrategyOptionAnalysis extends StrategyEvaluationOption {
  advantages: string[];
  disadvantages: string[];
  risks: string[];
  tradeoffs: string[];
}

export interface EpistemicEvidenceBreakdown {
  factsCount: number;
  observationsCount: number;
  hypothesesCount: number;
}

export interface StrategyComparisonOutput extends StrategyComparisonResult {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  autoApplied: false;
  insufficientData: boolean;
  options: StrategyOptionAnalysis[];
  epistemicBreakdown: EpistemicEvidenceBreakdown;
  safetyDecision: MetaCognitiveSafetyDecision;
  processMonitor: CognitiveProcessMonitorResult;
  uncertaintyEvaluation: UncertaintyEvaluationResult;
}

export interface StrategyComparisonInput {
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  declaredGoal?: string;
  constraints?: StrategyConstraintsInput;
  availableResources?: string[];
  knownRisks?: string[];
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  adaptiveLearning?: AdaptiveLearningEngine;
  experienceSummary?: ExperienceSummary;
  adaptationHints?: AdaptationHints;
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

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function buildBlockedComparison(
  reason: string,
  safetyDecision: MetaCognitiveSafetyDecision,
  processMonitor: CognitiveProcessMonitorResult,
  uncertaintyEvaluation: UncertaintyEvaluationResult
): StrategyComparisonOutput {
  return {
    allowed: false,
    advisoryOnly: true,
    readOnly: true,
    autoApplied: false,
    insufficientData: true,
    selectedStrategy: null,
    options: [],
    selectionRationale: reason,
    discardedAlternatives: [
      "Confronto strategie bloccato dal controllo di sicurezza fail-closed.",
    ],
    confidence: null,
    epistemicTag: "ipotesi_da_verificare",
    epistemicBreakdown: {
      factsCount: 0,
      observationsCount: 0,
      hypothesesCount: 0,
    },
    safetyDecision,
    processMonitor,
    uncertaintyEvaluation,
  };
}

function computeEpistemicBreakdown(
  processMonitor: CognitiveProcessMonitorResult
): EpistemicEvidenceBreakdown {
  let factsCount = 0;
  let observationsCount = 0;
  let hypothesesCount = 0;

  for (const ev of processMonitor.trace.evidences) {
    if (
      ev.evidenceType === "hypothesis" ||
      ev.epistemicTag === "ipotesi_da_verificare"
    ) {
      hypothesesCount += 1;
    } else if (ev.epistemicTag === "fatto_osservato") {
      factsCount += 1;
    } else {
      observationsCount += 1;
    }
  }

  return { factsCount, observationsCount, hypothesesCount };
}

function getValidAdaptiveWeight(
  hints: AdaptationHints | undefined,
  strategy: AdaptiveStrategy
): number | null {
  if (!hints || !hints.allowed || hints.insufficientData) {
    return null;
  }
  const weight = hints.strategyWeights[strategy];
  return typeof weight === "number" && Number.isFinite(weight) ? weight : null;
}

/**
 * Strategy Comparison Engine V1.
 * Confronta in sola lettura e in modo deterministico le strategie STANDARD, LIGHT e DEFERRED
 * riutilizzando monitorCognitiveProcess, evaluateUncertainty ed evaluateMetaCognitiveSafety.
 * Non inventa pesi, benefici, costi o percentuali e non applica automaticamente alcuna strategia.
 */
export function compareCognitiveStrategies(
  input: StrategyComparisonInput
): StrategyComparisonOutput {
  const nowIso = input?.nowIso ?? new Date().toISOString();
  const hasLearningSources = Boolean(
    input?.controlledLearning ||
      input?.adaptiveLearning ||
      input?.experienceSummary ||
      input?.adaptationHints
  );
  const usesLearningData = hasLearningSources
    ? true
    : (input?.usesLearningData ?? true);

  const safetyDecision = evaluateMetaCognitiveSafety({
    operation: "compare_strategies",
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
    return buildBlockedComparison(
      blockingDecision.reason,
      blockingDecision,
      processMonitor,
      uncertaintyEvaluation
    );
  }

  try {
    const breakdown = computeEpistemicBreakdown(processMonitor);
    const goal = input?.declaredGoal?.trim() ?? "";
    const hasDeclaredGoal = goal.length > 0;
    const constraints = input?.constraints ?? {};
    const availableResources = (input?.availableResources ?? []).filter(
      (r) => r.trim().length > 0
    );
    const knownRisks = (input?.knownRisks ?? []).filter(
      (r) => r.trim().length > 0
    );

    const missingItems = processMonitor.trace.missingInformation;
    const hasHighImpactMissing = missingItems.some((m) => m.impact === "high");
    const contradictionsCount = processMonitor.trace.contradictionsDetected;
    const sufficiency = uncertaintyEvaluation.sufficiencyStatus;
    const reliability = uncertaintyEvaluation.assessment.reliabilityScore;

    // Lettura rigorosamente in sola lettura degli hints adattivi (solo se consentiti)
    let hints: AdaptationHints | undefined = input?.adaptationHints;
    if (!hints && input?.adaptiveLearning && usesLearningData) {
      const readHints = input.adaptiveLearning.getAdaptationHints(
        input.consentState,
        {
          crisisBlocked: input?.crisisBlocked,
          userTextForSafetyCheck: input?.userTextForSafetyCheck,
          nowIso,
        }
      );
      if (readHints.allowed) {
        hints = readHints;
      } else if (!readHints.allowed && readHints.guardDecision.blockedBy) {
        return buildBlockedComparison(
          readHints.guardDecision.reason,
          {
            ...safetyDecision,
            allowed: false,
            failClosed: true,
            blockedBy: readHints.guardDecision.blockedBy,
            reason: readHints.guardDecision.reason,
            learningGuardDecision: readHints.guardDecision,
          },
          processMonitor,
          uncertaintyEvaluation
        );
      }
    }

    const lowEnergy = constraints.energyLevel === "low";
    const tightTime =
      typeof constraints.timeBudgetMinutes === "number" &&
      Number.isFinite(constraints.timeBudgetMinutes) &&
      constraints.timeBudgetMinutes <= 20;
    const overload = constraints.overloadDetected === true;
    const urgentDeadline = constraints.deadlineUrgent === true;
    const blockedOrSuspendedProcess =
      processMonitor.processLifecycleState === "bloccato" ||
      processMonitor.processLifecycleState === "sospeso";

    const hasInsufficientEvidences =
      uncertaintyEvaluation.verifiedObservationCount < MIN_EVIDENCE_FOR_RELIABILITY;
    const insufficientForReliableChoice =
      hasInsufficientEvidences ||
      (sufficiency === "insufficient" && !blockedOrSuspendedProcess) ||
      (!hasDeclaredGoal && uncertaintyEvaluation.verifiedObservationCount === 0);

    // Punteggi deterministici basati solo su evidenze reali e vincoli dichiarati
    const computeAccuracyFor = (strategy: AdaptiveStrategy): number | null => {
      if (insufficientForReliableChoice || reliability === null) {
        return null;
      }
      const weight = getValidAdaptiveWeight(hints, strategy);
      if (weight === null) {
        return null;
      }
      // Normalizza il peso reale [0.5, 1.5] nell'intervallo [0, 1] e lo limita con l'affidabilità osservata
      const normalizedWeight = clampScore(weight - 0.5);
      return clampScore((reliability + normalizedWeight) / 2);
    };

    const standardSafety = clampScore(
      0.85 -
        (overload ? 0.3 : 0) -
        (lowEnergy ? 0.15 : 0) -
        (hasHighImpactMissing ? 0.25 : 0) -
        Math.min(0.3, contradictionsCount * 0.15) -
        (insufficientForReliableChoice ? 0.2 : 0)
    );
    const lightSafety = clampScore(
      0.9 -
        (hasHighImpactMissing ? 0.15 : 0) -
        Math.min(0.25, contradictionsCount * 0.1) -
        (insufficientForReliableChoice ? 0.15 : 0)
    );
    const deferredSafety = clampScore(
      0.95 - (urgentDeadline && sufficiency === "sufficient" && !overload ? 0.25 : 0)
    );

    const standardCoherence = clampScore(
      (hasDeclaredGoal ? 0.75 : 0.35) +
        (availableResources.length > 0 ? 0.15 : 0) -
        (lowEnergy ? 0.25 : 0) -
        (tightTime ? 0.25 : 0) -
        (overload ? 0.25 : 0) -
        (blockedOrSuspendedProcess ? 0.3 : 0)
    );
    const lightCoherence = clampScore(
      (hasDeclaredGoal ? 0.75 : 0.4) +
        (lowEnergy || tightTime || overload ? 0.2 : 0) -
        (blockedOrSuspendedProcess ? 0.2 : 0)
    );
    const deferredCoherence = clampScore(
      (insufficientForReliableChoice ||
      hasHighImpactMissing ||
      blockedOrSuspendedProcess ||
      overload ||
      contradictionsCount > 0
        ? 0.85
        : 0.45) - (urgentDeadline && sufficiency === "sufficient" && !overload ? 0.25 : 0)
    );

    // Determinazione della strategia consultiva consigliata (null se dati insufficienti)
    let selectedStrategy: AdaptiveStrategy | null = null;
    if (!insufficientForReliableChoice) {
      if (
        blockedOrSuspendedProcess ||
        uncertaintyEvaluation.assessment.level === "high" ||
        (overload && (hasHighImpactMissing || contradictionsCount > 0))
      ) {
        selectedStrategy = "DEFERRED";
      } else if (
        lowEnergy ||
        tightTime ||
        overload ||
        (sufficiency === "partial" &&
          uncertaintyEvaluation.assessment.level === "moderate")
      ) {
        selectedStrategy = "LIGHT";
      } else {
        const standardWeight = getValidAdaptiveWeight(hints, "STANDARD");
        const lightWeight = getValidAdaptiveWeight(hints, "LIGHT");
        if (
          lightWeight !== null &&
          standardWeight !== null &&
          lightWeight > standardWeight + 0.15
        ) {
          selectedStrategy = "LIGHT";
        } else {
          selectedStrategy = "STANDARD";
        }
      }
    }

    const commonRiskNotes: string[] = [...knownRisks];
    if (missingItems.length > 0) {
      commonRiskNotes.push(
        `Informazioni mancanti rilevate: ${missingItems.map((m) => m.field).join(", ")}.`
      );
    }
    if (contradictionsCount > 0) {
      commonRiskNotes.push(
        `Presenza di ${contradictionsCount} incongruenze interne da chiarire.`
      );
    }
    if (breakdown.hypothesesCount > 0) {
      commonRiskNotes.push(
        `${breakdown.hypothesesCount} ipotesi non verificate non possono guidare da sole la scelta.`
      );
    }

    const standardOption: StrategyOptionAnalysis = {
      strategy: "STANDARD",
      accuracyScore: computeAccuracyFor("STANDARD"),
      safetyScore: standardSafety,
      coherenceScore: standardCoherence,
      operationalCost: lowEnergy || tightTime ? "high" : "medium",
      advantages: [
        hasDeclaredGoal
          ? `Supporta l'esecuzione completa dell'obiettivo dichiarato "${goal}".`
          : "Consente avanzamento operativo completo quando contesto e risorse sono definiti.",
        ...(availableResources.length > 0
          ? [`Sfrutta le risorse disponibili dichiarate (${availableResources.join(", ")}).`]
          : []),
      ],
      disadvantages: [
        "Richiede disponibilità completa di tempo, energia e informazioni coerenti.",
        ...(tightTime
          ? [`Budget temporale dichiarato ridotto (${constraints.timeBudgetMinutes} min).`]
          : []),
        ...(lowEnergy ? ["Livello di energia dichiarato basso."] : []),
      ],
      risks: [
        ...commonRiskNotes,
        ...(overload
          ? ["Rischio di sovraccarico esecutivo se applicata con carico già elevato."]
          : []),
      ],
      tradeoffs: [
        "Massima copertura dell'obiettivo a fronte del costo operativo e cognitivo più elevato.",
      ],
      rationale:
        selectedStrategy === "STANDARD"
          ? `Consigliata in sola lettura sulla base di ${uncertaintyEvaluation.verifiedObservationCount} osservazioni verificate, bassa incertezza e assenza di vincoli bloccanti.`
          : "Valutata rispetto a obiettivo, vincoli dichiarati e livello di incertezza corrente.",
      rejectedReason:
        selectedStrategy !== "STANDARD"
          ? insufficientForReliableChoice
            ? "Non selezionabile in modo affidabile finché le evidenze verificate restano insufficienti."
            : overload || lowEnergy || tightTime || blockedOrSuspendedProcess
              ? "Richiede impegno pieno incompatibile con i vincoli di carico/tempo/energia o con lo stato del processo."
              : "Superata da un'alternativa più prudente rispetto alle evidenze correnti."
          : undefined,
    };

    const lightOption: StrategyOptionAnalysis = {
      strategy: "LIGHT",
      accuracyScore: computeAccuracyFor("LIGHT"),
      safetyScore: lightSafety,
      coherenceScore: lightCoherence,
      operationalCost: "low",
      advantages: [
        "Riduce il carico cognitivo e temporale mantenendo un avanzamento minimo verificabile.",
        ...(lowEnergy || tightTime || overload
          ? ["Adatta ai vincoli correnti di energia ridotta, tempo limitato o sovraccarico."]
          : []),
      ],
      disadvantages: [
        "Copre solo i passaggi essenziali dell'obiettivo rinviando gli approfondimenti.",
      ],
      risks: [
        ...commonRiskNotes,
        ...(urgentDeadline && !lowEnergy && !overload
          ? ["Potrebbe non esaurire tutte le attività richieste da una scadenza urgente."]
          : []),
      ],
      tradeoffs: [
        "Compromesso tra continuità operativa e contenimento dello sforzo richiesto.",
      ],
      rationale:
        selectedStrategy === "LIGHT"
          ? `Consigliata in sola lettura per proteggere la sostenibilità sotto vincoli attivi o sufficienza informativa parziale (${uncertaintyEvaluation.verifiedObservationCount} evidenze verificate).`
          : "Valutata come opzione a basso costo operativo per preservare continuità.",
      rejectedReason:
        selectedStrategy !== "LIGHT"
          ? insufficientForReliableChoice
            ? "Non selezionabile in modo affidabile finché mancano evidenze verificate sufficienti."
            : selectedStrategy === "STANDARD"
              ? "Le evidenze e i vincoli disponibili consentono l'approccio STANDARD senza ridurre la portata."
              : "Le lacune critiche o lo stato bloccato suggeriscono il rinvio prudente rispetto all'esecuzione leggera."
          : undefined,
    };

    const deferredOption: StrategyOptionAnalysis = {
      strategy: "DEFERRED",
      accuracyScore: computeAccuracyFor("DEFERRED"),
      safetyScore: deferredSafety,
      coherenceScore: deferredCoherence,
      operationalCost: "low",
      advantages: [
        "Evita errori operativi e impegni prematuri quando dati o condizioni sono incompleti o contrastanti.",
        "Preserva margine per chiarimenti umani prima di avviare azioni.",
      ],
      disadvantages: [
        "Non produce avanzamento immediato sull'obiettivo dichiarato.",
        ...(urgentDeadline
          ? ["Può entrare in tensione con la scadenza urgente dichiarata."]
          : []),
      ],
      risks: [
        ...(urgentDeadline
          ? ["Rischio di ritardo su una scadenza urgente dichiarata."]
          : ["Possibile posticipo non necessario se l'utente può chiarire subito i dati mancanti."]),
      ],
      tradeoffs: [
        "Massima prudenza epistemica e protezione dal sovraccarico a costo di sospendere l'avanzamento immediato.",
      ],
      rationale:
        selectedStrategy === "DEFERRED"
          ? "Consigliata in sola lettura perché lo stato bloccato/sospeso, le contraddizioni o l'elevata incertezza sconsigliano l'azione immediata."
          : "Valutata come opzione di prudenza e rinvio controllato.",
      rejectedReason:
        selectedStrategy !== "DEFERRED"
          ? insufficientForReliableChoice
            ? "Dati insufficienti per emettere una raccomandazione definitiva; richiesto prima chiarimento utente."
            : "Le informazioni e le condizioni disponibili permettono di procedere in modo proporzionato senza rinvio totale."
          : undefined,
    };

    const options: StrategyOptionAnalysis[] = [
      standardOption,
      lightOption,
      deferredOption,
    ];

    const discardedAlternatives = options
      .filter((opt) => opt.strategy !== selectedStrategy)
      .map(
        (opt) =>
          `${opt.strategy}: ${opt.rejectedReason ?? "Alternativa non prioritaria rispetto alle evidenze disponibili."}`
      );

    const epistemicTag: EpistemicTag = insufficientForReliableChoice
      ? "ipotesi_da_verificare"
      : sufficiency === "sufficient" &&
          breakdown.hypothesesCount === 0 &&
          breakdown.observationsCount === 0 &&
          breakdown.factsCount >= 3
        ? "fatto_osservato"
        : "interpretazione_prudente";

    const confidence: Confidence | null = insufficientForReliableChoice
      ? null
      : reliability;

    const selectionRationale = insufficientForReliableChoice
      ? `Confronto non sufficiente per una raccomandazione affidabile: presenti ${breakdown.factsCount} fatti osservati, ${breakdown.observationsCount} interpretazioni osservate e ${breakdown.hypothesesCount} ipotesi da verificare (stato incertezza: ${uncertaintyEvaluation.assessment.level}). Nessun peso o percentuale inventata.`
      : `Strategia consultiva consigliata: ${selectedStrategy}. Basata esclusivamente su ${breakdown.factsCount} fatti osservati, ${breakdown.observationsCount} osservazioni prudenti e ${breakdown.hypothesesCount} ipotesi distinte (sufficienza: ${sufficiency}, incertezza: ${uncertaintyEvaluation.assessment.level}). Nessuna modifica automatica applicata.`;

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      autoApplied: false,
      insufficientData: insufficientForReliableChoice,
      selectedStrategy,
      options,
      selectionRationale,
      discardedAlternatives,
      confidence,
      epistemicTag,
      epistemicBreakdown: breakdown,
      safetyDecision,
      processMonitor,
      uncertaintyEvaluation,
    };
  } catch {
    return buildBlockedComparison(
      "Errore interno nello Strategy Comparison Engine: blocco fail-closed senza impatto sui motori esistenti.",
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
