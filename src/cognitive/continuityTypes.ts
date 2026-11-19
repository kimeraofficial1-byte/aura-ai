import type {
  EpistemicTag,
  ProactiveOpportunityV2,
} from "../proactive/types";

export type TimelineEventCategory =
  | "new_goal"
  | "progress"
  | "completed_task"
  | "priority_change"
  | "recurring_difficulty"
  | "confirmed_decision";

export interface CognitiveTimelineEvent {
  id: string;
  date: string;
  source: string;
  category: TimelineEventCategory;
  title: string;
  description: string;
  epistemicTag: EpistemicTag;
  reliability: number; // 0..1
  entityId?: string;
}

export interface CognitiveTimelineExport {
  exportType: "aura_cognitive_timeline";
  version: 1;
  exportedAt: string;
  totalEvents: number;
  events: CognitiveTimelineEvent[];
}

export type GoalEvolutionTrend =
  | "in_crescita"
  | "stabile"
  | "sospeso_o_rimandato"
  | "completato";

export interface GoalEvolutionEntry {
  goalId: string;
  title: string;
  currentStatus: string;
  completedSteps: number;
  totalSteps: number;
  progressPercent: number;
  trend: GoalEvolutionTrend;
  epistemicTag: EpistemicTag;
  reliability: number;
  dataSource: string;
}

export interface ProgressEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  epistemicTag: EpistemicTag;
  reliability: number;
  dataSource: string;
}

export interface RecurringDifficultyEntry {
  id: string;
  label: string;
  occurrences: number;
  description: string;
  epistemicTag: EpistemicTag;
  reliability: number;
  dataSource: string;
}

export interface ContinuitySnapshot {
  generatedAt: string;
  safetyBlocked: boolean;
  insufficientData: boolean;
  statusMessage: string;
  goalEvolution: GoalEvolutionEntry[];
  recentProgress: ProgressEntry[];
  recurringDifficulties: RecurringDifficultyEntry[];
  recoveredOperationalContext: string[];
  suggestedOpportunities: ProactiveOpportunityV2[];
  contradictionsDetected: string[];
  needsClarification: boolean;
  clarificationQuestion?: string;
  timelineEventsCount: number;
  averageReliability: number;
}
