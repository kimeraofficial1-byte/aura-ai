import type { EpistemicTag as ProactiveEpistemicTag } from "../proactive/types";

export type EvidenceType =
  | "explicit_feedback"
  | "observed_behavior"
  | "hypothesis";

export type EpistemicTag = ProactiveEpistemicTag;

export type CognitiveImprovementStage =
  | "observation"
  | "analysis"
  | "proposal"
  | "approval"
  | "verification";

/** Valore numerico compreso tra 0 e 1 (inclusi). */
export type Confidence = number;

export type LearningOperationType =
  | "read"
  | "write"
  | "propose"
  | "approve"
  | "clear";

export interface LearningConsentState {
  /** Consenso dedicato all'apprendimento adattivo (indipendente da AI Memory). */
  learningConsent: boolean;
  /** Stato della Memoria Personale AI (AuraMemoryStore), gestito separatamente. */
  aiMemoryConsent: boolean;
  revokedAt?: string;
  /** Autorizzazione separata ed esplicita per la procedura di cancellazione dei dati appresi. */
  explicitClearRequested?: boolean;
}

export interface LearningPayload {
  stage: CognitiveImprovementStage;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  confidence: Confidence;
  dataSource: string;
  timestamp: string;
  uncertaintyNote: string;
  summary: string;
  targetSubsystem?: string;
  /** Deve essere esplicitamente true per approvare una proposta; il silenzio (undefined/false) non è mai consenso. */
  userExplicitApproval?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export type LearningGuardBlockReason =
  | "crisis"
  | "consent"
  | "silence"
  | "escalation"
  | "sensitive_content"
  | "invalid_payload"
  | "storage_unavailable"
  | "corrupted_data"
  | "internal_error";

export interface LearningAuditEvent {
  id: string;
  timestamp: string;
  operation: LearningOperationType;
  stage?: CognitiveImprovementStage;
  allowed: boolean;
  reason: string;
  blockedBy?: LearningGuardBlockReason;
  dataSource?: string;
}

export interface LearningSafetyInput {
  operation: LearningOperationType;
  consentState: LearningConsentState;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  payload?: LearningPayload;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

export interface LearningGuardDecision {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  blockedBy?: LearningGuardBlockReason;
  sanitizedPayload?: LearningPayload;
  auditEvent: LearningAuditEvent;
}
