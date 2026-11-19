import type { EmotionalAnalysis, EmotionalTrendEntry } from "../emotion/types";
import type { CheckInRecord } from "../memory/types";
import type { AdaptiveMission } from "../missions/types";

export type GrowthGoalStatus = "attivo" | "in_pausa" | "completato";

export interface GrowthGoalStep {
  id: string;
  title: string;
  done: boolean;
}

export interface GoalChangeEvent {
  id: string;
  date: string;
  type: "created" | "edited" | "paused" | "resumed" | "completed" | "step_added" | "step_completed";
  summary: string;
}

export interface GrowthGoal {
  id: string;
  title: string;
  description?: string;
  status: GrowthGoalStatus;
  steps: GrowthGoalStep[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  history: GoalChangeEvent[];
}

export type TimelinePeriodFilter = "7d" | "30d" | "all";

export type TimelineEventKind =
  | "mission_completed"
  | "mission_skipped_or_paused"
  | "goal_completed"
  | "goal_evolved"
  | "checkin"
  | "achievement";

export interface ProgressTimelineEntry {
  id: string;
  date: string;
  kind: TimelineEventKind;
  title: string;
  detail: string;
  badge: string;
}

export type AchievementId =
  | "first_goal_completed"
  | "first_missions_completed"
  | "personal_consistency"
  | "new_habits_explored"
  | "user_declared_progress";

export interface GrowthAchievement {
  id: AchievementId;
  title: string;
  description: string;
  unlocked: boolean;
  unlockedAt?: string;
  progressLabel: string;
}

export interface PersonalGrowthProfile {
  declaredGoalsCount: number;
  activeGoalsCount: number;
  pausedGoalsCount: number;
  completedGoalsCount: number;
  expressedPreferences: string[];
  acceptedMissionsCount: number;
  completedMissionsCount: number;
  availableCheckInsCount: number;
  goalModificationsCount: number;
  consentedStorageActive: boolean;
}

export interface WeeklyReflection {
  periodStart: string;
  periodEnd: string;
  hasSufficientData: boolean;
  dataSufficiencyNote: string;
  activitiesCount: number;
  completedMissions: string[];
  goalsWorkedOn: string[];
  declaredDifficulties: string[];
  observableSmallProgress: string[];
  optionalNextWeekSuggestions: string[];
}

export interface PersonalInsightItem {
  id: string;
  title: string;
  observedFacts: string[];
  cautiousInterpretation: string;
  confidenceNote: string;
}

export interface PersonalInsightsContext {
  goals: GrowthGoal[];
  preferences: string[];
  missions: AdaptiveMission[];
  checkIns: CheckInRecord[];
  emotionalTrends: EmotionalTrendEntry[];
  latestAnalysis?: EmotionalAnalysis | null;
  consentEnabled: boolean;
  focusPrompt?: string;
}

export interface PersonalInsightsResult {
  insights: PersonalInsightItem[];
  insufficientData: boolean;
  insufficientDataMessage?: string;
  source: "local-reflective" | "gemini-json";
  fallbackUsed: boolean;
  fallbackReason?: string;
  blockedBySafety?: boolean;
  safetyReply?: string;
  generatedAt: string;
}
