import type { MetaCognitiveSafetyDecision } from "./metaCognitiveTypes";
import type { LearningConsentState } from "./selfLearningTypes";
import type {
  CognitiveEngineId,
  CognitiveSafetyCheckResult,
} from "./types";

/**
 * Livelli di priorità deterministici per eventi e sottoscrittori nel Neural Synaptic Core.
 */
export type CognitiveEventPriority = "low" | "normal" | "high" | "critical";

export const COGNITIVE_EVENT_PRIORITY_WEIGHTS: Readonly<
  Record<CognitiveEventPriority, number>
> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
} as const;

/**
 * Identificativi dei motori registrabili nel Synaptic Registry.
 * Estende direttamente CognitiveEngineId esistente senza duplicarlo.
 */
export type SynapticEngineId =
  | CognitiveEngineId
  | "cognitive_coordinator"
  | "unified_orchestrator"
  | "cognitive_process_monitor"
  | "meta_cognitive_intelligence"
  | "autonomous_intelligence"
  | "continuity_engine"
  | "cognitive_timeline"
  | "learning_safety_guard"
  | "authorization_ledger"
  | "controlled_execution_engine"
  | (string & {});

export type SynapticEngineStatus = "available" | "unavailable" | "disabled";

/**
 * Evento cognitivo tipizzato scambiato tramite CognitiveEventBus e SynapticRouter.
 */
export interface CognitiveEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  correlationId: string;
  parentEventId?: string;
  hopDepth: number;
  causationChain: string[];
  visitedEngines: string[];
  priority: CognitiveEventPriority;
  payload: TPayload;
  metadata?: Record<string, string | number | boolean>;
}

export interface CreateCognitiveEventInput<
  TPayload = Record<string, unknown>,
> {
  id?: string;
  type: string;
  source: string;
  timestamp?: string;
  correlationId?: string;
  parentEventId?: string;
  parentEvent?: CognitiveEvent<unknown>;
  hopDepth?: number;
  causationChain?: string[];
  visitedEngines?: string[];
  priority?: CognitiveEventPriority;
  payload: TPayload;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Descrittore canonico di un motore cognitivo registrato nel Synaptic Registry.
 */
export interface CognitiveEngineDescriptor {
  engineId: SynapticEngineId;
  name: string;
  version: string;
  capabilities: string[];
  supportedEvents: string[];
  dependencies: string[];
  status: SynapticEngineStatus;
  /** True per motori consultivi / di sola lettura (obbligatorio per esecuzione nella Fase 11.1). */
  readOnly: boolean;
  /** Ordinamento prioritario deterministico opzionale (valori più alti prima). */
  priorityOrder?: number;
  description?: string;
}

export interface SynapticEngineHandlerContext<
  TPayload = Record<string, unknown>,
> {
  event: CognitiveEvent<TPayload>;
  correlationId: string;
  descriptor: CognitiveEngineDescriptor;
  signal: AbortSignal;
  advisoryOnly: true;
  readOnly: true;
}

export type CognitiveEventHandler<
  TPayload = Record<string, unknown>,
  TResult = unknown,
> = (
  context: SynapticEngineHandlerContext<TPayload>
) => Promise<TResult> | TResult;

export type BusSubscriberHandler<TPayload = Record<string, unknown>> = (
  event: CognitiveEvent<TPayload>,
  signal: AbortSignal
) => Promise<unknown> | unknown;

export interface CognitiveEventBusSubscribeOptions {
  priority?: CognitiveEventPriority;
  subscriberId?: string;
  once?: boolean;
}

export interface CognitiveEventSubscription {
  subscriberId: string;
  eventType: string;
  unsubscribe: () => void;
}

export interface CognitiveEventBusConfig {
  maxQueueSize?: number;
  maxEventDepth?: number;
  maxDedupeHistory?: number;
  maxSubscribersPerEvent?: number;
}

export interface SubscriberDeliveryOutcome {
  subscriberId: string;
  status: "delivered" | "error";
  durationMs: number;
  result?: unknown;
  error?: string;
}

export type CognitiveBusDispatchStatus =
  | "dispatched"
  | "duplicate_ignored"
  | "rejected_invalid"
  | "rejected_loop"
  | "rejected_queue_limit"
  | "disposed";

export interface CognitiveBusDispatchResult {
  accepted: boolean;
  status: CognitiveBusDispatchStatus;
  eventId: string;
  correlationId: string;
  matchedSubscribers: number;
  deliveredCount: number;
  failedCount: number;
  outcomes: SubscriberDeliveryOutcome[];
  reason?: string;
}

export interface SynapticEngineRegistrationOptions<
  TPayload = Record<string, unknown>,
  TResult = unknown,
> {
  replace?: boolean;
  handler?: CognitiveEventHandler<TPayload, TResult>;
}

export interface DependencyCheckResult {
  satisfied: boolean;
  missing: string[];
  unavailable: string[];
}

export interface SynapticSafetyInput {
  event: CognitiveEvent;
  userTextForSafetyCheck?: string;
  crisisBlocked?: boolean;
  corruptedDataDetected?: boolean;
  consentState?: LearningConsentState;
  usesLearningData?: boolean;
  nowIso?: string;
}

export interface SynapticSafetyVerdict {
  allowed: boolean;
  failClosed: boolean;
  reason: string;
  crisisCheck?: CognitiveSafetyCheckResult;
  metaSafetyDecision?: MetaCognitiveSafetyDecision;
}

export type SynapticSafetyEvaluator = (
  input: SynapticSafetyInput
) => SynapticSafetyVerdict;

export interface SynapticRoutingOptions {
  requiredCapabilities?: string[];
  targetEngineIds?: string[];
  safetyInput?: Omit<SynapticSafetyInput, "event">;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxHops?: number;
  /** Nella Fase 11.1 qualsiasi richiesta di mutazione autonoma viene bloccata fail-closed. */
  allowMutation?: boolean;
  preventDuplicateActivation?: boolean;
}

export type SynapticRouteOutcomeStatus =
  | "executed"
  | "skipped_unavailable"
  | "skipped_disabled"
  | "blocked_missing_dependency"
  | "blocked_dependency_unavailable"
  | "blocked_loop"
  | "blocked_duplicate"
  | "blocked_concurrency"
  | "blocked_mutation_policy"
  | "blocked_safety"
  | "timeout"
  | "cancelled"
  | "error";

export interface SynapticRouteExecutionRecord {
  engineId: string;
  descriptor: CognitiveEngineDescriptor;
  status: SynapticRouteOutcomeStatus;
  reason: string;
  durationMs: number;
  output?: unknown;
  error?: string;
}

export type SynapticRoutingOverallStatus =
  | "completed"
  | "partial"
  | "blocked"
  | "safety_blocked"
  | "no_matching_engines"
  | "cancelled"
  | "timeout";

export interface SynapticRoutingResult {
  allowed: boolean;
  safetyBlocked: boolean;
  status: SynapticRoutingOverallStatus;
  eventId: string;
  eventType: string;
  correlationId: string;
  matchedEngines: string[];
  executedEngines: string[];
  skippedOrBlockedEngines: string[];
  records: SynapticRouteExecutionRecord[];
  safetyVerdict: SynapticSafetyVerdict;
  reason: string;
  timestamp: string;
}

export interface SynapticCorrelationRecord {
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  eventIds: string[];
  parentLinks: Array<{ eventId: string; parentEventId?: string; eventType: string }>;
  invokedEngines: string[];
  blockedEngines: string[];
  safetyBlocked: boolean;
}

export interface SynapticCoordinationResult {
  accepted: boolean;
  event: CognitiveEvent;
  busResult: CognitiveBusDispatchResult;
  routingResult: SynapticRoutingResult;
  correlationRecord: SynapticCorrelationRecord;
}
