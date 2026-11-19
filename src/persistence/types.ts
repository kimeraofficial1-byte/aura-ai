import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import type { PersonalPlan, PlanHorizon } from "../planning/types";

export const CURRENT_SCHEMA_VERSION = 2;

export type DataDomain = "operational" | "ai_memory" | "session" | "technical";

export type RecordSource = "user" | "migration" | "import" | "engine";

export type RecordStatus = "active" | "corrupted" | "archived";

export interface StorageRecordEnvelope<T> {
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  source: RecordSource;
  status: RecordStatus;
  domain: DataDomain;
  payload: T;
}

export interface OperationalPreferences {
  voiceModeEnabled?: boolean;
  autoSpeakResponses?: boolean;
  defaultPlanHorizon?: PlanHorizon;
}

export interface OperationalDataSnapshot {
  schemaVersion: number;
  updatedAt: string;
  revision: number;
  legacyMigrationCompleted?: boolean;
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  preferences: OperationalPreferences;
}

export interface IntegrityReport {
  valid: boolean;
  schemaVersion: number;
  checkedAt: string;
  totalRecords: number;
  validRecords: number;
  corruptedRecords: number;
  recoveredCount: number;
  issues: string[];
}

export interface ImportPreview {
  valid: boolean;
  schemaVersion: number;
  error?: string;
  incomingPlans: number;
  incomingMissions: number;
  incomingGoals: number;
  duplicatePlanIds: string[];
  duplicateMissionIds: string[];
  duplicateGoalIds: string[];
  willOverwriteExisting: boolean;
  snapshot?: OperationalDataSnapshot;
}

export interface TechnicalLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  details?: string;
}

export interface StorageAdapter {
  readonly name: string;
  isAvailable(): boolean;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}
