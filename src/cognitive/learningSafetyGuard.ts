import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import type {
  CognitiveImprovementStage,
  EpistemicTag,
  EvidenceType,
  LearningAuditEvent,
  LearningGuardBlockReason,
  LearningGuardDecision,
  LearningPayload,
  LearningSafetyInput,
} from "./selfLearningTypes";

const VALID_EVIDENCE_TYPES = new Set<EvidenceType>([
  "explicit_feedback",
  "observed_behavior",
  "hypothesis",
]);

const VALID_EPISTEMIC_TAGS = new Set<EpistemicTag>([
  "fatto_osservato",
  "interpretazione_prudente",
  "ipotesi_da_verificare",
]);

const VALID_STAGES = new Set<CognitiveImprovementStage>([
  "observation",
  "analysis",
  "proposal",
  "approval",
  "verification",
]);

const FORBIDDEN_ESCALATION_PATTERNS = [
  /authorizationledger/i,
  /authorization_ledger/i,
  /\bwhitelist\b/i,
  /safety\s*system/i,
  /system\s*prompt/i,
  /prompt\s*di\s*sicurezza/i,
  /source\s*code|modifica\s*codice|self[-_ ]?modify/i,
  /grant\s*permission|auto[-_ ]?approve|auto[-_ ]?authorize/i,
  /background\s*job|hidden\s*timer/i,
  /send\s*to\s*gemini|invio\s*automatico/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email
  /\b(?:\+?\d[\d\s-]{8,}\d)\b/, // telefono / carta
  /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/i, // IBAN
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Gemini API key
  /\b(?:ghp_|github_pat_|sk-)[0-9A-Za-z_]{16,}\b/, // token segreti
  /\b(?:password|passphrase|pin\s*bancario|codice\s*fiscale)\b/i,
  /\b(?:diagnosi|psicofarmac\w*|antidepressiv\w*|terapia\s+clinica|disturbo\s+bipolare|schizofrenia)\b/i,
];

function generateAuditId(): string {
  return `learn-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isValidEpistemicTag(value: unknown): value is EpistemicTag {
  return typeof value === "string" && VALID_EPISTEMIC_TAGS.has(value as EpistemicTag);
}

export function isValidEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && VALID_EVIDENCE_TYPES.has(value as EvidenceType);
}

export function isValidImprovementStage(value: unknown): value is CognitiveImprovementStage {
  return typeof value === "string" && VALID_STAGES.has(value as CognitiveImprovementStage);
}

function detectEscalationAttempt(payload: LearningPayload): boolean {
  const fieldsToInspect = [
    payload.summary,
    payload.dataSource,
    payload.uncertaintyNote,
    payload.targetSubsystem ?? "",
    ...Object.entries(payload.metadata ?? {}).flatMap(([k, v]) => [k, String(v)]),
  ];
  return fieldsToInspect.some((text) =>
    FORBIDDEN_ESCALATION_PATTERNS.some((rx) => rx.test(text))
  );
}

function detectSensitiveContent(payload: LearningPayload): boolean {
  const fieldsToInspect = [
    payload.summary,
    payload.dataSource,
    payload.uncertaintyNote,
    ...Object.values(payload.metadata ?? {}).map((v) => String(v)),
  ];
  return fieldsToInspect.some((text) =>
    SENSITIVE_CONTENT_PATTERNS.some((rx) => rx.test(text))
  );
}

export function sanitizeLearningPayload(
  payload: LearningPayload | undefined | null
):
  | { ok: true; sanitized: LearningPayload }
  | { ok: false; reason: string; blockedBy: LearningGuardBlockReason } {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "Payload di apprendimento mancante o corrotto.",
      blockedBy: "invalid_payload",
    };
  }

  if (!isValidImprovementStage(payload.stage)) {
    return {
      ok: false,
      reason: "Fase del Cognitive Improvement Loop non valida.",
      blockedBy: "invalid_payload",
    };
  }
  if (!isValidEvidenceType(payload.evidenceType)) {
    return {
      ok: false,
      reason: "Tipo di evidenza non valido (atteso explicit_feedback, observed_behavior o hypothesis).",
      blockedBy: "invalid_payload",
    };
  }
  if (!isValidEpistemicTag(payload.epistemicTag)) {
    return {
      ok: false,
      reason: "Tag epistemico non valido.",
      blockedBy: "invalid_payload",
    };
  }
  if (!isValidConfidence(payload.confidence)) {
    return {
      ok: false,
      reason: "Valore confidence non valido: deve essere un numero finito compreso tra 0 e 1.",
      blockedBy: "invalid_payload",
    };
  }
  if (!payload.dataSource?.trim() || !payload.summary?.trim() || !payload.uncertaintyNote?.trim()) {
    return {
      ok: false,
      reason: "Campi obbligatori mancanti (dataSource, summary o uncertaintyNote).",
      blockedBy: "invalid_payload",
    };
  }
  if (!payload.timestamp || Number.isNaN(Date.parse(payload.timestamp))) {
    return {
      ok: false,
      reason: "Timestamp del payload mancante o non valido.",
      blockedBy: "invalid_payload",
    };
  }

  // Protezione da escalation dei permessi e auto-modifiche
  if (detectEscalationAttempt(payload)) {
    return {
      ok: false,
      reason:
        "Tentativo di escalation o modifica di sottosistemi protetti (codice, Safety System, AuthorizationLedger, whitelist o prompt) bloccato.",
      blockedBy: "escalation",
    };
  }

  // Rifiuto contenuti sensibili, PII non necessari o contenuti clinici
  if (detectSensitiveContent(payload)) {
    return {
      ok: false,
      reason:
        "Contenuto sensibile, dato personale non necessario o riferimento clinico rilevato e rifiutato.",
      blockedBy: "sensitive_content",
    };
  }

  // Verifica Safety System anche sul testo del summary
  const safety = evaluateCognitiveSafety(payload.summary);
  if (!safety.safe || safety.crisisDetected) {
    return {
      ok: false,
      reason: "Contenuto di crisi rilevato nel payload: apprendimento bloccato dal Safety System.",
      blockedBy: "crisis",
    };
  }

  const sanitizedMetadata: Record<string, string | number | boolean> = {};
  if (payload.metadata) {
    for (const [key, val] of Object.entries(payload.metadata)) {
      const cleanKey = key.trim().slice(0, 48);
      if (!cleanKey) continue;
      if (typeof val === "string") {
        sanitizedMetadata[cleanKey] = val.trim().slice(0, 160);
      } else if (typeof val === "number" && Number.isFinite(val)) {
        sanitizedMetadata[cleanKey] = val;
      } else if (typeof val === "boolean") {
        sanitizedMetadata[cleanKey] = val;
      }
    }
  }

  return {
    ok: true,
    sanitized: {
      stage: payload.stage,
      evidenceType: payload.evidenceType,
      epistemicTag: payload.epistemicTag,
      confidence: Math.round(payload.confidence * 100) / 100,
      dataSource: payload.dataSource.trim().slice(0, 120),
      timestamp: payload.timestamp,
      uncertaintyNote: payload.uncertaintyNote.trim().slice(0, 240),
      summary: payload.summary.trim().slice(0, 320),
      targetSubsystem: payload.targetSubsystem?.trim().slice(0, 64),
      userExplicitApproval: payload.userExplicitApproval === true,
      metadata: Object.keys(sanitizedMetadata).length > 0 ? sanitizedMetadata : undefined,
    },
  };
}

/**
 * Learning Safety Guard V1 — Fail-closed.
 * Controlla priorità Safety System, consenso dedicato learningConsent (indipendente da AI Memory),
 * regola del silenzio, integrità storage/dati, contenuti sensibili ed escalation di permessi.
 */
export function evaluateLearningSafety(
  input: LearningSafetyInput
): LearningGuardDecision {
  const nowIso = input?.nowIso ?? new Date().toISOString();

  const makeDecision = (
    allowed: boolean,
    reason: string,
    blockedBy?: LearningGuardBlockReason,
    sanitizedPayload?: LearningPayload
  ): LearningGuardDecision => {
    const auditEvent: LearningAuditEvent = {
      id: generateAuditId(),
      timestamp: nowIso,
      operation: input?.operation ?? "read",
      stage: input?.payload?.stage,
      allowed,
      reason,
      blockedBy,
      dataSource: input?.payload?.dataSource,
    };
    return {
      allowed,
      failClosed: !allowed,
      reason,
      blockedBy,
      sanitizedPayload,
      auditEvent,
    };
  };

  try {
    if (!input || !input.consentState) {
      return makeDecision(
        false,
        "Input o stato del consenso mancante: accesso bloccato (fail-closed).",
        "corrupted_data"
      );
    }

    // 1. Safety System sempre prioritario
    const textSafety = input.userTextForSafetyCheck
      ? evaluateCognitiveSafety(input.userTextForSafetyCheck)
      : { safe: true, crisisDetected: false };
    if (input.crisisBlocked || !textSafety.safe || textSafety.crisisDetected) {
      return makeDecision(
        false,
        "Condizione di crisi attiva: il Safety System blocca immediatamente ogni operazione di apprendimento.",
        "crisis"
      );
    }

    // 2. Storage indisponibile o dati corrotti -> fail-closed
    if (input.storageAvailable === false) {
      return makeDecision(
        false,
        "Storage locale non disponibile: operazione di apprendimento bloccata senza interrompere l'app.",
        "storage_unavailable"
      );
    }
    if (input.corruptedDataDetected === true) {
      return makeDecision(
        false,
        "Dati di apprendimento corrotti o non verificabili: accesso bloccato (fail-closed).",
        "corrupted_data"
      );
    }

    // 3. Procedura esplicita di cancellazione autorizzabile anche dopo revoca del consenso
    if (input.operation === "clear") {
      if (input.consentState.explicitClearRequested === true) {
        return makeDecision(
          true,
          "Procedura esplicita di cancellazione dei dati appresi autorizzata separatamente (AI Memory e dati operativi restano intatti)."
        );
      }
      return makeDecision(
        false,
        "Cancellazione bloccata: è richiesta conferma esplicita dedicata (explicitClearRequested).",
        "consent"
      );
    }

    // 4. Controllo consenso dedicato learningConsent (indipendente da aiMemoryConsent)
    if (input.consentState.learningConsent !== true) {
      return makeDecision(
        false,
        "Consenso all'apprendimento (learningConsent) disattivato o revocato: bloccata ogni lettura e scrittura.",
        "consent"
      );
    }

    // 5. Operazione di sola lettura con consenso ON
    if (input.operation === "read") {
      return makeDecision(
        true,
        "Lettura dei dati di apprendimento consentita (learningConsent ON, indipendente da AI Memory)."
      );
    }

    // 6. Validazione e sanitizzazione payload per write / propose / approve
    const sanitized = sanitizeLearningPayload(input.payload);
    if (!sanitized.ok) {
      return makeDecision(false, sanitized.reason, sanitized.blockedBy);
    }

    // 7. Regola del silenzio: nessuna proposta può essere approvata automaticamente
    if (input.operation === "approve") {
      if (
        sanitized.sanitized.userExplicitApproval !== true ||
        sanitized.sanitized.evidenceType !== "explicit_feedback"
      ) {
        return makeDecision(
          false,
          "Il silenzio dell'utente non equivale a consenso: approvazione bloccata senza feedback esplicito.",
          "silence"
        );
      }
    }

    return makeDecision(
      true,
      "Operazione di apprendimento verificata e consentita dal Learning Safety Guard.",
      undefined,
      sanitized.sanitized
    );
  } catch {
    return makeDecision(
      false,
      "Errore interno nel Learning Safety Guard: operazione bloccata in modalità fail-closed.",
      "internal_error"
    );
  }
}
