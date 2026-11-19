import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { DataRepository } from "../persistence/dataManagement";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { EpistemicTag, ProactiveMode } from "../proactive/types";
import type { CognitiveTimeline } from "./cognitiveTimeline";

export interface EpistemicItem {
  id: string;
  label: string;
  detail: string;
  epistemicTag: EpistemicTag;
  confidence: number; // 0..1
  dataSource: string;
  uncertaintyNote: string;
}

export type StrategyCategory = "STANDARD" | "LIGHT" | "DEFERRED";

export type StrategyEffort = "basso" | "medio" | "alto";

export type StrategyReversibility = "reversibile" | "parzialmente_reversibile";

export interface AlternativeStrategy {
  id: string;
  category: StrategyCategory;
  title: string;
  goal: string;
  suggestedActions: string[];
  potentialBenefits: string[];
  risks: string[];
  effortRequired: StrategyEffort;
  impactOnOtherGoals: string;
  dependencies: string[];
  reversibility: StrategyReversibility;
  uncertaintyLevel: "bassa" | "media" | "alta";
  epistemicTag: EpistemicTag;
  confidence: number; // 0..1
  dataSource: string;
  uncertaintyNote: string;
}

export interface AuthorizedEmotionalSignal {
  primaryEmotion: string;
  intensity: number; // 0..10
  uncertain?: boolean;
  dataSource: string;
}

export interface AutonomousSituation {
  generatedAt: string;
  currentSituationSummary: string;
  activeGoals: EpistemicItem[];
  documentedProgress: EpistemicItem[];
  detectedDifficulties: EpistemicItem[];
  deadlinesAndDependencies: EpistemicItem[];
  potentialFutureNeeds: EpistemicItem[];
  missingData: EpistemicItem[];
  uncertaintyFactors: EpistemicItem[];
  emotionalContextAuthorized: boolean;
  emotionalSummary?: EpistemicItem;
  insufficientData: boolean;
  epistemicTag: EpistemicTag;
  confidence: number; // 0..1
  dataSource: string;
  uncertaintyNote: string;
}

export interface AutonomousEngineInput {
  mode: ProactiveMode;
  repository?: DataRepository;
  plans?: PersonalPlan[];
  missions?: AdaptiveMission[];
  growthGoals?: GrowthGoal[];
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  stressLevel?: number;
  nowIso?: string;
  timeline?: CognitiveTimeline;
  learningEngine?: ControlledLearningEngine;
  authorizedEmotionalSignal?: AuthorizedEmotionalSignal | null;
}

export interface AutonomousCycleResult {
  mode: ProactiveMode;
  effectivePolicyMode: "PASSIVE" | "ASSISTED";
  safetyBlocked: boolean;
  safetyReason?: string;
  executedActionsCount: 0;
  executionBlockedReason: string;
  insufficientData: boolean;
  statusMessage: string;
  situation: AutonomousSituation;
  strategies: AlternativeStrategy[];
  learningExplanation: string;
  generatedAt: string;
}
