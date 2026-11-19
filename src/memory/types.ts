import type { EmotionalTrendEntry } from "../emotion/types";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission } from "../missions/types";
import type { ChatHistoryItem } from "../types/aura";

export type { EmotionalTrendEntry } from "../emotion/types";
export type { GrowthGoal } from "../growth/types";
export type { AdaptiveMission } from "../missions/types";

export interface MemoryConsentState {
  enabled: boolean;
  updatedAt: string | null;
}

export interface CheckInRecord {
  date: string;
  stress: number;
  mood: string;
}

export interface ShortTermMemory {
  messages: Array<ChatHistoryItem & { time: string }>;
  updatedAt: string | null;
}

export interface LongTermMemory {
  preferences: string[];
  goalsAndStrategies: string[];
  completedMissions: string[];
  conversationTopics: string[];
  userNotes: string;
  updatedAt: string | null;
}

export interface AuraExportBundle {
  version: "aura-memory-v1";
  exportedAt: string;
  consent: MemoryConsentState;
  longTermMemory: LongTermMemory;
  shortTermMemory: ShortTermMemory;
  checkIns: CheckInRecord[];
  emotionalTrends: EmotionalTrendEntry[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
}

export interface StorageDriver {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
