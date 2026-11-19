export type OrchestrationPhase =
  | "RICEZIONE"
  | "ANALISI"
  | "SELEZIONE"
  | "VALIDAZIONE"
  | "PIANIFICAZIONE"
  | "AUTORIZZAZIONE"
  | "ESECUZIONE"
  | "VERIFICA"
  | "RECUPERO"
  | "RISPOSTA";

export const ORCHESTRATION_PHASES: readonly OrchestrationPhase[] = [
  "RICEZIONE",
  "ANALISI",
  "SELEZIONE",
  "VALIDAZIONE",
  "PIANIFICAZIONE",
  "AUTORIZZAZIONE",
  "ESECUZIONE",
  "VERIFICA",
  "RECUPERO",
  "RISPOSTA",
] as const;

export type OrchestrationIntent =
  | "READ"
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "ANALYZE";

export type ToolRiskLevel = "BASSO" | "MEDIO" | "ALTO";

export type ToolCategory =
  | "reasoning"
  | "planning"
  | "memory"
  | "emotion"
  | "growth"
  | "missions"
  | "context"
  | "external";

export type ToolPermission =
  | "internal_read"
  | "memory_consent"
  | "plan_write"
  | "external_action";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ToolStorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface ToolExecutionContext {
  intent: OrchestrationIntent;
  consentEnabled: boolean;
  crisisBlocked: boolean;
  signal: AbortSignal;
  /** Approvazioni specifiche per singolo stepId */
  approvedStepIds: ReadonlySet<string>;
  /** Storage opzionale per letture reali verificabili */
  storage?: ToolStorageAdapter;
}

export interface ToolExecutionResult<TOutput = unknown> {
  ok: boolean;
  verified: boolean;
  data?: TOutput;
  summary: string;
  error?: string;
  durationMs: number;
  attempts: number;
}

export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: ToolRiskLevel;
  requiredPermissions: ToolPermission[];
  /** Operazioni esplicitamente supportate dallo strumento (V1.1) */
  supportedOperations: OrchestrationIntent[];
  readOnly: boolean;
  modifiesData: boolean;
  requiresConsent: boolean;
  requiresConfirmation: boolean;
  timeoutMs: number;
  maxRetries: number;
  /** True solo se lo strumento ha un'implementazione reale e verificata */
  implemented: boolean;
  validateInput: (input: unknown, intent?: OrchestrationIntent) => ValidationResult;
  execute: (
    input: TInput,
    ctx: ToolExecutionContext
  ) => Promise<{ verified: boolean; data: TOutput; summary: string }>;
  onError?: (error: unknown, input: TInput) => string;
}

export type OrchestrationStepStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface OrchestrationStep {
  id: string;
  toolId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  operation: OrchestrationIntent;
  input: Record<string, unknown>;
  dependsOn: string[];
  status: OrchestrationStepStatus;
  approvalRequired: boolean;
  approvalReason?: string;
  result?: ToolExecutionResult;
  error?: string;
}

export type OrchestrationRunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "safety_blocked";

export interface OrchestrationRun {
  id: string;
  request: string;
  intent: OrchestrationIntent;
  createdAt: string;
  updatedAt: string;
  currentPhase: OrchestrationPhase;
  completedPhases: OrchestrationPhase[];
  status: OrchestrationRunStatus;
  steps: OrchestrationStep[];
  errors: string[];
  finalSummary: string;
  safetyBlocked: boolean;
  safetyReply?: string;
  source: "local" | "gemini";
}

export interface OrchestrationRequest {
  request: string;
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  /** Step espliciti (opzionali); se omessi l'engine seleziona gli strumenti automaticamente */
  explicitSteps?: Array<{
    id?: string;
    toolId: string;
    operation?: OrchestrationIntent;
    input: Record<string, unknown>;
    dependsOn?: string[];
  }>;
  /** Approvazioni specifiche per singolo stepId */
  approvedStepIds?: string[];
  signal?: AbortSignal;
  storage?: ToolStorageAdapter;
}
