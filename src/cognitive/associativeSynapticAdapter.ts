import {
  isSafeForLongTermMemory,
  normalizeText,
  redactSensitiveTokens,
} from "../memory/privacyFilter";
import { evaluateAssociativeAccess } from "./associativeMemoryGuard";
import type {
  AssociativeEpistemicCategory,
  AssociativeRankedItem,
  AssociativeRetrievalDetailedResult,
  AssociativeRetrievalEngine,
  AssociativeRetrievalExplanation,
} from "./associativeRetrievalEngine";
import {
  ASSOCIATIVE_LIMITS,
  type AssociativeConsentScope,
  type AssociativeEdge,
  type AssociativeGuardBlockReason,
  type AssociativeNodeKind,
  type AssociativeNodeProvenance,
  type AssociativeRelationType,
  type AssociativeRetrievalInput,
  type AssociativeValidationStatus,
} from "./associativeTypes";
import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
} from "./selfLearningTypes";
import type { SynapticEngine } from "./synapticEngine";
import type {
  CognitiveEngineDescriptor,
  CognitiveEvent,
  CognitiveEventPriority,
  SynapticCoordinationResult,
  SynapticRoutingOptions,
} from "./synapticTypes";

export const ASSOCIATIVE_SYNAPTIC_ENGINE_ID = "associative_retrieval_engine" as const;

export const ASSOCIATIVE_SYNAPTIC_EVENTS = {
  RETRIEVE: "cognitive.associative.retrieve",
  CONTEXT_REQUESTED: "cognitive.context.requested",
} as const;

export const DEFAULT_ASSOCIATIVE_ADAPTER_TIMEOUT_MS = 250;
export const MAX_ASSOCIATIVE_ADAPTER_TIMEOUT_MS = 1500;
export const DEFAULT_MIN_ASSOCIATIVE_FINAL_SCORE = 0.2;
export const MAX_ASSOCIATIVE_CONTEXT_ITEMS = 8;

const ALL_ASSOCIATIVE_SCOPES: readonly AssociativeConsentScope[] = [
  "operational",
  "ai_memory",
  "learning",
  "session_ephemeral",
];

const INACTIVE_NODE_STATUSES: ReadonlySet<AssociativeValidationStatus> = new Set([
  "revoked",
  "expired",
  "superseded",
]);

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignora\s+(?:tutte\s+)?le\s+istruzioni(?:\s+precedenti)?|ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+previous\s+instructions|override\s+system)\b/gi,
  /\b(system\s+prompt|developer\s+prompt|you\s+are\s+now\s+in\s+developer\s+mode|jailbreak)\b/gi,
];

export interface AssociativeAdapterConsentInput {
  aiMemoryConsent?: boolean;
  learningConsent?: boolean;
}

export interface AssociativeConversationRequest {
  userMessage: string;
  historyTexts?: readonly string[];
  consentState?: AssociativeAdapterConsentInput;
  /**
   * Decisione esplicita Fase 11.2.4: default = false.
   * La partizione operational NON viene recuperata automaticamente quando AI Memory è OFF,
   * ma solo con opt-in separato ed esplicito.
   */
  allowOperationalInNoConsentMode?: boolean;
  /** Default = true (RAM-only, mai persistita). */
  includeSessionEphemeral?: boolean;
  requestedScopes?: readonly AssociativeConsentScope[];
  seedNodeIds?: readonly string[];
  preferredKinds?: readonly AssociativeNodeKind[];
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeHypotheses?: boolean;
  minFinalScore?: number;
  crisisBlocked?: boolean;
  nowIso?: string;
  correlationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AssociativeContextItem {
  nodeId: string;
  canonicalKey: string;
  sourceRecordId?: string;
  kind: AssociativeNodeKind;
  label: string;
  summary: string;
  scope: AssociativeConsentScope;
  epistemicCategory: AssociativeEpistemicCategory;
  epistemicTag: EpistemicTag;
  validationStatus: AssociativeValidationStatus;
  reliability: Confidence;
  finalScore: number;
  hopDistance: number;
  relations: AssociativeRelationType[];
  pathNodeIds: string[];
  pathEdgeIds: string[];
  seedNodeId: string;
  seedNodeLabel: string;
  provenance: AssociativeNodeProvenance;
  conflictWithNodeIds?: string[];
  explanationSummary: string;
  uncertain: boolean;
  observedAt: string;
}

export type AssociativeBundleBlockReason =
  | AssociativeGuardBlockReason
  | "timeout"
  | "aborted"
  | "loop_or_duplicate"
  | "mutation_forbidden";

export interface AssociativeContextBundle {
  allowed: boolean;
  failClosed: boolean;
  safetyBlocked: boolean;
  insufficientSignal: boolean;
  timedOut: boolean;
  aborted: boolean;
  reason: string;
  blockedBy?: AssociativeBundleBlockReason;
  retrievedAt: string;
  correlationId?: string;
  consentState: LearningConsentState;
  allowOperationalInNoConsentMode: boolean;
  authorizedScopes: AssociativeConsentScope[];
  excludedScopes: AssociativeConsentScope[];
  effectiveMaxHops: number;
  items: AssociativeContextItem[];
  explanations: AssociativeRetrievalExplanation[];
  edges: AssociativeEdge[];
  latencyMs: number;
  rawResult?: AssociativeRetrievalDetailedResult;
}

export interface BuiltAssociativeRetrievalInput {
  valid: boolean;
  reason: string;
  retrievalInput: AssociativeRetrievalInput;
  consentState: LearningConsentState;
  allowOperationalInNoConsentMode: boolean;
  authorizedScopes: AssociativeConsentScope[];
  excludedScopes: AssociativeConsentScope[];
  effectiveMaxHops: number;
  maxNodes: number;
  maxEdges: number;
  minFinalScore: number;
  preferredKinds?: AssociativeNodeKind[];
  timeoutMs: number;
}

export interface RegisterAssociativeSynapticEngineDeps {
  retrievalEngine: AssociativeRetrievalEngine;
  defaultConsentState?: AssociativeAdapterConsentInput;
  defaultAllowOperationalInNoConsentMode?: boolean;
  timeoutMs?: number;
}

export interface AssociativeSynapticDispatchOptions {
  parentEvent?: CognitiveEvent<unknown>;
  priority?: CognitiveEventPriority;
  routingOptions?: SynapticRoutingOptions;
}

export interface AssociativeSynapticDispatchResult {
  bundle: AssociativeContextBundle;
  coordinationResult?: SynapticCoordinationResult;
}

/**
 * Normalizza i consensi in modalità rigorosamente fail-closed:
 * qualsiasi valore diverso da `true` viene forzato a `false`.
 */
export function normalizeAdapterConsentState(
  consentState?: AssociativeAdapterConsentInput | null
): LearningConsentState {
  if (!consentState || typeof consentState !== "object") {
    return {
      aiMemoryConsent: false,
      learningConsent: false,
    };
  }
  return {
    aiMemoryConsent: consentState.aiMemoryConsent === true,
    learningConsent: consentState.learningConsent === true,
  };
}

/**
 * Sanitizza testi provenienti dal grafo associativo contro prompt injection e PII residue.
 */
export function sanitizeAssociativeText(raw: string, maxLen = 220): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw.replace(/[\r\n]+/g, " ");
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[contenuto-filtrato]");
  }
  cleaned = redactSensitiveTokens(cleaned).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function clampTimeoutMs(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_ASSOCIATIVE_ADAPTER_TIMEOUT_MS;
  }
  return Math.max(10, Math.min(Math.round(requested), MAX_ASSOCIATIVE_ADAPTER_TIMEOUT_MS));
}

function isNodeExpired(expiresAt: string | undefined, nowIso: string): boolean {
  if (!expiresAt) return false;
  const expMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(expMs)) return true;
  if (!Number.isFinite(nowMs)) return false;
  return expMs <= nowMs;
}

function resolveAuthorizedScopes(params: {
  consentState: LearningConsentState;
  allowOperationalInNoConsentMode: boolean;
  includeSessionEphemeral: boolean;
  requestedScopes?: readonly AssociativeConsentScope[];
}): {
  authorizedScopes: AssociativeConsentScope[];
  excludedScopes: AssociativeConsentScope[];
} {
  const candidates: AssociativeConsentScope[] =
    params.requestedScopes && params.requestedScopes.length > 0
      ? Array.from(
          new Set(
            params.requestedScopes.filter((s): s is AssociativeConsentScope =>
              ALL_ASSOCIATIVE_SCOPES.includes(s)
            )
          )
        )
      : [...ALL_ASSOCIATIVE_SCOPES];

  const authorizedScopes: AssociativeConsentScope[] = [];
  const excludedScopes: AssociativeConsentScope[] = [];

  for (const scope of candidates) {
    if (scope === "ai_memory") {
      if (params.consentState.aiMemoryConsent) {
        authorizedScopes.push(scope);
      } else {
        excludedScopes.push(scope);
      }
      continue;
    }

    if (scope === "learning") {
      if (params.consentState.learningConsent) {
        authorizedScopes.push(scope);
      } else {
        excludedScopes.push(scope);
      }
      continue;
    }

    if (scope === "operational") {
      if (params.consentState.aiMemoryConsent || params.allowOperationalInNoConsentMode) {
        authorizedScopes.push(scope);
      } else {
        excludedScopes.push(scope);
      }
      continue;
    }

    if (scope === "session_ephemeral") {
      if (params.includeSessionEphemeral) {
        authorizedScopes.push(scope);
      } else {
        excludedScopes.push(scope);
      }
    }
  }

  for (const scope of ALL_ASSOCIATIVE_SCOPES) {
    if (!authorizedScopes.includes(scope) && !excludedScopes.includes(scope)) {
      excludedScopes.push(scope);
    }
  }

  return { authorizedScopes, excludedScopes };
}

function buildQueryText(
  userMessage: string,
  historyTexts?: readonly string[]
): string {
  const cleanUser = sanitizeAssociativeText(userMessage, 320);
  if (!historyTexts || historyTexts.length === 0 || cleanUser.length >= 48) {
    return cleanUser;
  }

  const recentHints = historyTexts
    .slice(-2)
    .map((h) => sanitizeAssociativeText(h, 90))
    .filter((h) => h.length > 0 && h !== cleanUser);

  if (recentHints.length === 0) {
    return cleanUser;
  }

  return `${cleanUser} ${recentHints.join(" ")}`.slice(0, 400).trim();
}

function createEmptyFailClosedBundle(params: {
  reason: string;
  blockedBy?: AssociativeBundleBlockReason;
  safetyBlocked?: boolean;
  insufficientSignal?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  allowed?: boolean;
  failClosed?: boolean;
  nowIso: string;
  correlationId?: string;
  consentState: LearningConsentState;
  allowOperationalInNoConsentMode: boolean;
  authorizedScopes: AssociativeConsentScope[];
  excludedScopes: AssociativeConsentScope[];
  effectiveMaxHops: number;
  latencyMs?: number;
  rawResult?: AssociativeRetrievalDetailedResult;
}): AssociativeContextBundle {
  return {
    allowed: params.allowed ?? false,
    failClosed: params.failClosed ?? true,
    safetyBlocked: params.safetyBlocked ?? false,
    insufficientSignal: params.insufficientSignal ?? false,
    timedOut: params.timedOut ?? false,
    aborted: params.aborted ?? false,
    reason: params.reason,
    blockedBy: params.blockedBy,
    retrievedAt: params.nowIso,
    correlationId: params.correlationId,
    consentState: { ...params.consentState },
    allowOperationalInNoConsentMode: params.allowOperationalInNoConsentMode,
    authorizedScopes: [...params.authorizedScopes],
    excludedScopes: [...params.excludedScopes],
    effectiveMaxHops: params.effectiveMaxHops,
    items: [],
    explanations: [],
    edges: [],
    latencyMs: params.latencyMs ?? 0,
    rawResult: params.rawResult,
  };
}

/**
 * Costruisce e valida un `AssociativeRetrievalInput` rispettando:
 * - consensi indipendenti (`aiMemoryConsent` vs `learningConsent`);
 * - `allowOperationalInNoConsentMode = false` di default;
 * - limiti rigidi su hop, nodi, archi e timeout.
 */
export function buildAssociativeRetrievalInput(
  request: AssociativeConversationRequest
): BuiltAssociativeRetrievalInput {
  const nowIso = request?.nowIso ?? new Date().toISOString();
  const consentState = normalizeAdapterConsentState(request?.consentState);
  const allowOperationalInNoConsentMode =
    request?.allowOperationalInNoConsentMode === true;
  const includeSessionEphemeral = request?.includeSessionEphemeral !== false;
  const timeoutMs = clampTimeoutMs(request?.timeoutMs);

  const effectiveMaxHops = Math.max(
    0,
    Math.min(
      typeof request?.maxHops === "number" && Number.isFinite(request.maxHops)
        ? Math.floor(request.maxHops)
        : ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS,
      ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS
    )
  );
  const maxNodes = Math.max(
    1,
    Math.min(
      typeof request?.maxNodes === "number" && Number.isFinite(request.maxNodes)
        ? Math.floor(request.maxNodes)
        : MAX_ASSOCIATIVE_CONTEXT_ITEMS,
      ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_NODES
    )
  );
  const maxEdges = Math.max(
    0,
    Math.min(
      typeof request?.maxEdges === "number" && Number.isFinite(request.maxEdges)
        ? Math.floor(request.maxEdges)
        : ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_EDGES,
      ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_EDGES
    )
  );
  const minFinalScore =
    typeof request?.minFinalScore === "number" && Number.isFinite(request.minFinalScore)
      ? Math.max(0, Math.min(1, request.minFinalScore))
      : DEFAULT_MIN_ASSOCIATIVE_FINAL_SCORE;

  const { authorizedScopes, excludedScopes } = resolveAuthorizedScopes({
    consentState,
    allowOperationalInNoConsentMode,
    includeSessionEphemeral,
    requestedScopes: request?.requestedScopes,
  });

  const userMessage = typeof request?.userMessage === "string" ? request.userMessage.trim() : "";
  const seedNodeIds = Array.isArray(request?.seedNodeIds)
    ? Array.from(
        new Set(
          request.seedNodeIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        )
      )
    : undefined;

  const preferredKinds = Array.isArray(request?.preferredKinds)
    ? Array.from(new Set(request.preferredKinds))
    : undefined;

  const query = buildQueryText(userMessage, request?.historyTexts);
  const valid =
    Boolean(request) &&
    typeof request === "object" &&
    (userMessage.length > 0 || (seedNodeIds !== undefined && seedNodeIds.length > 0));

  const retrievalInput: AssociativeRetrievalInput = {
    query,
    consentState,
    seedNodeIds: seedNodeIds && seedNodeIds.length > 0 ? seedNodeIds : undefined,
    allowedScopes: authorizedScopes,
    maxHops: effectiveMaxHops,
    maxNodes,
    maxEdges,
    includeHypotheses: request?.includeHypotheses !== false,
    crisisBlocked: request?.crisisBlocked === true,
    userTextForSafetyCheck: userMessage,
    nowIso,
  };

  return {
    valid,
    reason: valid
      ? "Input associativo validato."
      : "Richiesta associativa priva di query o seedNodeIds.",
    retrievalInput,
    consentState,
    allowOperationalInNoConsentMode,
    authorizedScopes,
    excludedScopes,
    effectiveMaxHops,
    maxNodes,
    maxEdges,
    minFinalScore,
    preferredKinds,
    timeoutMs,
  };
}

function isScopeCurrentlyAuthorized(
  scope: AssociativeConsentScope,
  consentState: LearningConsentState,
  allowOperationalInNoConsentMode: boolean,
  authorizedScopes: readonly AssociativeConsentScope[]
): boolean {
  if (!authorizedScopes.includes(scope)) return false;
  if (scope === "ai_memory") return consentState.aiMemoryConsent === true;
  if (scope === "learning") return consentState.learningConsent === true;
  if (scope === "operational") {
    return consentState.aiMemoryConsent === true || allowOperationalInNoConsentMode === true;
  }
  return scope === "session_ephemeral";
}

function buildDedupeSignature(item: AssociativeRankedItem): string {
  const sourceRecordId = item.node.provenance?.sourceRecordId?.trim();
  if (sourceRecordId) {
    return `src:${item.node.kind}:${sourceRecordId.toLowerCase()}`;
  }
  const canonicalKey = item.node.canonicalKey?.trim();
  if (canonicalKey) {
    return `key:${canonicalKey.toLowerCase()}`;
  }
  return `lbl:${item.node.kind}:${normalizeText(item.node.label)}`;
}

/**
 * Converte il risultato di `AssociativeRetrievalEngine` in un `AssociativeContextBundle`
 * compatibile con `ContextOrchestrator`, eseguendo ulteriori filtri difensivi in sola lettura.
 */
export function convertRetrievalResultToBundle(
  result: AssociativeRetrievalDetailedResult,
  meta: {
    nowIso: string;
    correlationId?: string;
    consentState: LearningConsentState;
    allowOperationalInNoConsentMode: boolean;
    authorizedScopes: readonly AssociativeConsentScope[];
    excludedScopes: readonly AssociativeConsentScope[];
    effectiveMaxHops: number;
    maxNodes: number;
    maxEdges: number;
    minFinalScore: number;
    hasExplicitSeeds: boolean;
    hasQuery: boolean;
    latencyMs: number;
  }
): AssociativeContextBundle {
  const mergedExcluded = Array.from(
    new Set([...meta.excludedScopes, ...(result.excludedScopes ?? [])])
  );

  if (result.safetyBlocked) {
    return createEmptyFailClosedBundle({
      reason: result.reason || "Recupero associativo bloccato dal Safety Engine.",
      blockedBy: result.blockedBy ?? "crisis",
      safetyBlocked: true,
      failClosed: true,
      allowed: false,
      nowIso: meta.nowIso,
      correlationId: meta.correlationId,
      consentState: meta.consentState,
      allowOperationalInNoConsentMode: meta.allowOperationalInNoConsentMode,
      authorizedScopes: [...meta.authorizedScopes],
      excludedScopes: mergedExcluded,
      effectiveMaxHops: meta.effectiveMaxHops,
      latencyMs: meta.latencyMs,
      rawResult: result,
    });
  }

  if (!result.allowed || result.failClosed) {
    return createEmptyFailClosedBundle({
      reason: result.reason || "Recupero associativo non autorizzato (fail-closed).",
      blockedBy: result.blockedBy ?? "consent",
      safetyBlocked: false,
      failClosed: true,
      allowed: false,
      nowIso: meta.nowIso,
      correlationId: meta.correlationId,
      consentState: meta.consentState,
      allowOperationalInNoConsentMode: meta.allowOperationalInNoConsentMode,
      authorizedScopes: [...meta.authorizedScopes],
      excludedScopes: mergedExcluded,
      effectiveMaxHops: meta.effectiveMaxHops,
      latencyMs: meta.latencyMs,
      rawResult: result,
    });
  }

  const dedupedItems: AssociativeContextItem[] = [];
  const seenSignatures = new Set<string>();
  const seenNodeIds = new Set<string>();
  const survivingExplanations: AssociativeRetrievalExplanation[] = [];

  const rankedItems = Array.isArray(result.items) ? result.items : [];
  for (const item of rankedItems) {
    if (dedupedItems.length >= meta.maxNodes) break;
    if (!item || !item.node) continue;
    const node = item.node;

    // 1. Verifica difesa in profondità dello scope e del consenso corrente
    if (
      !isScopeCurrentlyAuthorized(
        node.consentScope,
        meta.consentState,
        meta.allowOperationalInNoConsentMode,
        meta.authorizedScopes
      )
    ) {
      continue;
    }

    // 2. Esclusione rigorosa nodi revocati, scaduti o sostituiti
    if (INACTIVE_NODE_STATUSES.has(node.validationStatus)) {
      continue;
    }
    if (isNodeExpired(node.expiresAt, meta.nowIso)) {
      continue;
    }

    // 3. Esclusione hop oltre il massimo consentito (<= 2)
    if (item.hopDistance > meta.effectiveMaxHops || item.hopDistance > ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS) {
      continue;
    }

    // 4. Verifica sicurezza PII / contenuti clinici
    if (!isSafeForLongTermMemory(node.label) || !isSafeForLongTermMemory(node.summary)) {
      continue;
    }

    // 5. Filtro pertinenza minima (esclusi irrilevanti quando query presente e non ci sono seed espliciti)
    if (
      meta.hasQuery &&
      !meta.hasExplicitSeeds &&
      item.scoreBreakdown.finalScore < meta.minFinalScore
    ) {
      continue;
    }

    // 6. Sanitizzazione anti-prompt-injection e PII
    const cleanLabel = sanitizeAssociativeText(node.label, ASSOCIATIVE_LIMITS.MAX_LABEL_LENGTH);
    const cleanSummary = sanitizeAssociativeText(node.summary, 240);
    const cleanExplanation = sanitizeAssociativeText(
      item.explanation?.relevanceReason ?? item.pathExplanation ?? "",
      220
    );
    if (!cleanLabel || !cleanSummary) continue;

    // 7. Deduplicazione deterministica per nodeId e firma logica
    if (seenNodeIds.has(node.id)) continue;
    const signature = buildDedupeSignature(item);
    // Non sopprimere segnalazioni di conflitto distinte con lo stesso sourceRecordId
    const effectiveSignature =
      item.epistemicCategory === "informazione_conflittuale"
        ? `conflict:${node.id}`
        : signature;
    if (seenSignatures.has(effectiveSignature)) continue;

    seenNodeIds.add(node.id);
    seenSignatures.add(effectiveSignature);

    const uncertain =
      item.epistemicCategory === "ipotesi_da_verificare" ||
      item.epistemicCategory === "informazione_conflittuale" ||
      item.epistemicCategory === "informazione_derivata" ||
      node.validationStatus === "unverified" ||
      node.validationStatus === "proposed" ||
      node.validationStatus === "conflicted";

    dedupedItems.push({
      nodeId: node.id,
      canonicalKey: node.canonicalKey,
      sourceRecordId: node.provenance?.sourceRecordId,
      kind: node.kind,
      label: cleanLabel,
      summary: cleanSummary,
      scope: node.consentScope,
      epistemicCategory: item.epistemicCategory,
      epistemicTag: item.pathEpistemicTag,
      validationStatus: node.validationStatus,
      reliability: item.scoreBreakdown.sourceReliability,
      finalScore: item.scoreBreakdown.finalScore,
      hopDistance: item.hopDistance,
      relations: [...item.relations],
      pathNodeIds: [...item.pathNodeIds],
      pathEdgeIds: [...item.pathEdgeIds],
      seedNodeId: item.seedNodeId,
      seedNodeLabel: sanitizeAssociativeText(
        item.explanation?.seedNodeLabel ?? item.seedNodeId,
        80
      ),
      provenance: {
        ...node.provenance,
        note: node.provenance?.note
          ? sanitizeAssociativeText(node.provenance.note, 180)
          : undefined,
      },
      conflictWithNodeIds: node.conflictWithNodeIds
        ? [...node.conflictWithNodeIds]
        : undefined,
      explanationSummary: cleanExplanation,
      uncertain,
      observedAt: node.observedAt,
    });

    if (item.explanation) {
      survivingExplanations.push({
        ...item.explanation,
        nodeLabel: cleanLabel,
        relevanceReason: cleanExplanation,
        pathNodeIds: [...item.explanation.pathNodeIds],
        pathEdgeIds: [...item.explanation.pathEdgeIds],
        relations: [...item.explanation.relations],
        provenance: { ...item.explanation.provenance },
        conflictWithNodeIds: item.explanation.conflictWithNodeIds
          ? [...item.explanation.conflictWithNodeIds]
          : undefined,
      });
    }
  }

  const keptEdgeIds = new Set<string>();
  for (const it of dedupedItems) {
    for (const edgeId of it.pathEdgeIds) {
      keptEdgeIds.add(edgeId);
    }
  }

  const survivingEdges = (Array.isArray(result.edges) ? result.edges : [])
    .filter(
      (edge) =>
        keptEdgeIds.has(edge.id) &&
        isScopeCurrentlyAuthorized(
          edge.storageScope,
          meta.consentState,
          meta.allowOperationalInNoConsentMode,
          meta.authorizedScopes
        )
    )
    .slice(0, meta.maxEdges);

  const insufficientSignal = result.insufficientSignal || dedupedItems.length === 0;

  return {
    allowed: true,
    failClosed: false,
    safetyBlocked: false,
    insufficientSignal,
    timedOut: false,
    aborted: false,
    reason: insufficientSignal
      ? "Nessun elemento associativo pertinente e autorizzato disponibile."
      : `Contesto associativo convertito in sola lettura (${dedupedItems.length} elementi).`,
    retrievedAt: result.retrievedAt || meta.nowIso,
    correlationId: meta.correlationId,
    consentState: { ...meta.consentState },
    allowOperationalInNoConsentMode: meta.allowOperationalInNoConsentMode,
    authorizedScopes: [...meta.authorizedScopes],
    excludedScopes: mergedExcluded,
    effectiveMaxHops: Math.min(result.effectiveMaxHops, meta.effectiveMaxHops),
    items: dedupedItems,
    explanations: survivingExplanations,
    edges: survivingEdges,
    latencyMs: meta.latencyMs,
    rawResult: result,
  };
}

/**
 * Esecuzione sincrona read-only per integrazione compatibile con `ContextOrchestrator`.
 * Degrada in modalità fail-closed su errori, dati corrotti, abort o superamento timeout.
 */
export function retrieveAssociativeContextSync(
  retrievalEngine: AssociativeRetrievalEngine,
  request: AssociativeConversationRequest
): AssociativeContextBundle {
  const startedAtMs = Date.now();
  const built = buildAssociativeRetrievalInput(request);
  const nowIso = built.retrievalInput.nowIso ?? new Date().toISOString();

  if (request?.signal?.aborted) {
    return createEmptyFailClosedBundle({
      reason: "Recupero associativo annullato tramite AbortSignal (fail-closed).",
      blockedBy: "aborted",
      aborted: true,
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }

  const safety = evaluateCognitiveSafety(
    typeof request?.userMessage === "string" ? request.userMessage : "",
    request?.crisisBlocked === true
  );
  if (!safety.safe || safety.crisisDetected) {
    return createEmptyFailClosedBundle({
      reason: safety.reply ?? "Recupero associativo bloccato per sicurezza.",
      blockedBy: "crisis",
      safetyBlocked: true,
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }

  if (!built.valid) {
    return createEmptyFailClosedBundle({
      reason: built.reason,
      blockedBy: "invalid_payload",
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }

  if (built.authorizedScopes.length === 0) {
    const decision = evaluateAssociativeAccess({
      operation: "retrieve",
      scope: "ai_memory",
      consentState: built.consentState,
      crisisBlocked: request?.crisisBlocked === true,
      userTextForSafetyCheck: built.retrievalInput.userTextForSafetyCheck,
      nowIso,
    });
    return createEmptyFailClosedBundle({
      reason: decision.reason,
      blockedBy: decision.blockedBy ?? "consent",
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: [],
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }

  if (!retrievalEngine || typeof retrievalEngine.retrieve !== "function") {
    return createEmptyFailClosedBundle({
      reason: "AssociativeRetrievalEngine non disponibile (fail-closed).",
      blockedBy: "internal_error",
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }

  try {
    const rawResult =
      built.preferredKinds &&
      built.preferredKinds.length > 0 &&
      !built.retrievalInput.seedNodeIds
        ? retrievalEngine.retrieveRelatedExperiences({
            ...built.retrievalInput,
            preferredKinds: built.preferredKinds,
          })
        : retrievalEngine.retrieve(built.retrievalInput);

    const elapsedMs = Date.now() - startedAtMs;
    if (request?.signal?.aborted) {
      return createEmptyFailClosedBundle({
        reason: "Recupero associativo interrotto da AbortSignal durante l'esecuzione.",
        blockedBy: "aborted",
        aborted: true,
        failClosed: true,
        nowIso,
        correlationId: request?.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: built.authorizedScopes,
        excludedScopes: built.excludedScopes,
        effectiveMaxHops: built.effectiveMaxHops,
        latencyMs: elapsedMs,
      });
    }

    if (elapsedMs > built.timeoutMs) {
      return createEmptyFailClosedBundle({
        reason: `Recupero associativo oltre il limite temporale di ${built.timeoutMs}ms (fail-closed).`,
        blockedBy: "timeout",
        timedOut: true,
        failClosed: true,
        nowIso,
        correlationId: request?.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: built.authorizedScopes,
        excludedScopes: built.excludedScopes,
        effectiveMaxHops: built.effectiveMaxHops,
        latencyMs: elapsedMs,
      });
    }

    return convertRetrievalResultToBundle(rawResult, {
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      maxNodes: built.maxNodes,
      maxEdges: built.maxEdges,
      minFinalScore: built.minFinalScore,
      hasExplicitSeeds: Boolean(built.retrievalInput.seedNodeIds?.length),
      hasQuery: Boolean(built.retrievalInput.query.trim()),
      latencyMs: elapsedMs,
    });
  } catch {
    return createEmptyFailClosedBundle({
      reason: "Errore o dati corrotti durante il recupero associativo (fail-closed).",
      blockedBy: "corrupted_data",
      failClosed: true,
      nowIso,
      correlationId: request?.correlationId,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      authorizedScopes: built.authorizedScopes,
      excludedScopes: built.excludedScopes,
      effectiveMaxHops: built.effectiveMaxHops,
      latencyMs: Date.now() - startedAtMs,
    });
  }
}

/**
 * Descrittore canonico in sola lettura per il `SynapticRegistry` della Fase 11.1.
 */
export function createAssociativeSynapticDescriptor(): CognitiveEngineDescriptor {
  return {
    engineId: ASSOCIATIVE_SYNAPTIC_ENGINE_ID,
    name: "Associative Retrieval Engine (Synaptic Read-Only Adapter)",
    version: "1.0.0",
    capabilities: [
      "associative_retrieval",
      "experience_graph_read",
      "context_enrichment",
    ],
    supportedEvents: [
      ASSOCIATIVE_SYNAPTIC_EVENTS.RETRIEVE,
      ASSOCIATIVE_SYNAPTIC_EVENTS.CONTEXT_REQUESTED,
    ],
    dependencies: ["safety_engine"],
    status: "available",
    readOnly: true,
    priorityOrder: 82,
    description:
      "Ponte consultivo in sola lettura verso AssociativeRetrievalEngine con isolamento dei consensi.",
  };
}

function parsePayloadRequest(
  event: CognitiveEvent<Record<string, unknown>>,
  defaults: {
    defaultConsentState?: AssociativeAdapterConsentInput;
    defaultAllowOperationalInNoConsentMode?: boolean;
    timeoutMs: number;
  }
): AssociativeConversationRequest {
  const payload = event.payload ?? {};
  const rawConsent =
    payload.consentState && typeof payload.consentState === "object"
      ? (payload.consentState as AssociativeAdapterConsentInput)
      : defaults.defaultConsentState;

  const userMessage =
    typeof payload.userMessage === "string"
      ? payload.userMessage
      : typeof payload.query === "string"
        ? payload.query
        : typeof payload.input === "string"
          ? payload.input
          : "";

  const historyTexts = Array.isArray(payload.historyTexts)
    ? payload.historyTexts.filter((x): x is string => typeof x === "string")
    : undefined;

  const requestedScopes = Array.isArray(payload.requestedScopes)
    ? (payload.requestedScopes.filter((s): s is AssociativeConsentScope =>
        ALL_ASSOCIATIVE_SCOPES.includes(s as AssociativeConsentScope)
      ) as AssociativeConsentScope[])
    : undefined;

  const seedNodeIds = Array.isArray(payload.seedNodeIds)
    ? payload.seedNodeIds.filter((s): s is string => typeof s === "string")
    : undefined;

  const preferredKinds = Array.isArray(payload.preferredKinds)
    ? (payload.preferredKinds as AssociativeNodeKind[])
    : undefined;

  return {
    userMessage,
    historyTexts,
    consentState: normalizeAdapterConsentState(rawConsent),
    allowOperationalInNoConsentMode:
      typeof payload.allowOperationalInNoConsentMode === "boolean"
        ? payload.allowOperationalInNoConsentMode === true
        : defaults.defaultAllowOperationalInNoConsentMode === true,
    includeSessionEphemeral:
      typeof payload.includeSessionEphemeral === "boolean"
        ? payload.includeSessionEphemeral
        : true,
    requestedScopes,
    seedNodeIds,
    preferredKinds,
    maxHops: typeof payload.maxHops === "number" ? payload.maxHops : undefined,
    maxNodes: typeof payload.maxNodes === "number" ? payload.maxNodes : undefined,
    maxEdges: typeof payload.maxEdges === "number" ? payload.maxEdges : undefined,
    includeHypotheses:
      typeof payload.includeHypotheses === "boolean" ? payload.includeHypotheses : true,
    minFinalScore:
      typeof payload.minFinalScore === "number" ? payload.minFinalScore : undefined,
    crisisBlocked: payload.crisisBlocked === true,
    nowIso: typeof payload.nowIso === "string" ? payload.nowIso : event.timestamp,
    correlationId: event.correlationId,
    timeoutMs:
      typeof payload.timeoutMs === "number" ? payload.timeoutMs : defaults.timeoutMs,
  };
}

/**
 * Registra `AssociativeRetrievalEngine` in un `SynapticEngine` esistente della Fase 11.1
 * senza modificare nessun file del core sinaptico.
 * Il handler è rigorosamente consultivo/read-only e non emette mai eventi derivati.
 */
export function registerAssociativeSynapticEngine(
  synapticEngine: SynapticEngine,
  deps: RegisterAssociativeSynapticEngineDeps
): CognitiveEngineDescriptor {
  const descriptor = createAssociativeSynapticDescriptor();
  const defaultTimeoutMs = clampTimeoutMs(deps.timeoutMs);

  return synapticEngine.registerEngine<Record<string, unknown>, AssociativeContextBundle>(
    descriptor,
    {
      replace: true,
      handler: (context) => {
        const request = parsePayloadRequest(context.event, {
          defaultConsentState: deps.defaultConsentState,
          defaultAllowOperationalInNoConsentMode:
            deps.defaultAllowOperationalInNoConsentMode,
          timeoutMs: defaultTimeoutMs,
        });
        const built = buildAssociativeRetrievalInput(request);

        if (!context.advisoryOnly || !context.readOnly) {
          return createEmptyFailClosedBundle({
            reason: "Esecuzione non consultiva rifiutata (readOnly/advisoryOnly obbligatori).",
            blockedBy: "mutation_forbidden",
            failClosed: true,
            nowIso: built.retrievalInput.nowIso ?? context.event.timestamp,
            correlationId: context.correlationId,
            consentState: built.consentState,
            allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
            authorizedScopes: [],
            excludedScopes: [...ALL_ASSOCIATIVE_SCOPES],
            effectiveMaxHops: built.effectiveMaxHops,
          });
        }

        const visitedCount = context.event.visitedEngines.filter(
          (id) => id === ASSOCIATIVE_SYNAPTIC_ENGINE_ID
        ).length;
        if (visitedCount > 1) {
          return createEmptyFailClosedBundle({
            reason: "Loop sinaptico bloccato: motore già visitato nella catena causale.",
            blockedBy: "loop_or_duplicate",
            failClosed: true,
            nowIso: built.retrievalInput.nowIso ?? context.event.timestamp,
            correlationId: context.correlationId,
            consentState: built.consentState,
            allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
            authorizedScopes: [],
            excludedScopes: [...ALL_ASSOCIATIVE_SCOPES],
            effectiveMaxHops: built.effectiveMaxHops,
          });
        }

        // Esecuzione read-only con AbortSignal del router (nessuna emissione di eventi derivati)
        return retrieveAssociativeContextSync(deps.retrievalEngine, {
          ...request,
          signal: context.signal,
        });
      },
    }
  );
}

/**
 * Esegue il recupero associativo passando attraverso `SynapticEngine.coordinateEvent()`
 * con propagazione di sicurezza, timeout, `AbortSignal` e tracciamento causale.
 */
export async function dispatchAssociativeRetrievalViaSynapticEngine(
  synapticEngine: SynapticEngine,
  request: AssociativeConversationRequest,
  options: AssociativeSynapticDispatchOptions = {}
): Promise<AssociativeSynapticDispatchResult> {
  const startedAtMs = Date.now();
  const built = buildAssociativeRetrievalInput(request);
  const nowIso = built.retrievalInput.nowIso ?? new Date().toISOString();

  if (request?.signal?.aborted) {
    return {
      bundle: createEmptyFailClosedBundle({
        reason: "Richiesta annullata tramite AbortSignal prima del routing sinaptico.",
        blockedBy: "aborted",
        aborted: true,
        failClosed: true,
        nowIso,
        correlationId: request?.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: built.authorizedScopes,
        excludedScopes: built.excludedScopes,
        effectiveMaxHops: built.effectiveMaxHops,
      }),
    };
  }

  const event = synapticEngine.createEvent<Record<string, unknown>>({
    type: ASSOCIATIVE_SYNAPTIC_EVENTS.RETRIEVE,
    source: "associative_synaptic_adapter",
    timestamp: nowIso,
    correlationId: request?.correlationId ?? options.parentEvent?.correlationId,
    parentEvent: options.parentEvent,
    priority: options.priority ?? "normal",
    payload: {
      userMessage: request?.userMessage ?? "",
      historyTexts: request?.historyTexts ? [...request.historyTexts] : undefined,
      consentState: built.consentState,
      allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
      includeSessionEphemeral: request?.includeSessionEphemeral !== false,
      requestedScopes: request?.requestedScopes ? [...request.requestedScopes] : undefined,
      seedNodeIds: built.retrievalInput.seedNodeIds,
      preferredKinds: built.preferredKinds,
      maxHops: built.effectiveMaxHops,
      maxNodes: built.maxNodes,
      maxEdges: built.maxEdges,
      includeHypotheses: built.retrievalInput.includeHypotheses,
      minFinalScore: built.minFinalScore,
      crisisBlocked: request?.crisisBlocked === true,
      nowIso,
      timeoutMs: built.timeoutMs,
      usesLearningData: built.authorizedScopes.includes("learning"),
    },
  });

  if (options.routingOptions?.allowMutation === true) {
    return {
      bundle: createEmptyFailClosedBundle({
        reason: "Mutazione esplicitamente vietata sul recupero associativo.",
        blockedBy: "mutation_forbidden",
        failClosed: true,
        nowIso,
        correlationId: event.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: [],
        excludedScopes: [...ALL_ASSOCIATIVE_SCOPES],
        effectiveMaxHops: built.effectiveMaxHops,
      }),
    };
  }

  const safetyCheck = evaluateCognitiveSafety(
    built.retrievalInput.userTextForSafetyCheck ?? "",
    request?.crisisBlocked === true
  );
  if (!safetyCheck.safe || safetyCheck.crisisDetected) {
    return {
      bundle: createEmptyFailClosedBundle({
        reason: safetyCheck.reply ?? "Recupero associativo bloccato dal Safety Engine.",
        blockedBy: "crisis",
        safetyBlocked: true,
        failClosed: true,
        nowIso,
        correlationId: event.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: built.authorizedScopes,
        excludedScopes: built.excludedScopes,
        effectiveMaxHops: built.effectiveMaxHops,
      }),
    };
  }

  try {
    const coordinationResult = await synapticEngine.coordinateEvent(event, {
      ...options.routingOptions,
      allowMutation: false,
      signal: request?.signal ?? options.routingOptions?.signal,
      timeoutMs: built.timeoutMs,
      safetyInput: {
        ...options.routingOptions?.safetyInput,
        crisisBlocked: request?.crisisBlocked === true,
        userTextForSafetyCheck: built.retrievalInput.userTextForSafetyCheck,
        consentState: built.consentState,
        usesLearningData: built.authorizedScopes.includes("learning"),
        nowIso,
      },
    });

    const elapsedMs = Date.now() - startedAtMs;
    const { routingResult } = coordinationResult;

    if (routingResult.safetyBlocked) {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: routingResult.reason,
          blockedBy: "crisis",
          safetyBlocked: true,
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    const assocRecord = routingResult.records.find(
      (r) => r.engineId === ASSOCIATIVE_SYNAPTIC_ENGINE_ID
    );
    if (!assocRecord) {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: routingResult.reason || "Motore associativo non eseguito dal SynapticRouter (fail-closed).",
          blockedBy:
            coordinationResult.busResult.status === "duplicate_ignored" ||
            coordinationResult.busResult.status === "rejected_loop"
              ? "loop_or_duplicate"
              : !routingResult.allowed
                ? "consent"
                : "internal_error",
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    if (assocRecord.status === "timeout") {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: assocRecord.reason || "Timeout del SynapticRouter sul recupero associativo.",
          blockedBy: "timeout",
          timedOut: true,
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    if (assocRecord.status === "cancelled") {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: assocRecord.reason || "Recupero associativo annullato dal SynapticRouter.",
          blockedBy: "aborted",
          aborted: true,
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    if (
      assocRecord.status === "blocked_loop" ||
      assocRecord.status === "blocked_duplicate"
    ) {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: assocRecord.reason,
          blockedBy: "loop_or_duplicate",
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    if (assocRecord.status !== "executed" || !assocRecord.output) {
      return {
        coordinationResult,
        bundle: createEmptyFailClosedBundle({
          reason: assocRecord.reason || "Esito non valido dal motore associativo.",
          blockedBy:
            assocRecord.status === "blocked_mutation_policy"
              ? "mutation_forbidden"
              : "internal_error",
          failClosed: true,
          nowIso,
          correlationId: event.correlationId,
          consentState: built.consentState,
          allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
          authorizedScopes: built.authorizedScopes,
          excludedScopes: built.excludedScopes,
          effectiveMaxHops: built.effectiveMaxHops,
          latencyMs: elapsedMs,
        }),
      };
    }

    return {
      coordinationResult,
      bundle: assocRecord.output as AssociativeContextBundle,
    };
  } catch {
    return {
      bundle: createEmptyFailClosedBundle({
        reason: "Errore imprevisto durante il dispatch sinaptico associativo (fail-closed).",
        blockedBy: "internal_error",
        failClosed: true,
        nowIso,
        correlationId: event.correlationId,
        consentState: built.consentState,
        allowOperationalInNoConsentMode: built.allowOperationalInNoConsentMode,
        authorizedScopes: built.authorizedScopes,
        excludedScopes: built.excludedScopes,
        effectiveMaxHops: built.effectiveMaxHops,
        latencyMs: Date.now() - startedAtMs,
      }),
    };
  }
}
