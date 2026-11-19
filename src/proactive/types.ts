import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import type { PersonalPlan } from "../planning/types";

export type ProactiveMode = "PASSIVE" | "ASSISTED" | "USER-AUTHORIZED";

export type SuggestionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "completed"
  | "expired";

export type SuggestionPriority = "alta" | "media" | "bassa";

export type EpistemicTag =
  | "fatto_osservato"
  | "interpretazione_prudente"
  | "ipotesi_da_verificare";

export interface ProactiveSuggestion {
  id: string;
  dedupeKey: string;
  title: string;
  description: string;
  rationale: string;
  dataSource: string;
  epistemicTag: EpistemicTag;
  priority: SuggestionPriority;
  confidence: number; // 0..1
  proposedAction: string;
  estimatedMinutes?: number;
  generatedAt: string;
  status: SuggestionStatus;
  snoozedUntil?: string;
}

export interface ProactiveAnalysisInput {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  nowIso?: string;
  existingSuggestions?: ProactiveSuggestion[];
}

export interface ProactiveAnalysisResult {
  safetyBlocked: boolean;
  generatedAt: string;
  suggestions: ProactiveSuggestion[];
  skippedDuplicates: number;
}

export interface ProactiveSchedulerConfig {
  mode: ProactiveMode;
  suspended: boolean;
  minIntervalMs: number;
  notificationsAuthorized: boolean;
}

// ==================== V1.1 PREDICTIVE & ADAPTIVE TYPES ====================

export type PredictiveCategory =
  | "overload"
  | "deadline"
  | "dependency"
  | "delay_risk"
  | "stalled_goal";

export interface PredictiveAlert {
  id: string;
  category: PredictiveCategory;
  title: string;
  description: string;
  epistemicTag: EpistemicTag;
  riskLevel: SuggestionPriority;
  confidence: number; // 0..1
  dataSource: string;
}

export interface PredictiveAnalysisResult {
  safetyBlocked: boolean;
  insufficientData: boolean;
  statusMessage: string;
  generatedAt: string;
  alerts: PredictiveAlert[];
}

export interface HabitPattern {
  id: string;
  label: string;
  description: string;
  dataSource: string;
  observationCount: number;
  periodAnalyzed: string;
  confidence: number; // 0..1
  insufficientData: boolean;
}

export type PriorityProposalStatus = "proposed" | "accepted" | "rejected" | "snoozed";

export interface PriorityProposal {
  id: string;
  planId: string;
  planTitle: string;
  taskId: string;
  taskTitle: string;
  previousPriority: SuggestionPriority;
  suggestedPriority: SuggestionPriority;
  reason: string;
  dataSource: string;
  confidence: number;
  status: PriorityProposalStatus;
}

export type LearningAction =
  | "accepted"
  | "rejected"
  | "snoozed"
  | "completed"
  | "suspended";

export interface LearningInteraction {
  category: string;
  action: LearningAction;
  timestamp: string;
}

export interface ControlledLearningExport {
  exportedAt: string;
  enabled: boolean;
  totalInteractions: number;
  categoryWeights: Record<string, number>;
  interactions: LearningInteraction[];
}

// ==================== V2 UNIFIED PROACTIVE OPPORTUNITY TYPES ====================

export type ProactiveOpportunityCategory =
  | "opportunity"
  | "difficulty"
  | "initiative";

export type ProactiveOpportunityStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "snoozed"
  | "suspended"
  | "completed"
  | "expired";

export interface ProactiveOpportunityV2 {
  id: string;
  dedupeKey: string;
  title: string;
  description: string;
  rationale: string;
  dataSource: string;
  category: ProactiveOpportunityCategory;
  epistemicTag: EpistemicTag;
  priority: SuggestionPriority;
  confidence: number; // 0..1
  deadline?: string;
  estimatedMinutes: number;
  expectedBenefits: string;
  possibleLimits: string;
  status: ProactiveOpportunityStatus;
  requiresConfirmationForMutation: boolean;
  rankScore: number;
  generatedAt: string;
  cooldownUntil?: string;
  expiresAt?: string;
}
