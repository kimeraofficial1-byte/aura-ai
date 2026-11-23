import type { MetaCognitiveSafetyDecision } from "./metaCognitiveTypes";
import type {
  Confidence,
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
  LearningGuardBlockReason,
  LearningGuardDecision,
} from "./selfLearningTypes";
import type { CognitiveSafetyCheckResult } from "./types";

/**
 * Partizioni fisiche separate per la persistenza locale della Fase 11.2.
 * Nota: la memoria `session_ephemeral` NON ha chiave persistente e resta esclusivamente in RAM.
 */
export const ASSOCIATIVE_GRAPH_STORAGE_KEYS = {
  operational: "aura_assoc_graph_operational_v1",
  aiMemory: "aura_assoc_graph_memory_v1",
  learning: "aura_assoc_graph_learning_v1",
} as const;

export const ASSOCIATIVE_LIMITS = {
  MAX_NODES_PER_SCOPE: 200,
  MAX_EDGES_PER_SCOPE: 400,
  MAX_EDGES_PER_NODE: 24,
  MAX_TRAVERSAL_HOPS: 2,
  MAX_RETRIEVAL_NODES: 8,
  MAX_RETRIEVAL_EDGES: 12,
  MAX_LABEL_LENGTH: 120,
  MAX_SUMMARY_LENGTH: 320,
  MAX_NOTE_LENGTH: 240,
  MAX_KEYWORDS_PER_NODE: 16,
  MAX_AUDIT_ENTRIES: 200,
} as const;

export type AssociativeConsentScope =
  | "operational"
  | "ai_memory"
  | "learning"
  | "session_ephemeral";

export type PersistentAssociativeScope = Exclude<
  AssociativeConsentScope,
  "session_ephemeral"
>;

export type AssociativeOperationType =
  | "read"
  | "write"
  | "link"
  | "retrieve"
  | "clear"
  | "export";

export type AssociativeNodeKind =
  | "goal"
  | "plan"
  | "task"
  | "mission"
  | "timeline_event"
  | "experience_pattern"
  | "knowledge_entry"
  | "preference"
  | "emotional_trend"
  | "checkin"
  | "concept"
  | "session_signal";

export type AssociativeValidationStatus =
  | "confirmed"
  | "observed"
  | "proposed"
  | "unverified"
  | "conflicted"
  | "superseded"
  | "revoked"
  | "expired";

export interface AssociativeNodeProvenance {
  sourceEngine: string;
  sourceRecordId?: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  note?: string;
}

export interface AssociativeMemoryNode {
  id: string;
  canonicalKey: string;
  kind: AssociativeNodeKind;
  label: string;
  summary: string;
  keywords: string[];
  consentScope: AssociativeConsentScope;
  provenance: AssociativeNodeProvenance;
  reliability: Confidence;
  validationStatus: AssociativeValidationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  expiresAt?: string;
  conflictWithNodeIds?: string[];
  supersededByNodeId?: string;
}

export interface CreateMemoryNodeInput {
  id?: string;
  canonicalKey?: string;
  kind: AssociativeNodeKind;
  label: string;
  summary: string;
  keywords?: string[];
  consentScope: AssociativeConsentScope;
  provenance: AssociativeNodeProvenance;
  reliability: Confidence;
  validationStatus: AssociativeValidationStatus;
  observedAt?: string;
  expiresAt?: string;
  conflictWithNodeIds?: string[];
  supersededByNodeId?: string;
  nowIso?: string;
}

export type AssociativeRelationType =
  | "part_of"
  | "supports"
  | "derived_from"
  | "precedes"
  | "related_to"
  | "hindered_by"
  | "blocked_by"
  | "contradicts"
  | "supersedes";

export type AssociativeEdgeDirection = "directed" | "bidirectional";

export type AssociativeEdgeValidationStatus =
  | "confirmed"
  | "observed"
  | "proposed"
  | "hypothesized"
  | "revoked"
  | "expired";

export interface AssociativeEdgeProvenance {
  createdByEngine: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  supportingEvidenceIds: string[];
  supportingNote: string;
}

export interface AssociativeEdge {
  id: string;
  canonicalKey: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceScope: AssociativeConsentScope;
  targetScope: AssociativeConsentScope;
  storageScope: AssociativeConsentScope;
  relationType: AssociativeRelationType;
  direction: AssociativeEdgeDirection;
  provenance: AssociativeEdgeProvenance;
  weight: Confidence;
  validationStatus: AssociativeEdgeValidationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssociativeEdgeInput {
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceScope: AssociativeConsentScope;
  targetScope: AssociativeConsentScope;
  relationType: AssociativeRelationType;
  direction?: AssociativeEdgeDirection;
  provenance: AssociativeEdgeProvenance;
  weight: Confidence;
  validationStatus: AssociativeEdgeValidationStatus;
  nowIso?: string;
}

export interface AssociativePartitionSnapshot {
  version: 1;
  scope: PersistentAssociativeScope;
  updatedAt: string;
  nodes: AssociativeMemoryNode[];
  edges: AssociativeEdge[];
}

export type AssociativeGuardBlockReason =
  | LearningGuardBlockReason
  | "ai_memory_consent"
  | "cross_scope_denied"
  | "hypothesis_promotion_forbidden"
  | "cycle_or_depth_exceeded"
  | "clinical_or_pii_content";

export interface AssociativeAuditEntry {
  id: string;
  timestamp: string;
  operation: AssociativeOperationType;
  scope: AssociativeConsentScope;
  secondaryScope?: AssociativeConsentScope;
  allowed: boolean;
  blockedBy?: AssociativeGuardBlockReason;
  reason: string;
  targetId?: string;
}

export interface AssociativeAccessInput {
  operation: AssociativeOperationType;
  scope: AssociativeConsentScope;
  secondaryScope?: AssociativeConsentScope;
  consentState: LearningConsentState;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  requestedConfirmation?: boolean;
  evidenceType?: EvidenceType;
  epistemicTag?: EpistemicTag;
  targetId?: string;
  nowIso?: string;
}

export interface AssociativeAccessDecision {
  allowed: boolean;
  failClosed: boolean;
  scope: AssociativeConsentScope;
  secondaryScope?: AssociativeConsentScope;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  safetyCheck?: CognitiveSafetyCheckResult;
  learningGuardDecision?: LearningGuardDecision;
  metaSafetyDecision?: MetaCognitiveSafetyDecision;
  auditEntry: AssociativeAuditEntry;
}

export interface AssociativeNodeValidationResult {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  sanitizedNode?: AssociativeMemoryNode;
  decision: AssociativeAccessDecision;
}

export interface AssociativeEdgeValidationResult {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: AssociativeGuardBlockReason;
  sanitizedEdge?: AssociativeEdge;
  decision: AssociativeAccessDecision;
}

export interface AssociativeRetrievalScoreBreakdown {
  contextualRelevance: number;
  associativeStrength: number;
  sourceReliability: number;
  temporalRecency: number;
  finalScore: number;
}

export interface AssociativeRetrievedNode {
  node: AssociativeMemoryNode;
  hopDistance: number;
  pathEdgeIds: string[];
  pathEpistemicTag: EpistemicTag;
  pathExplanation: string;
  scoreBreakdown: AssociativeRetrievalScoreBreakdown;
}

export interface AssociativeRetrievalInput {
  query: string;
  consentState: LearningConsentState;
  seedNodeIds?: string[];
  allowedScopes?: AssociativeConsentScope[];
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  includeHypotheses?: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  nowIso?: string;
}

export interface AssociativeRetrievalResult {
  allowed: boolean;
  safetyBlocked: boolean;
  insufficientSignal: boolean;
  reason: string;
  retrievedAt: string;
  nodes: AssociativeRetrievedNode[];
  edges: AssociativeEdge[];
  excludedScopes: AssociativeConsentScope[];
  accessDecision: AssociativeAccessDecision;
}
