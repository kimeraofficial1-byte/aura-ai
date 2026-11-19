export type PlanHorizon = "daily" | "weekly" | "monthly";

export type PlanStatus = "active" | "paused" | "completed" | "archived";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "paused"
  | "cancelled"
  | "overdue";

export type TaskPriority = "alta" | "media" | "bassa";

export type HorizonBucket = "oggi" | "settimana" | "mese";

export interface PlanSubtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string; // YYYY-MM-DD
  estimatedMinutes: number;
  uncertaintyNote: string;
  dependencies: string[]; // IDs of prerequisite tasks
  resources: string[];
  subtasks: PlanSubtask[];
  alternatives: string[];
  horizonBucket: HorizonBucket;
  completedAt?: string;
}

export interface PlanRevision {
  id: string;
  timestamp: string;
  reason: string;
  explanation: string;
  changesSummary: string[];
}

export interface PersonalPlan {
  id: string;
  title: string;
  declaredGoal: string;
  desiredOutcome: string;
  horizon: PlanHorizon;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  targetDate: string; // YYYY-MM-DD
  constraints: string[];
  dailyMinutesLimit: number;
  uncertainties: string[];
  tasks: PlanTask[];
  revisions: PlanRevision[];
  reasoningSummary: string;
  progressPercent: number;
  source: "local" | "gemini";
  sessionOnly: boolean;
}

export interface PlanCreateInput {
  declaredGoal: string;
  desiredOutcome?: string;
  horizon: PlanHorizon;
  targetDate?: string;
  dailyMinutesLimit?: number;
  constraints?: string[];
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  existingMissionTitles?: string[];
  growthGoalTitles?: string[];
  emotionalTone?: string;
}

export interface PlanRecalculateInput {
  reason: string;
  unavailableTaskIds?: string[];
  newDailyMinutesLimit?: number;
  newTargetDate?: string;
  extraConstraints?: string[];
  nowIso?: string;
}

export interface PlanProgressMetrics {
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
  pausedTasks: number;
  cancelledTasks: number;
  todayTasks: number;
  blockedByDependencies: number;
  progressPercent: number;
}

export interface PlanExportBundle {
  exportedAt: string;
  consentEnabled: boolean;
  sessionOnly: boolean;
  plans: PersonalPlan[];
}
