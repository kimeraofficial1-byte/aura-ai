import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import {
  evaluateLearningSafety,
  sanitizeLearningPayload,
} from "./learningSafetyGuard";
import type {
  MetaCognitiveOperation,
  MetaCognitiveSafetyDecision,
  MetaCognitiveSafetyInput,
} from "./metaCognitiveTypes";

const ALLOWED_META_OPERATIONS = new Set<MetaCognitiveOperation>([
  "analyze",
  "compare_strategies",
  "detect_errors",
  "explain",
]);

/**
 * Meta-Cognitive Safety Guard V1 — Deterministico e fail-closed.
 * Compone le protezioni esistenti (evaluateCognitiveSafety, evaluateLearningSafety,
 * sanitizeLearningPayload) senza duplicarle e garantisce operatività esclusivamente
 * consultiva e in sola lettura.
 */
export function evaluateMetaCognitiveSafety(
  input: MetaCognitiveSafetyInput
): MetaCognitiveSafetyDecision {
  const nowIso = input?.nowIso ?? new Date().toISOString();

  const block = (
    reason: string,
    blockedBy: MetaCognitiveSafetyDecision["blockedBy"],
    learningGuardDecision?: MetaCognitiveSafetyDecision["learningGuardDecision"]
  ): MetaCognitiveSafetyDecision => ({
    allowed: false,
    failClosed: true,
    advisoryOnly: true,
    readOnly: true,
    reason,
    blockedBy,
    learningGuardDecision,
    timestamp: nowIso,
  });

  try {
    if (!input || !input.consentState) {
      return block(
        "Input metacognitivo o stato del consenso mancante: accesso bloccato (fail-closed).",
        "corrupted_data"
      );
    }

    if (!ALLOWED_META_OPERATIONS.has(input.operation)) {
      return block(
        "Operazione metacognitiva non consentita: sono ammesse solo operazioni consultive in sola lettura.",
        "escalation"
      );
    }

    // 1. Safety System sempre prioritario (crisi)
    const textSafety = input.userTextForSafetyCheck
      ? evaluateCognitiveSafety(input.userTextForSafetyCheck)
      : { safe: true, crisisDetected: false };

    if (input.crisisBlocked || !textSafety.safe || textSafety.crisisDetected) {
      return block(
        "Condizione di crisi attiva: il Safety System blocca immediatamente l'analisi metacognitiva.",
        "crisis"
      );
    }

    // 2. Controllo integrità e disponibilità storage (fail-closed)
    if (input.storageAvailable === false) {
      return block(
        "Storage locale non disponibile: analisi metacognitiva bloccata senza impatto su chat o voce.",
        "storage_unavailable"
      );
    }

    if (input.corruptedDataDetected === true) {
      return block(
        "Dati corrotti o non verificabili rilevati: analisi metacognitiva bloccata (fail-closed).",
        "corrupted_data"
      );
    }

    // 3. Controllo consenso dedicato e revoca tramite Learning Safety Guard esistente
    const usesLearningData = input.usesLearningData !== false;
    if (usesLearningData) {
      if (input.consentState.revokedAt && input.consentState.learningConsent !== true) {
        const revokedGuard = evaluateLearningSafety({
          operation: "read",
          consentState: input.consentState,
          crisisBlocked: input.crisisBlocked,
          userTextForSafetyCheck: input.userTextForSafetyCheck,
          storageAvailable: input.storageAvailable,
          corruptedDataDetected: input.corruptedDataDetected,
          nowIso,
        });
        return block(
          "Consenso all'apprendimento revocato: blocco immediato dell'analisi metacognitiva sui dati appresi.",
          "consent",
          revokedGuard
        );
      }

      const learningDecision = evaluateLearningSafety({
        operation: "read",
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck,
        storageAvailable: input.storageAvailable,
        corruptedDataDetected: input.corruptedDataDetected,
        nowIso,
      });

      if (!learningDecision.allowed) {
        return block(
          learningDecision.reason,
          learningDecision.blockedBy ?? "consent",
          learningDecision
        );
      }

      // 4. Sanitizzazione e verifica escalation su eventuale payload fornito
      if (input.payload !== undefined) {
        const sanitized = sanitizeLearningPayload(input.payload);
        if (!sanitized.ok) {
          return block(sanitized.reason, sanitized.blockedBy, learningDecision);
        }

        return {
          allowed: true,
          failClosed: false,
          advisoryOnly: true,
          readOnly: true,
          reason:
            "Analisi metacognitiva consultiva in sola lettura autorizzata dal Meta-Cognitive Safety Guard.",
          sanitizedPayload: sanitized.sanitized,
          learningGuardDecision: learningDecision,
          timestamp: nowIso,
        };
      }

      return {
        allowed: true,
        failClosed: false,
        advisoryOnly: true,
        readOnly: true,
        reason:
          "Analisi metacognitiva consultiva in sola lettura autorizzata dal Meta-Cognitive Safety Guard.",
        learningGuardDecision: learningDecision,
        timestamp: nowIso,
      };
    }

    // Percorso senza dati di apprendimento: comunque validato contro payload/escalation
    if (input.payload !== undefined) {
      const sanitized = sanitizeLearningPayload(input.payload);
      if (!sanitized.ok) {
        return block(sanitized.reason, sanitized.blockedBy);
      }
      return {
        allowed: true,
        failClosed: false,
        advisoryOnly: true,
        readOnly: true,
        reason: "Analisi metacognitiva consultiva consentita senza accesso ai dati di apprendimento.",
        sanitizedPayload: sanitized.sanitized,
        timestamp: nowIso,
      };
    }

    return {
      allowed: true,
      failClosed: false,
      advisoryOnly: true,
      readOnly: true,
      reason: "Analisi metacognitiva consultiva consentita in sola lettura.",
      timestamp: nowIso,
    };
  } catch {
    return block(
      "Errore interno nel Meta-Cognitive Safety Guard: blocco fail-closed senza impatto su chat o voce.",
      "internal_error"
    );
  }
}
