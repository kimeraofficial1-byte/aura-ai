import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { AdaptiveLearningEngine, AdaptiveStrategy } from "./adaptiveLearningEngine";
import type { AuthorizationLedger } from "./authorizationLedger";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import type { ExperienceSummary } from "./experienceAnalyzer";
import { evaluateLearningSafety } from "./learningSafetyGuard";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
  LearningGuardDecision,
} from "./selfLearningTypes";

export const MIN_SELF_EVALUATION_OBSERVATIONS = 3;

export interface DurationAccuracySample {
  estimatedMinutes: number;
  actualMinutes: number;
}

export interface SuggestionUtilityMetrics {
  accepted: number;
  rejected: number;
  completed: number;
  suspended: number;
  snoozed: number;
  totalValidObservations: number;
  positiveRatio: number | null;
  evaluable: boolean;
  note: string;
}

export interface OperationalAccuracyMetrics {
  sampleCount: number;
  meanAbsoluteErrorMinutes: number | null;
  averageBiasMinutes: number | null;
  reliability: number | null;
  evaluable: boolean;
  note: string;
}

export interface StrategyQualityMetrics {
  STANDARD: { weight: number | null; status: string };
  LIGHT: { weight: number | null; status: string };
  DEFERRED: { weight: number | null; status: string };
  recommendedStrategy: AdaptiveStrategy | null;
  evaluable: boolean;
  note: string;
}

export interface SafetyEvaluationMetrics {
  totalAuditEvents: number;
  rollbackCount: number;
  blockedCount: number;
  errorCount: number;
  revocationCount: number;
  rollbackRate: number | null;
  evaluable: boolean;
  note: string;
}

export interface EpistemicCoherenceMetrics {
  observedFacts: number;
  prudentInterpretations: number;
  hypothesesToVerify: number;
  evaluable: boolean;
  note: string;
}

export interface EvaluationMetrics {
  suggestionUtility: SuggestionUtilityMetrics;
  operationalAccuracy: OperationalAccuracyMetrics;
  strategyQuality: StrategyQualityMetrics;
  safetyMetrics: SafetyEvaluationMetrics;
  epistemicCoherence: EpistemicCoherenceMetrics;
}

export interface CognitiveSelfEvaluationReport {
  timestamp: string;
  status: "completed" | "insufficient_data" | "blocked";
  allowed: boolean;
  metrics: EvaluationMetrics;
  documentedStrengths: string[];
  improvementAreas: string[];
  insufficientDataDimensions: string[];
  evaluationLimits: string[];
  confidence: Confidence;
  epistemicTag: EpistemicTag;
  dataSource: string;
  uncertaintyNote: string;
  guardDecision: LearningGuardDecision;
}

export interface CognitiveSelfEvaluationInput {
  consentState: LearningConsentState;
  experienceSummary?: ExperienceSummary;
  controlledLearning?: ControlledLearningEngine;
  adaptiveLearning?: AdaptiveLearningEngine;
  authorizationLedger?: AuthorizationLedger;
  timeline?: CognitiveTimeline;
  durationSamples?: DurationAccuracySample[];
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

function createEmptyMetrics(): EvaluationMetrics {
  return {
    suggestionUtility: {
      accepted: 0,
      rejected: 0,
      completed: 0,
      suspended: 0,
      snoozed: 0,
      totalValidObservations: 0,
      positiveRatio: null,
      evaluable: false,
      note: "Dimensione non valutabile: dati sui suggerimenti non disponibili.",
    },
    operationalAccuracy: {
      sampleCount: 0,
      meanAbsoluteErrorMinutes: null,
      averageBiasMinutes: null,
      reliability: null,
      evaluable: false,
      note: "Dimensione non valutabile: nessun campione confrontabile tra durata stimata ed effettiva.",
    },
    strategyQuality: {
      STANDARD: { weight: null, status: "non_valutabile" },
      LIGHT: { weight: null, status: "non_valutabile" },
      DEFERRED: { weight: null, status: "non_valutabile" },
      recommendedStrategy: null,
      evaluable: false,
      note: "Dimensione non valutabile: profilo adattivo non disponibile o dati insufficienti.",
    },
    safetyMetrics: {
      totalAuditEvents: 0,
      rollbackCount: 0,
      blockedCount: 0,
      errorCount: 0,
      revocationCount: 0,
      rollbackRate: null,
      evaluable: false,
      note: "Dimensione non valutabile: registro di audit non fornito o vuoto.",
    },
    epistemicCoherence: {
      observedFacts: 0,
      prudentInterpretations: 0,
      hypothesesToVerify: 0,
      evaluable: false,
      note: "Dimensione non valutabile: nessuna evidenza epistemica disponibile.",
    },
  };
}

/**
 * Calcola le metriche diagnostiche in sola lettura senza inventare dati mancanti
 * e proteggendo ogni calcolo da divisioni per zero.
 */
export function calculateEvaluationMetrics(
  input: CognitiveSelfEvaluationInput
): EvaluationMetrics {
  const metrics = createEmptyMetrics();

  // A. Utilità dei suggerimenti (ControlledLearningEngine in sola lettura)
  if (input.controlledLearning) {
    const exported = input.controlledLearning.exportLearningData();
    let accepted = 0;
    let rejected = 0;
    let completed = 0;
    let suspended = 0;
    let snoozed = 0;

    for (const item of exported.interactions) {
      if (item.action === "accepted") accepted += 1;
      else if (item.action === "rejected") rejected += 1;
      else if (item.action === "completed") completed += 1;
      else if (item.action === "suspended") suspended += 1;
      else if (item.action === "snoozed") snoozed += 1;
    }

    const total = accepted + rejected + completed + suspended + snoozed;
    const positive = accepted + completed;
    const evaluable = total >= MIN_SELF_EVALUATION_OBSERVATIONS;

    metrics.suggestionUtility = {
      accepted,
      rejected,
      completed,
      suspended,
      snoozed,
      totalValidObservations: total,
      positiveRatio: evaluable && total > 0 ? Math.round((positive / total) * 100) / 100 : null,
      evaluable,
      note: evaluable
        ? `Valutazione calcolata su ${total} interazioni esplicite locali.`
        : `Dati insufficienti (${total}/${MIN_SELF_EVALUATION_OBSERVATIONS}): nessuna percentuale generata.`,
    };
  }

  // B. Precisione operativa (solo con campioni confrontabili validi)
  const validSamples = (input.durationSamples ?? []).filter(
    (s) =>
      Number.isFinite(s.estimatedMinutes) &&
      Number.isFinite(s.actualMinutes) &&
      s.estimatedMinutes > 0 &&
      s.actualMinutes >= 0
  );
  if (validSamples.length >= MIN_SELF_EVALUATION_OBSERVATIONS) {
    const absErrors = validSamples.map((s) => Math.abs(s.actualMinutes - s.estimatedMinutes));
    const biases = validSamples.map((s) => s.actualMinutes - s.estimatedMinutes);
    const mae = absErrors.reduce((a, b) => a + b, 0) / validSamples.length;
    const avgBias = biases.reduce((a, b) => a + b, 0) / validSamples.length;
    const relErrors = validSamples.map(
      (s) => Math.abs(s.actualMinutes - s.estimatedMinutes) / s.estimatedMinutes
    );
    const meanRelError = relErrors.reduce((a, b) => a + b, 0) / validSamples.length;
    const reliability = clampConfidence(1 - Math.min(1, meanRelError));

    metrics.operationalAccuracy = {
      sampleCount: validSamples.length,
      meanAbsoluteErrorMinutes: Math.round(mae * 100) / 100,
      averageBiasMinutes: Math.round(avgBias * 100) / 100,
      reliability,
      evaluable: true,
      note: `Calcolata su ${validSamples.length} campioni confrontabili tra durata stimata ed effettiva.`,
    };
  } else if (validSamples.length > 0) {
    metrics.operationalAccuracy = {
      sampleCount: validSamples.length,
      meanAbsoluteErrorMinutes: null,
      averageBiasMinutes: null,
      reliability: null,
      evaluable: false,
      note: `Campioni insufficienti (${validSamples.length}/${MIN_SELF_EVALUATION_OBSERVATIONS}) per stimare l'accuratezza operativa.`,
    };
  }

  // C. Qualità delle strategie (AdaptiveLearningEngine in sola lettura)
  if (input.adaptiveLearning) {
    const hints = input.adaptiveLearning.getAdaptationHints(input.consentState, {
      crisisBlocked: input.crisisBlocked,
      userTextForSafetyCheck: input.userTextForSafetyCheck,
      nowIso: input.nowIso,
    });
    if (hints.allowed && !hints.insufficientData) {
      const classify = (w: number): string =>
        w > 1.05 ? "favorita" : w < 0.95 ? "penalizzata" : "neutra";
      metrics.strategyQuality = {
        STANDARD: {
          weight: hints.strategyWeights.STANDARD,
          status: classify(hints.strategyWeights.STANDARD),
        },
        LIGHT: {
          weight: hints.strategyWeights.LIGHT,
          status: classify(hints.strategyWeights.LIGHT),
        },
        DEFERRED: {
          weight: hints.strategyWeights.DEFERRED,
          status: classify(hints.strategyWeights.DEFERRED),
        },
        recommendedStrategy: hints.recommendedStrategy,
        evaluable: true,
        note: "Basata sui pesi limitati [0.5, 1.5] del profilo adattivo locale.",
      };
    } else {
      metrics.strategyQuality.note = hints.allowed
        ? "Dati insufficienti nel profilo adattivo per valutare le strategie."
        : hints.uncertaintyNote;
    }
  }

  // D. Sicurezza (AuthorizationLedger esclusivamente in sola lettura)
  if (input.authorizationLedger) {
    const events = input.authorizationLedger.getAuditEvents();
    const totalAuditEvents = events.length;
    let rollbackCount = 0;
    let blockedCount = 0;
    let errorCount = 0;
    let revocationCount = 0;
    let executionCount = 0;

    for (const ev of events) {
      if (ev.eventType === "rollback_succeeded") rollbackCount += 1;
      if (ev.eventType === "execution_blocked" || ev.eventType === "authorization_rejected") {
        blockedCount += 1;
      }
      if (ev.eventType === "execution_error") errorCount += 1;
      if (ev.eventType === "authorization_revoked") revocationCount += 1;
      if (ev.eventType === "execution_succeeded") executionCount += 1;
    }

    const rollbackDenom = executionCount + rollbackCount;
    metrics.safetyMetrics = {
      totalAuditEvents,
      rollbackCount,
      blockedCount,
      errorCount,
      revocationCount,
      rollbackRate:
        rollbackDenom > 0 ? Math.round((rollbackCount / rollbackDenom) * 100) / 100 : null,
      evaluable: totalAuditEvents > 0,
      note:
        totalAuditEvents > 0
          ? `Rilevati ${totalAuditEvents} eventi di audit in sola lettura.`
          : "Nessun evento di audit presente nel registro.",
    };
  }

  // E. Coerenza epistemica (ExperienceSummary + CognitiveTimeline in sola lettura)
  let observedFacts = 0;
  let prudentInterpretations = 0;
  let hypothesesToVerify = 0;

  if (input.experienceSummary && input.experienceSummary.allowed) {
    for (const p of input.experienceSummary.patterns) {
      if (p.epistemicTag === "fatto_osservato") observedFacts += 1;
      else if (p.epistemicTag === "interpretazione_prudente") prudentInterpretations += 1;
      else hypothesesToVerify += 1;
    }
  }
  if (input.timeline) {
    for (const ev of input.timeline.getEvents()) {
      if (ev.epistemicTag === "fatto_osservato") observedFacts += 1;
      else if (ev.epistemicTag === "interpretazione_prudente") prudentInterpretations += 1;
      else hypothesesToVerify += 1;
    }
  }

  const totalEpistemic = observedFacts + prudentInterpretations + hypothesesToVerify;
  metrics.epistemicCoherence = {
    observedFacts,
    prudentInterpretations,
    hypothesesToVerify,
    evaluable: totalEpistemic > 0,
    note:
      totalEpistemic > 0
        ? `Distinzione epistemica su ${totalEpistemic} elementi (${observedFacts} fatti, ${prudentInterpretations} interpretazioni, ${hypothesesToVerify} ipotesi).`
        : "Nessun elemento epistemico disponibile per la verifica.",
  };

  return metrics;
}

/**
 * Genera il report consultivo di autovalutazione a partire dalle metriche calcolate.
 */
export function generateEvaluationReport(
  input: CognitiveSelfEvaluationInput,
  metrics: EvaluationMetrics,
  guardDecision: LearningGuardDecision,
  nowIso: string
): CognitiveSelfEvaluationReport {
  const sources: string[] = [];
  if (input.experienceSummary) sources.push("ExperienceAnalyzer");
  if (input.controlledLearning) sources.push("ControlledLearningEngine");
  if (input.adaptiveLearning) sources.push("AdaptiveLearningEngine");
  if (input.authorizationLedger) sources.push("AuthorizationLedger");
  if (input.timeline) sources.push("CognitiveTimeline");
  if ((input.durationSamples?.length ?? 0) > 0) sources.push("DurationSamples");

  const documentedStrengths: string[] = [];
  const improvementAreas: string[] = [];
  const insufficientDataDimensions: string[] = [];
  const evaluationLimits: string[] = [
    "Autovalutazione esclusivamente diagnostica e consultiva: non modifica parametri, prompt o permessi.",
    "Nessun dato viene inviato a Gemini; analisi eseguita solo localmente su richiesta.",
  ];

  if (metrics.suggestionUtility.evaluable) {
    const ratio = metrics.suggestionUtility.positiveRatio ?? 0;
    if (ratio >= 0.6) {
      documentedStrengths.push(
        `Buona utilità dei suggerimenti (rapporto positivo ${(ratio * 100).toFixed(0)}% su ${metrics.suggestionUtility.totalValidObservations} osservazioni).`
      );
    } else {
      improvementAreas.push(
        `Utilità dei suggerimenti migliorabile (rapporto positivo ${(ratio * 100).toFixed(0)}%): valutare una strategia più leggera.`
      );
    }
  } else {
    insufficientDataDimensions.push("suggestionUtility");
  }

  if (metrics.operationalAccuracy.evaluable) {
    const rel = metrics.operationalAccuracy.reliability ?? 0;
    if (rel >= 0.7) {
      documentedStrengths.push(
        `Buona affidabilità delle stime di durata (MAE ${metrics.operationalAccuracy.meanAbsoluteErrorMinutes} min).`
      );
    } else {
      improvementAreas.push(
        `Scostamento elevato tra durata stimata ed effettiva (MAE ${metrics.operationalAccuracy.meanAbsoluteErrorMinutes} min).`
      );
    }
  } else {
    insufficientDataDimensions.push("operationalAccuracy");
  }

  if (metrics.strategyQuality.evaluable) {
    documentedStrengths.push(
      `Strategia attualmente favorita dai segnali locali: ${metrics.strategyQuality.recommendedStrategy}.`
    );
  } else {
    insufficientDataDimensions.push("strategyQuality");
  }

  if (metrics.safetyMetrics.evaluable) {
    if (
      metrics.safetyMetrics.rollbackCount > 0 ||
      metrics.safetyMetrics.blockedCount > 0 ||
      metrics.safetyMetrics.errorCount > 0
    ) {
      improvementAreas.push(
        `Rilevati eventi di cautela nell'audit (rollback: ${metrics.safetyMetrics.rollbackCount}, blocchi: ${metrics.safetyMetrics.blockedCount}, errori: ${metrics.safetyMetrics.errorCount}).`
      );
    } else {
      documentedStrengths.push("Nessun rollback, blocco o errore rilevato nel registro di audit.");
    }
  } else {
    insufficientDataDimensions.push("safetyMetrics");
  }

  if (!metrics.epistemicCoherence.evaluable) {
    insufficientDataDimensions.push("epistemicCoherence");
  }

  const evaluableCount = 5 - insufficientDataDimensions.length;
  const status = evaluableCount === 0 ? "insufficient_data" : "completed";
  const confidence = clampConfidence(evaluableCount / 5);
  const epistemicTag: EpistemicTag =
    evaluableCount >= 3
      ? "interpretazione_prudente"
      : evaluableCount > 0
        ? "ipotesi_da_verificare"
        : "ipotesi_da_verificare";

  return {
    timestamp: nowIso,
    status,
    allowed: true,
    metrics,
    documentedStrengths,
    improvementAreas,
    insufficientDataDimensions,
    evaluationLimits,
    confidence,
    epistemicTag,
    dataSource: sources.length > 0 ? sources.join("+") : "none",
    uncertaintyNote:
      status === "insufficient_data"
        ? "Dati insufficienti in tutte le dimensioni: nessuna metrica percentuale generata."
        : `Valutazione consultiva completata su ${evaluableCount}/5 dimensioni disponibili; i risultati restano soggetti a verifica utente.`,
    guardDecision,
  };
}

/**
 * Esegue la Cognitive Self-Evaluation V1 su richiesta esplicita,
 * protetta dal Learning Safety Guard V1 in modalità fail-closed.
 */
export function runCognitiveSelfEvaluation(
  input: CognitiveSelfEvaluationInput
): CognitiveSelfEvaluationReport {
  const nowIso = input.nowIso ?? new Date().toISOString();

  const guardDecision = evaluateLearningSafety({
    operation: "read",
    consentState: input.consentState,
    crisisBlocked: input.crisisBlocked,
    userTextForSafetyCheck: input.userTextForSafetyCheck,
    storageAvailable: input.storageAvailable,
    corruptedDataDetected: input.corruptedDataDetected,
    nowIso,
  });

  if (!guardDecision.allowed) {
    return {
      timestamp: nowIso,
      status: "blocked",
      allowed: false,
      metrics: createEmptyMetrics(),
      documentedStrengths: [],
      improvementAreas: [],
      insufficientDataDimensions: [
        "suggestionUtility",
        "operationalAccuracy",
        "strategyQuality",
        "safetyMetrics",
        "epistemicCoherence",
      ],
      evaluationLimits: [guardDecision.reason],
      confidence: 0,
      epistemicTag: "ipotesi_da_verificare",
      dataSource: "none",
      uncertaintyNote: guardDecision.reason,
      guardDecision,
    };
  }

  try {
    const metrics = calculateEvaluationMetrics(input);
    return generateEvaluationReport(input, metrics, guardDecision, nowIso);
  } catch {
    return {
      timestamp: nowIso,
      status: "blocked",
      allowed: false,
      metrics: createEmptyMetrics(),
      documentedStrengths: [],
      improvementAreas: [],
      insufficientDataDimensions: [
        "suggestionUtility",
        "operationalAccuracy",
        "strategyQuality",
        "safetyMetrics",
        "epistemicCoherence",
      ],
      evaluationLimits: [
        "Errore interno durante l'autovalutazione: blocco fail-closed senza impatto su chat o voce.",
      ],
      confidence: 0,
      epistemicTag: "ipotesi_da_verificare",
      dataSource: "error",
      uncertaintyNote:
        "Errore interno durante l'autovalutazione cognitiva (fail-closed).",
      guardDecision: {
        ...guardDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
    };
  }
}
