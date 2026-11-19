import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthGoal } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import {
  classifyCognitiveIntent,
  CognitiveCoordinator,
} from "./cognitiveCoordinator";

test("1. Safety blocca l'elaborazione PRIMA del routing (flag crisisBlocked e testo di crisi)", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(undefined, storage);

  const byFlag = await coordinator.execute({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    crisisBlocked: true,
    storage,
  });

  assert.equal(byFlag.status, "safety_blocked");
  assert.ok(byFlag.completedPhases.includes("SAFETY"));
  assert.equal(byFlag.completedPhases.includes("ROUTING"), false);
  assert.equal(byFlag.completedPhases.includes("EXECUTION"), false);
  assert.deepEqual(byFlag.selectedEngines, ["safety_engine"]);
  assert.ok(byFlag.safetyReply);

  const byText = await coordinator.execute({
    input: "Non ce la faccio più, voglio farmi del male",
    consentEnabled: false,
    storage,
  });

  assert.equal(byText.status, "safety_blocked");
  assert.equal(byText.completedPhases.includes("ROUTING"), false);
  assert.ok(byText.safetyReply?.includes("112"));
});

test("2. CHAT completa il ciclo senza modificare i dati operativi", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Studiare architettura",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const coordinator = new CognitiveCoordinator(undefined, storage);
  const result = await coordinator.execute({
    input: "Ciao AURA, oggi mi sento un po' stanco ma motivato",
    consentEnabled: false,
    storage,
  });

  assert.equal(result.intent, "CHAT");
  assert.equal(result.status, "completed");
  assert.equal(result.verified, true);
  assert.ok(result.executionId.startsWith("cog-"));
  assert.equal(repo.getPlans().length, 1);
  assert.equal(repo.getPlans()[0].id, plan.id);
});

test("3 & 4. READ di piani, missioni e obiettivi con Memoria AI OFF senza creare o modificare dati", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);

  const plan = createPlan({
    declaredGoal: "Completare Cognitive V1",
    horizon: "weekly",
    consentEnabled: false,
  });
  const missions = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    2
  ).missions;
  const goal = createGrowthGoal({ title: "Meditare ogni mattina" });
  assert.ok(goal);

  repo.savePlans([plan]);
  repo.saveMissions(missions);
  repo.saveGrowthGoals([goal]);

  const coordinator = new CognitiveCoordinator(undefined, storage);

  const readPlans = await coordinator.execute({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });
  assert.equal(readPlans.intent, "READ");
  assert.equal(readPlans.status, "completed");
  assert.equal(readPlans.verified, true);
  assert.equal(readPlans.data?.operational?.plans.length, 1);
  assert.equal(repo.getPlans().length, 1);

  const readMissions = await coordinator.execute({
    input: "Recupera le mie missioni",
    consentEnabled: false,
    storage,
  });
  assert.equal(readMissions.intent, "READ");
  assert.equal(readMissions.status, "completed");
  assert.equal(readMissions.data?.operational?.missions.length, 2);
  assert.equal(repo.getMissions().length, 2);

  const readGoals = await coordinator.execute({
    input: "Visualizza i miei obiettivi di crescita",
    consentEnabled: false,
    storage,
  });
  assert.equal(readGoals.intent, "READ");
  assert.equal(readGoals.status, "completed");
  assert.equal(readGoals.data?.operational?.growthGoals.length, 1);
  assert.equal(repo.getGrowthGoals().length, 1);
});

test("5. CREATE richiede autorizzazione e con autorizzazione crea il piano su DataRepository", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const coordinator = new CognitiveCoordinator(undefined, storage);

  // Senza autorizzazione -> awaiting_authorization, nessuna creazione
  const pending = await coordinator.execute({
    input: "Crea un nuovo piano per correre 5 km",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "create-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Correre 5 km", horizon: "weekly" },
      },
    ],
  });
  assert.equal(pending.status, "awaiting_authorization");
  assert.equal(pending.authorizationsRequired.length, 1);
  assert.equal(pending.authorizationsRequired[0].approved, false);
  assert.equal(repo.getPlans().length, 0);

  // Con autorizzazione esplicita -> eseguito e verificato
  const approved = await coordinator.execute({
    input: "Crea un nuovo piano per correre 5 km",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "create-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Correre 5 km", horizon: "weekly" },
      },
    ],
    approvedOperationIds: ["create-1"],
  });
  assert.equal(approved.status, "completed");
  assert.equal(approved.verified, true);
  assert.equal(repo.getPlans().length, 1);
});

test("6. UPDATE rispetta le autorizzazioni e aggiorna il piano solo se approvato", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Imparare Rust",
    horizon: "monthly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const coordinator = new CognitiveCoordinator(undefined, storage);

  const blocked = await coordinator.execute({
    input: "Modifica il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "upd-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: plan.id, title: "Imparare Rust in 30 giorni" },
      },
    ],
  });
  assert.equal(blocked.status, "awaiting_authorization");
  assert.equal(repo.getPlans()[0].title, plan.title);

  const approved = await coordinator.execute({
    input: "Modifica il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "upd-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: plan.id, title: "Imparare Rust in 30 giorni" },
      },
    ],
    approvedOperationIds: ["upd-1"],
  });
  assert.equal(approved.status, "completed");
  assert.equal(approved.verified, true);
  assert.equal(repo.getPlans()[0].title, "Imparare Rust in 30 giorni");
});

test("7 & 8. DELETE senza conferma viene bloccato; DELETE con conferma viene autorizzato ed eseguito", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Piano temporaneo",
    horizon: "daily",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const coordinator = new CognitiveCoordinator(undefined, storage);

  const blocked = await coordinator.execute({
    input: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "del-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
  });
  assert.equal(blocked.intent, "DELETE");
  assert.equal(blocked.status, "awaiting_authorization");
  assert.equal(repo.getPlans().length, 1);

  const confirmed = await coordinator.execute({
    input: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "del-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
    approvedOperationIds: ["del-1"],
  });
  assert.equal(confirmed.intent, "DELETE");
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.verified, true);
  assert.equal(repo.getPlans().length, 0);
});

test("9. Richieste ambigue non vengono classificate come distruttive e richiedono chiarimento", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(undefined, storage);

  const ambiguousDelete = classifyCognitiveIntent("Elimina tutto");
  assert.equal(ambiguousDelete.ambiguous, true);
  assert.notEqual(ambiguousDelete.intent, "DELETE");

  const result = await coordinator.execute({
    input: "Elimina",
    consentEnabled: false,
    storage,
  });
  assert.equal(result.status, "needs_clarification");
  assert.ok(result.clarificationQuestion);
  assert.equal(result.completedPhases.includes("EXECUTION"), false);
});

test("10. Errori degli engine gestiti correttamente con dipendenze simulate", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(
    {
      runOrchestration: async () => {
        throw new Error("Simulated orchestration failure");
      },
    },
    storage
  );

  const result = await coordinator.execute({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.verified, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Simulated orchestration failure/);
});

test("11. Gestione corretta di timeout e cancellazione via AbortSignal", async () => {
  const storage = new MemoryStorageAdapter();

  // Timeout
  const slowCoordinator = new CognitiveCoordinator(
    {
      runOrchestration: async () =>
        await new Promise((resolve) => setTimeout(resolve, 200)),
    },
    storage
  );
  const timeoutRes = await slowCoordinator.execute({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
    timeoutMs: 15,
  });
  assert.equal(timeoutRes.status, "timeout");
  assert.equal(timeoutRes.verified, false);

  // Cancellazione via AbortController
  const controller = new AbortController();
  controller.abort();
  const cancelledRes = await slowCoordinator.execute({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
    signal: controller.signal,
  });
  assert.equal(cancelledRes.status, "cancelled");
  assert.equal(cancelledRes.verified, false);
});

test("12. ANALYZE integra Proactive Intelligence e restituisce tracciabilità completa", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(undefined, storage);

  const res = await coordinator.execute({
    input: "Analizza la mia giornata e dammi suggerimenti",
    consentEnabled: false,
    storage,
  });

  assert.equal(res.intent, "ANALYZE");
  assert.equal(res.status, "completed");
  assert.equal(res.verified, true);
  assert.ok(res.selectedEngines.includes("proactive_engine"));
  assert.ok(res.trace.length >= 9);
});
