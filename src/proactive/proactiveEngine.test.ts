import assert from "node:assert/strict";
import test from "node:test";
import { executeServerProactiveAnalysis } from "../../server/proactiveEngine";
import { createGrowthGoal } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import {
  analyzeProactiveOpportunities,
  snoozeSuggestion,
  transitionSuggestionStatus,
} from "./proactiveEngine";
import { ProactiveScheduler } from "./proactiveScheduler";

test("1. Rilevamento di attività in ritardo e nessuna modifica automatica ai piani", () => {
  const plan = createPlan(
    {
      declaredGoal: "Preparare il portfolio",
      horizon: "weekly",
      dailyMinutesLimit: 30,
      consentEnabled: false,
    },
    "2026-11-01T10:00:00.000Z"
  );
  const snapshotBefore = JSON.stringify(plan);

  const res = analyzeProactiveOpportunities({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
    nowIso: "2026-11-17T10:00:00.000Z",
  });

  assert.equal(res.safetyBlocked, false);
  assert.ok(res.suggestions.some((s) => s.dedupeKey.startsWith("overdue:")));
  assert.equal(res.suggestions[0].epistemicTag, "fatto_osservato");
  // Nessuna modifica automatica al piano originale
  assert.equal(JSON.stringify(plan), snapshotBefore);
});

test("2. Rilevamento di obiettivi senza progressi recenti", () => {
  const goal = createGrowthGoal({
    title: "Leggere 20 pagine al giorno",
    steps: ["Scegliere il libro"],
  });
  assert.ok(goal);
  const staleGoal = { ...goal, updatedAt: "2026-11-01T10:00:00.000Z" };

  const res = analyzeProactiveOpportunities({
    plans: [],
    missions: [],
    growthGoals: [staleGoal],
    consentEnabled: false,
    nowIso: "2026-11-17T10:00:00.000Z",
  });

  assert.ok(res.suggestions.some((s) => s.dedupeKey === `goal_stalled:${goal.id}`));
  assert.equal(res.suggestions[0].epistemicTag, "interpretazione_prudente");
});

test("3. Individuazione di conflitti di carico tra attività e limite giornaliero", () => {
  const plan = createPlan(
    {
      declaredGoal: "Organizzare la giornata",
      horizon: "daily",
      dailyMinutesLimit: 20,
      consentEnabled: false,
    },
    "2026-11-17T08:00:00.000Z"
  );
  // 3 attività nello stesso giorno superano i 20 min/giorno
  const res = analyzeProactiveOpportunities({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
    nowIso: "2026-11-17T09:00:00.000Z",
  });

  assert.ok(res.suggestions.some((s) => s.dedupeKey.startsWith("conflict:")));
});

test("4 & 5. Nessun dato inventato su stato vuoto ed eliminazione suggerimenti duplicati", () => {
  const emptyRes = analyzeProactiveOpportunities({
    plans: [],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(emptyRes.suggestions.length, 0);

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

  const first = analyzeProactiveOpportunities({
    plans: [],
    missions,
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(first.suggestions.length, 1);

  const second = analyzeProactiveOpportunities({
    plans: [],
    missions,
    growthGoals: [],
    consentEnabled: false,
    existingSuggestions: first.suggestions,
  });
  assert.equal(second.suggestions.length, 0);
  assert.equal(second.skippedDuplicates, 1);
});

test("6 & 7. Accettazione, rifiuto, completamento e rimando di un suggerimento", () => {
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

  const { suggestions } = analyzeProactiveOpportunities({
    plans: [],
    missions,
    growthGoals: [],
    consentEnabled: false,
  });
  const id = suggestions[0].id;

  const accepted = transitionSuggestionStatus(suggestions, id, "accepted");
  assert.equal(accepted[0].status, "accepted");

  const completed = transitionSuggestionStatus(accepted, id, "completed");
  assert.equal(completed[0].status, "completed");

  const rejected = transitionSuggestionStatus(suggestions, id, "rejected");
  assert.equal(rejected[0].status, "rejected");

  const snoozed = snoozeSuggestion(suggestions, id, 2, "2026-11-17T10:00:00.000Z");
  assert.ok(snoozed[0].snoozedUntil);
});

test("8, 9, 10 & 14. Modalità PASSIVE predefinita, ASSISTED, sospensione completa e nessuna notifica non autorizzata", () => {
  const scheduler = new ProactiveScheduler();
  assert.equal(scheduler.getConfig().mode, "PASSIVE");
  assert.equal(scheduler.canSendNotification(), false);

  const plan = createPlan({
    declaredGoal: "Studiare per il test",
    horizon: "daily",
    dailyMinutesLimit: 15,
    consentEnabled: false,
  });

  // In PASSIVE un evento automatico app viene saltato
  const passiveEvent = scheduler.runControlledAppEvent({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(passiveEvent.skippedReason, "passive_mode");
  assert.equal(passiveEvent.suggestions.length, 0);

  // In ASSISTED l'evento controllato produce suggerimenti, ma nessuna notifica
  scheduler.setMode("ASSISTED");
  const assistedEvent = scheduler.runControlledAppEvent(
    {
      plans: [plan],
      missions: [],
      growthGoals: [],
      consentEnabled: false,
    },
    100_000
  );
  assert.ok(assistedEvent.suggestions.length > 0);
  assert.equal(scheduler.canSendNotification(), false);

  // Sospensione completa blocca anche l'analisi manuale
  scheduler.suspend();
  const suspendedRes = scheduler.runManualAnalysis({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(suspendedRes.skippedReason, "suspended");
  assert.equal(suspendedRes.suggestions.length, 0);
});

test("11, 12 & 15. Memoria AI OFF, rispetto Safety Engine e compatibilità con Persistence Engine V1", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Completare il modulo proattivo",
    horizon: "daily",
    dailyMinutesLimit: 15,
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  // Con Memoria AI OFF, executeServerProactiveAnalysis NON chiama Gemini
  let geminiCalled = false;
  const offRes = await executeServerProactiveAnalysis({
    plans: repo.getPlans(),
    missions: [],
    growthGoals: [],
    consentEnabled: false,
    useGemini: true,
    geminiCaller: async () => {
      geminiCalled = true;
      return '{"description":"non deve essere chiamato"}';
    },
  });
  assert.equal(geminiCalled, false);
  assert.equal(offRes.usedGemini, false);
  assert.ok(offRes.result.suggestions.length > 0);

  // Priorità Safety Engine pre-modello
  const crisisRes = await executeServerProactiveAnalysis({
    plans: repo.getPlans(),
    missions: [],
    growthGoals: [],
    consentEnabled: true,
    userContextText: "Voglio farmi del male e farla finita",
    useGemini: true,
  });
  assert.equal(crisisRes.result.safetyBlocked, true);
  assert.equal(crisisRes.result.suggestions.length, 0);
  assert.ok(crisisRes.safetyReply && crisisRes.safetyReply.length > 20);
});
