import type { orchestratePersonalContext } from "../context/contextOrchestrator";

export type ContextOrchestrationInput = Parameters<typeof orchestratePersonalContext>[0];
export type ContextBundle = ReturnType<typeof orchestratePersonalContext>;
import type { GrowthGoal } from "../growth/types";
import type { AuraMemoryStore } from "../memory/storage";
import type { AdaptiveMission } from "../missions/types";
import type {
  OrchestrationRequest,
  OrchestrationRun,
  ToolStorageAdapter,
} from "../orchestration/types";
import type { DataRepository } from "../persistence/dataManagement";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { ProactiveAnalysisInput, ProactiveAnalysisResult } from "../proactive/types";
import type { ReasoningInput, ReasoningResult } from "../reasoning/types";

export type CognitivePhase =
  | "RECEIVE"
  | "SAFETY"
  | "INTENT"
  | "CONTEXT"
  | "REASONING"
  | "ROUTING"
  | "AUTHORIZATION"
  | "EXECUTION"
  | "VERIFICATION"
  | "RESPONSE";

export const COGNITIVE_PHASES: readonly CognitivePhase[] = [
  "RECEIVE",
  "SAFETY",
  "INTENT",
  "CONTEXT",
  "REASONING",
  "ROUTING",
  "AUTHORIZATION",
  "EXECUTION",
  "VERIFICATION",
  "RESPONSE",
] as const;

export type CognitiveIntent =
  | "CHAT"
  | "READ"
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "ANALYZE"
  | "PLAN"
  | "PROACTIVE_ANALYSIS"
  | "PROACTIVE_SUGGESTION";

export type CognitiveExecutionStatus =
  | "completed"
  | "safety_blocked"
  | "awaiting_authorization"
  | "needs_clarification"
  | "failed"
  | "cancelled"
  | "timeout";

export type CognitiveEngineId =
  | "safety_engine"
  | "context_engine"
  | "reasoning_engine"
  | "orchestration_engine"
  | "planning_engine"
  | "persistence_v2"
  | "proactive_engine"
  | "controlled_learning_engine";

export interface CognitiveSafetyCheckResult {
  safe: boolean;
  crisisDetected: boolean;
  reply?: string;
}

export interface CognitiveIntentClassification {
  intent: CognitiveIntent;
  ambiguous: boolean;
  clarificationQuestion?: string;
  reason: string;
}

export interface CognitiveAuthorizationRequirement {
  id: string;
  engine: CognitiveEngineId;
  operation: CognitiveIntent;
  reason: string;
  approved: boolean;
}

export interface CognitiveTraceEvent {
  phase: CognitivePhase;
  timestamp: string;
  summary: string;
}

export interface CognitiveErrorEntry {
  phase: CognitivePhase;
  message: string;
}

export interface CognitiveSessionContext {
  recentMood?: string;
  recentStress?: number;
  activeTab?: string;
}

export interface CognitiveAdapters {
  evaluateSafety: (input: string, crisisBlocked?: boolean) => CognitiveSafetyCheckResult;
  repository: DataRepository;
  memoryStore?: AuraMemoryStore;
  learningEngine?: ControlledLearningEngine;
  orchestrateContext: (input: ContextOrchestrationInput) => ContextBundle;
  runReasoning: (input: ReasoningInput) => ReasoningResult;
  runOrchestration: (request: OrchestrationRequest) => Promise<OrchestrationRun>;
  analyzeProactive: (input: ProactiveAnalysisInput) => ProactiveAnalysisResult;
}

export interface CognitiveRequest {
  input: string;
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  sessionContext?: CognitiveSessionContext;
  /** ID delle operazioni/step esplicitamente approvati dall'utente */
  approvedOperationIds?: string[];
  /** Step opzionali espliciti da inoltrare a Tool Orchestration V1.1 */
  explicitSteps?: OrchestrationRequest["explicitSteps"];
  /** Storage adapter opzionale per esecuzioni isolate o test */
  storage?: ToolStorageAdapter;
  /** Timeout massimo in millisecondi per la fase di esecuzione */
  timeoutMs?: number;
  /** Segnale di cancellazione esterno */
  signal?: AbortSignal;
}

export interface CognitiveResultData {
  operational?: {
    plans: PersonalPlan[];
    missions: AdaptiveMission[];
    growthGoals: GrowthGoal[];
  };
  reasoning?: ReasoningResult;
  orchestration?: OrchestrationRun;
  proactive?: ProactiveAnalysisResult;
  contextItemsCount?: number;
  learningEnabled?: boolean;
}

export interface CognitiveResult {
  executionId: string;
  intent: CognitiveIntent;
  completedPhases: CognitivePhase[];
  selectedEngines: CognitiveEngineId[];
  authorizationsRequired: CognitiveAuthorizationRequirement[];
  status: CognitiveExecutionStatus;
  verified: boolean;
  summary: string;
  clarificationQuestion?: string;
  safetyReply?: string;
  data?: CognitiveResultData;
  errors: CognitiveErrorEntry[];
  trace: CognitiveTraceEvent[];
}
