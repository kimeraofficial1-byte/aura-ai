import assert from "node:assert/strict";
import test from "node:test";
import { SynapticRegistry } from "./synapticRegistry";

test("SynapticRegistry: registrazione, consultazione e rimozione dei motori", () => {
  const registry = new SynapticRegistry();

  const descriptor = registry.register({
    engineId: "reasoning_engine",
    name: "Reasoning Engine",
    version: "1.0.0",
    capabilities: ["structured_reasoning", "subproblem_decomposition"],
    supportedEvents: ["cognitive.input.received", "cognitive.reasoning.requested"],
    dependencies: [],
    status: "available",
    readOnly: true,
    priorityOrder: 50,
  });

  assert.equal(descriptor.engineId, "reasoning_engine");
  assert.equal(registry.has("reasoning_engine"), true);
  assert.equal(registry.list().length, 1);

  // Immutabilità esterna: mutare il descrittore restituito non altera il registro
  descriptor.capabilities.push("mutated_cap");
  assert.deepEqual(registry.get("reasoning_engine")?.capabilities, [
    "structured_reasoning",
    "subproblem_decomposition",
  ]);

  assert.throws(
    () =>
      registry.register({
        engineId: "reasoning_engine",
        name: "Duplicate",
        version: "1.0.0",
        capabilities: [],
        supportedEvents: ["cognitive.input.received"],
        dependencies: [],
        status: "available",
        readOnly: true,
      }),
    /già registrato/
  );

  assert.equal(registry.unregister("reasoning_engine"), true);
  assert.equal(registry.has("reasoning_engine"), false);
  assert.equal(registry.unregister("reasoning_engine"), false);
});

test("SynapticRegistry: ricerca deterministica per evento, capacità e stato", () => {
  const registry = new SynapticRegistry();

  registry.register({
    engineId: "low_priority_engine",
    name: "Low Engine",
    version: "1.0.0",
    capabilities: ["analysis"],
    supportedEvents: ["cognitive.analyze"],
    dependencies: [],
    status: "available",
    readOnly: true,
    priorityOrder: 10,
  });

  registry.register({
    engineId: "high_priority_engine",
    name: "High Engine",
    version: "1.0.0",
    capabilities: ["analysis", "continuity"],
    supportedEvents: ["cognitive.analyze"],
    dependencies: [],
    status: "available",
    readOnly: true,
    priorityOrder: 90,
  });

  registry.register({
    engineId: "disabled_engine",
    name: "Disabled Engine",
    version: "1.0.0",
    capabilities: ["analysis"],
    supportedEvents: ["*"],
    dependencies: [],
    status: "disabled",
    readOnly: true,
    priorityOrder: 100,
  });

  const byEvent = registry.findByEvent("cognitive.analyze");
  assert.deepEqual(
    byEvent.map((d) => d.engineId),
    ["high_priority_engine", "low_priority_engine"]
  );

  const byCap = registry.findByCapability("continuity");
  assert.deepEqual(
    byCap.map((d) => d.engineId),
    ["high_priority_engine"]
  );

  const includingDisabled = registry.findByEvent("cognitive.analyze", {
    includeNonAvailable: true,
  });
  assert.deepEqual(
    includingDisabled.map((d) => d.engineId),
    ["disabled_engine", "high_priority_engine", "low_priority_engine"]
  );
});

test("SynapticRegistry: verifica delle dipendenze mancanti e non disponibili", () => {
  const registry = new SynapticRegistry();

  registry.register({
    engineId: "safety_engine",
    name: "Safety Engine",
    version: "1.0.0",
    capabilities: ["safety_check"],
    supportedEvents: ["*"],
    dependencies: [],
    status: "available",
    readOnly: true,
  });

  registry.register({
    engineId: "dependent_engine",
    name: "Dependent Engine",
    version: "1.0.0",
    capabilities: ["continuity"],
    supportedEvents: ["cognitive.continuity.requested"],
    dependencies: ["safety_engine", "missing_repo_engine"],
    status: "available",
    readOnly: true,
  });

  const missingCheck = registry.checkDependencies("dependent_engine");
  assert.equal(missingCheck.satisfied, false);
  assert.deepEqual(missingCheck.missing, ["missing_repo_engine"]);
  assert.deepEqual(missingCheck.unavailable, []);

  registry.register({
    engineId: "missing_repo_engine",
    name: "Repo Engine",
    version: "1.0.0",
    capabilities: ["read"],
    supportedEvents: ["cognitive.context.requested"],
    dependencies: [],
    status: "unavailable",
    readOnly: true,
  });

  const unavailableCheck = registry.checkDependencies("dependent_engine");
  assert.equal(unavailableCheck.satisfied, false);
  assert.deepEqual(unavailableCheck.missing, []);
  assert.deepEqual(unavailableCheck.unavailable, ["missing_repo_engine"]);

  registry.setStatus("missing_repo_engine", "available");
  const okCheck = registry.checkDependencies("dependent_engine");
  assert.equal(okCheck.satisfied, true);
});
