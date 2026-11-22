import assert from "node:assert/strict";
import test from "node:test";
import { CognitiveEventBus } from "./cognitiveEventBus";
import { SynapticRegistry } from "./synapticRegistry";
import { SynapticRouter } from "./synapticRouter";

function setupRouter(config?: ConstructorParameters<typeof SynapticRouter>[1]) {
  const bus = new CognitiveEventBus();
  const registry = new SynapticRegistry();
  const router = new SynapticRouter(registry, config);
  return { bus, registry, router };
}

test("SynapticRouter: instradamento per eventi e capacità con priorità e gestione stati unavailable/disabled", async () => {
  const { bus, registry, router } = setupRouter();
  const traceOrder: string[] = [];

  registry.register(
    {
      engineId: "eng_low",
      name: "Engine Low",
      version: "1.0.0",
      capabilities: ["analyze"],
      supportedEvents: ["cognitive.analyze"],
      dependencies: [],
      status: "available",
      readOnly: true,
      priorityOrder: 10,
    },
    { handler: () => traceOrder.push("eng_low") }
  );

  registry.register(
    {
      engineId: "eng_high",
      name: "Engine High",
      version: "1.0.0",
      capabilities: ["analyze", "meta_trace"],
      supportedEvents: ["cognitive.analyze"],
      dependencies: [],
      status: "available",
      readOnly: true,
      priorityOrder: 90,
    },
    { handler: () => traceOrder.push("eng_high") }
  );

  registry.register(
    {
      engineId: "eng_unavail",
      name: "Engine Unavailable",
      version: "1.0.0",
      capabilities: ["analyze"],
      supportedEvents: ["cognitive.analyze"],
      dependencies: [],
      status: "unavailable",
      readOnly: true,
    },
    { handler: () => traceOrder.push("should_not_run") }
  );

  registry.register(
    {
      engineId: "eng_disabled",
      name: "Engine Disabled",
      version: "1.0.0",
      capabilities: ["analyze"],
      supportedEvents: ["cognitive.analyze"],
      dependencies: [],
      status: "disabled",
      readOnly: true,
    },
    { handler: () => traceOrder.push("should_not_run") }
  );

  const event = bus.createEvent({
    type: "cognitive.analyze",
    source: "test",
    priority: "high",
    payload: { topic: "routine" },
  });

  const result = await router.route(event);

  assert.equal(result.allowed, true);
  assert.equal(result.status, "partial");
  assert.deepEqual(traceOrder, ["eng_high", "eng_low"]);
  assert.deepEqual(result.executedEngines, ["eng_high", "eng_low"]);
  assert.deepEqual(
    result.records.find((r) => r.engineId === "eng_unavail")?.status,
    "skipped_unavailable"
  );
  assert.deepEqual(
    result.records.find((r) => r.engineId === "eng_disabled")?.status,
    "skipped_disabled"
  );

  // Filtro per capacità specifica
  const filteredEvent = bus.createEvent({
    type: "cognitive.analyze",
    source: "test",
    payload: { topic: "meta" },
  });
  const capFiltered = await router.route(filteredEvent, {
    requiredCapabilities: ["meta_trace"],
  });
  assert.equal(capFiltered.status, "completed");
  assert.deepEqual(capFiltered.executedEngines, ["eng_high"]);
});

test("SynapticRouter: blocco dipendenze mancanti e prevenzione duplicati e loop", async () => {
  const { bus, registry, router } = setupRouter({ maxHops: 2 });

  registry.register(
    {
      engineId: "eng_missing_dep",
      name: "Missing Dep",
      version: "1.0.0",
      capabilities: ["continuity"],
      supportedEvents: ["cognitive.test"],
      dependencies: ["non_existent_engine"],
      status: "available",
      readOnly: true,
    },
    { handler: () => "never" }
  );

  registry.register(
    {
      engineId: "eng_ok",
      name: "OK Engine",
      version: "1.0.0",
      capabilities: ["continuity"],
      supportedEvents: ["cognitive.test"],
      dependencies: [],
      status: "available",
      readOnly: true,
    },
    { handler: () => "executed-ok" }
  );

  const event1 = bus.createEvent({
    id: "evt-loop-check",
    correlationId: "corr-loop-1",
    type: "cognitive.test",
    source: "test",
    payload: {},
  });

  const res1 = await router.route(event1);
  assert.equal(
    res1.records.find((r) => r.engineId === "eng_missing_dep")?.status,
    "blocked_missing_dependency"
  );
  assert.equal(
    res1.records.find((r) => r.engineId === "eng_ok")?.status,
    "executed"
  );

  // Stesso evento/correlazione -> bloccato come duplicato
  const resDuplicate = await router.route(event1);
  assert.equal(
    resDuplicate.records.find((r) => r.engineId === "eng_ok")?.status,
    "blocked_duplicate"
  );

  // Ciclo rientrante su visitedEngines -> bloccato come loop
  const reentrantEvent = bus.createEvent({
    id: "evt-reentrant",
    correlationId: "corr-loop-2",
    type: "cognitive.test",
    source: "test",
    visitedEngines: ["eng_ok"],
    payload: {},
  });
  const resCycle = await router.route(reentrantEvent);
  assert.equal(
    resCycle.records.find((r) => r.engineId === "eng_ok")?.status,
    "blocked_loop"
  );

  // Hop depth oltre maxHops -> bloccato come loop
  const tooDeepEvent = bus.createEvent({
    id: "evt-too-deep",
    correlationId: "corr-loop-3",
    type: "cognitive.test",
    source: "test",
    hopDepth: 3,
    payload: {},
  });
  const resDeep = await router.route(tooDeepEvent);
  assert.equal(
    resDeep.records.find((r) => r.engineId === "eng_ok")?.status,
    "blocked_loop"
  );
});

test("SynapticRouter: gestione timeout, cancellazione AbortSignal, concorrenza e isolamento errori", async () => {
  const { bus, registry, router } = setupRouter({
    defaultTimeoutMs: 40,
    maxConcurrentPerEngine: 1,
    maxGlobalConcurrent: 2,
  });

  registry.register(
    {
      engineId: "slow_engine",
      name: "Slow Engine",
      version: "1.0.0",
      capabilities: ["slow"],
      supportedEvents: ["timeout.test"],
      dependencies: [],
      status: "available",
      readOnly: true,
    },
    {
      handler: ({ signal }) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve("too-late"), 300);
          signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        }),
    }
  );

  registry.register(
    {
      engineId: "failing_engine",
      name: "Failing Engine",
      version: "1.0.0",
      capabilities: ["err"],
      supportedEvents: ["error.test"],
      dependencies: [],
      status: "available",
      readOnly: true,
      priorityOrder: 20,
    },
    {
      handler: () => {
        throw new Error("Errore motore isolato");
      },
    }
  );

  registry.register(
    {
      engineId: "healthy_sibling",
      name: "Healthy Sibling",
      version: "1.0.0",
      capabilities: ["err"],
      supportedEvents: ["error.test"],
      dependencies: [],
      status: "available",
      readOnly: true,
      priorityOrder: 10,
    },
    { handler: () => "sibling-ok" }
  );

  // Timeout check
  const timeoutRes = await router.route(
    bus.createEvent({ type: "timeout.test", source: "test", payload: {} }),
    { timeoutMs: 25 }
  );
  assert.equal(timeoutRes.status, "timeout");
  assert.equal(timeoutRes.records[0].status, "timeout");

  // AbortSignal cancellation before dispatch
  const abortController = new AbortController();
  abortController.abort();
  const cancelledRes = await router.route(
    bus.createEvent({ type: "timeout.test", source: "test", payload: {} }),
    { signal: abortController.signal }
  );
  assert.equal(cancelledRes.status, "cancelled");

  // Concurrency check while slow_engine is running
  const slowController = new AbortController();
  const slowPromise = router.route(
    bus.createEvent({ type: "timeout.test", source: "test", payload: {} }),
    { timeoutMs: 200, signal: slowController.signal }
  );
  const concurrentBlocked = await router.route(
    bus.createEvent({ type: "timeout.test", source: "test", payload: {} }),
    { timeoutMs: 200 }
  );
  assert.equal(concurrentBlocked.records[0].status, "blocked_concurrency");
  slowController.abort();
  await slowPromise;

  // Error isolation check
  const errorIsolationRes = await router.route(
    bus.createEvent({ type: "error.test", source: "test", payload: {} })
  );
  assert.equal(errorIsolationRes.status, "partial");
  assert.equal(
    errorIsolationRes.records.find((r) => r.engineId === "failing_engine")?.status,
    "error"
  );
  assert.equal(
    errorIsolationRes.records.find((r) => r.engineId === "healthy_sibling")?.status,
    "executed"
  );
});

test("SynapticRouter: comportamento fail-closed su safety guard assente/crisi/dati corrotti e blocco mutazioni Fase 11.1", async () => {
  const { bus, registry, router } = setupRouter();
  let executed = 0;

  registry.register(
    {
      engineId: "safe_reader",
      name: "Safe Reader",
      version: "1.0.0",
      capabilities: ["read"],
      supportedEvents: ["cognitive.input"],
      dependencies: [],
      status: "available",
      readOnly: true,
    },
    {
      handler: () => {
        executed += 1;
        return "ok";
      },
    }
  );

  registry.register(
    {
      engineId: "mutating_engine",
      name: "Mutating Engine",
      version: "1.0.0",
      capabilities: ["write"],
      supportedEvents: ["cognitive.input"],
      dependencies: [],
      status: "available",
      readOnly: false,
    },
    {
      handler: () => {
        executed += 1;
        return "mutated";
      },
    }
  );

  // 1. Crisi rilevata -> blocco fail-closed immediato
  const crisisRes = await router.route(
    bus.createEvent({
      type: "cognitive.input",
      source: "test",
      payload: { userText: "non voglio più vivere" },
    })
  );
  assert.equal(crisisRes.allowed, false);
  assert.equal(crisisRes.safetyBlocked, true);
  assert.equal(crisisRes.status, "safety_blocked");
  assert.equal(executed, 0);

  // 2. Dati corrotti segnalati -> blocco fail-closed
  const corruptedFlagRes = await router.route(
    bus.createEvent({ type: "cognitive.input", source: "test", payload: { ok: true } }),
    { safetyInput: { corruptedDataDetected: true } }
  );
  assert.equal(corruptedFlagRes.safetyBlocked, true);
  assert.equal(executed, 0);

  // 3. Richiesta allowMutation in Fase 11.1 -> bloccata
  const mutationAttempt = await router.route(
    bus.createEvent({ type: "cognitive.input", source: "test", payload: { ok: true } }),
    { allowMutation: true }
  );
  assert.equal(mutationAttempt.allowed, false);
  assert.equal(executed, 0);

  // 4. Motore con readOnly=false bloccato per policy anche su evento sicuro
  const safeRes = await router.route(
    bus.createEvent({ type: "cognitive.input", source: "test", payload: { input: "ciao" } })
  );
  assert.equal(safeRes.allowed, true);
  assert.deepEqual(safeRes.executedEngines, ["safe_reader"]);
  assert.equal(
    safeRes.records.find((r) => r.engineId === "mutating_engine")?.status,
    "blocked_mutation_policy"
  );
  assert.equal(executed, 1);

  // 5. Safety guard assente o che lancia eccezione -> fail-closed
  const routerWithoutSafety = new SynapticRouter(registry, {
    safetyEvaluator: undefined,
  });
  const missingGuardRes = await routerWithoutSafety.route(
    bus.createEvent({ type: "cognitive.input", source: "test", payload: {} })
  );
  assert.equal(missingGuardRes.allowed, false);
  assert.equal(missingGuardRes.safetyBlocked, true);

  const routerThrowingSafety = new SynapticRouter(registry, {
    safetyEvaluator: () => {
      throw new Error("Guard corrupted");
    },
  });
  const throwingGuardRes = await routerThrowingSafety.route(
    bus.createEvent({ type: "cognitive.input", source: "test", payload: {} })
  );
  assert.equal(throwingGuardRes.allowed, false);
  assert.equal(throwingGuardRes.safetyBlocked, true);

  // 6. Evento corrotto -> fail-closed
  const invalidRoute = await router.route(null as unknown as ReturnType<typeof bus.createEvent>);
  assert.equal(invalidRoute.allowed, false);
  assert.equal(invalidRoute.safetyBlocked, true);
});
