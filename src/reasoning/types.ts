import type { ChatHistoryItem, WellnessContext } from "../types/aura";

export type ReasoningPhase =
  | "INPUT_ANALYSIS"
  | "GOAL_IDENTIFICATION"
  | "CONTEXT_RETRIEVAL"
  | "PROBLEM_DECOMPOSITION"
  | "STRATEGY_EVALUATION"
  | "SOLUTION_SELECTION"
  | "ANSWER_VALIDATION"
  | "RESPONSE_GENERATION";

export const REASONING_PHASES: readonly ReasoningPhase[] = [
  "INPUT_ANALYSIS",
  "GOAL_IDENTIFICATION",
  "CONTEXT_RETRIEVAL",
  "PROBLEM_DECOMPOSITION",
  "STRATEGY_EVALUATION",
  "SOLUTION_SELECTION",
  "ANSWER_VALIDATION",
  "RESPONSE_GENERATION",
] as const;

export type RequestComplexity = "simple" | "moderate" | "complex";

export interface ReasoningStrategy {
  id: string;
  label: string;
  rationale: string;
  suitabilityScore: number; // 0..10
  risks: string[];
}

export interface ReasoningValidation {
  passed: boolean;
  contradictionsDetected: string[];
  diagnosticRiskBlocked: boolean;
  externalActionBlocked: boolean;
  distinguishesSuggestionsFromActions: true;
  exposesPrivateChainOfThought: false;
}

export interface ReasoningResult {
  safetyBlocked: boolean;
  completedPhases: ReasoningPhase[];
  complexity: RequestComplexity;
  primaryGoal: string;
  subProblems: string[];
  facts: string[];
  assumptions: string[];
  uncertainties: string[];
  missingInformation: string[];
  needsClarification: boolean;
  clarificationQuestions: string[];
  evaluatedStrategies: ReasoningStrategy[];
  selectedStrategy: ReasoningStrategy | null;
  actionableSteps: string[];
  validation: ReasoningValidation;
  source: "local-deterministic" | "gemini-structured";
}

export interface ReasoningInput {
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  consentEnabled?: boolean;
  crisisBlocked?: boolean;
}
