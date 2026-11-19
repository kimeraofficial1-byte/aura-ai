import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { AuthorizationLedger } from "./authorizationLedger";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import { evaluateLearningSafety } from "./learningSafetyGuard";
import type {
  Confidence,
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
  LearningGuardDecision,
} from "./selfLearningTypes";

export const MIN_OBSERVATIONS_FOR_PATTERN = 3;

export type OperationalStrategyHint = "STANDARD" | "LIGHT" | "DEFERRED";

export interface ExperiencePattern {
  id: string;
  title: string;
  description: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  confidence: Confidence;
  observationCount: number;
  dataSource: string;
  uncertaintyNote: string;
  recommendedStrategy?: OperationalStrategyHint;
}

export interface ExperienceEvidenceBreakdown {
  explicit_feedback: number;
  observed_behavior: number;
  hypothesis: number;
}

export interface ExperienceSummary {
  allowed: boolean;
  insufficientData: boolean;
  totalObservations: number;
  minRequiredObservations: number;
  analyzedAt: string;
  dataSource: string;
  epistemicTag: EpistemicTag;
  confidence: Confidence;
  uncertaintyNote: string;
  evidenceBreakdown: ExperienceEvidenceBreakdown;
  patterns: ExperiencePattern[];
  guardDecision: LearningGuardDecision;
}

export interface ExperienceAnalyzerInput {
  consentState: LearningConsentState;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  authorizationLedger?: AuthorizationLedger;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

function clampConfidence(value: number): Confidence {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

/**
 * Experience Analyzer V1 — sola lettura.
 * Analizza DataRepository, CognitiveTimeline, ControlledLearningEngine e AuthorizationLedger
 * senza mai modificare i dati sorgente. Rileva pattern solo con >= 3 osservazioni valide
 * e distingue explicit_feedback, observed_behavior e hypothesis.
 */
export function analyzeExperience(
  input: ExperienceAnalyzerInput
): ExperienceSummary {
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
      allowed: false,
      insufficientData: true,
      totalObservations: 0,
      minRequiredObservations: MIN_OBSERVATIONS_FOR_PATTERN,
      analyzedAt: nowIso,
      dataSource: "none",
      epistemicTag: "ipotesi_da_verificare",
      confidence: 0,
      uncertaintyNote: guardDecision.reason,
      evidenceBreakdown: {
        explicit_feedback: 0,
        observed_behavior: 0,
        hypothesis: 0,
      },
      patterns: [],
      guardDecision,
    };
  }

  try {
    const sources: string[] = [];
    let explicitFeedbackCount = 0;
    let observedBehaviorCount = 0;

    // 1. DataRepository (sola lettura)
    let completedTasks = 0;
    let overdueOrPausedTasks = 0;
    let totalTasks = 0;
    if (input.repository) {
      sources.push("DataRepository");
      const snapshot = input.repository.loadSnapshot();
      for (const plan of snapshot.plans) {
        for (const task of plan.tasks) {
          totalTasks += 1;
          if (task.status === "completed") {
            completedTasks += 1;
            observedBehaviorCount += 1;
          } else if (task.status === "overdue" || task.status === "paused") {
            overdueOrPausedTasks += 1;
            observedBehaviorCount += 1;
          }
        }
      }
      for (const mission of snapshot.missions) {
        if (
          mission.status === "completata" ||
          mission.status === "rifiutata" ||
          mission.status === "annullata"
        ) {
          observedBehaviorCount += 1;
        }
      }
    }

    // 2. CognitiveTimeline (sola lettura)
    let timelineEventsCount = 0;
    if (input.timeline) {
      sources.push("CognitiveTimeline");
      const events = input.timeline.getEvents();
      timelineEventsCount = events.length;
      observedBehaviorCount += timelineEventsCount;
    }

    // 3. ControlledLearningEngine (sola lettura — feedback esplicito)
    let positiveExplicit = 0;
    let negativeExplicit = 0;
    let deferredExplicit = 0;
    if (input.controlledLearning) {
      sources.push("ControlledLearningEngine");
      const exported = input.controlledLearning.exportLearningData();
      for (const item of exported.interactions) {
        explicitFeedbackCount += 1;
        if (item.action === "accepted" || item.action === "completed") {
          positiveExplicit += 1;
        } else if (item.action === "rejected" || item.action === "suspended") {
          negativeExplicit += 1;
        } else if (item.action === "snoozed") {
          deferredExplicit += 1;
        }
      }
    }

    // 4. AuthorizationLedger (sola lettura — conferme e revoche esplicite)
    let explicitGrants = 0;
    let explicitRevocations = 0;
    if (input.authorizationLedger) {
      sources.push("AuthorizationLedger");
      const events = input.authorizationLedger.getAuditEvents();
      for (const ev of events) {
        if (ev.eventType === "authorization_granted") {
          explicitGrants += 1;
          explicitFeedbackCount += 1;
        } else if (ev.eventType === "authorization_revoked") {
          explicitRevocations += 1;
          explicitFeedbackCount += 1;
        }
      }
    }

    const totalObservations = explicitFeedbackCount + observedBehaviorCount;
    const dataSource = sources.length > 0 ? sources.join("+") : "none";

    if (totalObservations < MIN_OBSERVATIONS_FOR_PATTERN) {
      return {
        allowed: true,
        insufficientData: true,
        totalObservations,
        minRequiredObservations: MIN_OBSERVATIONS_FOR_PATTERN,
        analyzedAt: nowIso,
        dataSource,
        epistemicTag: "ipotesi_da_verificare",
        confidence: clampConfidence(totalObservations / (MIN_OBSERVATIONS_FOR_PATTERN * 2)),
        uncertaintyNote: `Dati insufficienti per rilevare pattern operativi affidabili (${totalObservations}/${MIN_OBSERVATIONS_FOR_PATTERN} osservazioni minime).`,
        evidenceBreakdown: {
          explicit_feedback: explicitFeedbackCount,
          observed_behavior: observedBehaviorCount,
          hypothesis: 0,
        },
        patterns: [],
        guardDecision,
      };
    }

    const patterns: ExperiencePattern[] = [];

    // Pattern da feedback esplicito
    if (positiveExplicit >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-explicit-positive-engagement",
        title: "Buona aderenza ai suggerimenti operativi",
        description: `Rilevate ${positiveExplicit} scelte esplicite positive (accepted/completed) sui suggerimenti proattivi.`,
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
        confidence: clampConfidence(0.55 + Math.min(0.35, positiveExplicit * 0.05)),
        observationCount: positiveExplicit,
        dataSource: "ControlledLearningEngine",
        uncertaintyNote:
          "Basato su feedback espliciti locali; le preferenze possono cambiare nel tempo.",
        recommendedStrategy: "STANDARD",
      });
    }

    if (negativeExplicit >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-explicit-light-preference",
        title: "Preferenza per carico proattivo ridotto",
        description: `Rilevati ${negativeExplicit} rifiuti o sospensioni esplicite sui suggerimenti proattivi.`,
        evidenceType: "explicit_feedback",
        epistemicTag: "interpretazione_prudente",
        confidence: clampConfidence(0.5 + Math.min(0.35, negativeExplicit * 0.05)),
        observationCount: negativeExplicit,
        dataSource: "ControlledLearningEngine",
        uncertaintyNote:
          "Indica possibile sovraccarico o scarsa pertinenza: richiede verifica esplicita dell'utente.",
        recommendedStrategy: "LIGHT",
      });
    }

    if (deferredExplicit >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-explicit-deferred-rhythm",
        title: "Frequente rinvio dei suggerimenti",
        description: `Rilevati ${deferredExplicit} rinvii espliciti (snoozed).`,
        evidenceType: "explicit_feedback",
        epistemicTag: "interpretazione_prudente",
        confidence: clampConfidence(0.45 + Math.min(0.35, deferredExplicit * 0.05)),
        observationCount: deferredExplicit,
        dataSource: "ControlledLearningEngine",
        uncertaintyNote:
          "Il rinvio può dipendere dal momento della giornata e non implica rifiuto definitivo.",
        recommendedStrategy: "DEFERRED",
      });
    }

    // Pattern da comportamento osservato
    if (completedTasks >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-observed-task-completion",
        title: "Continuità nel completamento dei task",
        description: `Osservati ${completedTasks} task completati su ${totalTasks} nei piani operativi.`,
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
        confidence: clampConfidence(0.5 + Math.min(0.35, completedTasks * 0.04)),
        observationCount: completedTasks,
        dataSource: "DataRepository",
        uncertaintyNote:
          "Fatto osservato sui piani locali; non implica automaticamente preferenza per carichi maggiori.",
        recommendedStrategy: "STANDARD",
      });
    }

    if (overdueOrPausedTasks >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-observed-overload-signal",
        title: "Possibile accumulo di task in pausa o in ritardo",
        description: `Osservati ${overdueOrPausedTasks} task in stato overdue o paused nei piani locali.`,
        evidenceType: "hypothesis",
        epistemicTag: "ipotesi_da_verificare",
        confidence: clampConfidence(0.4 + Math.min(0.3, overdueOrPausedTasks * 0.04)),
        observationCount: overdueOrPausedTasks,
        dataSource: "DataRepository",
        uncertaintyNote:
          "Ipotesi prudente: i task in ritardo possono riflettere cambi di priorità non ancora aggiornati.",
        recommendedStrategy: "LIGHT",
      });
    }

    if (explicitGrants + explicitRevocations >= MIN_OBSERVATIONS_FOR_PATTERN) {
      patterns.push({
        id: "pattern-explicit-autonomy-control",
        title: "Uso attivo delle autorizzazioni granulari",
        description: `Registrate ${explicitGrants} autorizzazioni e ${explicitRevocations} revoche esplicite nel registro di audit.`,
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
        confidence: clampConfidence(
          0.55 + Math.min(0.3, (explicitGrants + explicitRevocations) * 0.04)
        ),
        observationCount: explicitGrants + explicitRevocations,
        dataSource: "AuthorizationLedger",
        uncertaintyNote:
          "Riflette il controllo esplicito esercitato dall'utente sulle azioni locali.",
      });
    }

    const hypothesisCount = patterns.filter((p) => p.evidenceType === "hypothesis").length;
    const summaryConfidence =
      patterns.length > 0
        ? clampConfidence(
            patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length
          )
        : clampConfidence(0.35 + Math.min(0.25, totalObservations * 0.02));

    const epistemicTag: EpistemicTag =
      explicitFeedbackCount >= MIN_OBSERVATIONS_FOR_PATTERN
        ? "fatto_osservato"
        : patterns.length > 0
          ? "interpretazione_prudente"
          : "ipotesi_da_verificare";

    return {
      allowed: true,
      insufficientData: false,
      totalObservations,
      minRequiredObservations: MIN_OBSERVATIONS_FOR_PATTERN,
      analyzedAt: nowIso,
      dataSource,
      epistemicTag,
      confidence: summaryConfidence,
      uncertaintyNote:
        patterns.length > 0
          ? "Analisi operativa locale in sola lettura: ogni adattamento resta trasparente, limitato e reversibile."
          : "Osservazioni sufficienti ma distribuite senza un pattern dominante chiaro.",
      evidenceBreakdown: {
        explicit_feedback: explicitFeedbackCount,
        observed_behavior: observedBehaviorCount,
        hypothesis: hypothesisCount,
      },
      patterns,
      guardDecision,
    };
  } catch {
    return {
      allowed: false,
      insufficientData: true,
      totalObservations: 0,
      minRequiredObservations: MIN_OBSERVATIONS_FOR_PATTERN,
      analyzedAt: nowIso,
      dataSource: "error",
      epistemicTag: "ipotesi_da_verificare",
      confidence: 0,
      uncertaintyNote:
        "Errore interno durante l'analisi dell'esperienza: blocco fail-closed senza impatto su chat o voce.",
      evidenceBreakdown: {
        explicit_feedback: 0,
        observed_behavior: 0,
        hypothesis: 0,
      },
      patterns: [],
      guardDecision: {
        ...guardDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
    };
  }
}
