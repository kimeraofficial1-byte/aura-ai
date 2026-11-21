import type { AdaptiveStrategy } from "./adaptiveLearningEngine";
import type {
  Confidence,
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
  LearningGuardBlockReason,
  LearningGuardDecision,
  LearningPayload,
} from "./selfLearningTypes";

export type MetaCognitiveProcessStatus =
  | "idle"
  | "monitoring"
  | "completed"
  | "insufficient_data"
  | "blocked";

/** Operazioni metacognitive ammesse: esclusivamente consultive e in sola lettura. */
export type MetaCognitiveOperation =
  | "analyze"
  | "compare_strategies"
  | "detect_errors"
  | "explain";

export interface MetaCognitiveEvidenceItem {
  id: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  dataSource: string;
  timestamp: string;
  summary: string;
  confidence: Confidence;
}

export interface MissingInformationItem {
  field: string;
  reason: string;
  impact: "low" | "medium" | "high";
}

export interface CognitiveProcessTrace {
  traceId: string;
  timestamp: string;
  status: MetaCognitiveProcessStatus;
  stagesExecuted: string[];
  evidences: MetaCognitiveEvidenceItem[];
  missingInformation: MissingInformationItem[];
  contradictionsDetected: number;
  dataSources: string[];
}

export type UncertaintyLevel =
  | "low"
  | "moderate"
  | "high"
  | "insufficient_evidence";

export interface UncertaintyAssessment {
  level: UncertaintyLevel;
  /** Null quando le evidenze sono insufficienti: evita percentuali arbitrarie. */
  reliabilityScore: Confidence | null;
  needsClarification: boolean;
  clarificationQuestions: string[];
  limitingFactors: string[];
  epistemicTag: EpistemicTag;
  uncertaintyNote: string;
}

export interface StrategyEvaluationOption {
  strategy: AdaptiveStrategy;
  accuracyScore: number | null;
  safetyScore: number;
  coherenceScore: number;
  operationalCost: "low" | "medium" | "high";
  rationale: string;
  rejectedReason?: string;
}

export interface StrategyComparisonResult {
  selectedStrategy: AdaptiveStrategy | null;
  options: StrategyEvaluationOption[];
  selectionRationale: string;
  discardedAlternatives: string[];
  confidence: Confidence | null;
  epistemicTag: EpistemicTag;
}

export type CognitiveErrorCategory =
  | "internal_contradiction"
  | "unsupported_conclusion"
  | "recurring_error"
  | "epistemic_mismatch";

export type CognitiveErrorSeverity = "low" | "medium" | "high";

export interface CognitiveErrorFinding {
  id: string;
  category: CognitiveErrorCategory;
  severity: CognitiveErrorSeverity;
  description: string;
  evidenceSource: string;
  /** Proposta correttiva esclusivamente consultiva: mai applicata automaticamente. */
  advisoryCorrection: string;
  autoApplied: false;
}

export interface DecisionExplanation {
  summary: string;
  whyChosen: string;
  evidencesUsed: string[];
  uncertaintiesAndLimits: string[];
  discardedAlternatives: string[];
  epistemicTag: EpistemicTag;
}

export interface MetaCognitiveSafetyInput {
  operation: MetaCognitiveOperation;
  /** Richiede il consenso esistente learningConsent senza creare nuovi consensi. */
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  payload?: LearningPayload;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

export interface MetaCognitiveSafetyDecision {
  allowed: boolean;
  failClosed: boolean;
  advisoryOnly: true;
  readOnly: true;
  reason: string;
  blockedBy?: LearningGuardBlockReason;
  sanitizedPayload?: LearningPayload;
  learningGuardDecision?: LearningGuardDecision;
  timestamp: string;
}

export interface MetaCognitiveReport {
  timestamp: string;
  status: MetaCognitiveProcessStatus;
  allowed: boolean;
  advisoryOnly: true;
  processTrace: CognitiveProcessTrace;
  uncertainty: UncertaintyAssessment;
  strategyComparison: StrategyComparisonResult;
  errorFindings: CognitiveErrorFinding[];
  explanation: DecisionExplanation;
  safetyDecision: MetaCognitiveSafetyDecision;
}
