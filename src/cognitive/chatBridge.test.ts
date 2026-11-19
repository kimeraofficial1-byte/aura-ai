import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthGoal } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { routeChatMessageWithCoordinator } from "./chatBridge";
import { CognitiveCoordinator } from "./cognitiveCoordinator";

test("F4.1. CHAT normale viene instradata allo streaming SSE di Gemini (stream_gemini)", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(undefined, storage);

  const outcome = await routeChatMessageWithCoordinator(coordinator, {
    input: "Ciao AURA, oggi ho voglia di fare chiarezza sui miei pensieri",
    consentEnabled: false,
    storage,
  });

  assert.equal(outcome.mode, "stream_gemini");
  assert.equal(outcome.result.intent, "CHAT");
  assert.equal(outcome.result.status, "completed");
});

test("F4.2, F4.3 & F4.4. READ di piani, missioni e obiettivi con Memoria AI OFF", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);

  const plan = createPlan({
    declaredGoal: "Imparare Docker",
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
  const goal = createGrowthGoal({ title: "Dormire prima delle 23" });
  assert.ok(goal);

  repo.savePlans([plan]);
  repo.saveMissions(missions);
  repo.saveGrowthGoals([goal]);

  const coordinator = new CognitiveCoordinator(undefined, storage);

  const plansRes = await routeChatMessageWithCoordinator(coordinator, {
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });
  assert.equal(plansRes.mode, "direct");
  assert.ok(plansRes.reply?.includes(plan.title));
  assert.equal(repo.getPlans().length, 1);

  const missionsRes = await routeChatMessageWithCoordinator(coordinator, {
    input: "Recupera le mie missioni",
    consentEnabled: false,
    storage,
  });
  assert.equal(missionsRes.mode, "direct");
  assert.ok(missionsRes.reply?.includes("missioni"));
  assert.equal(repo.getMissions().length, 2);

  const goalsRes = await routeChatMessageWithCoordinator(coordinator, {
    input: "Visualizza i miei obiettivi di crescita",
    consentEnabled: false,
    storage,
  });
  assert.equal(goalsRes.mode, "direct");
  assert.ok(goalsRes.reply?.includes("Dormire prima delle 23"));
  assert.equal(repo.getGrowthGoals().length, 1);
});

test("F4.5. ANALYZE analizza i dati reali tramite Reasoning e Proactive Intelligence", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Consegnare report mensile",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const coordinator = new CognitiveCoordinator(undefined, storage);
  const res = await routeChatMessageWithCoordinator(coordinator, {
    input: "Analizza le mie priorità e dammi suggerimenti",
    consentEnabled: false,
    storage,
  });

  assert.equal(res.mode, "direct");
  assert.equal(res.result.intent, "ANALYZE");
  assert.equal(res.result.status, "completed");
  assert.ok(res.result.selectedEngines.includes("proactive_engine"));
  assert.ok(res.result.selectedEngines.includes("reasoning_engine"));
});

test("F4.6, F4.7 & F4.8. PLAN/CREATE e UPDATE richiedono conferma esplicita e non duplicano", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const coordinator = new CognitiveCoordinator(undefined, storage);

  // PLAN senza conferma -> awaiting_confirmation
  const planPending = await routeChatMessageWithCoordinator(coordinator, {
    input: "Crea un piano per studiare inglese",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "plan-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Studiare inglese", horizon: "weekly" },
      },
    ],
  });
  assert.equal(planPending.mode, "awaiting_confirmation");
  assert.ok(planPending.pendingAction);
  assert.equal(repo.getPlans().length, 0);

  // Conferma esplicita -> crea 1 solo piano (nessuna duplicazione)
  const planConfirmed = await routeChatMessageWithCoordinator(coordinator, {
    input: planPending.pendingAction.originalInput,
    consentEnabled: false,
    storage,
    explicitSteps: planPending.pendingAction.explicitSteps,
    approvedOperationIds: [planPending.pendingAction.operationId],
  });
  assert.equal(planConfirmed.mode, "direct");
  assert.equal(planConfirmed.result.status, "completed");
  assert.equal(repo.getPlans().length, 1);

  const createdId = repo.getPlans()[0].id;

  // UPDATE con conferma esplicita
  const updateConfirmed = await routeChatMessageWithCoordinator(coordinator, {
    input: "Modifica il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "upd-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: createdId, title: "Studiare inglese B2" },
      },
    ],
    approvedOperationIds: ["upd-1"],
  });
  assert.equal(updateConfirmed.mode, "direct");
  assert.equal(updateConfirmed.result.status, "completed");
  assert.equal(repo.getPlans()[0].title, "Studiare inglese B2");
});

test("F4.9 & F4.10. DELETE senza conferma bloccato e annullamento non modifica i dati", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Piano protetto",
    horizon: "daily",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const coordinator = new CognitiveCoordinator(undefined, storage);
  const delPending = await routeChatMessageWithCoordinator(coordinator, {
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

  assert.equal(delPending.mode, "awaiting_confirmation");
  assert.equal(delPending.pendingAction?.intent, "DELETE");
  // Simulazione annullamento: nessuna riesecuzione -> dato intatto
  assert.equal(repo.getPlans().length, 1);
});

test("F4.11 & F4.12. Richiesta ambigua chiede chiarimento; errori e timeout gestiti in sicurezza", async () => {
  const storage = new MemoryStorageAdapter();
  const coordinator = new CognitiveCoordinator(undefined, storage);

  const ambiguous = await routeChatMessageWithCoordinator(coordinator, {
    input: "Elimina",
    consentEnabled: false,
    storage,
  });
  assert.equal(ambiguous.mode, "direct");
  assert.equal(ambiguous.result.status, "needs_clarification");
  assert.ok(ambiguous.reply);

  const slowCoordinator = new CognitiveCoordinator(
    {
      runOrchestration: async () =>
        await new Promise((resolve) => setTimeout(resolve, 200)),
    },
    storage
  );
  const timedOut = await routeChatMessageWithCoordinator(slowCoordinator, {
    input: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
    timeoutMs: 15,
  });
  assert.equal(timedOut.mode, "direct");
  assert.equal(timedOut.result.status, "timeout");
  assert.ok(timedOut.reply?.includes("troppo tempo"));
});
