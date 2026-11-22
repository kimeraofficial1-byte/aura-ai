import type { ExperienceSummary } from "./experienceAnalyzer";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type {
  CognitiveProcessTrace,
  MetaCognitiveSafetyDecision,
  UncertaintyAssessment,
} from "./metaCognitiveTypes";
import type { EpistemicTag, LearningConsentState } from "./selfLearningTypes";

export const MIN_EVIDENCE_FOR_RELIABILITY = 3;

export type InformationSufficiency = "sufficient" | "partial" | "insufficient";

export interface UncertaintyEngineInput {
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  trace?: CognitiveProcessTrace;
  experienceSummary?: ExperienceSummary;
  minRequiredEvidence?: number;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

export interface UncertaintyEvaluationResult {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  sufficiencyStatus: InformationSufficiency;
  unverifiedHypothesesCount: number;
  missingInformationCount: number;
  verifiedObservationCount: number;
  assessment: UncertaintyAssessment;
  safetyDecision: MetaCognitiveSafetyDecision;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

/**
 * Uncertainty Engine V1.
 * Valuta deterministicamente l'incertezza e la sufficienza informativa in sola lettura.
 * Non inventa percentuali quando le evidenze non sono sufficienti (reliabilityScore = null)
 * e non promuove mai ipotesi a fatti.
 */
export function evaluateUncertainty(
  input: UncertaintyEngineInput
): UncertaintyEvaluationResult {
  const nowIso = input?.nowIso ?? new Date().toISOString();
  const minRequired = Math.max(1, input?.minRequiredEvidence ?? MIN_EVIDENCE_FOR_RELIABILITY);
  const usesLearningData =
    input?.usesLearningData ?? Boolean(input?.experienceSummary);

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
    return {
      allowed: false,
      advisoryOnly: true,
      readOnly: true,
      sufficiencyStatus: "insufficient",
      unverifiedHypothesesCount: 0,
      missingInformationCount: 0,
      verifiedObservationCount: 0,
      assessment: {
        level: "insufficient_evidence",
        reliabilityScore: null,
        needsClarification: false,
        clarificationQuestions: [],
        limitingFactors: [safetyDecision.reason],
        epistemicTag: "ipotesi_da_verificare",
        uncertaintyNote: safetyDecision.reason,
      },
      safetyDecision,
    };
  }

  try {
    const evidences = input.trace?.evidences ?? [];
    const missing = input.trace?.missingInformation ?? [];
    const contradictions = input.trace?.contradictionsDetected ?? 0;

    // Le ipotesi non possono mai essere conteggiate come fatti verificati
    const unverifiedHypotheses = evidences.filter(
      (e) =>
        e.evidenceType === "hypothesis" ||
        e.epistemicTag === "ipotesi_da_verificare"
    );
    const verifiedObservations = evidences.filter(
      (e) =>
        e.evidenceType !== "hypothesis" &&
        e.epistemicTag !== "ipotesi_da_verificare"
    );

    const verifiedObservationCount = verifiedObservations.length;
    const unverifiedHypothesesCount = unverifiedHypotheses.length;
    const missingInformationCount = missing.length;
    const hasHighImpactMissing = missing.some((m) => m.impact === "high");

    const limitingFactors: string[] = [];
    const clarificationQuestions: string[] = [];

    if (verifiedObservationCount < minRequired) {
      limitingFactors.push(
        `Evidenze verificate insufficienti (${verifiedObservationCount}/${minRequired} minime richieste; le ipotesi non vengono contate come fatti).`
      );
    }

    if (missingInformationCount > 0) {
      for (const item of missing) {
        limitingFactors.push(`Informazione mancante (${item.impact}): ${item.field}.`);
        clarificationQuestions.push(
          `Puoi fornire o chiarire il dato "${item.field}" (${item.reason})?`
        );
      }
    }

    if (unverifiedHypothesesCount > 0) {
      limitingFactors.push(
        `Presenti ${unverifiedHypothesesCount} ipotesi non verificate che non possono essere trattate come fatti.`
      );
      clarificationQuestions.push(
        `Confermi se le ipotesi rilevate (${unverifiedHypotheses.map((h) => h.summary).slice(0, 2).join("; ")}) corrispondono alla tua situazione attuale?`
      );
    }

    if (contradictions > 0) {
      limitingFactors.push(
        `Rilevate ${contradictions} incongruenze o segnali contrastanti nella traccia cognitiva.`
      );
      clarificationQuestions.push(
        "Ci sono preferenze o priorità cambiate di recente rispetto ai segnali registrati in precedenza?"
      );
    }

    if (input.experienceSummary && input.experienceSummary.insufficientData) {
      limitingFactors.push(input.experienceSummary.uncertaintyNote);
    }

    if (limitingFactors.length === 0) {
      limitingFactors.push(
        "Analisi deterministica locale: l'affidabilità rimane soggetta a eventuale verifica dell'utente."
      );
    }

    // Classificazione sufficienza informativa
    let sufficiencyStatus: InformationSufficiency;
    if (
      input.trace?.status === "blocked" ||
      verifiedObservationCount < minRequired ||
      (verifiedObservationCount === 0 && evidences.length === 0)
    ) {
      sufficiencyStatus = "insufficient";
    } else if (
      hasHighImpactMissing ||
      missingInformationCount > 0 ||
      unverifiedHypothesesCount > 0 ||
      contradictions > 0
    ) {
      sufficiencyStatus = "partial";
    } else {
      sufficiencyStatus = "sufficient";
    }

    // Nessuna percentuale inventata quando le evidenze non sono sufficienti
    if (sufficiencyStatus === "insufficient") {
      if (clarificationQuestions.length === 0) {
        clarificationQuestions.push(
          "Vuoi aggiungere maggiori dettagli operativi o confermare le tue priorità attuali prima di proseguire?"
        );
      }

      return {
        allowed: true,
        advisoryOnly: true,
        readOnly: true,
        sufficiencyStatus,
        unverifiedHypothesesCount,
        missingInformationCount,
        verifiedObservationCount,
        assessment: {
          level: "insufficient_evidence",
          reliabilityScore: null,
          needsClarification: true,
          clarificationQuestions,
          limitingFactors,
          epistemicTag: "ipotesi_da_verificare",
          uncertaintyNote:
            "Evidenze insufficienti: nessuna stima numerica di confidenza generata per evitare percentuali arbitrarie.",
        },
        safetyDecision,
      };
    }

    // Calcolo deterministico basato solo sulle evidenze verificate e penalità per limiti/contraddizioni
    const avgEvidenceConfidence =
      verifiedObservations.reduce((sum, e) => sum + e.confidence, 0) /
      verifiedObservations.length;
    const penalty =
      Math.min(0.25, missingInformationCount * 0.08) +
      Math.min(0.25, contradictions * 0.12) +
      Math.min(0.15, unverifiedHypothesesCount * 0.05);
    const reliabilityScore = clampConfidence(avgEvidenceConfidence - penalty);

    const level =
      sufficiencyStatus === "sufficient" && reliabilityScore >= 0.7
        ? "low"
        : reliabilityScore >= 0.45
          ? "moderate"
          : "high";

    const needsClarification =
      sufficiencyStatus === "partial" ||
      level === "high" ||
      unverifiedHypothesesCount > 0 ||
      contradictions > 0;

    const allObservedFacts = verifiedObservations.every(
      (e) => e.epistemicTag === "fatto_osservato"
    );
    const epistemicTag: EpistemicTag =
      sufficiencyStatus === "sufficient" && allObservedFacts
        ? "fatto_osservato"
        : "interpretazione_prudente";

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      sufficiencyStatus,
      unverifiedHypothesesCount,
      missingInformationCount,
      verifiedObservationCount,
      assessment: {
        level,
        reliabilityScore,
        needsClarification,
        clarificationQuestions: needsClarification ? clarificationQuestions : [],
        limitingFactors,
        epistemicTag,
        uncertaintyNote:
          sufficiencyStatus === "sufficient"
            ? `Informazioni sufficienti su ${verifiedObservationCount} evidenze verificate (livello incertezza: ${level}).`
            : `Informazioni parziali: alcune lacune, ipotesi non verificate o incongruenze richiedono chiarimento.`,
      },
      safetyDecision,
    };
  } catch {
    return {
      allowed: false,
      advisoryOnly: true,
      readOnly: true,
      sufficiencyStatus: "insufficient",
      unverifiedHypothesesCount: 0,
      missingInformationCount: 0,
      verifiedObservationCount: 0,
      assessment: {
        level: "insufficient_evidence",
        reliabilityScore: null,
        needsClarification: false,
        clarificationQuestions: [],
        limitingFactors: [
          "Errore interno nell'Uncertainty Engine: blocco fail-closed senza impatto sui motori esistenti.",
        ],
        epistemicTag: "ipotesi_da_verificare",
        uncertaintyNote:
          "Errore interno nell'Uncertainty Engine (fail-closed): nessuna stima generata.",
      },
      safetyDecision: {
        ...safetyDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
    };
  }
}
