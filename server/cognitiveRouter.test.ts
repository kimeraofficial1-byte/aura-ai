import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthGoal } from "../src/growth/engine";
import { generateAdaptiveMissionsLocal } from "../src/missions/engine";
import { createPlan } from "../src/planning/planningEngine";
import { validateCognitiveRouteRequest } from "./cognitiveContext";
import {
  getServerCognitiveHealth,
  routeServerCognitiveRequest,
} from "./cognitiveRouter";

test("1. Healthcheck cognitivo restituisce stato sano e modello storage isolato", () => {
  const health = getServerCognitiveHealth();
  assert.equal(health.ok, true);
  assert.equal(health.engine, "cognitive-coordinator-v1");
  assert.equal(health.safetyPriority, true);
  assert.equal(health.storageModel, "per-request-isolated");
  assert.equal(typeof health.geminiConfigured, "boolean");
});

test("2. CHAT completa senza alterare dati o contratto SSE", async () => {
  const res = await routeServerCognitiveRequest({
    input: "Ciao AURA, oggi voglio fare ordine nei miei pensieri",
    consentEnabled: false,
  });

  assert.equal(res.ok, true);
  assert.equal(res.result.intent, "CHAT");
  assert.equal(res.result.status, "completed");
  assert.equal(res.result.verified, true);
  assert.equal(res.meta.hasOperationalData, false);
});

test("3 & 4. READ dei dati disponibili con Memoria AI OFF (e nessun dato inventato se assente)", async () => {
  // Senza snapshot fornito -> nessun dato inventato
  const emptyRead = await routeServerCognitiveRequest({
    input: "Mostrami i miei piani",
    consentEnabled: false,
  });
  assert.equal(emptyRead.ok, true);
  assert.equal(emptyRead.result.intent, "READ");
  assert.equal(emptyRead.result.data?.operational?.plans.length, 0);

  // Con snapshot operativo esplicito e Memoria AI OFF -> lettura reale
  const plan = createPlan({
    declaredGoal: "Completare Fase 5",
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
    1
  ).missions;
  const goal = createGrowthGoal({ title: "Leggere 10 pagine al giorno" });
  assert.ok(goal);

  const readWithData = await routeServerCognitiveRequest({
    input: "Mostrami i miei piani",
    consentEnabled: false,
    operationalSnapshot: {
      plans: [plan],
      missions,
      growthGoals: [goal],
    },
  });

  assert.equal(readWithData.ok, true);
  assert.equal(readWithData.meta.hasOperationalData, true);
  assert.equal(readWithData.result.data?.operational?.plans.length, 1);
  assert.equal(readWithData.result.data?.operational?.plans[0].id, plan.id);
  assert.equal(readWithData.result.data?.operational?.missions.length, 1);
  assert.equal(readWithData.result.data?.operational?.growthGoals.length, 1);
});

test("5. ANALYZE con dati realmente disponibili attiva Reasoning e Proactive", async () => {
  const plan = createPlan({
    declaredGoal: "Preparare demo tecnica",
    horizon: "weekly",
    consentEnabled: false,
  });

  const res = await routeServerCognitiveRequest({
    input: "Analizza le mie priorità e dammi suggerimenti",
    consentEnabled: false,
    operationalSnapshot: { plans: [plan] },
  });

  assert.equal(res.ok, true);
  assert.equal(res.result.intent, "ANALYZE");
  assert.equal(res.result.status, "completed");
  assert.ok(res.result.selectedEngines.includes("reasoning_engine"));
  assert.ok(res.result.selectedEngines.includes("proactive_engine"));
});

test("6, 7 & 8. PLAN/CREATE bloccato senza autorizzazione ed eseguito senza duplicazioni con autorizzazione valida", async () => {
  const blocked = await routeServerCognitiveRequest({
    input: "Crea un piano settimanale per studiare Node.js",
    consentEnabled: false,
    explicitSteps: [
      {
        id: "create-plan-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Studiare Node.js", horizon: "weekly" },
      },
    ],
  });
  assert.equal(blocked.result.status, "awaiting_authorization");
  assert.equal(blocked.result.data?.operational?.plans.length, 0);

  const approved = await routeServerCognitiveRequest({
    input: "Crea un piano settimanale per studiare Node.js",
    consentEnabled: false,
    explicitSteps: [
      {
        id: "create-plan-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Studiare Node.js", horizon: "weekly" },
      },
    ],
    approvedOperationIds: ["create-plan-1"],
  });
  assert.equal(approved.result.status, "completed");
  assert.equal(approved.result.verified, true);
  assert.equal(approved.result.data?.operational?.plans.length, 1);
});

test("9, 10 & 11. UPDATE/DELETE bloccati senza autorizzazione; approvazione riferita a un'altra operazione rifiutata", async () => {
  const plan = createPlan({
    declaredGoal: "Piano protetto",
    horizon: "daily",
    consentEnabled: false,
  });

  // UPDATE senza autorizzazione -> bloccato
  const updBlocked = await routeServerCognitiveRequest({
    input: "Modifica il mio piano",
    consentEnabled: false,
    operationalSnapshot: { plans: [plan] },
    explicitSteps: [
      {
        id: "upd-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: plan.id, title: "Nuovo titolo" },
      },
    ],
  });
  assert.equal(updBlocked.result.status, "awaiting_authorization");
  assert.equal(updBlocked.result.data?.operational?.plans[0].title, plan.title);

  // DELETE senza autorizzazione -> bloccato
  const delBlocked = await routeServerCognitiveRequest({
    input: "Elimina il mio piano",
    consentEnabled: false,
    operationalSnapshot: { plans: [plan] },
    explicitSteps: [
      {
        id: "del-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
  });
  assert.equal(delBlocked.result.status, "awaiting_authorization");
  assert.equal(delBlocked.result.data?.operational?.plans.length, 1);

  // Approvazione riferita a un'altra operazione ("other-op-99") -> RIFIUTATA
  const wrongApproval = await routeServerCognitiveRequest({
    input: "Elimina il mio piano",
    consentEnabled: false,
    operationalSnapshot: { plans: [plan] },
    explicitSteps: [
      {
        id: "del-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
    approvedOperationIds: ["other-op-99"],
  });
  assert.equal(wrongApproval.result.status, "awaiting_authorization");
  assert.equal(wrongApproval.result.data?.operational?.plans.length, 1);
});

test("12 & 13. Richiesta ambigua chiede chiarimento; Safety blocca prioritariamente", async () => {
  const ambiguous = await routeServerCognitiveRequest({
    input: "Elimina",
    consentEnabled: false,
  });
  assert.equal(ambiguous.result.status, "needs_clarification");
  assert.ok(ambiguous.result.clarificationQuestion);

  const crisis = await routeServerCognitiveRequest({
    input: "Non voglio più vivere, voglio farla finita",
    consentEnabled: false,
  });
  assert.equal(crisis.result.status, "safety_blocked");
  assert.equal(crisis.result.completedPhases.includes("ROUTING"), false);
  assert.ok(crisis.result.safetyReply);
});

test("14, 15 & 16. Timeout, AbortSignal ed errori degli engine gestiti in sicurezza", async () => {
  const slowAdapter = {
    runOrchestration: async () =>
      await new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late")), 200);
      }),
  };

  // Timeout
  const timeoutRes = await routeServerCognitiveRequest(
    { input: "Mostrami i miei piani", consentEnabled: false, timeoutMs: 15 },
    { adapterOverrides: slowAdapter }
  );
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.result.status, "timeout");

  // AbortSignal
  const controller = new AbortController();
  controller.abort();
  const abortRes = await routeServerCognitiveRequest(
    { input: "Mostrami i miei piani", consentEnabled: false },
    { signal: controller.signal }
  );
  assert.equal(abortRes.ok, false);
  assert.equal(abortRes.result.status, "cancelled");

  // Errore engine
  const errRes = await routeServerCognitiveRequest(
    { input: "Mostrami i miei piani", consentEnabled: false },
    {
      adapterOverrides: {
        runOrchestration: async () => {
          throw new Error("Simulated backend engine failure");
        },
      },
    }
  );
  assert.equal(errRes.ok, false);
  assert.equal(errRes.result.status, "failed");
  assert.match(errRes.result.errors[0].message, /Simulated backend engine failure/);
});

test("17 & 18. Isolamento tra richieste simultanee e validazione rigorosa degli input", async () => {
  const planA = createPlan({
    declaredGoal: "Piano Utente A",
    horizon: "daily",
    consentEnabled: false,
  });
  const planB = createPlan({
    declaredGoal: "Piano Utente B",
    horizon: "daily",
    consentEnabled: false,
  });

  const [resA, resB] = await Promise.all([
    routeServerCognitiveRequest({
      input: "Mostrami i miei piani",
      consentEnabled: false,
      operationalSnapshot: { plans: [planA] },
    }),
    routeServerCognitiveRequest({
      input: "Mostrami i miei piani",
      consentEnabled: false,
      operationalSnapshot: { plans: [planB] },
    }),
  ]);

  assert.equal(resA.result.data?.operational?.plans.length, 1);
  assert.equal(resA.result.data?.operational?.plans[0].id, planA.id);
  assert.equal(resB.result.data?.operational?.plans.length, 1);
  assert.equal(resB.result.data?.operational?.plans[0].id, planB.id);

  // Validazione input
  assert.equal(validateCognitiveRouteRequest(null).ok, false);
  assert.equal(validateCognitiveRouteRequest({ input: "" }).ok, false);
  assert.equal(validateCognitiveRouteRequest({ input: "a".repeat(4001) }).ok, false);
  assert.equal(validateCognitiveRouteRequest({ input: "Ciao", consentEnabled: false }).ok, true);
});
