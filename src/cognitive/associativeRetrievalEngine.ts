import { normalizeText } from "../memory/privacyFilter";
import {
  evaluateAssociativeAccess,
  propagatePathEpistemicTag,
  propagatePathReliability,
} from "./associativeMemoryGuard";
import {
  ASSOCIATIVE_LIMITS,
  type AssociativeAccessDecision,
  type AssociativeConsentScope,
  type AssociativeEdge,
  type AssociativeGuardBlockReason,
  type AssociativeMemoryNode,
  type AssociativeNodeKind,
  type AssociativeNodeProvenance,
  type AssociativeRelationType,
  type AssociativeRetrievalInput,
  type AssociativeRetrievalResult,
  type AssociativeRetrievalScoreBreakdown,
  type AssociativeRetrievedNode,
  type AssociativeValidationStatus,
  type PersistentAssociativeScope,
} from "./associativeTypes";
import type { ExperienceGraphEngine } from "./experienceGraphEngine";
import type { EpistemicTag } from "./selfLearningTypes";

const ALL_SCOPES: readonly AssociativeConsentScope[] = [
  "operational",
  "ai_memory",
  "learning",
  "session_ephemeral",
];

const PERSISTENT_SCOPES: readonly PersistentAssociativeScope[] = [
  "operational",
  "ai_memory",
  "learning",
];

const EXPERIENCE_NODE_KINDS = new Set<AssociativeNodeKind>([
  "experience_pattern",
  "timeline_event",
  "goal",
  "plan",
  "mission",
  "checkin",
  "emotional_trend",
  "knowledge_entry",
  "preference",
]);

const STOPWORDS = new Set<string>([
  "per",
  "con",
  "che",
  "del",
  "della",
  "delle",
  "dei",
  "degli",
  "nel",
  "nella",
  "nelle",
  "sul",
  "sulla",
  "una",
  "uno",
  "gli",
  "non",
  "come",
  "piu",
  "the",
  "and",
  "for",
  "with",
]);

export type AssociativeEpistemicCategory =
  | "fatto_verificato"
  | "informazione_osservata"
  | "ipotesi_da_verificare"
  | "informazione_derivata"
  | "informazione_conflittuale";

export interface RetrievalContextValidationResult {
  allowed: boolean;
  failClosed: boolean;
  safetyBlocked: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  authorizedScopes: AssociativeConsentScope[];
  excludedScopes: AssociativeConsentScope[];
  effectiveMaxHops: number;
  maxNodes: number;
  maxEdges: number;
  accessDecision: AssociativeAccessDecision;
}

export interface RetrievalCandidate {
  node: AssociativeMemoryNode;
  seedNodeId: string;
  hopDistance: number;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  relations: AssociativeRelationType[];
  pathEpistemicTag: EpistemicTag;
  pathReliability: number;
  directQueryMatchScore: number;
}

export interface AssociativeRetrievalExplanation {
  nodeId: string;
  nodeLabel: string;
  consentScope: AssociativeConsentScope;
  seedNodeId: string;
  seedNodeLabel: string;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  relations: AssociativeRelationType[];
  hopDistance: number;
  relevanceReason: string;
  provenance: AssociativeNodeProvenance;
  reliability: number;
  epistemicTag: EpistemicTag;
  epistemicCategory: AssociativeEpistemicCategory;
  validationStatus: AssociativeValidationStatus;
  conflictWithNodeIds?: string[];
}

export interface AssociativeRankedItem extends AssociativeRetrievedNode {
  seedNodeId: string;
  pathNodeIds: string[];
  relations: AssociativeRelationType[];
  epistemicCategory: AssociativeEpistemicCategory;
  explanation: AssociativeRetrievalExplanation;
}

export interface AssociativeRetrievalDetailedResult extends AssociativeRetrievalResult {
  failClosed: boolean;
  blockedBy?: AssociativeGuardBlockReason;
  effectiveMaxHops: number;
  items: AssociativeRankedItem[];
  explanations: AssociativeRetrievalExplanation[];
}

export interface RetrieveByNodeInput {
  nodeId: string;
  consentState: AssociativeRetrievalInput["consentState"];
  query?: string;
  allowedScopes?: AssociativeConsentScope[];
  relationTypes?: AssociativeRelationType[];
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeHypotheses?: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  nowIso?: string;
}

export interface RetrieveRelatedExperiencesInput {
  query: string;
  consentState: AssociativeRetrievalInput["consentState"];
  seedNodeIds?: string[];
  allowedScopes?: AssociativeConsentScope[];
  preferredKinds?: AssociativeNodeKind[];
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeHypotheses?: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  nowIso?: string;
}

export interface RankingContext {
  query: string;
  nowIso: string;
  preferredKinds?: readonly AssociativeNodeKind[];
  preferredRelations?: readonly AssociativeRelationType[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function tokenizeQuery(rawQuery: string): string[] {
  const normalized = normalizeText(rawQuery)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return Array.from(new Set(normalized));
}

function computeLexicalRelevance(
  node: AssociativeMemoryNode,
  rawQuery: string,
  tokens: readonly string[]
): number {
  const normalizedQuery = normalizeText(rawQuery);
  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const labelNorm = normalizeText(node.label);
  const summaryNorm = normalizeText(node.summary);
  const keywordsNorm = node.keywords.map((k) => normalizeText(k));

  let labelHits = 0;
  let keywordHits = 0;
  let summaryHits = 0;

  for (const token of tokens) {
    if (labelNorm.includes(token)) labelHits += 1;
    if (keywordsNorm.some((k) => k.includes(token) || token.includes(k))) keywordHits += 1;
    if (summaryNorm.includes(token)) summaryHits += 1;
  }

  const labelRatio = labelHits / tokens.length;
  const keywordRatio = keywordHits / tokens.length;
  const summaryRatio = summaryHits / tokens.length;

  let score = labelRatio * 0.5 + keywordRatio * 0.3 + summaryRatio * 0.2;
  if (labelNorm.includes(normalizedQuery)) {
    score = Math.min(1, score + 0.25);
  } else if (summaryNorm.includes(normalizedQuery)) {
    score = Math.min(1, score + 0.12);
  }

  return clamp01(score);
}

function getRelationWeightMultiplier(relation: AssociativeRelationType): number {
  switch (relation) {
    case "supports":
    case "part_of":
    case "derived_from":
      return 1.0;
    case "precedes":
    case "hindered_by":
    case "blocked_by":
      return 0.95;
    case "related_to":
      return 0.9;
    case "contradicts":
      return 0.85;
    case "supersedes":
      return 0.75;
  }
}

function computeTemporalRecency(node: AssociativeMemoryNode, nowMs: number): number {
  const refIso = node.observedAt || node.updatedAt || node.createdAt;
  const refMs = Date.parse(refIso);
  if (Number.isNaN(refMs)) return 0.5;
  const ageDays = Math.max(0, (nowMs - refMs) / (1000 * 60 * 60 * 24));
  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.9;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.55;
  return 0.35;
}

export function classifyEpistemicCategory(
  node: AssociativeMemoryNode,
  pathEpistemicTag: EpistemicTag,
  hopDistance: number
): AssociativeEpistemicCategory {
  if (node.validationStatus === "conflicted") {
    return "informazione_conflittuale";
  }
  if (
    pathEpistemicTag === "ipotesi_da_verificare" ||
    node.provenance.epistemicTag === "ipotesi_da_verificare" ||
    node.provenance.evidenceType === "hypothesis"
  ) {
    return "ipotesi_da_verificare";
  }
  if (
    hopDistance > 0 ||
    pathEpistemicTag === "interpretazione_prudente" ||
    node.provenance.epistemicTag === "interpretazione_prudente"
  ) {
    return "informazione_derivata";
  }
  if (
    node.validationStatus === "confirmed" &&
    node.provenance.evidenceType === "explicit_feedback" &&
    node.provenance.epistemicTag === "fatto_osservato"
  ) {
    return "fatto_verificato";
  }
  return "informazione_osservata";
}

function getCategoryReliabilityMultiplier(category: AssociativeEpistemicCategory): number {
  switch (category) {
    case "fatto_verificato":
      return 1.0;
    case "informazione_osservata":
      return 0.95;
    case "informazione_derivata":
      return 0.85;
    case "ipotesi_da_verificare":
      return 0.65;
    case "informazione_conflittuale":
      return 0.5;
  }
}

function describeCategoryLabel(category: AssociativeEpistemicCategory): string {
  switch (category) {
    case "fatto_verificato":
      return "Fatto verificato";
    case "informazione_osservata":
      return "Informazione osservata";
    case "ipotesi_da_verificare":
      return "Ipotesi da verificare";
    case "informazione_derivata":
      return "Informazione derivata";
    case "informazione_conflittuale":
      return "Informazione conflittuale";
  }
}

function isNodeEligibleForRetrieval(
  node: AssociativeMemoryNode,
  nowMs: number,
  includeHypotheses: boolean
): boolean {
  if (
    node.validationStatus === "revoked" ||
    node.validationStatus === "expired" ||
    node.validationStatus === "superseded"
  ) {
    return false;
  }
  if (node.expiresAt) {
    const expMs = Date.parse(node.expiresAt);
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      return false;
    }
  }
  if (!includeHypotheses) {
    if (
      node.provenance.epistemicTag === "ipotesi_da_verificare" ||
      node.provenance.evidenceType === "hypothesis"
    ) {
      return false;
    }
  }
  return true;
}

function cloneEdgeReadOnly(edge: AssociativeEdge): AssociativeEdge {
  return {
    ...edge,
    provenance: {
      ...edge.provenance,
      supportingEvidenceIds: [...edge.provenance.supportingEvidenceIds],
    },
  };
}

function cloneNodeReadOnly(node: AssociativeMemoryNode): AssociativeMemoryNode {
  return {
    ...node,
    keywords: [...node.keywords],
    provenance: { ...node.provenance },
    conflictWithNodeIds: node.conflictWithNodeIds
      ? [...node.conflictWithNodeIds]
      : undefined,
  };
}

/**
 * Associative Retrieval Engine V1 (Fase 11.2.3).
 *
 * Motore rigorosamente READ-ONLY per recupero associativo, ricostruzione percorsi
 * fino a massimo 2 hop, ranking deterministico ed esplicabile, con isolamento
 * assoluto dei consensi e propagazione epistemica conservativa.
 */
export class AssociativeRetrievalEngine {
  private readonly graphEngine: ExperienceGraphEngine;

  constructor(graphEngine: ExperienceGraphEngine) {
    this.graphEngine = graphEngine;
  }

  validateRetrievalContext(
    input: AssociativeRetrievalInput
  ): RetrievalContextValidationResult {
    const nowIso = input?.nowIso ?? new Date().toISOString();
    const effectiveMaxHops = Math.max(
      0,
      Math.min(
        input?.maxHops ?? ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS,
        ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS
      )
    );
    const maxNodes = Math.max(
      1,
      Math.min(
        input?.maxNodes ?? ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_NODES,
        ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_NODES
      )
    );
    const maxEdges = Math.max(
      0,
      Math.min(
        input?.maxEdges ?? ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_EDGES,
        ASSOCIATIVE_LIMITS.MAX_RETRIEVAL_EDGES
      )
    );

    const candidateScopes: AssociativeConsentScope[] =
      input?.allowedScopes && input.allowedScopes.length > 0
        ? Array.from(new Set(input.allowedScopes))
        : [...ALL_SCOPES];

    const safetyText = (
      input?.userTextForSafetyCheck ??
      input?.query ??
      ""
    ).trim();

    if (!input || !input.consentState || typeof input.consentState !== "object") {
      const failDecision = evaluateAssociativeAccess({
        operation: "retrieve",
        scope: "operational",
        consentState: undefined as unknown as AssociativeRetrievalInput["consentState"],
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: safetyText,
        nowIso,
      });
      return {
        allowed: false,
        failClosed: true,
        safetyBlocked: failDecision.blockedBy === "crisis",
        reason: failDecision.reason,
        blockedBy: failDecision.blockedBy,
        authorizedScopes: [],
        excludedScopes: [...candidateScopes],
        effectiveMaxHops,
        maxNodes,
        maxEdges,
        accessDecision: failDecision,
      };
    }

    const authorizedScopes: AssociativeConsentScope[] = [];
    const excludedScopes: AssociativeConsentScope[] = [];
    let primaryDecision: AssociativeAccessDecision | null = null;

    for (const scope of candidateScopes) {
      const decision = evaluateAssociativeAccess({
        operation: "retrieve",
        scope,
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: safetyText,
        nowIso,
      });

      if (!primaryDecision) {
        primaryDecision = decision;
      }

      if (!decision.allowed) {
        if (
          decision.blockedBy === "crisis" ||
          decision.blockedBy === "clinical_or_pii_content" ||
          decision.blockedBy === "corrupted_data" ||
          decision.blockedBy === "invalid_payload" ||
          decision.blockedBy === "internal_error"
        ) {
          return {
            allowed: false,
            failClosed: true,
            safetyBlocked:
              decision.blockedBy === "crisis" ||
              decision.blockedBy === "clinical_or_pii_content",
            reason: decision.reason,
            blockedBy: decision.blockedBy,
            authorizedScopes: [],
            excludedScopes: [...candidateScopes],
            effectiveMaxHops,
            maxNodes,
            maxEdges,
            accessDecision: decision,
          };
        }
        excludedScopes.push(scope);
      } else {
        authorizedScopes.push(scope);
      }
    }

    // Verifica integrità sulle partizioni persistenti candidate (fail-closed su dati corrotti)
    const persistentToInspect = candidateScopes.filter((s): s is PersistentAssociativeScope =>
      PERSISTENT_SCOPES.includes(s as PersistentAssociativeScope)
    );
    if (persistentToInspect.length > 0) {
      const integrityCheck = this.graphEngine.exportAuthorizedGraph(input.consentState, {
        scopes: persistentToInspect,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: safetyText,
        nowIso,
      });
      if (!integrityCheck.allowed) {
        const corruptDecision = evaluateAssociativeAccess({
          operation: "retrieve",
          scope: "operational",
          consentState: input.consentState,
          crisisBlocked: input.crisisBlocked,
          userTextForSafetyCheck: safetyText,
          corruptedDataDetected: integrityCheck.blockedBy === "corrupted_data",
          nowIso,
        });
        return {
          allowed: false,
          failClosed: true,
          safetyBlocked:
            integrityCheck.blockedBy === "crisis" ||
            integrityCheck.blockedBy === "clinical_or_pii_content",
          reason: integrityCheck.reason,
          blockedBy: integrityCheck.blockedBy,
          authorizedScopes: [],
          excludedScopes: [...candidateScopes],
          effectiveMaxHops,
          maxNodes,
          maxEdges,
          accessDecision: corruptDecision,
        };
      }
    }

    const resolvedDecision =
      primaryDecision ??
      evaluateAssociativeAccess({
        operation: "retrieve",
        scope: "operational",
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: safetyText,
        nowIso,
      });

    if (authorizedScopes.length === 0) {
      return {
        allowed: false,
        failClosed: true,
        safetyBlocked: false,
        reason:
          "Nessuno scope associativo autorizzato per il contesto di recupero richiesto.",
        blockedBy: resolvedDecision.blockedBy ?? "consent",
        authorizedScopes: [],
        excludedScopes,
        effectiveMaxHops,
        maxNodes,
        maxEdges,
        accessDecision: resolvedDecision,
      };
    }

    return {
      allowed: true,
      failClosed: false,
      safetyBlocked: false,
      reason: "Contesto di recupero associativo autorizzato.",
      authorizedScopes,
      excludedScopes,
      effectiveMaxHops,
      maxNodes,
      maxEdges,
      accessDecision: resolvedDecision,
    };
  }

  rankResults(
    candidates: readonly RetrievalCandidate[],
    context: RankingContext,
    nodeLabelLookup?: ReadonlyMap<string, string>,
    edgeLookup?: ReadonlyMap<string, AssociativeEdge>
  ): AssociativeRankedItem[] {
    const nowMs = Date.parse(context.nowIso) || Date.now();
    const tokens = tokenizeQuery(context.query);
    const hasQuery = tokens.length > 0;

    const scored = candidates.map((cand): AssociativeRankedItem => {
      const node = cloneNodeReadOnly(cand.node);
      const epistemicCategory = classifyEpistemicCategory(
        node,
        cand.pathEpistemicTag,
        cand.hopDistance
      );

      const lexicalScore = hasQuery
        ? computeLexicalRelevance(node, context.query, tokens)
        : 0;

      const structuralBaseline =
        cand.hopDistance === 0 ? 1.0 : cand.hopDistance === 1 ? 0.72 : 0.48;

      let contextualRelevance = hasQuery
        ? cand.hopDistance === 0
          ? lexicalScore
          : clamp01(Math.max(lexicalScore, cand.directQueryMatchScore * (cand.hopDistance === 1 ? 0.68 : 0.45)))
        : structuralBaseline;

      if (
        context.preferredKinds &&
        context.preferredKinds.length > 0 &&
        context.preferredKinds.includes(node.kind)
      ) {
        contextualRelevance = clamp01(contextualRelevance + 0.08);
      }

      // Forza associativa basata sugli archi attraversati e distanza
      let associativeStrength = 1.0;
      if (cand.hopDistance > 0 && edgeLookup && cand.pathEdgeIds.length > 0) {
        const edgeWeights: number[] = [];
        let relMultSum = 0;
        for (const edgeId of cand.pathEdgeIds) {
          const edge = edgeLookup.get(edgeId);
          if (edge) {
            edgeWeights.push(edge.weight);
            let relMult = getRelationWeightMultiplier(edge.relationType);
            if (
              context.preferredRelations &&
              context.preferredRelations.includes(edge.relationType)
            ) {
              relMult = Math.min(1.05, relMult + 0.05);
            }
            relMultSum += relMult;
          }
        }
        const minWeight =
          edgeWeights.length > 0 ? propagatePathReliability(edgeWeights) : 0.5;
        const avgRelMult =
          cand.pathEdgeIds.length > 0 ? relMultSum / cand.pathEdgeIds.length : 0.9;
        const hopAttenuation = cand.hopDistance === 1 ? 0.9 : 0.65;
        associativeStrength = clamp01(minWeight * avgRelMult * hopAttenuation);
      } else if (cand.hopDistance > 0) {
        associativeStrength = cand.hopDistance === 1 ? 0.75 : 0.5;
      }

      const categoryReliabilityMult = getCategoryReliabilityMultiplier(epistemicCategory);
      const sourceReliability = clamp01(cand.pathReliability * categoryReliabilityMult);
      const temporalRecency = clamp01(computeTemporalRecency(node, nowMs));

      const finalScore = clamp01(
        contextualRelevance * 0.4 +
          associativeStrength * 0.25 +
          sourceReliability * 0.25 +
          temporalRecency * 0.1
      );

      const scoreBreakdown: AssociativeRetrievalScoreBreakdown = {
        contextualRelevance,
        associativeStrength,
        sourceReliability,
        temporalRecency,
        finalScore,
      };

      const seedLabel =
        nodeLabelLookup?.get(cand.seedNodeId) ??
        (cand.hopDistance === 0 ? node.label : cand.seedNodeId);

      const relationsText =
        cand.relations.length > 0 ? cand.relations.join(" -> ") : "corrispondenza diretta";
      const conflictNote =
        node.validationStatus === "conflicted"
          ? ` Stato conflittuale attivo (${node.conflictWithNodeIds?.length ?? 0} conflitti dichiarati): valutazione prudente richiesta.`
          : "";

      const relevanceReason =
        cand.hopDistance === 0
          ? `${describeCategoryLabel(epistemicCategory)} recuperato direttamente (${hasQuery ? "pertinenza testuale" : "nodo richiesto"}).${conflictNote}`
          : `${describeCategoryLabel(epistemicCategory)} collegato al nodo "${seedLabel}" in ${cand.hopDistance} hop tramite [${relationsText}].${conflictNote}`;

      const explanation: AssociativeRetrievalExplanation = {
        nodeId: node.id,
        nodeLabel: node.label,
        consentScope: node.consentScope,
        seedNodeId: cand.seedNodeId,
        seedNodeLabel: seedLabel,
        pathNodeIds: [...cand.pathNodeIds],
        pathEdgeIds: [...cand.pathEdgeIds],
        relations: [...cand.relations],
        hopDistance: cand.hopDistance,
        relevanceReason,
        provenance: { ...node.provenance },
        reliability: sourceReliability,
        epistemicTag: cand.pathEpistemicTag,
        epistemicCategory,
        validationStatus: node.validationStatus,
        conflictWithNodeIds: node.conflictWithNodeIds
          ? [...node.conflictWithNodeIds]
          : undefined,
      };

      return {
        node,
        hopDistance: cand.hopDistance,
        pathEdgeIds: [...cand.pathEdgeIds],
        pathEpistemicTag: cand.pathEpistemicTag,
        pathExplanation: relevanceReason,
        scoreBreakdown,
        seedNodeId: cand.seedNodeId,
        pathNodeIds: [...cand.pathNodeIds],
        relations: [...cand.relations],
        epistemicCategory,
        explanation,
      };
    });

    scored.sort((a, b) => {
      if (b.scoreBreakdown.finalScore !== a.scoreBreakdown.finalScore) {
        return b.scoreBreakdown.finalScore - a.scoreBreakdown.finalScore;
      }
      if (a.hopDistance !== b.hopDistance) {
        return a.hopDistance - b.hopDistance;
      }
      if (b.scoreBreakdown.sourceReliability !== a.scoreBreakdown.sourceReliability) {
        return b.scoreBreakdown.sourceReliability - a.scoreBreakdown.sourceReliability;
      }
      return a.node.id.localeCompare(b.node.id);
    });

    return scored;
  }

  explainRetrieval(
    source: AssociativeRetrievalDetailedResult | readonly AssociativeRankedItem[]
  ): AssociativeRetrievalExplanation[] {
    const items = Array.isArray(source)
      ? source
      : (source as AssociativeRetrievalDetailedResult).items ?? [];

    return items.map((item) => ({
      ...item.explanation,
      pathNodeIds: [...item.explanation.pathNodeIds],
      pathEdgeIds: [...item.explanation.pathEdgeIds],
      relations: [...item.explanation.relations],
      provenance: { ...item.explanation.provenance },
      conflictWithNodeIds: item.explanation.conflictWithNodeIds
        ? [...item.explanation.conflictWithNodeIds]
        : undefined,
    }));
  }

  private executeScopedRetrieval(
    input: AssociativeRetrievalInput,
    options?: {
      preferredKinds?: readonly AssociativeNodeKind[];
      preferredRelations?: readonly AssociativeRelationType[];
      requiredRelationsFilter?: readonly AssociativeRelationType[];
      restrictToExperienceKindsWhenNoQueryMatch?: boolean;
    }
  ): AssociativeRetrievalDetailedResult {
    const nowIso = input?.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso) || Date.now();
    const includeHypotheses = input?.includeHypotheses ?? true;

    const validation = this.validateRetrievalContext({
      ...input,
      nowIso,
    });

    if (!validation.allowed) {
      return {
        allowed: false,
        failClosed: true,
        safetyBlocked: validation.safetyBlocked,
        insufficientSignal: false,
        reason: validation.reason,
        blockedBy: validation.blockedBy,
        retrievedAt: nowIso,
        effectiveMaxHops: validation.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: validation.excludedScopes,
        accessDecision: validation.accessDecision,
      };
    }

    const authorizedSet = new Set<AssociativeConsentScope>(validation.authorizedScopes);
    const authorizedPersistentScopes = validation.authorizedScopes.filter(
      (s): s is PersistentAssociativeScope =>
        PERSISTENT_SCOPES.includes(s as PersistentAssociativeScope)
    );

    // 1. Raccolta nodi persistenti autorizzati (senza mai esportare session_ephemeral)
    const exported =
      authorizedPersistentScopes.length > 0
        ? this.graphEngine.exportAuthorizedGraph(input.consentState, {
            scopes: authorizedPersistentScopes,
            crisisBlocked: input.crisisBlocked,
            userTextForSafetyCheck: input.userTextForSafetyCheck ?? input.query,
            nowIso,
          })
        : null;

    if (exported && !exported.allowed) {
      return {
        allowed: false,
        failClosed: true,
        safetyBlocked:
          exported.blockedBy === "crisis" ||
          exported.blockedBy === "clinical_or_pii_content",
        insufficientSignal: false,
        reason: exported.reason,
        blockedBy: exported.blockedBy,
        retrievedAt: nowIso,
        effectiveMaxHops: validation.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: validation.excludedScopes,
        accessDecision: validation.accessDecision,
      };
    }

    const persistentNodes = new Map<string, AssociativeMemoryNode>();
    if (exported) {
      for (const scope of exported.includedScopes) {
        // Verifica autorizzazione in corso d'opera per ogni partizione
        const runtimeScopeCheck = evaluateAssociativeAccess({
          operation: "retrieve",
          scope,
          consentState: input.consentState,
          crisisBlocked: input.crisisBlocked,
          userTextForSafetyCheck: input.userTextForSafetyCheck ?? input.query,
          nowIso,
        });
        if (!runtimeScopeCheck.allowed) continue;

        const part = exported.partitions[scope];
        if (!part) continue;
        for (const node of part.nodes) {
          if (!authorizedSet.has(node.consentScope)) continue;
          if (!isNodeEligibleForRetrieval(node, nowMs, includeHypotheses)) continue;
          persistentNodes.set(node.id, cloneNodeReadOnly(node));
        }
      }
    }

    const rawQuery = (input.query ?? "").trim();
    const queryTokens = tokenizeQuery(rawQuery);
    const explicitSeedIds = Array.from(
      new Set((input.seedNodeIds ?? []).map((id) => id.trim()).filter(Boolean))
    );

    if (queryTokens.length === 0 && explicitSeedIds.length === 0) {
      return {
        allowed: true,
        failClosed: false,
        safetyBlocked: false,
        insufficientSignal: true,
        reason:
          "Segnale di ricerca insufficiente: specifica una query significativa o almeno un nodo di partenza.",
        retrievedAt: nowIso,
        effectiveMaxHops: validation.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: validation.excludedScopes,
        accessDecision: validation.accessDecision,
      };
    }

    // 2. Identificazione nodi seed autorizzati
    const seedRelevanceById = new Map<string, number>();
    for (const seedId of explicitSeedIds) {
      const node = persistentNodes.get(seedId);
      if (node) {
        const lex =
          queryTokens.length > 0 ? computeLexicalRelevance(node, rawQuery, queryTokens) : 1.0;
        seedRelevanceById.set(seedId, Math.max(0.75, lex));
      } else if (authorizedSet.has("session_ephemeral")) {
        // Seed potenziale in RAM (verificato tramite findConnectedPaths)
        seedRelevanceById.set(seedId, 0.85);
      }
    }

    if (queryTokens.length > 0) {
      const scoredMatches: Array<{ id: string; score: number }> = [];
      for (const node of persistentNodes.values()) {
        const lex = computeLexicalRelevance(node, rawQuery, queryTokens);
        if (lex > 0) {
          scoredMatches.push({ id: node.id, score: lex });
        }
      }
      scoredMatches.sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)
      );
      for (const match of scoredMatches.slice(0, validation.maxNodes)) {
        const prev = seedRelevanceById.get(match.id) ?? 0;
        if (match.score > prev) {
          seedRelevanceById.set(match.id, match.score);
        }
      }
    }

    const seedIds = Array.from(seedRelevanceById.keys());
    if (seedIds.length === 0) {
      return {
        allowed: true,
        failClosed: false,
        safetyBlocked: false,
        insufficientSignal: true,
        reason: "Nessun nodo autorizzato pertinente trovato per la richiesta.",
        retrievedAt: nowIso,
        effectiveMaxHops: validation.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: validation.excludedScopes,
        accessDecision: validation.accessDecision,
      };
    }

    // 3. Traversal associativo controllato (max 2 hop) tramite ExperienceGraphEngine
    const pathResult = this.graphEngine.findConnectedPaths(
      {
        seedNodeIds: seedIds,
        allowedScopes: validation.authorizedScopes,
        maxHops: validation.effectiveMaxHops,
        maxNodes: validation.maxNodes,
        maxEdges: validation.maxEdges,
        includeInactive: false,
        crisisBlocked: input.crisisBlocked,
        userTextForSafetyCheck: input.userTextForSafetyCheck ?? rawQuery,
        nowIso,
      },
      input.consentState,
      { nowIso }
    );

    if (!pathResult.allowed) {
      return {
        allowed: false,
        failClosed: true,
        safetyBlocked:
          pathResult.blockedBy === "crisis" ||
          pathResult.blockedBy === "clinical_or_pii_content",
        insufficientSignal: false,
        reason: pathResult.reason,
        blockedBy: pathResult.blockedBy,
        retrievedAt: nowIso,
        effectiveMaxHops: pathResult.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: pathResult.excludedScopes,
        accessDecision: validation.accessDecision,
      };
    }

    // 4. Verifica continua durante il recupero di nodi, archi, scope ed epistemica
    const runtimeAuthorizedEdges = new Map<string, AssociativeEdge>();
    for (const edge of pathResult.edges) {
      if (
        edge.validationStatus === "revoked" ||
        edge.validationStatus === "expired"
      ) {
        continue;
      }
      if (
        !authorizedSet.has(edge.sourceScope) ||
        !authorizedSet.has(edge.targetScope)
      ) {
        continue;
      }
      if (
        !includeHypotheses &&
        (edge.provenance.epistemicTag === "ipotesi_da_verificare" ||
          edge.provenance.evidenceType === "hypothesis")
      ) {
        continue;
      }
      const edgeGuard = evaluateAssociativeAccess({
        operation: "retrieve",
        scope: edge.sourceScope,
        secondaryScope:
          edge.targetScope !== edge.sourceScope ? edge.targetScope : undefined,
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        nowIso,
      });
      if (!edgeGuard.allowed) continue;

      if (
        options?.requiredRelationsFilter &&
        options.requiredRelationsFilter.length > 0 &&
        !options.requiredRelationsFilter.includes(edge.relationType)
      ) {
        continue;
      }

      runtimeAuthorizedEdges.set(edge.id, cloneEdgeReadOnly(edge));
    }

    const nodeLabelLookup = new Map<string, string>();
    for (const n of persistentNodes.values()) {
      nodeLabelLookup.set(n.id, n.label);
    }
    for (const p of pathResult.paths) {
      nodeLabelLookup.set(p.targetNode.id, p.targetNode.label);
    }

    const candidates: RetrievalCandidate[] = [];
    const survivingEdgeIds = new Set<string>();

    for (const path of pathResult.paths) {
      if (path.hopDistance > ASSOCIATIVE_LIMITS.MAX_TRAVERSAL_HOPS) continue;
      if (path.hopDistance > validation.effectiveMaxHops) continue;

      const node = path.targetNode;
      if (!authorizedSet.has(node.consentScope)) continue;
      if (!isNodeEligibleForRetrieval(node, nowMs, includeHypotheses)) continue;

      // Verifica autorizzazione in-flight sul singolo nodo
      const nodeGuard = evaluateAssociativeAccess({
        operation: "retrieve",
        scope: node.consentScope,
        consentState: input.consentState,
        crisisBlocked: input.crisisBlocked,
        targetId: node.id,
        nowIso,
      });
      if (!nodeGuard.allowed) continue;

      // Tutti gli archi lungo il path devono essere ancora autorizzati e validi
      const allPathEdgesValid = path.pathEdgeIds.every((eid) =>
        runtimeAuthorizedEdges.has(eid)
      );
      if (!allPathEdgesValid) continue;

      if (
        options?.restrictToExperienceKindsWhenNoQueryMatch &&
        path.hopDistance > 0 &&
        !EXPERIENCE_NODE_KINDS.has(node.kind)
      ) {
        continue;
      }

      const relations: AssociativeRelationType[] = [];
      const tags: EpistemicTag[] = [];
      const reliabilities: number[] = [];

      const seedId = path.pathNodeIds[0] ?? node.id;
      const seedNode = persistentNodes.get(seedId);
      if (seedNode) {
        tags.push(seedNode.provenance.epistemicTag);
        reliabilities.push(seedNode.reliability);
      }
      for (const edgeId of path.pathEdgeIds) {
        const edge = runtimeAuthorizedEdges.get(edgeId)!;
        relations.push(edge.relationType);
        tags.push(edge.provenance.epistemicTag);
        reliabilities.push(edge.weight);
      }
      tags.push(node.provenance.epistemicTag);
      reliabilities.push(node.reliability);

      const safeEpistemicTag = propagatePathEpistemicTag([
        path.pathEpistemicTag,
        ...tags,
      ]);
      const safeReliability = propagatePathReliability([
        path.pathReliability,
        ...reliabilities,
      ]);

      if (
        !includeHypotheses &&
        safeEpistemicTag === "ipotesi_da_verificare"
      ) {
        continue;
      }

      for (const eid of path.pathEdgeIds) {
        survivingEdgeIds.add(eid);
      }

      candidates.push({
        node,
        seedNodeId: seedId,
        hopDistance: path.hopDistance,
        pathNodeIds: [...path.pathNodeIds],
        pathEdgeIds: [...path.pathEdgeIds],
        relations,
        pathEpistemicTag: safeEpistemicTag,
        pathReliability: safeReliability,
        directQueryMatchScore: seedRelevanceById.get(seedId) ?? 0.5,
      });
    }

    if (candidates.length === 0) {
      return {
        allowed: true,
        failClosed: false,
        safetyBlocked: false,
        insufficientSignal: true,
        reason: "Nessun risultato associativo autorizzato disponibile per i criteri indicati.",
        retrievedAt: nowIso,
        effectiveMaxHops: validation.effectiveMaxHops,
        nodes: [],
        edges: [],
        items: [],
        explanations: [],
        excludedScopes: Array.from(
          new Set([...validation.excludedScopes, ...pathResult.excludedScopes])
        ),
        accessDecision: validation.accessDecision,
      };
    }

    const ranked = this.rankResults(
      candidates,
      {
        query: rawQuery,
        nowIso,
        preferredKinds: options?.preferredKinds,
        preferredRelations: options?.preferredRelations,
      },
      nodeLabelLookup,
      runtimeAuthorizedEdges
    ).slice(0, validation.maxNodes);

    const usedEdgeIds = new Set<string>();
    for (const item of ranked) {
      for (const eid of item.pathEdgeIds) {
        if (survivingEdgeIds.has(eid)) {
          usedEdgeIds.add(eid);
        }
      }
    }

    const finalEdges = Array.from(usedEdgeIds)
      .map((eid) => runtimeAuthorizedEdges.get(eid)!)
      .filter(Boolean)
      .slice(0, validation.maxEdges)
      .map(cloneEdgeReadOnly);

    const explanations = this.explainRetrieval(ranked);

    return {
      allowed: true,
      failClosed: false,
      safetyBlocked: false,
      insufficientSignal: ranked.length === 0,
      reason: `Recupero associativo completato in sola lettura (${ranked.length} nodi, max ${validation.effectiveMaxHops} hop).`,
      retrievedAt: nowIso,
      effectiveMaxHops: validation.effectiveMaxHops,
      nodes: ranked.map((item) => ({
        node: item.node,
        hopDistance: item.hopDistance,
        pathEdgeIds: item.pathEdgeIds,
        pathEpistemicTag: item.pathEpistemicTag,
        pathExplanation: item.pathExplanation,
        scoreBreakdown: item.scoreBreakdown,
      })),
      edges: finalEdges,
      items: ranked,
      explanations,
      excludedScopes: Array.from(
        new Set([...validation.excludedScopes, ...pathResult.excludedScopes])
      ),
      accessDecision: validation.accessDecision,
    };
  }

  retrieve(input: AssociativeRetrievalInput): AssociativeRetrievalDetailedResult {
    return this.executeScopedRetrieval(input);
  }

  retrieveByNode(input: RetrieveByNodeInput): AssociativeRetrievalDetailedResult {
    const cleanId = input?.nodeId?.trim();
    return this.executeScopedRetrieval(
      {
        query: input?.query ?? "",
        consentState: input?.consentState,
        seedNodeIds: cleanId ? [cleanId] : [],
        allowedScopes: input?.allowedScopes,
        maxHops: input?.maxHops,
        maxNodes: input?.maxNodes,
        maxEdges: input?.maxEdges,
        includeHypotheses: input?.includeHypotheses,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        nowIso: input?.nowIso,
      },
      {
        requiredRelationsFilter: input?.relationTypes,
      }
    );
  }

  retrieveRelatedExperiences(
    input: RetrieveRelatedExperiencesInput
  ): AssociativeRetrievalDetailedResult {
    const preferredKinds =
      input?.preferredKinds && input.preferredKinds.length > 0
        ? input.preferredKinds
        : Array.from(EXPERIENCE_NODE_KINDS);

    return this.executeScopedRetrieval(
      {
        query: input?.query ?? "",
        consentState: input?.consentState,
        seedNodeIds: input?.seedNodeIds,
        allowedScopes: input?.allowedScopes,
        maxHops: input?.maxHops,
        maxNodes: input?.maxNodes,
        maxEdges: input?.maxEdges,
        includeHypotheses: input?.includeHypotheses,
        crisisBlocked: input?.crisisBlocked,
        userTextForSafetyCheck: input?.userTextForSafetyCheck,
        nowIso: input?.nowIso,
      },
      {
        preferredKinds,
        preferredRelations: ["supports", "derived_from", "precedes", "hindered_by", "related_to"],
        restrictToExperienceKindsWhenNoQueryMatch: true,
      }
    );
  }
}
