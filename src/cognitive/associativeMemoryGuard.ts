import {
  isCrisisOrClinicalContent,
  isSafeForLongTermMemory,
  normalizeText,
  redactSensitiveTokens,
} from "../memory/privacyFilter";
import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import {
  evaluateLearningSafety,
  isValidConfidence,
  isValidEpistemicTag,
  isValidEvidenceType,
} from "./learningSafetyGuard";
import {
  ASSOCIATIVE_LIMITS,
  type AssociativeAccessDecision,
  type AssociativeAccessInput,
  type AssociativeAuditEntry,
  type AssociativeConsentScope,
  type AssociativeEdge,
  type AssociativeEdgeDirection,
  type AssociativeEdgeValidationResult,
  type AssociativeEdgeValidationStatus,
  type AssociativeGuardBlockReason,
  type AssociativeMemoryNode,
  type AssociativeNodeKind,
  type AssociativeNodeValidationResult,
  type AssociativeOperationType,
  type AssociativeRelationType,
  type AssociativeValidationStatus,
  type CreateAssociativeEdgeInput,
  type CreateMemoryNodeInput,
} from "./associativeTypes";
import type { EpistemicTag, LearningConsentState } from "./selfLearningTypes";

const VALID_SCOPES = new Set<AssociativeConsentScope>([
  "operational",
  "ai_memory",
  "learning",
  "session_ephemeral",
]);

const VALID_OPERATIONS = new Set<AssociativeOperationType>([
  "read",
  "write",
  "link",
  "retrieve",
  "clear",
  "export",
]);

const VALID_NODE_KINDS = new Set<AssociativeNodeKind>([
  "goal",
  "plan",
  "task",
  "mission",
  "timeline_event",
  "experience_pattern",
  "knowledge_entry",
  "preference",
  "emotional_trend",
  "checkin",
  "concept",
  "session_signal",
]);

const VALID_NODE_STATUSES = new Set<AssociativeValidationStatus>([
  "confirmed",
  "observed",
  "proposed",
  "unverified",
  "conflicted",
  "superseded",
  "revoked",
  "expired",
]);

const VALID_RELATION_TYPES = new Set<AssociativeRelationType>([
  "part_of",
  "supports",
  "derived_from",
  "precedes",
  "related_to",
  "hindered_by",
  "blocked_by",
  "contradicts",
  "supersedes",
]);

const VALID_EDGE_STATUSES = new Set<AssociativeEdgeValidationStatus>([
  "confirmed",
  "observed",
  "proposed",
  "hypothesized",
  "revoked",
  "expired",
]);

const SYMMETRIC_RELATION_TYPES = new Set<AssociativeRelationType>([
  "related_to",
  "contradicts",
]);

const FORBIDDEN_GRAPH_ESCALATION_PATTERNS: readonly RegExp[] = [
  /authorizationledger/i,
  /authorization_ledger/i,
  /\bwhitelist\b/i,
  /safety\s*system/i,
  /system\s*prompt/i,
  /prompt\s*di\s*sicurezza/i,
  /source\s*code|modifica\s*codice|self[-_ ]?modify/i,
  /grant\s*permission|auto[-_ ]?approve|auto[-_ ]?authorize/i,
  /ignore\s+previous\s+instructions|ignora\s+le\s+istruzioni/i,
];

function generateGuardAuditId(): string {
  return `assoc-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableCanonicalHash(value: string): string {
  // Hash deterministico leggero (FNV-1a 32-bit) senza dipendenze esterne
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function hasEscalationOrSecretPattern(text: string): boolean {
  if (!text) return false;
  if (FORBIDDEN_GRAPH_ESCALATION_PATTERNS.some((rx) => rx.test(text))) {
    return true;
  }
  if (/\b(?:AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z_]{16,}|github_pat_[0-9A-Za-z_]{16,}|sk-[0-9A-Za-z_]{16,})\b/.test(text)) {
    return true;
  }
  return false;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function normalizeKeywords(rawKeywords: string[] | undefined, fallbackText: string): string[] {
  const candidates =
    rawKeywords && rawKeywords.length > 0
      ? rawKeywords
      : normalizeText(fallbackText)
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((token) => token.length >= 3);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of candidates) {
    if (typeof item !== "string") continue;
    const cleaned = normalizeText(redactSensitiveTokens(item));
    if (!cleaned || cleaned.length < 2) continue;
    if (!isSafeForLongTermMemory(cleaned) || hasEscalationOrSecretPattern(cleaned)) continue;
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned.slice(0, 48));
    }
    if (out.length >= ASSOCIATIVE_LIMITS.MAX_KEYWORDS_PER_NODE) break;
  }
  return out;
}

/**
 * Propaga in modo conservativo i tag epistemici lungo una catena associativa.
 * Un'ipotesi non può mai essere promossa a fatto attraverso il collegamento con fatti.
 */
export function propagatePathEpistemicTag(tags: readonly EpistemicTag[]): EpistemicTag {
  if (tags.length === 0) return "ipotesi_da_verificare";
  if (tags.includes("ipotesi_da_verificare")) return "ipotesi_da_verificare";
  if (tags.includes("interpretazione_prudente")) return "interpretazione_prudente";
  return "fatto_osservato";
}

/**
 * Calcola l'affidabilità conservativa lungo un percorso associativo
 * senza mai superare il valore minimo degli elementi attraversati.
 */
export function propagatePathReliability(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let minVal = 1;
  for (const v of values) {
    if (!Number.isFinite(v)) return 0;
    const clamped = clampScore(v);
    if (clamped < minVal) minVal = clamped;
  }
  return minVal;
}

/**
 * Determina la partizione fisica di destinazione di un arco in base agli scope dei nodi:
 * - session_ephemeral resta sempre solo in RAM;
 * - qualsiasi arco che tocca ai_memory viene isolato nella partizione ai_memory
 *   così la revoca di AI Memory elimina immediatamente anche gli archi associativi residui;
 * - qualsiasi arco che tocca learning (senza ai_memory/session) resta nella partizione learning;
 * - archi tra soli nodi operational restano in operational.
 */
export function resolveEdgeStorageScope(
  sourceScope: AssociativeConsentScope,
  targetScope: AssociativeConsentScope
): AssociativeConsentScope {
  if (sourceScope === "session_ephemeral" || targetScope === "session_ephemeral") {
    return "session_ephemeral";
  }
  if (sourceScope === "ai_memory" || targetScope === "ai_memory") {
    return "ai_memory";
  }
  if (sourceScope === "learning" || targetScope === "learning") {
    return "learning";
  }
  return "operational";
}

function buildCanonicalEdgeKey(
  sourceNodeId: string,
  targetNodeId: string,
  relationType: AssociativeRelationType,
  direction: AssociativeEdgeDirection
): string {
  if (direction === "bidirectional" && SYMMETRIC_RELATION_TYPES.has(relationType)) {
    const [a, b] = [sourceNodeId, targetNodeId].sort();
    return `${a}::${relationType}::${b}`;
  }
  return `${sourceNodeId}::${relationType}::${targetNodeId}`;
}

function evaluateSingleScopeAccess(params: {
  operation: AssociativeOperationType;
  scope: AssociativeConsentScope;
  consentState: LearningConsentState;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  targetId?: string;
  nowIso: string;
}):
  | { ok: true; reason: string; learningDecision?: AssociativeAccessDecision["learningGuardDecision"] }
  | {
      ok: false;
      reason: string;
      blockedBy: AssociativeGuardBlockReason;
      learningDecision?: AssociativeAccessDecision["learningGuardDecision"];
    } {
  const { scope, operation, consentState } = params;

  if (scope !== "session_ephemeral" && params.storageAvailable === false) {
    return {
      ok: false,
      blockedBy: "storage_unavailable",
      reason: `Storage non disponibile per lo scope "${scope}": operazione bloccata (fail-closed).`,
    };
  }

  if (scope === "session_ephemeral") {
    if (operation === "export") {
      return {
        ok: false,
        blockedBy: "consent",
        reason: "La memoria session_ephemeral resta esclusivamente in RAM e non è esportabile.",
      };
    }
    return {
      ok: true,
      reason: "Accesso consentito alla memoria effimera di sessione (solo RAM).",
    };
  }

  if (scope === "operational") {
    if (operation === "clear" && consentState.explicitClearRequested !== true) {
      return {
        ok: false,
        blockedBy: "consent",
        reason:
          "La cancellazione dello scope operational richiede conferma esplicita (explicitClearRequested).",
      };
    }
    return {
      ok: true,
      reason:
        "Accesso consentito allo scope operativo separato dalla Memoria Personale AI e dal consenso evolutivo.",
    };
  }

  if (scope === "ai_memory") {
    if (operation === "clear") {
      if (consentState.explicitClearRequested === true) {
        return {
          ok: true,
          reason:
            "Cancellazione completa dello scope ai_memory e degli archi associativi residui autorizzata.",
        };
      }
      return {
        ok: false,
        blockedBy: "ai_memory_consent",
        reason:
          "Cancellazione dello scope ai_memory bloccata senza autorizzazione esplicita o revoca.",
      };
    }

    if (consentState.aiMemoryConsent !== true) {
      return {
        ok: false,
        blockedBy: "ai_memory_consent",
        reason:
          "Consenso AI Memory (aiMemoryConsent) disattivato o revocato: accesso a nodi e archi personali bloccato.",
      };
    }

    return {
      ok: true,
      reason: "Accesso allo scope ai_memory autorizzato (aiMemoryConsent ON).",
    };
  }

  // scope === "learning": delega obbligatoria a LearningSafetyGuard (Fase 9.1)
  const mappedLearningOp =
    operation === "clear"
      ? "clear"
      : operation === "read" || operation === "retrieve" || operation === "export"
        ? "read"
        : "write";

  const learningDecision = evaluateLearningSafety({
    operation: mappedLearningOp,
    consentState,
    crisisBlocked: params.crisisBlocked,
    userTextForSafetyCheck: params.userTextForSafetyCheck,
    storageAvailable: params.storageAvailable,
    corruptedDataDetected: params.corruptedDataDetected,
    payload:
      mappedLearningOp === "write"
        ? {
            stage: "analysis",
            evidenceType: "observed_behavior",
            epistemicTag: "interpretazione_prudente",
            confidence: 0.7,
            dataSource: "ExperienceGraph",
            timestamp: params.nowIso,
            uncertaintyNote: "Controllo accesso associativo per scope learning.",
            summary: `Operazione grafo associativo: ${operation}`,
            targetSubsystem: "associative_memory",
          }
        : undefined,
    nowIso: params.nowIso,
  });

  if (!learningDecision.allowed) {
    return {
      ok: false,
      blockedBy: learningDecision.blockedBy ?? "consent",
      reason: learningDecision.reason,
      learningDecision,
    };
  }

  return {
    ok: true,
    reason: learningDecision.reason,
    learningDecision,
  };
}

/**
 * Associative Memory Guard V1 (Fase 11.2.1) — Deterministico e fail-closed.
 * Verifica Safety System, integrità dati, separazione rigorosa tra:
 * - operational (sempre locale, indipendente dai consensi AI Memory e Learning),
 * - ai_memory (governato esclusivamente da aiMemoryConsent),
 * - learning (governato esclusivamente da learningConsent via LearningSafetyGuard),
 * - session_ephemeral (solo RAM, mai persistito).
 */
export function evaluateAssociativeAccess(
  input: AssociativeAccessInput
): AssociativeAccessDecision {
  const nowIso = input?.nowIso ?? new Date().toISOString();
  const safeScope: AssociativeConsentScope =
    input && VALID_SCOPES.has(input.scope) ? input.scope : "operational";
  const safeOp: AssociativeOperationType =
    input && VALID_OPERATIONS.has(input.operation) ? input.operation : "read";

  const makeDecision = (
    allowed: boolean,
    reason: string,
    blockedBy?: AssociativeGuardBlockReason,
    extras?: {
      safetyCheck?: AssociativeAccessDecision["safetyCheck"];
      learningGuardDecision?: AssociativeAccessDecision["learningGuardDecision"];
    }
  ): AssociativeAccessDecision => {
    const auditEntry: AssociativeAuditEntry = {
      id: generateGuardAuditId(),
      timestamp: nowIso,
      operation: safeOp,
      scope: safeScope,
      secondaryScope: input?.secondaryScope,
      allowed,
      blockedBy,
      reason,
      targetId: input?.targetId,
    };
    return {
      allowed,
      failClosed: !allowed,
      scope: safeScope,
      secondaryScope: input?.secondaryScope,
      reason,
      blockedBy,
      safetyCheck: extras?.safetyCheck,
      learningGuardDecision: extras?.learningGuardDecision,
      auditEntry,
    };
  };

  try {
    if (!input || !input.consentState || typeof input.consentState !== "object") {
      return makeDecision(
        false,
        "Input o stato dei consensi mancante: accesso al grafo associativo bloccato (fail-closed).",
        "corrupted_data"
      );
    }

    if (!VALID_OPERATIONS.has(input.operation) || !VALID_SCOPES.has(input.scope)) {
      return makeDecision(
        false,
        "Operazione o scope associativo non valido (fail-closed).",
        "invalid_payload"
      );
    }

    if (input.secondaryScope !== undefined && !VALID_SCOPES.has(input.secondaryScope)) {
      return makeDecision(
        false,
        "Scope secondario associativo non valido (fail-closed).",
        "invalid_payload"
      );
    }

    if (
      typeof input.consentState.learningConsent !== "boolean" ||
      typeof input.consentState.aiMemoryConsent !== "boolean"
    ) {
      return makeDecision(
        false,
        "Stato dei consensi non valido o corrotto (attesi booleani espliciti): accesso bloccato (fail-closed).",
        "corrupted_data"
      );
    }

    // 1. Safety System sempre prioritario
    const safetyCheck = input.userTextForSafetyCheck
      ? evaluateCognitiveSafety(input.userTextForSafetyCheck, input.crisisBlocked)
      : evaluateCognitiveSafety("", input.crisisBlocked);

    if (input.crisisBlocked || !safetyCheck.safe || safetyCheck.crisisDetected) {
      return makeDecision(
        false,
        "Condizione di crisi attiva: il Safety System blocca immediatamente ogni accesso al grafo associativo.",
        "crisis",
        { safetyCheck }
      );
    }

    if (
      input.userTextForSafetyCheck &&
      isCrisisOrClinicalContent(input.userTextForSafetyCheck)
    ) {
      return makeDecision(
        false,
        "Contenuto clinico, di crisi o dato personale sensibile rilevato: accesso associativo bloccato.",
        "clinical_or_pii_content",
        { safetyCheck }
      );
    }

    // 2. Dati corrotti -> fail-closed
    if (input.corruptedDataDetected === true) {
      return makeDecision(
        false,
        "Dati del grafo corrotti o non verificabili: accesso bloccato (fail-closed).",
        "corrupted_data",
        { safetyCheck }
      );
    }

    // 3. Regola epistemica anti-promozione
    if (
      input.requestedConfirmation === true &&
      (input.epistemicTag === "ipotesi_da_verificare" ||
        input.evidenceType !== "explicit_feedback")
    ) {
      return makeDecision(
        false,
        "Impossibile promuovere automaticamente un'ipotesi a fatto confermato senza feedback esplicito.",
        "hypothesis_promotion_forbidden",
        { safetyCheck }
      );
    }

    // 4. Verifica scope primario
    const primaryRes = evaluateSingleScopeAccess({
      operation: safeOp,
      scope: safeScope,
      consentState: input.consentState,
      crisisBlocked: input.crisisBlocked,
      userTextForSafetyCheck: input.userTextForSafetyCheck,
      storageAvailable: input.storageAvailable,
      corruptedDataDetected: input.corruptedDataDetected,
      targetId: input.targetId,
      nowIso,
    });

    if (!primaryRes.ok) {
      return makeDecision(false, primaryRes.reason, primaryRes.blockedBy, {
        safetyCheck,
        learningGuardDecision: primaryRes.learningDecision,
      });
    }

    // 5. Verifica scope secondario (prevenzione bypass tra domini su archi associativi)
    if (input.secondaryScope && input.secondaryScope !== safeScope) {
      const secondaryRes = evaluateSingleScopeAccess({
        operation: safeOp,
        scope: input.secondaryScope,
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck,
        storageAvailable: input.storageAvailable,
        corruptedDataDetected: input.corruptedDataDetected,
        targetId: input.targetId,
        nowIso,
      });

      if (!secondaryRes.ok) {
        return makeDecision(
          false,
          `Accesso cross-scope negato tra "${safeScope}" e "${input.secondaryScope}": ${secondaryRes.reason}`,
          "cross_scope_denied",
          {
            safetyCheck,
            learningGuardDecision:
              secondaryRes.learningDecision ?? primaryRes.learningDecision,
          }
        );
      }
    }

    return makeDecision(true, primaryRes.reason, undefined, {
      safetyCheck,
      learningGuardDecision: primaryRes.learningDecision,
    });
  } catch {
    return makeDecision(
      false,
      "Errore interno nell'Associative Memory Guard: operazione bloccata in modalità fail-closed.",
      "internal_error"
    );
  }
}

/**
 * Valida, sanitizza e normalizza un nodo del grafo prima di qualsiasi inserimento in RAM o partizione.
 * Applica privacyFilter, Safety Gate e blocco di promozione ipotesi -> fatto.
 */
export function validateAndSanitizeMemoryNode(
  input: CreateMemoryNodeInput,
  consentState: LearningConsentState,
  options?: {
    crisisBlocked?: boolean;
    storageAvailable?: boolean;
    corruptedDataDetected?: boolean;
    nowIso?: string;
  }
): AssociativeNodeValidationResult {
  const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();

  const accessDecision = evaluateAssociativeAccess({
    operation: "write",
    scope: input?.consentScope as AssociativeConsentScope,
    consentState,
    crisisBlocked: options?.crisisBlocked,
    userTextForSafetyCheck: `${input?.label ?? ""} ${input?.summary ?? ""}`.trim(),
    storageAvailable: options?.storageAvailable,
    corruptedDataDetected: options?.corruptedDataDetected,
    targetId: input?.id,
    nowIso,
  });

  if (!accessDecision.allowed) {
    return {
      allowed: false,
      failClosed: true,
      reason: accessDecision.reason,
      blockedBy: accessDecision.blockedBy,
      decision: accessDecision,
    };
  }

  if (!input || typeof input !== "object") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Input del nodo di memoria mancante o corrotto.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!VALID_NODE_KINDS.has(input.kind)) {
    return {
      allowed: false,
      failClosed: true,
      reason: `Tipo di nodo associativo non valido: "${String(input.kind)}".`,
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!VALID_NODE_STATUSES.has(input.validationStatus)) {
    return {
      allowed: false,
      failClosed: true,
      reason: `Stato di validazione nodo non valido: "${String(input.validationStatus)}".`,
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!input.provenance || typeof input.provenance !== "object") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Provenienza del nodo obbligatoria e mancante.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (
    !input.provenance.sourceEngine?.trim() ||
    !isValidEvidenceType(input.provenance.evidenceType) ||
    !isValidEpistemicTag(input.provenance.epistemicTag)
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Metadati di provenienza non validi (sourceEngine, evidenceType o epistemicTag).",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!isValidConfidence(input.reliability)) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Affidabilità (reliability) non valida: atteso numero finito tra 0 e 1.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  // Divieto di promozione automatica o creazione di ipotesi marcate come fatti/conferme
  if (
    (input.provenance.evidenceType === "hypothesis" ||
      input.provenance.epistemicTag === "ipotesi_da_verificare") &&
    (input.validationStatus === "confirmed" || input.validationStatus === "observed")
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Un'ipotesi non può essere registrata come fatto osservato o confermato senza validazione esplicita.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  if (
    input.provenance.evidenceType === "hypothesis" &&
    input.provenance.epistemicTag === "fatto_osservato"
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Incongruenza epistemica: un'evidenza di tipo hypothesis non può avere tag fatto_osservato.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  if (input.validationStatus === "confirmed" && input.provenance.evidenceType !== "explicit_feedback") {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Lo stato confirmed richiede provenienza explicit_feedback.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
  const rawSummary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!rawLabel || !rawSummary) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Campi obbligatori del nodo mancanti (label o summary).",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (
    hasEscalationOrSecretPattern(rawLabel) ||
    hasEscalationOrSecretPattern(rawSummary) ||
    hasEscalationOrSecretPattern(input.provenance.note ?? "")
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Rilevato tentativo di escalation, prompt injection o potenziale segreto nel nodo associativo.",
      blockedBy: "escalation",
      decision: accessDecision,
    };
  }

  if (
    !isSafeForLongTermMemory(rawLabel) ||
    !isSafeForLongTermMemory(rawSummary) ||
    (input.provenance.note && !isSafeForLongTermMemory(input.provenance.note))
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Contenuto clinico, di crisi o dato personale sensibile rifiutato nel nodo associativo.",
      blockedBy: "clinical_or_pii_content",
      decision: accessDecision,
    };
  }

  const cleanLabel = redactSensitiveTokens(rawLabel).slice(
    0,
    ASSOCIATIVE_LIMITS.MAX_LABEL_LENGTH
  );
  const cleanSummary = redactSensitiveTokens(rawSummary).slice(
    0,
    ASSOCIATIVE_LIMITS.MAX_SUMMARY_LENGTH
  );

  if (!cleanLabel || !cleanSummary) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Il contenuto sanitizzato del nodo risulta vuoto.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  const observedAt =
    input.observedAt && !Number.isNaN(Date.parse(input.observedAt))
      ? input.observedAt
      : nowIso;
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Timestamp expiresAt non valido.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  const canonicalSource = input.canonicalKey?.trim()
    ? normalizeText(input.canonicalKey)
    : `${input.consentScope}:${input.kind}:${input.provenance.sourceRecordId?.trim() || normalizeText(cleanLabel)}`;
  const id =
    input.id?.trim() ||
    `node-${input.consentScope}-${input.kind}-${stableCanonicalHash(canonicalSource)}`;

  const sanitizedNode: AssociativeMemoryNode = {
    id,
    canonicalKey: canonicalSource,
    kind: input.kind,
    label: cleanLabel,
    summary: cleanSummary,
    keywords: normalizeKeywords(input.keywords, `${cleanLabel} ${cleanSummary}`),
    consentScope: input.consentScope,
    provenance: {
      sourceEngine: input.provenance.sourceEngine.trim().slice(0, 64),
      sourceRecordId: input.provenance.sourceRecordId?.trim().slice(0, 80),
      evidenceType: input.provenance.evidenceType,
      epistemicTag: input.provenance.epistemicTag,
      note: input.provenance.note
        ? redactSensitiveTokens(input.provenance.note).slice(0, ASSOCIATIVE_LIMITS.MAX_NOTE_LENGTH)
        : undefined,
    },
    reliability: clampScore(input.reliability),
    validationStatus: input.validationStatus,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    observedAt,
    expiresAt: input.expiresAt,
    conflictWithNodeIds: input.conflictWithNodeIds
      ? Array.from(new Set(input.conflictWithNodeIds.map((x) => x.trim()).filter(Boolean)))
      : undefined,
    supersededByNodeId: input.supersededByNodeId?.trim() || undefined,
  };

  return {
    allowed: true,
    failClosed: false,
    reason: "Nodo associativo validato e sanitizzato con successo.",
    sanitizedNode,
    decision: accessDecision,
  };
}

/**
 * Valida, sanitizza e verifica i consensi su entrambi i nodi di una relazione associativa.
 */
export function validateAndSanitizeAssociativeEdge(
  input: CreateAssociativeEdgeInput,
  consentState: LearningConsentState,
  options?: {
    crisisBlocked?: boolean;
    storageAvailable?: boolean;
    corruptedDataDetected?: boolean;
    nowIso?: string;
  }
): AssociativeEdgeValidationResult {
  const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();

  const accessDecision = evaluateAssociativeAccess({
    operation: "link",
    scope: input?.sourceScope as AssociativeConsentScope,
    secondaryScope: input?.targetScope as AssociativeConsentScope,
    consentState,
    crisisBlocked: options?.crisisBlocked,
    userTextForSafetyCheck: input?.provenance?.supportingNote,
    storageAvailable: options?.storageAvailable,
    corruptedDataDetected: options?.corruptedDataDetected,
    targetId: input?.id,
    nowIso,
  });

  if (!accessDecision.allowed) {
    return {
      allowed: false,
      failClosed: true,
      reason: accessDecision.reason,
      blockedBy: accessDecision.blockedBy,
      decision: accessDecision,
    };
  }

  if (!input || typeof input !== "object") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Input della relazione associativa mancante o corrotto.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  const sourceNodeId = input.sourceNodeId?.trim();
  const targetNodeId = input.targetNodeId?.trim();
  if (!sourceNodeId || !targetNodeId) {
    return {
      allowed: false,
      failClosed: true,
      reason: "sourceNodeId e targetNodeId sono obbligatori.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (sourceNodeId === targetNodeId) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Auto-collegamento (self-loop) su singolo nodo non consentito.",
      blockedBy: "cycle_or_depth_exceeded",
      decision: accessDecision,
    };
  }

  if (!VALID_RELATION_TYPES.has(input.relationType)) {
    return {
      allowed: false,
      failClosed: true,
      reason: `Tipologia di relazione non valida: "${String(input.relationType)}".`,
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!VALID_EDGE_STATUSES.has(input.validationStatus)) {
    return {
      allowed: false,
      failClosed: true,
      reason: `Stato di validazione della relazione non valido: "${String(input.validationStatus)}".`,
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  const direction: AssociativeEdgeDirection = input.direction ?? "directed";
  if (direction !== "directed" && direction !== "bidirectional") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Direzione della relazione non valida (atteso directed o bidirectional).",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (!isValidConfidence(input.weight)) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Peso della relazione non valido: atteso numero finito tra 0 e 1.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  const prov = input.provenance;
  if (
    !prov ||
    !prov.createdByEngine?.trim() ||
    !isValidEvidenceType(prov.evidenceType) ||
    !isValidEpistemicTag(prov.epistemicTag) ||
    !prov.supportingNote?.trim() ||
    !Array.isArray(prov.supportingEvidenceIds)
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Metadati di provenienza ed evidenze dell'arco incompleti o non validi.",
      blockedBy: "invalid_payload",
      decision: accessDecision,
    };
  }

  if (
    (prov.evidenceType === "hypothesis" || prov.epistemicTag === "ipotesi_da_verificare") &&
    (input.validationStatus === "confirmed" || input.validationStatus === "observed")
  ) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Un'associazione ipotetica non può essere registrata come confirmed o observed.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  if (prov.evidenceType === "hypothesis" && prov.epistemicTag === "fatto_osservato") {
    return {
      allowed: false,
      failClosed: true,
      reason:
        "Incongruenza epistemica nell'arco: hypothesis non può avere tag fatto_osservato.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  if (input.validationStatus === "confirmed" && prov.evidenceType !== "explicit_feedback") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Una relazione confirmed richiede provenienza explicit_feedback.",
      blockedBy: "hypothesis_promotion_forbidden",
      decision: accessDecision,
    };
  }

  const rawNote = prov.supportingNote.trim();
  if (hasEscalationOrSecretPattern(rawNote)) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Rilevato tentativo di escalation o potenziale segreto nella nota dell'arco.",
      blockedBy: "escalation",
      decision: accessDecision,
    };
  }
  if (!isSafeForLongTermMemory(rawNote)) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Contenuto clinico, di crisi o sensibile rifiutato nella nota dell'arco.",
      blockedBy: "clinical_or_pii_content",
      decision: accessDecision,
    };
  }

  const cleanNote = redactSensitiveTokens(rawNote).slice(
    0,
    ASSOCIATIVE_LIMITS.MAX_NOTE_LENGTH
  );
  const canonicalKey = buildCanonicalEdgeKey(
    sourceNodeId,
    targetNodeId,
    input.relationType,
    direction
  );
  const storageScope = resolveEdgeStorageScope(input.sourceScope, input.targetScope);
  const id = input.id?.trim() || `edge-${stableCanonicalHash(canonicalKey)}`;

  const sanitizedEdge: AssociativeEdge = {
    id,
    canonicalKey,
    sourceNodeId,
    targetNodeId,
    sourceScope: input.sourceScope,
    targetScope: input.targetScope,
    storageScope,
    relationType: input.relationType,
    direction,
    provenance: {
      createdByEngine: prov.createdByEngine.trim().slice(0, 64),
      evidenceType: prov.evidenceType,
      epistemicTag: prov.epistemicTag,
      supportingEvidenceIds: Array.from(
        new Set(prov.supportingEvidenceIds.map((x) => x.trim()).filter(Boolean))
      ).slice(0, 20),
      supportingNote: cleanNote,
    },
    weight: clampScore(input.weight),
    validationStatus: input.validationStatus,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  return {
    allowed: true,
    failClosed: false,
    reason: "Relazione associativa validata e sanitizzata con successo.",
    sanitizedEdge,
    decision: accessDecision,
  };
}
