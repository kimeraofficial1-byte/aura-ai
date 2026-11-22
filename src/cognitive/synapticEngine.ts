import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import {
  AuthorizationLedger,
  ControlledExecutionEngine,
} from "./authorizationLedger";
import { synthesizeAutonomousSituation } from "./autonomousIntelligenceEngine";
import {
  classifyCognitiveIntent,
  evaluateCognitiveSafety,
  type CognitiveCoordinator,
} from "./cognitiveCoordinator";
import { CognitiveEventBus } from "./cognitiveEventBus";
import { monitorCognitiveProcess } from "./cognitiveProcessMonitor";
import { CognitiveTimeline } from "./cognitiveTimeline";
import { buildContinuitySnapshot } from "./continuityEngine";
import { evaluateLearningSafety } from "./learningSafetyGuard";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type { LearningConsentState } from "./selfLearningTypes";
import { SynapticRegistry } from "./synapticRegistry";
import { SynapticRouter, type SynapticRouterConfig } from "./synapticRouter";
import {
  COGNITIVE_EVENT_PRIORITY_WEIGHTS,
  type CognitiveBusDispatchResult,
  type CognitiveEngineDescriptor,
  type CognitiveEvent,
  type CognitiveEventBusConfig,
  type CognitiveEventBusSubscribeOptions,
  type CognitiveEventSubscription,
  type CreateCognitiveEventInput,
  type SynapticCoordinationResult,
  type SynapticCorrelationRecord,
  type SynapticEngineId,
  type SynapticEngineRegistrationOptions,
  type SynapticEngineStatus,
  type SynapticRoutingOptions,
  type SynapticRoutingResult,
} from "./synapticTypes";
import {
  classifyUnifiedIntent,
  type UnifiedCognitiveOrchestrator,
} from "./unifiedCognitiveOrchestrator";

export interface SynapticEngineConfig {
  busConfig?: CognitiveEventBusConfig;
  routerConfig?: SynapticRouterConfig;
  maxCorrelationHistory?: number;
}

/**
 * Synaptic Engine V1 (Fase 11.1 — Neural Synaptic Foundation).
 * Coordina CognitiveEventBus, SynapticRegistry e SynapticRouter mantenendo
 * una separazione rigorosa tra coordinamento e ragionamento/esecuzione:
 * - riceve/pubblica eventi cognitivi tipizzati;
 * - seleziona e instrada verso motori compatibili e disponibili in sola lettura;
 * - previene attivazioni duplicate dello stesso evento/correlazione;
 * - traccia correlationId e relazioni causali padre-figlio;
 * - non esegue azioni autonome né muta dati operativi, memoria o consensi.
 */
export class SynapticEngine {
  readonly bus: CognitiveEventBus;
  readonly registry: SynapticRegistry;
  readonly router: SynapticRouter;

  private readonly maxCorrelationHistory: number;
  private readonly correlationRecords = new Map<string, SynapticCorrelationRecord>();
  private readonly coordinatedEventIds = new Set<string>();
  private readonly history: SynapticCoordinationResult[] = [];
  private disposed = false;

  constructor(config: SynapticEngineConfig = {}) {
    this.bus = new CognitiveEventBus(config.busConfig);
    this.registry = new SynapticRegistry();
    this.router = new SynapticRouter(this.registry, config.routerConfig);
    this.maxCorrelationHistory = Math.max(10, config.maxCorrelationHistory ?? 500);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  registerEngine<TPayload = Record<string, unknown>, TResult = unknown>(
    descriptor: CognitiveEngineDescriptor,
    options?: SynapticEngineRegistrationOptions<TPayload, TResult>
  ): CognitiveEngineDescriptor {
    return this.registry.register(descriptor, options);
  }

  unregisterEngine(engineId: SynapticEngineId): boolean {
    return this.registry.unregister(engineId);
  }

  setEngineStatus(engineId: SynapticEngineId, status: SynapticEngineStatus): boolean {
    return this.registry.setStatus(engineId, status);
  }

  subscribe<TPayload = Record<string, unknown>>(
    eventType: string,
    handler: (
      event: CognitiveEvent<TPayload>,
      signal: AbortSignal
    ) => Promise<unknown> | unknown,
    options?: CognitiveEventBusSubscribeOptions
  ): CognitiveEventSubscription {
    return this.bus.subscribe(eventType, handler, options);
  }

  createEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateCognitiveEventInput<TPayload>
  ): CognitiveEvent<TPayload> {
    return this.bus.createEvent(input);
  }

  private upsertCorrelationRecord(
    event: CognitiveEvent,
    routingResult: SynapticRoutingResult
  ): SynapticCorrelationRecord {
    const nowIso = new Date().toISOString();
    const existing = this.correlationRecords.get(event.correlationId);
    const invokedSet = new Set(existing?.invokedEngines ?? []);
    for (const id of routingResult.executedEngines) {
      invokedSet.add(id);
    }
    const blockedSet = new Set(existing?.blockedEngines ?? []);
    for (const id of routingResult.skippedOrBlockedEngines) {
      blockedSet.add(id);
    }

    const updated: SynapticCorrelationRecord = {
      correlationId: event.correlationId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      eventIds: existing
        ? existing.eventIds.includes(event.id)
          ? existing.eventIds
          : [...existing.eventIds, event.id]
        : [event.id],
      parentLinks: existing
        ? existing.parentLinks.some((l) => l.eventId === event.id)
          ? existing.parentLinks
          : [
              ...existing.parentLinks,
              {
                eventId: event.id,
                parentEventId: event.parentEventId,
                eventType: event.type,
              },
            ]
        : [
            {
              eventId: event.id,
              parentEventId: event.parentEventId,
              eventType: event.type,
            },
          ],
      invokedEngines: Array.from(invokedSet),
      blockedEngines: Array.from(blockedSet),
      safetyBlocked: Boolean(existing?.safetyBlocked || routingResult.safetyBlocked),
    };

    this.correlationRecords.set(event.correlationId, updated);
    if (this.correlationRecords.size > this.maxCorrelationHistory) {
      const oldestKey = this.correlationRecords.keys().next().value;
      if (oldestKey !== undefined) {
        this.correlationRecords.delete(oldestKey);
      }
    }

    return {
      ...updated,
      eventIds: [...updated.eventIds],
      parentLinks: updated.parentLinks.map((l) => ({ ...l })),
      invokedEngines: [...updated.invokedEngines],
      blockedEngines: [...updated.blockedEngines],
    };
  }

  async coordinateEvent<
    TPayload extends Record<string, unknown> = Record<string, unknown>,
  >(
    eventOrInput: CognitiveEvent<TPayload> | CreateCognitiveEventInput<TPayload>,
    options: SynapticRoutingOptions = {}
  ): Promise<SynapticCoordinationResult> {
    const event: CognitiveEvent<TPayload> =
      eventOrInput &&
      typeof eventOrInput === "object" &&
      "id" in eventOrInput &&
      "correlationId" in eventOrInput &&
      "hopDepth" in eventOrInput &&
      "causationChain" in eventOrInput &&
      "visitedEngines" in eventOrInput &&
      typeof (eventOrInput as CognitiveEvent<TPayload>).id === "string"
        ? (eventOrInput as CognitiveEvent<TPayload>)
        : this.bus.createEvent(eventOrInput as CreateCognitiveEventInput<TPayload>);

    if (this.disposed) {
      const disposedReason = "SynapticEngine è stato dismesso (disposed).";
      const correlationRecord = this.upsertCorrelationRecord(event, {
        allowed: false,
        safetyBlocked: true,
        status: "blocked",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict: {
          allowed: false,
          failClosed: true,
          reason: disposedReason,
        },
        reason: disposedReason,
        timestamp: new Date().toISOString(),
      });

      return {
        accepted: false,
        event,
        busResult: {
          accepted: false,
          status: "disposed",
          eventId: event.id,
          correlationId: event.correlationId,
          matchedSubscribers: 0,
          deliveredCount: 0,
          failedCount: 0,
          outcomes: [],
          reason: disposedReason,
        },
        routingResult: {
          allowed: false,
          safetyBlocked: true,
          status: "blocked",
          eventId: event.id,
          eventType: event.type,
          correlationId: event.correlationId,
          matchedEngines: [],
          executedEngines: [],
          skippedOrBlockedEngines: [],
          records: [],
          safetyVerdict: {
            allowed: false,
            failClosed: true,
            reason: disposedReason,
          },
          reason: disposedReason,
          timestamp: new Date().toISOString(),
        },
        correlationRecord,
      };
    }

    // Prevenzione attivazione duplicata dello stesso evento prima di bus/router
    if (this.coordinatedEventIds.has(event.id) || this.bus.hasProcessedEvent(event.id)) {
      const duplicateReason = `Evento duplicato bloccato dal SynapticEngine (${event.id}).`;
      const duplicateRouting: SynapticRoutingResult = {
        allowed: false,
        safetyBlocked: false,
        status: "blocked",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict: {
          allowed: true,
          failClosed: false,
          reason: "Controllo saltato: evento già coordinato.",
        },
        reason: duplicateReason,
        timestamp: new Date().toISOString(),
      };
      const duplicateBus: CognitiveBusDispatchResult = {
        accepted: false,
        status: "duplicate_ignored",
        eventId: event.id,
        correlationId: event.correlationId,
        matchedSubscribers: 0,
        deliveredCount: 0,
        failedCount: 0,
        outcomes: [],
        reason: duplicateReason,
      };
      const correlationRecord = this.upsertCorrelationRecord(event, duplicateRouting);
      return {
        accepted: false,
        event,
        busResult: duplicateBus,
        routingResult: duplicateRouting,
        correlationRecord,
      };
    }

    // 1. Routing deterministico con controllo Safety fail-closed
    const routingResult = await this.router.route(event, options);

    // Se bloccato da sicurezza, politica o integrità -> non propagare ai sottoscrittori del bus (fail-closed)
    if (!routingResult.allowed || routingResult.safetyBlocked) {
      const blockedBus: CognitiveBusDispatchResult = {
        accepted: false,
        status: "rejected_invalid",
        eventId: event.id,
        correlationId: event.correlationId,
        matchedSubscribers: 0,
        deliveredCount: 0,
        failedCount: 0,
        outcomes: [],
        reason: routingResult.reason,
      };
      const correlationRecord = this.upsertCorrelationRecord(event, routingResult);
      const res: SynapticCoordinationResult = {
        accepted: false,
        event,
        busResult: blockedBus,
        routingResult,
        correlationRecord,
      };
      this.recordHistory(res);
      return res;
    }

    // 2. Pubblicazione sul CognitiveEventBus (con deduplicazione e isolamento errori sottoscrittori)
    this.coordinatedEventIds.add(event.id);
    if (this.coordinatedEventIds.size > this.maxCorrelationHistory * 4) {
      const oldest = this.coordinatedEventIds.values().next().value;
      if (oldest !== undefined) this.coordinatedEventIds.delete(oldest);
    }

    const busResult = await this.bus.publish(event, options.signal);
    const correlationRecord = this.upsertCorrelationRecord(event, routingResult);

    const coordinationResult: SynapticCoordinationResult = {
      accepted: busResult.accepted,
      event,
      busResult,
      routingResult,
      correlationRecord,
    };
    this.recordHistory(coordinationResult);
    return coordinationResult;
  }

  private readonly pendingPriorityQueue: Array<{
    event: CognitiveEvent;
    options: SynapticRoutingOptions;
    sequence: number;
  }> = [];
  private pendingSeq = 0;

  enqueueEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    eventOrInput: CognitiveEvent<TPayload> | CreateCognitiveEventInput<TPayload>,
    options: SynapticRoutingOptions = {}
  ): { accepted: boolean; eventId: string; correlationId: string; reason?: string } {
    const event: CognitiveEvent<TPayload> =
      eventOrInput &&
      typeof eventOrInput === "object" &&
      "id" in eventOrInput &&
      "correlationId" in eventOrInput &&
      "hopDepth" in eventOrInput &&
      "causationChain" in eventOrInput &&
      "visitedEngines" in eventOrInput &&
      typeof (eventOrInput as CognitiveEvent<TPayload>).id === "string"
        ? (eventOrInput as CognitiveEvent<TPayload>)
        : this.bus.createEvent(eventOrInput as CreateCognitiveEventInput<TPayload>);

    if (this.disposed) {
      return {
        accepted: false,
        eventId: event.id,
        correlationId: event.correlationId,
        reason: "SynapticEngine dismesso.",
      };
    }

    if (
      this.coordinatedEventIds.has(event.id) ||
      this.pendingPriorityQueue.some((q) => q.event.id === event.id)
    ) {
      return {
        accepted: false,
        eventId: event.id,
        correlationId: event.correlationId,
        reason: `Evento duplicato già in coda o elaborato (${event.id}).`,
      };
    }

    this.pendingSeq += 1;
    this.pendingPriorityQueue.push({
      event,
      options,
      sequence: this.pendingSeq,
    });
    this.pendingPriorityQueue.sort((a, b) => {
      const diff =
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[b.event.priority] -
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[a.event.priority];
      return diff !== 0 ? diff : a.sequence - b.sequence;
    });

    return {
      accepted: true,
      eventId: event.id,
      correlationId: event.correlationId,
    };
  }

  async flushQueue(signal?: AbortSignal): Promise<SynapticCoordinationResult[]> {
    const results: SynapticCoordinationResult[] = [];
    while (this.pendingPriorityQueue.length > 0) {
      if (signal?.aborted) break;
      const next = this.pendingPriorityQueue.shift();
      if (!next) break;
      const mergedOptions: SynapticRoutingOptions = signal
        ? { ...next.options, signal }
        : next.options;
      const result = await this.coordinateEvent(next.event, mergedOptions);
      results.push(result);
    }
    return results;
  }

  private recordHistory(result: SynapticCoordinationResult): void {
    this.history.unshift(result);
    if (this.history.length > this.maxCorrelationHistory) {
      this.history.length = this.maxCorrelationHistory;
    }
  }

  getCorrelationRecord(correlationId: string): SynapticCorrelationRecord | undefined {
    const rec = this.correlationRecords.get(correlationId);
    if (!rec) return undefined;
    return {
      ...rec,
      eventIds: [...rec.eventIds],
      parentLinks: rec.parentLinks.map((l) => ({ ...l })),
      invokedEngines: [...rec.invokedEngines],
      blockedEngines: [...rec.blockedEngines],
    };
  }

  getCoordinationHistory(): SynapticCoordinationResult[] {
    return [...this.history];
  }

  dispose(): void {
    this.disposed = true;
    this.pendingPriorityQueue.length = 0;
    this.bus.dispose();
    this.registry.clear();
    this.router.clearActivationHistory();
    this.correlationRecords.clear();
    this.coordinatedEventIds.clear();
  }
}

export interface AuraCoreWiringDependencies {
  storage?: StorageAdapter;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  authorizationLedger?: AuthorizationLedger;
  coordinator?: CognitiveCoordinator;
  unifiedOrchestrator?: UnifiedCognitiveOrchestrator;
  controlledExecutionEngine?: ControlledExecutionEngine;
  defaultConsentState?: LearningConsentState;
}

const DEFAULT_READ_ONLY_CONSENT: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: false,
};

/**
 * Registra in modo leggero, retrocompatibile e rigorosamente in sola lettura
 * i motori cognitivi esistenti di AURA AI all'interno del SynapticEngine (Fase 11.1).
 * Nessun motore viene riscritto o autorizzato a eseguire mutazioni autonome.
 */
export function registerAuraCoreEngines(
  engine: SynapticEngine,
  deps: AuraCoreWiringDependencies = {}
): CognitiveEngineDescriptor[] {
  const storage = deps.storage ?? new MemoryStorageAdapter();
  const repository = deps.repository ?? new DataRepository(storage);
  const timeline = deps.timeline ?? new CognitiveTimeline(storage);
  const ledger = deps.authorizationLedger ?? new AuthorizationLedger(storage);
  const defaultConsent = deps.defaultConsentState ?? DEFAULT_READ_ONLY_CONSENT;

  const registered: CognitiveEngineDescriptor[] = [];

  registered.push(
    engine.registerEngine(
      {
        engineId: "safety_engine",
        name: "AURA Safety & Meta-Cognitive Guard",
        version: "1.0.0",
        capabilities: ["safety_check", "crisis_detection", "meta_safety_guard"],
        supportedEvents: ["*"],
        dependencies: [],
        status: "available",
        readOnly: true,
        priorityOrder: 100,
        description:
          "Valutazione preventiva di sicurezza e crisi prima del coordinamento cognitivo.",
      },
      {
        replace: true,
        handler: ({ event }) => {
          const text =
            typeof event.payload.userText === "string"
              ? event.payload.userText
              : typeof event.payload.input === "string"
                ? event.payload.input
                : "";
          const safety = evaluateCognitiveSafety(
            text,
            event.payload.crisisBlocked === true
          );
          const consentState =
            (event.payload.consentState as LearningConsentState | undefined) ??
            defaultConsent;
          const metaSafety = evaluateMetaCognitiveSafety({
            operation: "analyze",
            consentState,
            usesLearningData: event.payload.usesLearningData === true,
            crisisBlocked: event.payload.crisisBlocked === true,
            userTextForSafetyCheck: text || undefined,
            nowIso: event.timestamp,
          });
          return {
            safe: safety.safe && metaSafety.allowed,
            crisisDetected: safety.crisisDetected,
            metaSafetyAllowed: metaSafety.allowed,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "persistence_v2",
        name: "DataRepository V2 (Read-Only Adapter)",
        version: "2.0.0",
        capabilities: ["operational_snapshot", "read_operational_data"],
        supportedEvents: [
          "cognitive.context.requested",
          "cognitive.continuity.requested",
          "cognitive.situation.requested",
        ],
        dependencies: ["safety_engine"],
        status: "available",
        readOnly: true,
        priorityOrder: 90,
        description:
          "Lettura controllata dei dati operativi separati dalla memoria personale AI.",
      },
      {
        replace: true,
        handler: () => {
          const snapshot = repository.loadSnapshot();
          return {
            schemaVersion: snapshot.schemaVersion,
            plansCount: snapshot.plans.length,
            missionsCount: snapshot.missions.length,
            growthGoalsCount: snapshot.growthGoals.length,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "learning_safety_guard",
        name: "Learning Safety Guard V1 (Read-Only Check)",
        version: "1.0.0",
        capabilities: ["learning_consent_check", "learning_safety"],
        supportedEvents: [
          "cognitive.learning.guard_check",
          "cognitive.meta.monitor",
        ],
        dependencies: ["safety_engine"],
        status: "available",
        readOnly: true,
        priorityOrder: 85,
        description:
          "Verifica deterministica fail-closed del consenso di apprendimento separato da AI Memory.",
      },
      {
        replace: true,
        handler: ({ event }) => {
          const consentState =
            (event.payload.consentState as LearningConsentState | undefined) ??
            defaultConsent;
          const decision = evaluateLearningSafety({
            operation: "read",
            consentState,
            crisisBlocked: event.payload.crisisBlocked === true,
            userTextForSafetyCheck:
              typeof event.payload.userText === "string"
                ? event.payload.userText
                : undefined,
            nowIso: event.timestamp,
          });
          return {
            allowed: decision.allowed,
            failClosed: decision.failClosed,
            reason: decision.reason,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "cognitive_coordinator",
        name: "CognitiveCoordinator V1 (Read-Only Classification Adapter)",
        version: "1.0.0",
        capabilities: ["intent_classification", "phase_coordination"],
        supportedEvents: [
          "cognitive.input.received",
          "cognitive.intent.classify",
        ],
        dependencies: ["safety_engine", "persistence_v2"],
        status: "available",
        readOnly: true,
        priorityOrder: 80,
        description:
          "Classificazione deterministica dell'intento cognitivo senza eseguire mutazioni.",
      },
      {
        replace: true,
        handler: ({ event }) => {
          const text =
            typeof event.payload.input === "string"
              ? event.payload.input
              : typeof event.payload.userText === "string"
                ? event.payload.userText
                : "";
          const classification = classifyCognitiveIntent(text);
          return {
            coordinatorAttached: Boolean(deps.coordinator),
            classification,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "unified_orchestrator",
        name: "UnifiedCognitiveOrchestrator V1 (Read-Only Adapter)",
        version: "1.0.0",
        capabilities: ["unified_intent_classification", "proactive_coordination"],
        supportedEvents: [
          "cognitive.input.received",
          "cognitive.proactive.evaluate",
        ],
        dependencies: ["safety_engine", "cognitive_coordinator"],
        status: "available",
        readOnly: true,
        priorityOrder: 75,
      },
      {
        replace: true,
        handler: ({ event }) => {
          const text =
            typeof event.payload.input === "string"
              ? event.payload.input
              : typeof event.payload.userText === "string"
                ? event.payload.userText
                : "";
          const unifiedIntent = classifyUnifiedIntent(text);
          return {
            unifiedIntent,
            proactiveMode: deps.unifiedOrchestrator?.getProactiveMode() ?? "PASSIVE",
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "cognitive_process_monitor",
        name: "Cognitive Process Monitor V1",
        version: "1.0.0",
        capabilities: ["process_monitoring", "meta_cognitive_trace"],
        supportedEvents: [
          "cognitive.meta.monitor",
          "cognitive.situation.requested",
        ],
        dependencies: ["safety_engine", "persistence_v2"],
        status: "available",
        readOnly: true,
        priorityOrder: 70,
      },
      {
        replace: true,
        handler: ({ event }) => {
          const consentState =
            (event.payload.consentState as LearningConsentState | undefined) ??
            defaultConsent;
          const monitorResult = monitorCognitiveProcess({
            traceId: `syn-${event.correlationId}`,
            consentState,
            usesLearningData: event.payload.usesLearningData === true,
            repository,
            timeline,
            crisisBlocked: event.payload.crisisBlocked === true,
            nowIso: event.timestamp,
          });
          return {
            allowed: monitorResult.allowed,
            lifecycleState: monitorResult.processLifecycleState,
            evidenceCount: monitorResult.trace.evidences.length,
            missingCount: monitorResult.trace.missingInformation.length,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "continuity_engine",
        name: "ContinuityEngine V1",
        version: "1.0.0",
        capabilities: ["cross_session_continuity", "progress_tracking"],
        supportedEvents: [
          "cognitive.continuity.requested",
          "cognitive.situation.requested",
        ],
        dependencies: ["safety_engine", "persistence_v2"],
        status: "available",
        readOnly: true,
        priorityOrder: 60,
      },
      {
        replace: true,
        handler: ({ event }) => {
          const snap = repository.loadSnapshot();
          const continuity = buildContinuitySnapshot({
            plans: snap.plans,
            missions: snap.missions,
            growthGoals: snap.growthGoals,
            consentEnabled: event.payload.aiMemoryConsent === true,
            crisisBlocked: event.payload.crisisBlocked === true,
            nowIso: event.timestamp,
            timeline,
          });
          return {
            insufficientData: continuity.insufficientData,
            goalEvolutionCount: continuity.goalEvolution.length,
            timelineEventsCount: continuity.timelineEventsCount,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "autonomous_intelligence",
        name: "AutonomousIntelligenceEngine V1 (Situation Synthesis Read-Only)",
        version: "1.0.0",
        capabilities: ["situation_synthesis", "need_detection"],
        supportedEvents: ["cognitive.situation.requested"],
        dependencies: ["safety_engine", "continuity_engine"],
        status: "available",
        readOnly: true,
        priorityOrder: 50,
        description:
          "Sintesi consultiva della situazione operativa: esecuzione autonoma disabilitata.",
      },
      {
        replace: true,
        handler: ({ event }) => {
          const situation = synthesizeAutonomousSituation({
            mode: "PASSIVE",
            consentEnabled: event.payload.aiMemoryConsent === true,
            crisisBlocked: event.payload.crisisBlocked === true,
            repository,
            timeline,
            nowIso: event.timestamp,
          });
          return {
            insufficientData: situation.insufficientData,
            activeGoalsCount: situation.activeGoals.length,
            uncertaintyCount: situation.uncertaintyFactors.length,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "cognitive_timeline",
        name: "CognitiveTimeline (Read-Only Adapter)",
        version: "1.0.0",
        capabilities: ["timeline_read"],
        supportedEvents: ["cognitive.continuity.requested", "cognitive.timeline.read"],
        dependencies: ["safety_engine"],
        status: "available",
        readOnly: true,
        priorityOrder: 55,
      },
      {
        replace: true,
        handler: () => {
          const events = timeline.getEvents();
          return {
            totalEvents: events.length,
          };
        },
      }
    )
  );

  registered.push(
    engine.registerEngine(
      {
        engineId: "authorization_ledger",
        name: "AuthorizationLedger (Read-Only Audit Adapter)",
        version: "1.0.0",
        capabilities: ["audit_read"],
        supportedEvents: ["cognitive.audit.read"],
        dependencies: ["safety_engine"],
        status: "available",
        readOnly: true,
        priorityOrder: 45,
      },
      {
        replace: true,
        handler: () => ({
          authorizationsCount: ledger.getAuthorizations().length,
          auditEventsCount: ledger.getAuditEvents().length,
        }),
      }
    )
  );

  // ControlledExecutionEngine rimane esplicitamente disabilitato in Fase 11.1 (nessuna esecuzione autonoma)
  registered.push(
    engine.registerEngine(
      {
        engineId: "controlled_execution_engine",
        name: "ControlledExecutionEngine (Locked in Phase 11.1)",
        version: "1.0.0",
        capabilities: ["controlled_execution"],
        supportedEvents: ["cognitive.execution.requested"],
        dependencies: ["safety_engine", "authorization_ledger"],
        status: "disabled",
        readOnly: false,
        priorityOrder: 10,
        description:
          "Motore di esecuzione controllata: disabilitato nel SynapticRouter durante la Fase 11.1.",
      },
      {
        replace: true,
        handler: () => {
          throw new Error(
            "ControlledExecutionEngine non può essere invocato autonomamente tramite SynapticEngine nella Fase 11.1."
          );
        },
      }
    )
  );

  return registered;
}

export function createAuraSynapticFoundation(
  deps: AuraCoreWiringDependencies = {},
  config: SynapticEngineConfig = {}
): {
  engine: SynapticEngine;
  registeredEngines: CognitiveEngineDescriptor[];
} {
  const engine = new SynapticEngine(config);
  const registeredEngines = registerAuraCoreEngines(engine, deps);
  return { engine, registeredEngines };
}
