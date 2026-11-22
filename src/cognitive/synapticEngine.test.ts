import assert from "node:assert/strict";
import test from "node:test";
import { AuraMemoryStore } from "../memory/storage";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import {
  ADAPTIVE_LEARNING_STORAGE_KEY,
  AdaptiveLearningEngine,
} from "./adaptiveLearningEngine";
import { CognitiveCoordinator } from "./cognitiveCoordinator";
import { CognitiveTimeline } from "./cognitiveTimeline";
import { createAuraSynapticFoundation, SynapticEngine } from "./synapticEngine";
import { UnifiedCognitiveOrchestrator } from "./unifiedCognitiveOrchestrator";

test("SynapticEngine: coordinamento, correlazione padre-figlio, deduplicazione e cleanup", async () => {
  const engine = new SynapticEngine();
  const busReceived: string[] = [];

  engine.subscribe("cognitive.situation.requested", (ev) => {
    busReceived.push(`${ev.id}:${ev.correlationId}`);
  });

  engine.registerEngine(
    {
      engineId: "continuity_reader",
      name: "Continuity Reader",
      version: "1.0.0",
      capabilities: ["continuity"],
      supportedEvents: ["cognitive.situation.requested", "cognitive.followup"],
      dependencies: [],
      status: "available",
      readOnly: true,
    },
    { handler: ({ event }) => `ok:${event.id}` }
  );

  const rootResult = await engine.coordinateEvent({
    id: "evt-root-coord",
    type: "cognitive.situation.requested",
    source: "test",
    correlationId: "corr-main-01",
    priority: "high",
    payload: { request: "sintesi" },
  });

  assert.equal(rootResult.accepted, true);
  assert.equal(rootResult.routingResult.status, "completed");
  assert.deepEqual(rootResult.routingResult.executedEngines, ["continuity_reader"]);
  assert.deepEqual(busReceived, ["evt-root-coord:corr-main-01"]);

  // Evento duplicato ignorato
  const dupResult = await engine.coordinateEvent(rootResult.event);
  assert.equal(dupResult.accepted, false);
  assert.equal(dupResult.busResult.status, "duplicate_ignored");

  // Evento figlio collegato tramite parentEvent
  const childEvent = engine.createEvent({
    id: "evt-child-coord",
    type: "cognitive.followup",
    source: "test",
    parentEvent: rootResult.event,
    payload: { step: 2 },
  });
  const childResult = await engine.coordinateEvent(childEvent);
  assert.equal(childResult.accepted, true);

  const correlation = engine.getCorrelationRecord("corr-main-01");
  assert.ok(correlation);
  assert.deepEqual(correlation.eventIds, ["evt-root-coord", "evt-child-coord"]);
  assert.equal(correlation.parentLinks[1].parentEventId, "evt-root-coord");

  // Coda prioritaria
  const order: string[] = [];
  engine.registerEngine(
    {
      engineId: "queue_observer",
      name: "Queue Observer",
      version: "1.0.0",
      capabilities: ["queue"],
      supportedEvents: ["queue.item"],
      dependencies: [],
      status: "available",
      readOnly: true,
    },
    {
      handler: ({ event }) => {
        order.push(String(event.payload.label));
      },
    }
  );

  engine.enqueueEvent({ type: "queue.item", source: "test", priority: "low", payload: { label: "low" } });
  engine.enqueueEvent({
    type: "queue.item",
    source: "test",
    priority: "critical",
    payload: { label: "critical" },
  });
  engine.enqueueEvent({
    type: "queue.item",
    source: "test",
    priority: "high",
    payload: { label: "high" },
  });

  await engine.flushQueue();
  assert.deepEqual(order, ["critical", "high", "low"]);

  engine.dispose();
  assert.equal(engine.isDisposed(), true);
  const afterDispose = await engine.coordinateEvent({
    type: "queue.item",
    source: "test",
    payload: { label: "after" },
  });
  assert.equal(afterDispose.accepted, false);
});

test("SynapticEngine: fail-closed non propaga eventi bloccati dal Safety Engine ai sottoscrittori", async () => {
  const { engine } = createAuraSynapticFoundation();
  let busSubscriberCalls = 0;

  engine.subscribe("*", () => {
    busSubscriberCalls += 1;
  });

  const blocked = await engine.coordinateEvent({
    type: "cognitive.input.received",
    source: "test",
    payload: { input: "voglio farla finita" },
  });

  assert.equal(blocked.accepted, false);
  assert.equal(blocked.routingResult.safetyBlocked, true);
  assert.equal(busSubscriberCalls, 0);
  assert.equal(blocked.correlationRecord.safetyBlocked, true);
});

test("SynapticEngine + motori reali AURA: integrazione retrocompatibile senza mutazioni, senza azioni esterne e senza esecuzioni autonome", async () => {
  const storage = new MemoryStorageAdapter();
  const repository = new DataRepository(storage);
  repository.savePlans([
    {
      id: "plan-1",
      title: "Routine studio",
      declaredGoal: "Studiare 20 minuti",
      desiredOutcome: "Completare capitolo 1",
      horizon: "daily",
      createdAt: "2026-11-20T09:00:00.000Z",
      updatedAt: "2026-11-20T09:00:00.000Z",
      targetDate: "2026-11-21",
      constraints: [],
      dailyMinutesLimit: 30,
      uncertainties: [],
      status: "active",
      revisions: [],
      reasoningSummary: "Piano test locale",
      progressPercent: 0,
      source: "local",
      sessionOnly: false,
      tasks: [
        {
          id: "task-1",
          title: "Ripasso capitolo 1",
          description: "Lettura sintetica",
          status: "pending",
          priority: "media",
          dueDate: "2026-11-21",
          estimatedMinutes: 20,
          uncertaintyNote: "Stima test",
          dependencies: [],
          resources: [],
          subtasks: [],
          alternatives: [],
          horizonBucket: "oggi",
        },
      ],
    },
  ]);

  const initialRevision = repository.loadSnapshot().revision;
  const timeline = new CognitiveTimeline(storage);
  const memoryStore = new AuraMemoryStore(storage);
  memoryStore.setConsent(false);
  const adaptiveLearning = new AdaptiveLearningEngine(storage);
  const initialAdaptiveStorage = storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY);
  const initialHints = adaptiveLearning.getAdaptationHints({
    learningConsent: true,
    aiMemoryConsent: false,
  });

  const coordinator = new CognitiveCoordinator({ repository, memoryStore }, storage);
  const unifiedOrchestrator = new UnifiedCognitiveOrchestrator({
    coordinator,
    repository,
  });

  // Spy su fetch globale per garantire zero chiamate di rete esterne
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("Nessuna chiamata esterna consentita in Fase 11.1");
  }) as typeof fetch;

  try {
    const { engine, registeredEngines } = createAuraSynapticFoundation({
      storage,
      repository,
      timeline,
      coordinator,
      unifiedOrchestrator,
      defaultConsentState: {
        learningConsent: false,
        aiMemoryConsent: false,
      },
    });

    assert.ok(registeredEngines.length >= 10);

    // 1. Input classificato in sola lettura con safety_engine, cognitive_coordinator e unified_orchestrator
    const inputCoord = await engine.coordinateEvent({
      type: "cognitive.input.received",
      source: "test_integration",
      payload: {
        input: "mostrami i miei piani attuali",
      },
    });

    assert.equal(inputCoord.accepted, true);
    assert.ok(inputCoord.routingResult.executedEngines.includes("safety_engine"));
    assert.ok(inputCoord.routingResult.executedEngines.includes("cognitive_coordinator"));
    assert.ok(inputCoord.routingResult.executedEngines.includes("unified_orchestrator"));

    // 2. Situazione operativa letta da continuity_engine + autonomous_intelligence + cognitive_process_monitor + persistence_v2
    const situationCoord = await engine.coordinateEvent({
      type: "cognitive.situation.requested",
      source: "test_integration",
      payload: {
        aiMemoryConsent: false,
        consentState: { learningConsent: false, aiMemoryConsent: false },
      },
    });

    assert.equal(situationCoord.accepted, true);
    assert.ok(situationCoord.routingResult.executedEngines.includes("persistence_v2"));
    assert.ok(situationCoord.routingResult.executedEngines.includes("continuity_engine"));
    assert.ok(situationCoord.routingResult.executedEngines.includes("autonomous_intelligence"));
    assert.ok(
      situationCoord.routingResult.executedEngines.includes("cognitive_process_monitor")
    );

    // 3. ControlledExecutionEngine resta bloccato / disabilitato nella Fase 11.1
    const execAttempt = await engine.coordinateEvent({
      type: "cognitive.execution.requested",
      source: "test_integration",
      payload: { action: "complete_plan_task" },
    });
    assert.equal(
      execAttempt.routingResult.records.find((r) => r.engineId === "controlled_execution_engine")
        ?.status,
      "skipped_disabled"
    );
    assert.equal(
      execAttempt.routingResult.executedEngines.includes("controlled_execution_engine"),
      false
    );

    // 4. Verifica retrocompatibilità completa dei motori esistenti (CognitiveCoordinator & UnifiedOrchestrator)
    const legacyResult = await coordinator.execute({
      input: "mostrami i miei piani attuali",
      consentEnabled: false,
      storage,
    });
    assert.equal(legacyResult.status, "completed");
    assert.equal(legacyResult.verified, true);

    const unifiedLegacy = await unifiedOrchestrator.orchestrate({
      input: "analizza i miei piani",
      consentEnabled: false,
      storage,
    });
    assert.ok(unifiedLegacy.proactiveResult || unifiedLegacy.cognitiveResult);

    // 5. Nessuna mutazione indesiderata su DataRepository, AuraMemoryStore, consensi o pesi adattivi
    assert.equal(repository.loadSnapshot().revision, initialRevision);
    assert.equal(repository.getPlans()[0].tasks[0].status, "pending");
    assert.equal(memoryStore.getConsent().enabled, false);
    assert.equal(memoryStore.getLongTermMemory().goalsAndStrategies.length, 0);
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), initialAdaptiveStorage);
    assert.deepEqual(
      adaptiveLearning.getAdaptationHints({
        learningConsent: true,
        aiMemoryConsent: false,
      }).strategyWeights,
      initialHints.strategyWeights
    );
    assert.equal(timeline.getEvents().length, 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
