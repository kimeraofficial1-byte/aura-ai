import type { EmotionalAnalysis } from "../emotion/types";

export const MISSION_CATEGORIES = [
  "Mindfulness",
  "Respirazione e rilassamento",
  "Movimento leggero",
  "Gratitudine",
  "Creatività",
  "Organizzazione quotidiana",
  "Pausa e recupero",
  "Connessione sociale",
  "Riflessione personale",
  "Piccoli obiettivi quotidiani",
] as const;

export type MissionCategory = (typeof MISSION_CATEGORIES)[number];

export type MissionStatus =
  | "proposta"
  | "accettata"
  | "completata"
  | "rifiutata"
  | "annullata";

export type MissionEffort = "basso" | "medio" | "alto";

export type EnergyLevel = "bassa" | "media" | "buona";

export interface AdaptiveMission {
  id: string;
  title: string;
  description: string;
  category: MissionCategory;
  estimatedMinutes: number;
  durationLabel: string;
  effortLevel: MissionEffort;
  goal: string;
  instructions: string[];
  createdAt: string;
  updatedAt?: string;
  status: MissionStatus;
  source: "local-adaptive" | "gemini-json" | "manual";
  adaptationNote?: string;
}

export interface MissionGenerationContext {
  availableMinutes: number;
  energyLevel: EnergyLevel;
  goals: string[];
  preferences: string[];
  recentMood?: string;
  recentStress?: number;
  emotionalAnalysis?: EmotionalAnalysis | null;
  consentEnabled: boolean;
  existingMissions: AdaptiveMission[];
  focusNote?: string;
}

export interface MissionGenerationResult {
  missions: AdaptiveMission[];
  source: "local-adaptive" | "gemini-json";
  askUserPreference: boolean;
  preferencePrompt?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  blockedBySafety?: boolean;
  safetyReply?: string;
}
