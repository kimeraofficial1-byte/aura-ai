import { isSafeForLongTermMemory, redactSensitiveTokens } from "../memory/privacyFilter";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import {
  LocalStorageAdapter,
  MemoryStorageAdapter,
  type MinimalWebStorage,
} from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import {
  evaluateAssociativeAccess,
  propagatePathEpistemicTag,
  propagatePathReliability,
  resolveEdgeStorageScope,
  validateAndSanitizeAssociativeEdge,
  validateAndSanitizeMemoryNode,
} from "./associativeMemoryGuard";
import {
  ASSOCIATIVE_GRAPH_STORAGE_KEYS,
  ASSOCIATIVE_LIMITS,
  type AssociativeAccessDecision,
  type AssociativeAuditEntry,
  type AssociativeConsentScope,
  type AssociativeEdge,
  type AssociativeGuardBlockReason,
  type AssociativeMemoryNode,
  type AssociativePartitionSnapshot,
  type CreateAssociativeEdgeInput,
  type CreateMemoryNodeInput,
  type PersistentAssociativeScope,
} from "./associativeTypes";
import type { CognitiveTimelineEvent } from "./continuityTypes";
import type { EpistemicTag, LearningConsentState } from "./selfLearningTypes";

const PERSISTENT_SCOPES: readonly PersistentAssociativeScope[] = [
  "operational",
  "ai_memory",
  "learning",
];

const ALL_SCOPES: readonly AssociativeConsentScope[] = [
  "operational",
  "ai_memory",
  "learning",
  "session_ephemeral",
];

function getStorageKeyForScope(scope: PersistentAssociativeScope): string {
  switch (scope) {
    case "operational":
      return ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational;
    case "ai_memory":
      return ASSOCIATIVE_GRAPH_STORAGE_KEYS.aiMemory;
    case "learning":
      return ASSOCIATIVE_GRAPH_STORAGE_KEYS.learning;
  }
}

export interface GraphOperationOptions {
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  nowIso?: string;
}

export interface GraphUpsertNodeResult {
  allowed: boolean;
  failClosed: boolean;
  created: boolean;
  updated: boolean;
  deduplicated: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  node?: AssociativeMemoryNode;
  decision: AssociativeAccessDecision;
}

export interface GraphUpsertEdgeResult {
  allowed: boolean;
  failClosed: boolean;
  created: boolean;
  updated: boolean;
  deduplicated: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  edge?: AssociativeEdge;
  decision: AssociativeAccessDecision;
}

export interface MarkNodeConflictedInput {
  nodeId: string;
  scope: AssociativeConsentScope;
  conflictingNodeIds: string[];
  conflictingScope?: AssociativeConsentScope;
  note?: string;
  nowIso?: string;
}

export interface MarkNodeSupersededInput {
  nodeId: string;
  scope: AssociativeConsentScope;
  supersededByNodeId: string;
  supersededByScope?: AssociativeConsentScope;
  note?: string;
  nowIso?: string;
}

export interface GraphNodeUpdateResult {
  allowed: boolean;
  failClosed: boolean;
  updated: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  node?: AssociativeMemoryNode;
  decision: AssociativeAccessDecision;
}

export interface FindConnectedPathsInput {
  seedNodeIds: string[];
  allowedScopes?: AssociativeConsentScope[];
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeInactive?: boolean;
  userTextForSafetyCheck?: string;
  crisisBlocked?: boolean;
  nowIso?: string;
}

export interface ConnectedGraphPath {
  targetNode: AssociativeMemoryNode;
  hopDistance: number;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  pathEpistemicTag: EpistemicTag;
  pathReliability: number;
}

export interface GraphPathSearchResult {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  paths: ConnectedGraphPath[];
  nodes: AssociativeMemoryNode[];
  edges: AssociativeEdge[];
  excludedScopes: AssociativeConsentScope[];
  effectiveMaxHops: number;
}

export interface OperationalSyncInput {
  growthGoals?: GrowthGoal[];
  plans?: PersonalPlan[];
  missions?: AdaptiveMission[];
  timelineEvents?: CognitiveTimelineEvent[];
  nowIso?: string;
}

export interface OperationalSyncResult {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  nodesCreated: number;
  nodesUpdated: number;
  nodesDeduplicated: number;
  edgesCreated: number;
  edgesUpdated: number;
  edgesDeduplicated: number;
  rejectedItemsCount: number;
}

export interface GraphClearResult {
  allowed: boolean;
  failClosed: boolean;
  cleared: boolean;
  scope: AssociativeConsentScope;
  removedNodesCount: number;
  removedEdgesCount: number;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  decision: AssociativeAccessDecision;
}

export interface GraphExportOptions extends GraphOperationOptions {
  scopes?: AssociativeConsentScope[];
}

export interface GraphExportResult {
  exportType: "aura_experience_graph";
  version: 1;
  exportedAt: string;
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  includedScopes: PersistentAssociativeScope[];
  excludedScopes: AssociativeConsentScope[];
  partitions: Partial<Record<PersistentAssociativeScope, AssociativePartitionSnapshot>>;
  totalNodes: number;
  totalEdges: number;
}

interface LoadedPartition {
  corrupted: boolean;
  snapshot: AssociativePartitionSnapshot;
}

function isValidStoredNode(item: unknown): item is AssociativeMemoryNode {
  if (!item || typeof item !== "object") return false;
  const n = item as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    n.id.trim().length > 0 &&
    typeof n.canonicalKey === "string" &&
    typeof n.kind === "string" &&
    typeof n.label === "string" &&
    typeof n.summary === "string" &&
    Array.isArray(n.keywords) &&
    typeof n.consentScope === "string" &&
    Boolean(n.provenance && typeof n.provenance === "object") &&
    typeof n.reliability === "number" &&
    Number.isFinite(n.reliability) &&
    typeof n.validationStatus === "string" &&
    typeof n.version === "number"
  );
}

function isValidStoredEdge(item: unknown): item is AssociativeEdge {
  if (!item || typeof item !== "object") return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.trim().length > 0 &&
    typeof e.canonicalKey === "string" &&
    typeof e.sourceNodeId === "string" &&
    typeof e.targetNodeId === "string" &&
    typeof e.sourceScope === "string" &&
    typeof e.targetScope === "string" &&
    typeof e.storageScope === "string" &&
    typeof e.relationType === "string" &&
    typeof e.direction === "string" &&
    Boolean(e.provenance && typeof e.provenance === "object") &&
    typeof e.weight === "number" &&
    Number.isFinite(e.weight) &&
    typeof e.validationStatus === "string" &&
    typeof e.version === "number"
  );
}

function areArraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function isNodeFunctionallyEqual(
  existing: AssociativeMemoryNode,
  incoming: AssociativeMemoryNode
): boolean {
  return (
    existing.kind === incoming.kind &&
    existing.label === incoming.label &&
    existing.summary === incoming.summary &&
    areArraysEqual(existing.keywords, incoming.keywords) &&
    existing.consentScope === incoming.consentScope &&
    existing.provenance.sourceEngine === incoming.provenance.sourceEngine &&
    existing.provenance.sourceRecordId === incoming.provenance.sourceRecordId &&
    existing.provenance.evidenceType === incoming.provenance.evidenceType &&
    existing.provenance.epistemicTag === incoming.provenance.epistemicTag &&
    existing.provenance.note === incoming.provenance.note &&
    existing.reliability === incoming.reliability &&
    existing.validationStatus === incoming.validationStatus &&
    existing.expiresAt === incoming.expiresAt &&
    existing.supersededByNodeId === incoming.supersededByNodeId &&
    areArraysEqual(existing.conflictWithNodeIds, incoming.conflictWithNodeIds)
  );
}

function isEdgeFunctionallyEqual(
  existing: AssociativeEdge,
  incoming: AssociativeEdge
): boolean {
  const isSymmetricBidirectional =
    existing.direction === "bidirectional" &&
    incoming.direction === "bidirectional" &&
    existing.relationType === incoming.relationType &&
    (existing.relationType === "related_to" || existing.relationType === "contradicts");

  const endpointsMatchDirect =
    existing.sourceNodeId === incoming.sourceNodeId &&
    existing.targetNodeId === incoming.targetNodeId &&
    existing.sourceScope === incoming.sourceScope &&
    existing.targetScope === incoming.targetScope;

  const endpointsMatchReversed =
    isSymmetricBidirectional &&
    existing.sourceNodeId === incoming.targetNodeId &&
    existing.targetNodeId === incoming.sourceNodeId &&
    existing.sourceScope === incoming.targetScope &&
    existing.targetScope === incoming.sourceScope;

  return (
    (endpointsMatchDirect || endpointsMatchReversed) &&
    existing.storageScope === incoming.storageScope &&
    existing.relationType === incoming.relationType &&
    existing.direction === incoming.direction &&
    existing.provenance.createdByEngine === incoming.provenance.createdByEngine &&
    existing.provenance.evidenceType === incoming.provenance.evidenceType &&
    existing.provenance.epistemicTag === incoming.provenance.epistemicTag &&
    existing.provenance.supportingNote === incoming.provenance.supportingNote &&
    areArraysEqual(
      existing.provenance.supportingEvidenceIds,
      incoming.provenance.supportingEvidenceIds
    ) &&
    existing.weight === incoming.weight &&
    existing.validationStatus === incoming.validationStatus
  );
}

function isNodeActive(node: AssociativeMemoryNode, nowMs: number): boolean {
  if (node.validationStatus === "revoked" || node.validationStatus === "expired") {
    return false;
  }
  if (node.expiresAt) {
    const expMs = Date.parse(node.expiresAt);
    if (!Number.isNaN(expMs) && expMs <= nowMs) {
      return false;
    }
  }
  return true;
}

function isEdgeActive(edge: AssociativeEdge): boolean {
  return edge.validationStatus !== "revoked" && edge.validationStatus !== "expired";
}

function cloneNode(node: AssociativeMemoryNode): AssociativeMemoryNode {
  return {
    ...node,
    keywords: [...node.keywords],
    provenance: { ...node.provenance },
    conflictWithNodeIds: node.conflictWithNodeIds
      ? [...node.conflictWithNodeIds]
      : undefined,
  };
}

function cloneEdge(edge: AssociativeEdge): AssociativeEdge {
  return {
    ...edge,
    provenance: {
      ...edge.provenance,
      supportingEvidenceIds: [...edge.provenance.supportingEvidenceIds],
    },
  };
}

/**
 * Experience Graph Engine & Partitioned Store V1 (Fase 11.2.2).
 *
 * Gestisce il grafo associativo su tre partizioni fisiche separate
 * (`operational`, `ai_memory`, `learning`) più una partizione effimera in RAM (`session_ephemeral`),
 * applicando obbligatoriamente `AssociativeMemoryGuard` per ogni operazione.
 */
export class ExperienceGraphEngine {
  private readonly adapter: StorageAdapter;
  private readonly sessionNodes = new Map<string, AssociativeMemoryNode>();
  private readonly sessionEdges = new Map<string, AssociativeEdge>();
  private readonly auditLog: AssociativeAuditEntry[] = [];

  constructor(storage?: MinimalWebStorage | StorageAdapter | null) {
    if (storage && "isAvailable" in storage) {
      this.adapter = storage;
    } else {
      const local = new LocalStorageAdapter(storage);
      this.adapter = local.isAvailable() ? local : new MemoryStorageAdapter();
    }
  }

  private recordAudit(entry: AssociativeAuditEntry): void {
    this.auditLog.push({ ...entry });
    if (this.auditLog.length > ASSOCIATIVE_LIMITS.MAX_AUDIT_ENTRIES) {
      this.auditLog.splice(0, this.auditLog.length - ASSOCIATIVE_LIMITS.MAX_AUDIT_ENTRIES);
    }
  }

  getAuditLog(): AssociativeAuditEntry[] {
    return this.auditLog.map((e) => ({ ...e }));
  }

  private createEmptyPartition(
    scope: PersistentAssociativeScope,
    nowIso: string
  ): AssociativePartitionSnapshot {
    return {
      version: 1,
      scope,
      updatedAt: nowIso,
      nodes: [],
      edges: [],
    };
  }

  private loadPartition(scope: AssociativeConsentScope, nowIso: string): LoadedPartition {
    if (scope === "session_ephemeral") {
      return {
        corrupted: false,
        snapshot: {
          version: 1,
          scope: "operational",
          updatedAt: nowIso,
          nodes: Array.from(this.sessionNodes.values()).map(cloneNode),
          edges: Array.from(this.sessionEdges.values()).map(cloneEdge),
        },
      };
    }

    const key = getStorageKeyForScope(scope);
    const raw = this.adapter.getItem(key);
    if (!raw) {
      return {
        corrupted: false,
        snapshot: this.createEmptyPartition(scope, nowIso),
      };
    }

    try {
      const parsed = JSON.parse(raw) as Partial<AssociativePartitionSnapshot>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.version !== 1 ||
        parsed.scope !== scope ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.edges)
      ) {
        return {
          corrupted: true,
          snapshot: this.createEmptyPartition(scope, nowIso),
        };
      }

      const validNodes = parsed.nodes.filter(isValidStoredNode).map(cloneNode);
      const validEdges = parsed.edges.filter(isValidStoredEdge).map(cloneEdge);
      if (
        validNodes.length !== parsed.nodes.length ||
        validEdges.length !== parsed.edges.length
      ) {
        return {
          corrupted: true,
          snapshot: this.createEmptyPartition(scope, nowIso),
        };
      }

      return {
        corrupted: false,
        snapshot: {
          version: 1,
          scope,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso,
          nodes: validNodes,
          edges: validEdges,
        },
      };
    } catch {
      return {
        corrupted: true,
        snapshot: this.createEmptyPartition(scope, nowIso),
      };
    }
  }

  private savePersistentPartition(
    scope: PersistentAssociativeScope,
    snapshot: AssociativePartitionSnapshot,
    nowIso: string
  ): void {
    const key = getStorageKeyForScope(scope);
    const normalized: AssociativePartitionSnapshot = {
      version: 1,
      scope,
      updatedAt: nowIso,
      nodes: snapshot.nodes.map(cloneNode),
      edges: snapshot.edges.map(cloneEdge),
    };
    this.adapter.setItem(key, JSON.stringify(normalized));
  }

  private getScopeNodes(scope: AssociativeConsentScope, nowIso: string): LoadedPartition {
    return this.loadPartition(scope, nowIso);
  }

  private countEdgesForNode(nodeId: string, nowIso: string): number {
    let count = 0;
    for (const edge of this.sessionEdges.values()) {
      if (
        isEdgeActive(edge) &&
        (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
      ) {
        count += 1;
      }
    }
    for (const scope of PERSISTENT_SCOPES) {
      const loaded = this.loadPartition(scope, nowIso);
      if (loaded.corrupted) continue;
      for (const edge of loaded.snapshot.edges) {
        if (
          isEdgeActive(edge) &&
          (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
        ) {
          count += 1;
        }
      }
    }
    return count;
  }

  private hasDirectedPath(
    startNodeId: string,
    goalNodeId: string,
    nowIso: string
  ): boolean {
    if (startNodeId === goalNodeId) return true;
    const adjacency = new Map<string, string[]>();

    const collectEdges = (edges: readonly AssociativeEdge[]) => {
      for (const edge of edges) {
        if (!isEdgeActive(edge)) continue;
        if (edge.direction !== "directed") continue;
        const list = adjacency.get(edge.sourceNodeId) ?? [];
        list.push(edge.targetNodeId);
        adjacency.set(edge.sourceNodeId, list);
      }
    };

    collectEdges(Array.from(this.sessionEdges.values()));
    for (const scope of PERSISTENT_SCOPES) {
      const loaded = this.loadPartition(scope, nowIso);
      if (!loaded.corrupted) {
        collectEdges(loaded.snapshot.edges);
      }
    }

    const visited = new Set<string>([startNodeId]);
    const queue: string[] = [startNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacency.get(current) ?? [];
      for (const next of neighbors) {
        if (next === goalNodeId) return true;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  upsertNode(
    input: CreateMemoryNodeInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphUpsertNodeResult {
    const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();
    const targetScope = input?.consentScope ?? "operational";
    const loaded =
      targetScope === "session_ephemeral" || PERSISTENT_SCOPES.includes(targetScope as PersistentAssociativeScope)
        ? this.loadPartition(targetScope, nowIso)
        : { corrupted: false, snapshot: this.createEmptyPartition("operational", nowIso) };

    const validation = validateAndSanitizeMemoryNode(input, consentState, {
      crisisBlocked: options?.crisisBlocked,
      storageAvailable: this.adapter.isAvailable(),
      corruptedDataDetected: loaded.corrupted,
      nowIso,
    });

    if (!validation.allowed || !validation.sanitizedNode) {
      this.recordAudit(validation.decision.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: validation.reason,
        blockedBy: validation.blockedBy,
        decision: validation.decision,
      };
    }

    const sanitized = validation.sanitizedNode;
    const nodes = loaded.snapshot.nodes;
    const existingIdx = nodes.findIndex(
      (n) => n.id === sanitized.id || n.canonicalKey === sanitized.canonicalKey
    );

    if (existingIdx >= 0) {
      const existing = nodes[existingIdx];

      // Impedisce qualsiasi promozione epistemica automatica di un'ipotesi esistente
      if (
        existing.provenance.epistemicTag === "ipotesi_da_verificare" &&
        sanitized.provenance.evidenceType !== "explicit_feedback" &&
        (sanitized.provenance.epistemicTag !== "ipotesi_da_verificare" ||
          sanitized.validationStatus === "confirmed" ||
          sanitized.validationStatus === "observed")
      ) {
        const denyDecision = evaluateAssociativeAccess({
          operation: "write",
          scope: sanitized.consentScope,
          consentState,
          requestedConfirmation: true,
          evidenceType: sanitized.provenance.evidenceType,
          epistemicTag: existing.provenance.epistemicTag,
          targetId: existing.id,
          nowIso,
        });
        this.recordAudit(denyDecision.auditEntry);
        return {
          allowed: false,
          failClosed: true,
          created: false,
          updated: false,
          deduplicated: false,
          reason:
            "Un nodo registrato come ipotesi non può essere promosso a fatto osservato/confermato senza explicit_feedback.",
          blockedBy: "hypothesis_promotion_forbidden",
          decision: denyDecision,
        };
      }

      if (isNodeFunctionallyEqual(existing, sanitized)) {
        this.recordAudit({
          ...validation.decision.auditEntry,
          targetId: existing.id,
          reason: "Nodo già presente con contenuto identico (idempotente).",
        });
        return {
          allowed: true,
          failClosed: false,
          created: false,
          updated: false,
          deduplicated: true,
          reason: "Nodo deduplicato in modo idempotente senza duplicazione.",
          node: cloneNode(existing),
          decision: validation.decision,
        };
      }

      const mergedKeywords = Array.from(
        new Set([...existing.keywords, ...sanitized.keywords])
      ).slice(0, ASSOCIATIVE_LIMITS.MAX_KEYWORDS_PER_NODE);

      const updatedNode: AssociativeMemoryNode = {
        ...sanitized,
        id: existing.id,
        canonicalKey: existing.canonicalKey,
        keywords: mergedKeywords,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
      };

      if (sanitized.consentScope === "session_ephemeral") {
        this.sessionNodes.set(updatedNode.id, cloneNode(updatedNode));
      } else {
        nodes[existingIdx] = cloneNode(updatedNode);
        this.savePersistentPartition(sanitized.consentScope, loaded.snapshot, nowIso);
      }

      this.recordAudit({
        ...validation.decision.auditEntry,
        targetId: updatedNode.id,
        reason: `Nodo aggiornato alla versione ${updatedNode.version} nello scope "${updatedNode.consentScope}".`,
      });
      return {
        allowed: true,
        failClosed: false,
        created: false,
        updated: true,
        deduplicated: false,
        reason: "Nodo associativo aggiornato in modo deterministico.",
        node: cloneNode(updatedNode),
        decision: validation.decision,
      };
    }

    if (nodes.length >= ASSOCIATIVE_LIMITS.MAX_NODES_PER_SCOPE) {
      const capDecision = evaluateAssociativeAccess({
        operation: "write",
        scope: sanitized.consentScope,
        consentState,
        targetId: sanitized.id,
        nowIso,
      });
      const blockedAudit: AssociativeAuditEntry = {
        ...capDecision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: `Limite massimo nodi per scope "${sanitized.consentScope}" raggiunto (${ASSOCIATIVE_LIMITS.MAX_NODES_PER_SCOPE}).`,
      };
      this.recordAudit(blockedAudit);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: blockedAudit.reason,
        blockedBy: "invalid_payload",
        decision: {
          ...capDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: blockedAudit.reason,
          auditEntry: blockedAudit,
        },
      };
    }

    if (sanitized.consentScope === "session_ephemeral") {
      this.sessionNodes.set(sanitized.id, cloneNode(sanitized));
    } else {
      nodes.push(cloneNode(sanitized));
      this.savePersistentPartition(sanitized.consentScope, loaded.snapshot, nowIso);
    }

    this.recordAudit({
      ...validation.decision.auditEntry,
      targetId: sanitized.id,
      reason: `Nuovo nodo creato nello scope "${sanitized.consentScope}".`,
    });

    return {
      allowed: true,
      failClosed: false,
      created: true,
      updated: false,
      deduplicated: false,
      reason: "Nuovo nodo associativo inserito nella partizione dedicata.",
      node: cloneNode(sanitized),
      decision: validation.decision,
    };
  }

  upsertEdge(
    input: CreateAssociativeEdgeInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphUpsertEdgeResult {
    const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();
    const storageScope =
      input?.sourceScope && input?.targetScope
        ? resolveEdgeStorageScope(input.sourceScope, input.targetScope)
        : "operational";

    const sourceLoaded = input?.sourceScope
      ? this.loadPartition(input.sourceScope, nowIso)
      : { corrupted: false, snapshot: this.createEmptyPartition("operational", nowIso) };
    const targetLoaded = input?.targetScope
      ? this.loadPartition(input.targetScope, nowIso)
      : { corrupted: false, snapshot: this.createEmptyPartition("operational", nowIso) };
    const storageLoaded = this.loadPartition(storageScope, nowIso);

    const validation = validateAndSanitizeAssociativeEdge(input, consentState, {
      crisisBlocked: options?.crisisBlocked,
      storageAvailable: this.adapter.isAvailable(),
      corruptedDataDetected:
        sourceLoaded.corrupted || targetLoaded.corrupted || storageLoaded.corrupted,
      nowIso,
    });

    if (!validation.allowed || !validation.sanitizedEdge) {
      this.recordAudit(validation.decision.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: validation.reason,
        blockedBy: validation.blockedBy,
        decision: validation.decision,
      };
    }

    const sanitized = validation.sanitizedEdge;
    const sourceNode = sourceLoaded.snapshot.nodes.find(
      (n) => n.id === sanitized.sourceNodeId
    );
    const targetNode = targetLoaded.snapshot.nodes.find(
      (n) => n.id === sanitized.targetNodeId
    );

    if (!sourceNode || !targetNode) {
      const missingReason =
        "Impossibile creare la relazione: uno o entrambi i nodi non esistono negli scope dichiarati.";
      const missingAudit: AssociativeAuditEntry = {
        ...validation.decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: missingReason,
        targetId: sanitized.id,
      };
      this.recordAudit(missingAudit);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: missingReason,
        blockedBy: "invalid_payload",
        decision: {
          ...validation.decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: missingReason,
          auditEntry: missingAudit,
        },
      };
    }

    const edges = storageLoaded.snapshot.edges;
    const existingIdx = edges.findIndex(
      (e) => e.canonicalKey === sanitized.canonicalKey || e.id === sanitized.id
    );

    if (existingIdx >= 0) {
      const existing = edges[existingIdx];

      if (
        existing.provenance.epistemicTag === "ipotesi_da_verificare" &&
        sanitized.provenance.evidenceType !== "explicit_feedback" &&
        (sanitized.provenance.epistemicTag !== "ipotesi_da_verificare" ||
          sanitized.validationStatus === "confirmed" ||
          sanitized.validationStatus === "observed")
      ) {
        const denyReason =
          "Una relazione ipotetica esistente non può essere promossa senza explicit_feedback.";
        const denyAudit: AssociativeAuditEntry = {
          ...validation.decision.auditEntry,
          allowed: false,
          blockedBy: "hypothesis_promotion_forbidden",
          reason: denyReason,
          targetId: existing.id,
        };
        this.recordAudit(denyAudit);
        return {
          allowed: false,
          failClosed: true,
          created: false,
          updated: false,
          deduplicated: false,
          reason: denyReason,
          blockedBy: "hypothesis_promotion_forbidden",
          decision: {
            ...validation.decision,
            allowed: false,
            failClosed: true,
            blockedBy: "hypothesis_promotion_forbidden",
            reason: denyReason,
            auditEntry: denyAudit,
          },
        };
      }

      if (isEdgeFunctionallyEqual(existing, sanitized)) {
        this.recordAudit({
          ...validation.decision.auditEntry,
          targetId: existing.id,
          reason: "Relazione associativa già presente e identica (idempotente).",
        });
        return {
          allowed: true,
          failClosed: false,
          created: false,
          updated: false,
          deduplicated: true,
          reason: "Relazione deduplicata in modo idempotente.",
          edge: cloneEdge(existing),
          decision: validation.decision,
        };
      }

      const updatedEdge: AssociativeEdge = {
        ...sanitized,
        id: existing.id,
        canonicalKey: existing.canonicalKey,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
      };

      if (updatedEdge.storageScope === "session_ephemeral") {
        this.sessionEdges.set(updatedEdge.id, cloneEdge(updatedEdge));
      } else {
        edges[existingIdx] = cloneEdge(updatedEdge);
        this.savePersistentPartition(
          updatedEdge.storageScope,
          storageLoaded.snapshot,
          nowIso
        );
      }

      this.recordAudit({
        ...validation.decision.auditEntry,
        targetId: updatedEdge.id,
        reason: `Relazione aggiornata alla versione ${updatedEdge.version}.`,
      });
      return {
        allowed: true,
        failClosed: false,
        created: false,
        updated: true,
        deduplicated: false,
        reason: "Relazione associativa aggiornata.",
        edge: cloneEdge(updatedEdge),
        decision: validation.decision,
      };
    }

    // Prevenzione cicli diretti su relazioni direzionali
    if (
      sanitized.direction === "directed" &&
      this.hasDirectedPath(sanitized.targetNodeId, sanitized.sourceNodeId, nowIso)
    ) {
      const cycleReason =
        "Relazione rifiutata: introdurrebbe un ciclo diretto nel grafo associativo.";
      const cycleAudit: AssociativeAuditEntry = {
        ...validation.decision.auditEntry,
        allowed: false,
        blockedBy: "cycle_or_depth_exceeded",
        reason: cycleReason,
        targetId: sanitized.id,
      };
      this.recordAudit(cycleAudit);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: cycleReason,
        blockedBy: "cycle_or_depth_exceeded",
        decision: {
          ...validation.decision,
          allowed: false,
          failClosed: true,
          blockedBy: "cycle_or_depth_exceeded",
          reason: cycleReason,
          auditEntry: cycleAudit,
        },
      };
    }

    // Limiti massimi per partizione e per singolo nodo
    if (edges.length >= ASSOCIATIVE_LIMITS.MAX_EDGES_PER_SCOPE) {
      const capReason = `Limite massimo archi per partizione "${sanitized.storageScope}" raggiunto (${ASSOCIATIVE_LIMITS.MAX_EDGES_PER_SCOPE}).`;
      const capAudit: AssociativeAuditEntry = {
        ...validation.decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: capReason,
        targetId: sanitized.id,
      };
      this.recordAudit(capAudit);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: capReason,
        blockedBy: "invalid_payload",
        decision: {
          ...validation.decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: capReason,
          auditEntry: capAudit,
        },
      };
    }

    const sourceDegree = this.countEdgesForNode(sanitized.sourceNodeId, nowIso);
    const targetDegree = this.countEdgesForNode(sanitized.targetNodeId, nowIso);
    if (
      sourceDegree >= ASSOCIATIVE_LIMITS.MAX_EDGES_PER_NODE ||
      targetDegree >= ASSOCIATIVE_LIMITS.MAX_EDGES_PER_NODE
    ) {
      const degReason = `Limite massimo di archi per nodo raggiunto (${ASSOCIATIVE_LIMITS.MAX_EDGES_PER_NODE}).`;
      const degAudit: AssociativeAuditEntry = {
        ...validation.decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: degReason,
        targetId: sanitized.id,
      };
      this.recordAudit(degAudit);
      return {
        allowed: false,
        failClosed: true,
        created: false,
        updated: false,
        deduplicated: false,
        reason: degReason,
        blockedBy: "invalid_payload",
        decision: {
          ...validation.decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: degReason,
          auditEntry: degAudit,
        },
      };
    }

    if (sanitized.storageScope === "session_ephemeral") {
      this.sessionEdges.set(sanitized.id, cloneEdge(sanitized));
    } else {
      edges.push(cloneEdge(sanitized));
      this.savePersistentPartition(sanitized.storageScope, storageLoaded.snapshot, nowIso);
    }

    this.recordAudit({
      ...validation.decision.auditEntry,
      targetId: sanitized.id,
      reason: `Nuova relazione "${sanitized.relationType}" salvata in "${sanitized.storageScope}".`,
    });

    return {
      allowed: true,
      failClosed: false,
      created: true,
      updated: false,
      deduplicated: false,
      reason: "Relazione associativa creata nella partizione autorizzata.",
      edge: cloneEdge(sanitized),
      decision: validation.decision,
    };
  }

  markNodeConflicted(
    input: MarkNodeConflictedInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphNodeUpdateResult {
    const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();
    const loaded = input?.scope
      ? this.loadPartition(input.scope, nowIso)
      : { corrupted: false, snapshot: this.createEmptyPartition("operational", nowIso) };

    const decision = evaluateAssociativeAccess({
      operation: "write",
      scope: input?.scope,
      secondaryScope: input?.conflictingScope,
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: input?.note ?? options?.userTextForSafetyCheck,
      storageAvailable: this.adapter.isAvailable(),
      corruptedDataDetected: loaded.corrupted,
      targetId: input?.nodeId,
      nowIso,
    });

    if (!decision.allowed) {
      this.recordAudit(decision.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: decision.reason,
        blockedBy: decision.blockedBy,
        decision,
      };
    }

    const nodeIdx = loaded.snapshot.nodes.findIndex((n) => n.id === input.nodeId);
    if (nodeIdx < 0) {
      const missingAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: `Nodo "${input.nodeId}" non trovato nello scope "${input.scope}".`,
      };
      this.recordAudit(missingAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: missingAudit.reason,
        blockedBy: "invalid_payload",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: missingAudit.reason,
          auditEntry: missingAudit,
        },
      };
    }

    const cleanConflicts = Array.from(
      new Set(
        (input.conflictingNodeIds ?? [])
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id !== input.nodeId)
      )
    );
    if (cleanConflicts.length === 0) {
      const invalidAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: "Almeno un conflictingNodeIds valido è richiesto per marcare il conflitto.",
      };
      this.recordAudit(invalidAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: invalidAudit.reason,
        blockedBy: "invalid_payload",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: invalidAudit.reason,
          auditEntry: invalidAudit,
        },
      };
    }

    if (input.note && !isSafeForLongTermMemory(input.note)) {
      const piiAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "clinical_or_pii_content",
        reason: "Nota di conflitto rifiutata per contenuto clinico o dato sensibile.",
      };
      this.recordAudit(piiAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: piiAudit.reason,
        blockedBy: "clinical_or_pii_content",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "clinical_or_pii_content",
          reason: piiAudit.reason,
          auditEntry: piiAudit,
        },
      };
    }

    const existing = loaded.snapshot.nodes[nodeIdx];
    const mergedConflicts = Array.from(
      new Set([...(existing.conflictWithNodeIds ?? []), ...cleanConflicts])
    ).sort();
    const sanitizedNote = input.note
      ? redactSensitiveTokens(input.note).slice(0, ASSOCIATIVE_LIMITS.MAX_NOTE_LENGTH)
      : existing.provenance.note;

    if (
      existing.validationStatus === "conflicted" &&
      areArraysEqual(existing.conflictWithNodeIds, mergedConflicts) &&
      existing.provenance.note === sanitizedNote
    ) {
      this.recordAudit({
        ...decision.auditEntry,
        reason: "Stato conflicted già aggiornato con gli stessi riferimenti (idempotente).",
      });
      return {
        allowed: true,
        failClosed: false,
        updated: false,
        reason: "Stato di conflitto già registrato (idempotente).",
        node: cloneNode(existing),
        decision,
      };
    }

    const updated: AssociativeMemoryNode = {
      ...cloneNode(existing),
      validationStatus: "conflicted",
      conflictWithNodeIds: mergedConflicts,
      provenance: {
        ...existing.provenance,
        note: sanitizedNote,
      },
      version: existing.version + 1,
      updatedAt: nowIso,
    };

    if (input.scope === "session_ephemeral") {
      this.sessionNodes.set(updated.id, cloneNode(updated));
    } else {
      loaded.snapshot.nodes[nodeIdx] = cloneNode(updated);
      this.savePersistentPartition(input.scope, loaded.snapshot, nowIso);
    }

    this.recordAudit({
      ...decision.auditEntry,
      reason: `Nodo "${updated.id}" marcato come conflicted.`,
    });
    return {
      allowed: true,
      failClosed: false,
      updated: true,
      reason: "Conflitto registrato in modo conservativo sul nodo.",
      node: cloneNode(updated),
      decision,
    };
  }

  markNodeSuperseded(
    input: MarkNodeSupersededInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphNodeUpdateResult {
    const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();
    const loaded = input?.scope
      ? this.loadPartition(input.scope, nowIso)
      : { corrupted: false, snapshot: this.createEmptyPartition("operational", nowIso) };

    const decision = evaluateAssociativeAccess({
      operation: "write",
      scope: input?.scope,
      secondaryScope: input?.supersededByScope,
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: input?.note ?? options?.userTextForSafetyCheck,
      storageAvailable: this.adapter.isAvailable(),
      corruptedDataDetected: loaded.corrupted,
      targetId: input?.nodeId,
      nowIso,
    });

    if (!decision.allowed) {
      this.recordAudit(decision.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: decision.reason,
        blockedBy: decision.blockedBy,
        decision,
      };
    }

    const targetReplacementId = input.supersededByNodeId?.trim();
    if (!targetReplacementId || targetReplacementId === input.nodeId) {
      const blockReason: AssociativeGuardBlockReason =
        targetReplacementId === input.nodeId ? "cycle_or_depth_exceeded" : "invalid_payload";
      const cycleAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: blockReason,
        reason:
          blockReason === "cycle_or_depth_exceeded"
            ? "Un nodo non può sostituire sé stesso (ciclo)."
            : "supersededByNodeId obbligatorio.",
      };
      this.recordAudit(cycleAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: cycleAudit.reason,
        blockedBy: blockReason,
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: blockReason,
          reason: cycleAudit.reason,
          auditEntry: cycleAudit,
        },
      };
    }

    const nodeIdx = loaded.snapshot.nodes.findIndex((n) => n.id === input.nodeId);
    if (nodeIdx < 0) {
      const missingAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: `Nodo "${input.nodeId}" non trovato nello scope "${input.scope}".`,
      };
      this.recordAudit(missingAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: missingAudit.reason,
        blockedBy: "invalid_payload",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: missingAudit.reason,
          auditEntry: missingAudit,
        },
      };
    }

    const replacementScope = input.supersededByScope ?? input.scope;
    const replacementLoaded = this.loadPartition(replacementScope, nowIso);
    const replacementNode = replacementLoaded.snapshot.nodes.find(
      (n) => n.id === targetReplacementId
    );
    if (!replacementNode) {
      const missingReplacementAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "invalid_payload",
        reason: `Nodo sostitutivo "${targetReplacementId}" non trovato nello scope "${replacementScope}".`,
      };
      this.recordAudit(missingReplacementAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: missingReplacementAudit.reason,
        blockedBy: "invalid_payload",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "invalid_payload",
          reason: missingReplacementAudit.reason,
          auditEntry: missingReplacementAudit,
        },
      };
    }

    if (replacementNode.supersededByNodeId === input.nodeId) {
      const mutualAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "cycle_or_depth_exceeded",
        reason: "Ciclo di sostituzione reciproca rilevato tra due nodi.",
      };
      this.recordAudit(mutualAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: mutualAudit.reason,
        blockedBy: "cycle_or_depth_exceeded",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "cycle_or_depth_exceeded",
          reason: mutualAudit.reason,
          auditEntry: mutualAudit,
        },
      };
    }

    if (input.note && !isSafeForLongTermMemory(input.note)) {
      const piiAudit: AssociativeAuditEntry = {
        ...decision.auditEntry,
        allowed: false,
        blockedBy: "clinical_or_pii_content",
        reason: "Nota di sostituzione rifiutata per contenuto clinico o sensibile.",
      };
      this.recordAudit(piiAudit);
      return {
        allowed: false,
        failClosed: true,
        updated: false,
        reason: piiAudit.reason,
        blockedBy: "clinical_or_pii_content",
        decision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: "clinical_or_pii_content",
          reason: piiAudit.reason,
          auditEntry: piiAudit,
        },
      };
    }

    const existing = loaded.snapshot.nodes[nodeIdx];
    const sanitizedNote = input.note
      ? redactSensitiveTokens(input.note).slice(0, ASSOCIATIVE_LIMITS.MAX_NOTE_LENGTH)
      : existing.provenance.note;

    if (
      existing.validationStatus === "superseded" &&
      existing.supersededByNodeId === targetReplacementId &&
      existing.provenance.note === sanitizedNote
    ) {
      return {
        allowed: true,
        failClosed: false,
        updated: false,
        reason: "Nodo già marcato come superseded dallo stesso sostituto (idempotente).",
        node: cloneNode(existing),
        decision,
      };
    }

    const updated: AssociativeMemoryNode = {
      ...cloneNode(existing),
      validationStatus: "superseded",
      supersededByNodeId: targetReplacementId,
      provenance: {
        ...existing.provenance,
        note: sanitizedNote,
      },
      version: existing.version + 1,
      updatedAt: nowIso,
    };

    if (input.scope === "session_ephemeral") {
      this.sessionNodes.set(updated.id, cloneNode(updated));
    } else {
      loaded.snapshot.nodes[nodeIdx] = cloneNode(updated);
      this.savePersistentPartition(input.scope, loaded.snapshot, nowIso);
    }

    this.recordAudit({
      ...decision.auditEntry,
      reason: `Nodo "${updated.id}" marcato come superseded da "${targetReplacementId}".`,
    });
    return {
      allowed: true,
      failClosed: false,
      updated: true,
      reason: "Nodo obsoleto marcato come superseded con tracciamento.",
      node: cloneNode(updated),
      decision,
    };
  }

  findConnectedPaths(
    input: FindConnectedPathsInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphPathSearchResult {
    const nowIso = options?.nowIso ?? input?.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso) || Date.now();
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

    const authorizedScopes = new Set<AssociativeConsentScope>();
    const excludedScopes: AssociativeConsentScope[] = [];

    for (const scope of candidateScopes) {
      const loaded = this.loadPartition(scope, nowIso);
      const decision = evaluateAssociativeAccess({
        operation: "retrieve",
        scope,
        consentState,
        crisisBlocked: input?.crisisBlocked ?? options?.crisisBlocked,
        userTextForSafetyCheck:
          input?.userTextForSafetyCheck ?? options?.userTextForSafetyCheck,
        storageAvailable: this.adapter.isAvailable(),
        corruptedDataDetected: loaded.corrupted,
        nowIso,
      });

      if (!decision.allowed) {
        if (
          decision.blockedBy === "crisis" ||
          decision.blockedBy === "clinical_or_pii_content" ||
          decision.blockedBy === "corrupted_data"
        ) {
          return {
            allowed: false,
            failClosed: true,
            reason: decision.reason,
            blockedBy: decision.blockedBy,
            paths: [],
            nodes: [],
            edges: [],
            excludedScopes: [...candidateScopes],
            effectiveMaxHops,
          };
        }
        excludedScopes.push(scope);
      } else {
        authorizedScopes.add(scope);
      }
    }

    const nodeById = new Map<string, AssociativeMemoryNode>();
    const allEdges: AssociativeEdge[] = [];

    for (const scope of authorizedScopes) {
      const loaded = this.loadPartition(scope, nowIso);
      for (const node of loaded.snapshot.nodes) {
        if (node.validationStatus === "revoked") continue;
        if (!input?.includeInactive) {
          if (!isNodeActive(node, nowMs) || node.validationStatus === "superseded") {
            continue;
          }
        }
        nodeById.set(node.id, cloneNode(node));
      }
      for (const edge of loaded.snapshot.edges) {
        if (edge.validationStatus === "revoked") continue;
        if (!input?.includeInactive && !isEdgeActive(edge)) continue;
        if (
          authorizedScopes.has(edge.sourceScope) &&
          authorizedScopes.has(edge.targetScope)
        ) {
          allEdges.push(cloneEdge(edge));
        }
      }
    }

    // Ordine deterministico degli archi per traversal prevedibile
    allEdges.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.id.localeCompare(b.id);
    });

    interface QueueEntry {
      nodeId: string;
      hopDistance: number;
      pathNodeIds: string[];
      pathEdgeIds: string[];
      pathTags: EpistemicTag[];
      pathReliabilities: number[];
    }

    const visitedNodes = new Map<string, ConnectedGraphPath>();
    const usedEdges = new Map<string, AssociativeEdge>();
    const queue: QueueEntry[] = [];

    for (const rawSeedId of input?.seedNodeIds ?? []) {
      const seedId = rawSeedId.trim();
      if (!seedId || visitedNodes.has(seedId)) continue;
      const seedNode = nodeById.get(seedId);
      if (!seedNode) continue;
      if (visitedNodes.size >= maxNodes) break;

      visitedNodes.set(seedId, {
        targetNode: seedNode,
        hopDistance: 0,
        pathNodeIds: [seedId],
        pathEdgeIds: [],
        pathEpistemicTag: seedNode.provenance.epistemicTag,
        pathReliability: seedNode.reliability,
      });
      queue.push({
        nodeId: seedId,
        hopDistance: 0,
        pathNodeIds: [seedId],
        pathEdgeIds: [],
        pathTags: [seedNode.provenance.epistemicTag],
        pathReliabilities: [seedNode.reliability],
      });
    }

    while (queue.length > 0 && visitedNodes.size < maxNodes) {
      const current = queue.shift()!;
      if (current.hopDistance >= effectiveMaxHops) continue;

      for (const edge of allEdges) {
        if (usedEdges.size >= maxEdges && !usedEdges.has(edge.id)) continue;

        let nextNodeId: string | null = null;
        if (edge.sourceNodeId === current.nodeId) {
          nextNodeId = edge.targetNodeId;
        } else if (
          edge.direction === "bidirectional" &&
          edge.targetNodeId === current.nodeId
        ) {
          nextNodeId = edge.sourceNodeId;
        }

        if (!nextNodeId) continue;
        if (current.pathNodeIds.includes(nextNodeId)) continue; // Prevenzione cicli nel path
        if (visitedNodes.has(nextNodeId)) continue;

        const nextNode = nodeById.get(nextNodeId);
        if (!nextNode) continue;

        if (!usedEdges.has(edge.id)) {
          if (usedEdges.size >= maxEdges) continue;
          usedEdges.set(edge.id, edge);
        }

        const nextPathTags: EpistemicTag[] = [
          ...current.pathTags,
          edge.provenance.epistemicTag,
          nextNode.provenance.epistemicTag,
        ];
        const nextPathReliabilities: number[] = [
          ...current.pathReliabilities,
          edge.weight,
          nextNode.reliability,
        ];
        const nextEntry: QueueEntry = {
          nodeId: nextNodeId,
          hopDistance: current.hopDistance + 1,
          pathNodeIds: [...current.pathNodeIds, nextNodeId],
          pathEdgeIds: [...current.pathEdgeIds, edge.id],
          pathTags: nextPathTags,
          pathReliabilities: nextPathReliabilities,
        };

        visitedNodes.set(nextNodeId, {
          targetNode: nextNode,
          hopDistance: nextEntry.hopDistance,
          pathNodeIds: nextEntry.pathNodeIds,
          pathEdgeIds: nextEntry.pathEdgeIds,
          pathEpistemicTag: propagatePathEpistemicTag(nextPathTags),
          pathReliability: propagatePathReliability(nextPathReliabilities),
        });
        queue.push(nextEntry);

        if (visitedNodes.size >= maxNodes) break;
      }
    }

    const paths = Array.from(visitedNodes.values());
    return {
      allowed: true,
      failClosed: false,
      reason: `Percorsi associativi recuperati (max ${effectiveMaxHops} hop).`,
      paths,
      nodes: paths.map((p) => cloneNode(p.targetNode)),
      edges: Array.from(usedEdges.values()).map(cloneEdge),
      excludedScopes,
      effectiveMaxHops,
    };
  }

  syncFromOperationalSources(
    sources: OperationalSyncInput,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): OperationalSyncResult {
    const nowIso = options?.nowIso ?? sources?.nowIso ?? new Date().toISOString();
    const opLoaded = this.loadPartition("operational", nowIso);

    const accessCheck = evaluateAssociativeAccess({
      operation: "write",
      scope: "operational",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable: this.adapter.isAvailable(),
      corruptedDataDetected: opLoaded.corrupted,
      nowIso,
    });

    if (!accessCheck.allowed) {
      this.recordAudit(accessCheck.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        reason: accessCheck.reason,
        blockedBy: accessCheck.blockedBy,
        nodesCreated: 0,
        nodesUpdated: 0,
        nodesDeduplicated: 0,
        edgesCreated: 0,
        edgesUpdated: 0,
        edgesDeduplicated: 0,
        rejectedItemsCount: 0,
      };
    }

    let nodesCreated = 0;
    let nodesUpdated = 0;
    let nodesDeduplicated = 0;
    let edgesCreated = 0;
    let edgesUpdated = 0;
    let edgesDeduplicated = 0;
    let rejectedItemsCount = 0;

    const recordNodeOutcome = (res: GraphUpsertNodeResult) => {
      if (!res.allowed) {
        rejectedItemsCount += 1;
        return;
      }
      if (res.created) nodesCreated += 1;
      else if (res.updated) nodesUpdated += 1;
      else if (res.deduplicated) nodesDeduplicated += 1;
    };

    const recordEdgeOutcome = (res: GraphUpsertEdgeResult) => {
      if (!res.allowed) {
        rejectedItemsCount += 1;
        return;
      }
      if (res.created) edgesCreated += 1;
      else if (res.updated) edgesUpdated += 1;
      else if (res.deduplicated) edgesDeduplicated += 1;
    };

    const goalNodeIdById = new Map<string, string>();
    const goalNodeIdByTitle = new Map<string, string>();

    for (const goal of sources.growthGoals ?? []) {
      const nodeId = `op-goal-${goal.id}`;
      const res = this.upsertNode(
        {
          id: nodeId,
          canonicalKey: `operational:goal:${goal.id}`,
          kind: "goal",
          label: goal.title,
          summary:
            goal.description?.trim() ||
            `Obiettivo personale (${goal.status}) con ${goal.steps.length} passi.`,
          consentScope: "operational",
          provenance: {
            sourceEngine: "GrowthEngine",
            sourceRecordId: goal.id,
            evidenceType: "explicit_feedback",
            epistemicTag: "fatto_osservato",
          },
          reliability: 0.95,
          validationStatus: "confirmed",
          observedAt: goal.updatedAt || goal.createdAt || nowIso,
          nowIso,
        },
        consentState,
        { crisisBlocked: options?.crisisBlocked, nowIso }
      );
      if (res.blockedBy === "crisis") {
        return {
          allowed: false,
          failClosed: true,
          reason: res.reason,
          blockedBy: "crisis",
          nodesCreated,
          nodesUpdated,
          nodesDeduplicated,
          edgesCreated,
          edgesUpdated,
          edgesDeduplicated,
          rejectedItemsCount: rejectedItemsCount + 1,
        };
      }
      recordNodeOutcome(res);
      if (res.node) {
        goalNodeIdById.set(goal.id, res.node.id);
        goalNodeIdByTitle.set(goal.title.trim().toLowerCase(), res.node.id);
      }
    }

    for (const plan of sources.plans ?? []) {
      const planNodeId = `op-plan-${plan.id}`;
      const planRes = this.upsertNode(
        {
          id: planNodeId,
          canonicalKey: `operational:plan:${plan.id}`,
          kind: "plan",
          label: plan.title,
          summary: `Piano ${plan.horizon} (${plan.status}) — obiettivo: ${plan.declaredGoal}.`,
          consentScope: "operational",
          provenance: {
            sourceEngine: "PlanningEngine",
            sourceRecordId: plan.id,
            evidenceType: "explicit_feedback",
            epistemicTag: "fatto_osservato",
          },
          reliability: 0.92,
          validationStatus: "confirmed",
          observedAt: plan.updatedAt || plan.createdAt || nowIso,
          nowIso,
        },
        consentState,
        { crisisBlocked: options?.crisisBlocked, nowIso }
      );
      if (planRes.blockedBy === "crisis") {
        return {
          allowed: false,
          failClosed: true,
          reason: planRes.reason,
          blockedBy: "crisis",
          nodesCreated,
          nodesUpdated,
          nodesDeduplicated,
          edgesCreated,
          edgesUpdated,
          edgesDeduplicated,
          rejectedItemsCount: rejectedItemsCount + 1,
        };
      }
      recordNodeOutcome(planRes);

      if (planRes.node) {
        const linkedGoalId = goalNodeIdByTitle.get(plan.declaredGoal.trim().toLowerCase());
        if (linkedGoalId && linkedGoalId !== planRes.node.id) {
          recordEdgeOutcome(
            this.upsertEdge(
              {
                sourceNodeId: planRes.node.id,
                targetNodeId: linkedGoalId,
                sourceScope: "operational",
                targetScope: "operational",
                relationType: "supports",
                direction: "directed",
                provenance: {
                  createdByEngine: "ExperienceGraphEngine",
                  evidenceType: "observed_behavior",
                  epistemicTag: "fatto_osservato",
                  supportingEvidenceIds: [plan.id],
                  supportingNote: "Piano operativo collegato all'obiettivo dichiarato.",
                },
                weight: 0.9,
                validationStatus: "observed",
                nowIso,
              },
              consentState,
              { crisisBlocked: options?.crisisBlocked, nowIso }
            )
          );
        }

        for (const task of plan.tasks) {
          const taskNodeId = `op-task-${plan.id}-${task.id}`;
          const taskRes = this.upsertNode(
            {
              id: taskNodeId,
              canonicalKey: `operational:task:${plan.id}:${task.id}`,
              kind: "task",
              label: task.title,
              summary:
                task.description?.trim() ||
                `Task ${task.status} (${task.priority}), stima ${task.estimatedMinutes} min.`,
              consentScope: "operational",
              provenance: {
                sourceEngine: "PlanningEngine",
                sourceRecordId: task.id,
                evidenceType: "observed_behavior",
                epistemicTag: "fatto_osservato",
              },
              reliability: 0.9,
              validationStatus: "observed",
              observedAt: task.completedAt || plan.updatedAt || nowIso,
              nowIso,
            },
            consentState,
            { crisisBlocked: options?.crisisBlocked, nowIso }
          );
          recordNodeOutcome(taskRes);

          if (taskRes.node) {
            recordEdgeOutcome(
              this.upsertEdge(
                {
                  sourceNodeId: taskRes.node.id,
                  targetNodeId: planRes.node.id,
                  sourceScope: "operational",
                  targetScope: "operational",
                  relationType: "part_of",
                  direction: "directed",
                  provenance: {
                    createdByEngine: "ExperienceGraphEngine",
                    evidenceType: "observed_behavior",
                    epistemicTag: "fatto_osservato",
                    supportingEvidenceIds: [plan.id, task.id],
                    supportingNote: "Task appartenente al piano operativo.",
                  },
                  weight: 0.95,
                  validationStatus: "observed",
                  nowIso,
                },
                consentState,
                { crisisBlocked: options?.crisisBlocked, nowIso }
              )
            );
          }
        }
      }
    }

    for (const mission of sources.missions ?? []) {
      const missionNodeId = `op-mission-${mission.id}`;
      const missionRes = this.upsertNode(
        {
          id: missionNodeId,
          canonicalKey: `operational:mission:${mission.id}`,
          kind: "mission",
          label: mission.title,
          summary: `${mission.description} (${mission.category}, ${mission.status}).`,
          consentScope: "operational",
          provenance: {
            sourceEngine: "MissionsEngine",
            sourceRecordId: mission.id,
            evidenceType: "observed_behavior",
            epistemicTag: "fatto_osservato",
          },
          reliability: 0.88,
          validationStatus: "observed",
          observedAt: mission.updatedAt || mission.createdAt || nowIso,
          nowIso,
        },
        consentState,
        { crisisBlocked: options?.crisisBlocked, nowIso }
      );
      if (missionRes.blockedBy === "crisis") {
        return {
          allowed: false,
          failClosed: true,
          reason: missionRes.reason,
          blockedBy: "crisis",
          nodesCreated,
          nodesUpdated,
          nodesDeduplicated,
          edgesCreated,
          edgesUpdated,
          edgesDeduplicated,
          rejectedItemsCount: rejectedItemsCount + 1,
        };
      }
      recordNodeOutcome(missionRes);

      if (missionRes.node) {
        const linkedGoalId = goalNodeIdByTitle.get(mission.goal.trim().toLowerCase());
        if (linkedGoalId && linkedGoalId !== missionRes.node.id) {
          recordEdgeOutcome(
            this.upsertEdge(
              {
                sourceNodeId: missionRes.node.id,
                targetNodeId: linkedGoalId,
                sourceScope: "operational",
                targetScope: "operational",
                relationType: "supports",
                direction: "directed",
                provenance: {
                  createdByEngine: "ExperienceGraphEngine",
                  evidenceType: "observed_behavior",
                  epistemicTag: "fatto_osservato",
                  supportingEvidenceIds: [mission.id],
                  supportingNote: "Missione adattiva collegata all'obiettivo.",
                },
                weight: 0.85,
                validationStatus: "observed",
                nowIso,
              },
              consentState,
              { crisisBlocked: options?.crisisBlocked, nowIso }
            )
          );
        }
      }
    }

    for (const event of sources.timelineEvents ?? []) {
      const eventNodeId = `op-tl-${event.id}`;
      const isHypothesis = event.epistemicTag === "ipotesi_da_verificare";
      const eventRes = this.upsertNode(
        {
          id: eventNodeId,
          canonicalKey: `operational:timeline_event:${event.id}`,
          kind: "timeline_event",
          label: event.title,
          summary: event.description,
          consentScope: "operational",
          provenance: {
            sourceEngine: event.source || "CognitiveTimeline",
            sourceRecordId: event.id,
            evidenceType: isHypothesis ? "hypothesis" : "observed_behavior",
            epistemicTag: event.epistemicTag,
          },
          reliability: event.reliability,
          validationStatus: isHypothesis ? "proposed" : "observed",
          observedAt: event.date || nowIso,
          nowIso,
        },
        consentState,
        { crisisBlocked: options?.crisisBlocked, nowIso }
      );
      if (eventRes.blockedBy === "crisis") {
        return {
          allowed: false,
          failClosed: true,
          reason: eventRes.reason,
          blockedBy: "crisis",
          nodesCreated,
          nodesUpdated,
          nodesDeduplicated,
          edgesCreated,
          edgesUpdated,
          edgesDeduplicated,
          rejectedItemsCount: rejectedItemsCount + 1,
        };
      }
      recordNodeOutcome(eventRes);

      if (eventRes.node && event.entityId) {
        const opNodes = this.getScopeNodes("operational", nowIso).snapshot.nodes;
        const candidateGoalId = goalNodeIdById.get(event.entityId);
        const candidates = [
          candidateGoalId,
          `op-goal-${event.entityId}`,
          `op-plan-${event.entityId}`,
          `op-mission-${event.entityId}`,
          event.entityId,
        ].filter((id): id is string => Boolean(id));
        const targetNodeId = candidates.find((cand) =>
          opNodes.some((n) => n.id === cand)
        );
        if (targetNodeId && targetNodeId !== eventRes.node.id) {
          recordEdgeOutcome(
            this.upsertEdge(
              {
                sourceNodeId: eventRes.node.id,
                targetNodeId,
                sourceScope: "operational",
                targetScope: "operational",
                relationType:
                  event.category === "recurring_difficulty" ? "hindered_by" : "supports",
                direction: "directed",
                provenance: {
                  createdByEngine: "ExperienceGraphEngine",
                  evidenceType: isHypothesis ? "hypothesis" : "observed_behavior",
                  epistemicTag: event.epistemicTag,
                  supportingEvidenceIds: [event.id],
                  supportingNote: "Evento timeline collegato all'entità operativa.",
                },
                weight: event.reliability,
                validationStatus: isHypothesis ? "hypothesized" : "observed",
                nowIso,
              },
              consentState,
              { crisisBlocked: options?.crisisBlocked, nowIso }
            )
          );
        }
      }
    }

    return {
      allowed: true,
      failClosed: false,
      reason: "Sincronizzazione dalle fonti operative completata nella partizione operational.",
      nodesCreated,
      nodesUpdated,
      nodesDeduplicated,
      edgesCreated,
      edgesUpdated,
      edgesDeduplicated,
      rejectedItemsCount,
    };
  }

  clearScope(
    scope: AssociativeConsentScope,
    consentState: LearningConsentState,
    options?: GraphOperationOptions
  ): GraphClearResult {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const decision = evaluateAssociativeAccess({
      operation: "clear",
      scope,
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable: this.adapter.isAvailable(),
      nowIso,
    });

    if (!decision.allowed) {
      this.recordAudit(decision.auditEntry);
      return {
        allowed: false,
        failClosed: true,
        cleared: false,
        scope,
        removedNodesCount: 0,
        removedEdgesCount: 0,
        reason: decision.reason,
        blockedBy: decision.blockedBy,
        decision,
      };
    }

    if (scope === "session_ephemeral") {
      const removedNodesCount = this.sessionNodes.size;
      const removedEdgesCount = this.sessionEdges.size;
      this.sessionNodes.clear();
      this.sessionEdges.clear();

      this.recordAudit({
        ...decision.auditEntry,
        reason: "Memoria effimera di sessione (RAM) azzerata.",
      });
      return {
        allowed: true,
        failClosed: false,
        cleared: true,
        scope,
        removedNodesCount,
        removedEdgesCount,
        reason: "Scope session_ephemeral azzerato completamente in RAM.",
        decision,
      };
    }

    const before = this.loadPartition(scope, nowIso);
    const removedNodeIds = new Set(before.snapshot.nodes.map((n) => n.id));
    const removedNodesCount = before.snapshot.nodes.length;
    let removedEdgesCount = before.snapshot.edges.length;

    this.adapter.removeItem(getStorageKeyForScope(scope));

    // Pulizia completa di eventuali archi o riferimenti residui nello scope effimero o in altre partizioni
    for (const [edgeId, edge] of this.sessionEdges.entries()) {
      if (
        edge.sourceScope === scope ||
        edge.targetScope === scope ||
        edge.storageScope === scope ||
        removedNodeIds.has(edge.sourceNodeId) ||
        removedNodeIds.has(edge.targetNodeId)
      ) {
        this.sessionEdges.delete(edgeId);
        removedEdgesCount += 1;
      }
    }

    for (const [nodeId, node] of this.sessionNodes.entries()) {
      let modified = false;
      const next = cloneNode(node);
      if (next.conflictWithNodeIds?.some((id) => removedNodeIds.has(id))) {
        next.conflictWithNodeIds = next.conflictWithNodeIds.filter(
          (id) => !removedNodeIds.has(id)
        );
        if (next.conflictWithNodeIds.length === 0) {
          next.conflictWithNodeIds = undefined;
        }
        modified = true;
      }
      if (next.supersededByNodeId && removedNodeIds.has(next.supersededByNodeId)) {
        next.supersededByNodeId = undefined;
        modified = true;
      }
      if (modified) {
        this.sessionNodes.set(nodeId, next);
      }
    }

    for (const otherScope of PERSISTENT_SCOPES) {
      if (otherScope === scope) continue;
      const otherLoaded = this.loadPartition(otherScope, nowIso);
      if (otherLoaded.corrupted) continue;
      const beforeEdgesLen = otherLoaded.snapshot.edges.length;
      const filteredEdges = otherLoaded.snapshot.edges.filter(
        (edge) =>
          edge.sourceScope !== scope &&
          edge.targetScope !== scope &&
          edge.storageScope !== scope &&
          !removedNodeIds.has(edge.sourceNodeId) &&
          !removedNodeIds.has(edge.targetNodeId)
      );
      let nodesModified = false;
      const scrubbedNodes = otherLoaded.snapshot.nodes.map((node) => {
        let changed = false;
        const next = cloneNode(node);
        if (next.conflictWithNodeIds?.some((id) => removedNodeIds.has(id))) {
          next.conflictWithNodeIds = next.conflictWithNodeIds.filter(
            (id) => !removedNodeIds.has(id)
          );
          if (next.conflictWithNodeIds.length === 0) {
            next.conflictWithNodeIds = undefined;
          }
          changed = true;
        }
        if (next.supersededByNodeId && removedNodeIds.has(next.supersededByNodeId)) {
          next.supersededByNodeId = undefined;
          changed = true;
        }
        if (changed) nodesModified = true;
        return next;
      });

      const edgesRemovedHere = beforeEdgesLen - filteredEdges.length;
      if (edgesRemovedHere > 0 || nodesModified) {
        removedEdgesCount += edgesRemovedHere;
        this.savePersistentPartition(
          otherScope,
          {
            version: 1,
            scope: otherScope,
            updatedAt: nowIso,
            nodes: scrubbedNodes,
            edges: filteredEdges,
          },
          nowIso
        );
      }
    }

    this.recordAudit({
      ...decision.auditEntry,
      reason: `Partizione "${scope}" rimossa integralmente (${removedNodesCount} nodi, ${removedEdgesCount} archi).`,
    });

    return {
      allowed: true,
      failClosed: false,
      cleared: true,
      scope,
      removedNodesCount,
      removedEdgesCount,
      reason: `Partizione "${scope}" e tutti i riferimenti associati rimossi completamente.`,
      decision,
    };
  }

  exportAuthorizedGraph(
    consentState: LearningConsentState,
    options?: GraphExportOptions
  ): GraphExportResult {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const requestedScopes: AssociativeConsentScope[] =
      options?.scopes && options.scopes.length > 0
        ? Array.from(new Set(options.scopes))
        : [...PERSISTENT_SCOPES];

    const includedScopes: PersistentAssociativeScope[] = [];
    const excludedScopes: AssociativeConsentScope[] = [];
    const partitions: Partial<Record<PersistentAssociativeScope, AssociativePartitionSnapshot>> = {};
    let totalNodes = 0;
    let totalEdges = 0;

    for (const scope of requestedScopes) {
      if (scope === "session_ephemeral") {
        // session_ephemeral non viene mai esportata (solo RAM)
        excludedScopes.push("session_ephemeral");
        continue;
      }

      const loaded = this.loadPartition(scope, nowIso);
      const decision = evaluateAssociativeAccess({
        operation: "export",
        scope,
        consentState,
        crisisBlocked: options?.crisisBlocked,
        userTextForSafetyCheck: options?.userTextForSafetyCheck,
        storageAvailable: this.adapter.isAvailable(),
        corruptedDataDetected: loaded.corrupted,
        nowIso,
      });

      if (!decision.allowed) {
        if (
          decision.blockedBy === "crisis" ||
          decision.blockedBy === "clinical_or_pii_content" ||
          decision.blockedBy === "corrupted_data"
        ) {
          return {
            exportType: "aura_experience_graph",
            version: 1,
            exportedAt: nowIso,
            allowed: false,
            failClosed: true,
            reason: decision.reason,
            blockedBy: decision.blockedBy,
            includedScopes: [],
            excludedScopes: [...requestedScopes],
            partitions: {},
            totalNodes: 0,
            totalEdges: 0,
          };
        }
        excludedScopes.push(scope);
        continue;
      }

      includedScopes.push(scope);
      partitions[scope] = {
        version: 1,
        scope,
        updatedAt: loaded.snapshot.updatedAt,
        nodes: loaded.snapshot.nodes.map(cloneNode),
        edges: loaded.snapshot.edges.map(cloneEdge),
      };
      totalNodes += loaded.snapshot.nodes.length;
      totalEdges += loaded.snapshot.edges.length;
    }

    return {
      exportType: "aura_experience_graph",
      version: 1,
      exportedAt: nowIso,
      allowed: true,
      failClosed: false,
      reason: "Esportazione grafo autorizzato completata nel rispetto dei consensi.",
      includedScopes,
      excludedScopes,
      partitions,
      totalNodes,
      totalEdges,
    };
  }
}
