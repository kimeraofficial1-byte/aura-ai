import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthGoal, setGrowthGoalStatus } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import {
  classifyUnifiedIntent,
  generateProactiveOpportunitiesV2,
  rankCognitiveOpportunities,
  UnifiedCognitiveOrchestrator,
} from "./unifiedCognitiveOrchestrator";

test("F6.1 & F6.2. Individuazione di opportunità reali vs dati insufficienti (nessun dato inventato)", () => {
  const empty = generateProactiveOpportunitiesV2({
    plans: [],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(empty.insufficientData, true);
  assert.equal(empty.opportunities.length, 0);

  const rawGoal = createGrowthGoal({ title: "Completare corso TypeScript" });
  assert.ok(rawGoal);
  const completedGoal = setGrowthGoalStatus(rawGoal, "completato");

  const withData = generateProactiveOpportunitiesV2({
    plans: [],
    missions: [],
    growthGoals: [completedGoal],
    consentEnabled: false,
  });
  assert.equal(withData.insufficientData, false);
  assert.ok(withData.opportunities.some((o) => o.category === "opportunity"));
  assert.ok(withData.opportunities.some((o) => o.epistemicTag === "fatto_osservato"));
});

test("F6.3, F6.4 & F6.5. Scadenze imminenti, sovraccarico e dipendenze bloccate", () => {
  const nowIso = "2026-11-18T10:00:00.000Z";
  const plan = createPlan({
    declaredGoal: "Preparare colloquio di lavoro",
    horizon: "daily",
    dailyMinutesLimit: 15,
    consentEnabled: false,
  });
  // Aggiungiamo scadenza imminente, carico elevato e dipendenza
  plan.tasks[0].dueDate = "2026-11-19T10:00:00.000Z";
  plan.tasks[0].estimatedMinutes = 45;
  if (plan.tasks[1]) {
    plan.tasks[1].dependencies = [plan.tasks[0].id];
    plan.tasks[1].estimatedMinutes = 40;
  }

  const res = generateProactiveOpportunitiesV2({
    plans: [plan],
    missions: [],
    growthGoals: [],
    availableMinutes: 15,
    energyLevel: "bassa",
    stressLevel: 8,
    consentEnabled: false,
    nowIso,
  });

  assert.equal(res.safetyBlocked, false);
  assert.ok(res.opportunities.length > 0);
  assert.ok(res.opportunities.some((o) => o.category === "difficulty" || o.category === "initiative"));
});

test("F6.6, F6.7, F6.8, F6.9 & F6.10. Deduplicazione, priorità, accettazione, rifiuto, rinvio e sospensione", () => {
  const nowIso = "2026-11-18T10:00:00.000Z";
  const learning = new ControlledLearningEngine(true);
  const orchestrator = new UnifiedCognitiveOrchestrator({ learningEngine: learning });

  const plan = createPlan({
    declaredGoal: "Organizzare settimana",
    horizon: "weekly",
    consentEnabled: false,
  });

  const first = generateProactiveOpportunitiesV2({
    plans: [plan],
    missions: [],
    growthGoals: [],
    availableMinutes: 20,
    consentEnabled: false,
    nowIso,
    learningEngine: learning,
  });
  assert.ok(first.opportunities.length > 0);

  // Deduplicazione su duplicati intenzionali
  const dupTest = rankCognitiveOpportunities(
    [first.opportunities[0], first.opportunities[0]],
    {
      nowIso,
      availableMinutes: 20,
      energyLevel: "media",
      stressLevel: 5,
    }
  );
  assert.equal(dupTest.ranked.length, 1);
  assert.equal(dupTest.skippedDuplicates, 1);

  // Decisioni esplicite: accepted, rejected, snoozed, suspended
  const accepted = orchestrator.applyOpportunityDecision(first.opportunities[0], "accepted", nowIso);
  assert.equal(accepted.status, "accepted");

  const rejected = orchestrator.applyOpportunityDecision(first.opportunities[0], "rejected", nowIso);
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.cooldownUntil);

  const snoozed = orchestrator.applyOpportunityDecision(first.opportunities[0], "snoozed", nowIso);
  assert.equal(snoozed.status, "snoozed");
  assert.ok(snoozed.cooldownUntil);

  const suspended = orchestrator.applyOpportunityDecision(first.opportunities[0], "suspended", nowIso);
  assert.equal(suspended.status, "suspended");

  // Un suggerimento sospeso/rifiutato NON viene riproposto
  const second = generateProactiveOpportunitiesV2({
    plans: [plan],
    missions: [],
    growthGoals: [],
    availableMinutes: 20,
    consentEnabled: false,
    nowIso,
    previousOpportunities: [suspended],
    learningEngine: learning,
  });
  assert.equal(
    second.opportunities.some((o) => o.dedupeKey === suspended.dedupeKey),
    false
  );
});

test("F6.11, F6.12 & F6.13. Controlled Learning V2 ON, OFF, alternativa più semplice e cancellazione dati", () => {
  const learning = new ControlledLearningEngine(true);
  learning.recordInteraction("missions", "rejected");
  learning.recordInteraction("missions", "rejected");
  assert.equal(learning.getInteractionCount(), 2);
  assert.equal(learning.getRejectedCount("missions"), 2);
  assert.ok(learning.getLearningExplanation().includes("attivo"));

  // Caso 3: rifiuti ripetuti -> propone alternativa più semplice
  const missions = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "bassa",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions;
  const withSimpler = generateProactiveOpportunitiesV2({
    plans: [],
    missions,
    growthGoals: [],
    consentEnabled: false,
    learningEngine: learning,
  });
  assert.ok(
    withSimpler.opportunities.some((o) =>
      o.title.toLowerCase().includes("alternativa più semplice")
    )
  );

  // Disattivazione: nessun aggiornamento registrato quando OFF
  learning.setEnabled(false);
  learning.recordInteraction("opportunity", "accepted");
  assert.equal(learning.getInteractionCount(), 2);
  assert.equal(learning.getCategoryWeight("missions"), 1.0);
  assert.ok(learning.getLearningExplanation().includes("disattivato"));

  // Cancellazione completa
  learning.clearLearningData();
  assert.equal(learning.getInteractionCount(), 0);
});

test("F6.14, F6.15, F6.16, F6.17, F6.18, F6.19 & F6.20. Memoria AI OFF, Safety prioritaria, CREATE/UPDATE/DELETE protetti, conferma e annullamento", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Piano protetto Fase 6",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const orchestrator = new UnifiedCognitiveOrchestrator({ repository: repo });
  assert.equal(orchestrator.getProactiveMode(), "PASSIVE");

  // Safety prioritaria
  const crisisRes = await orchestrator.orchestrate({
    input: "Non voglio più vivere, voglio farla finita",
    consentEnabled: false,
    storage,
  });
  assert.equal(crisisRes.cognitiveResult?.status, "safety_blocked");

  // PROACTIVE_ANALYSIS con Memoria AI OFF legge dati operativi reali
  assert.equal(classifyUnifiedIntent("Fai un'analisi proattiva dei rischi"), "PROACTIVE_ANALYSIS");
  assert.equal(classifyUnifiedIntent("Suggeriscimi il prossimo passo"), "PROACTIVE_SUGGESTION");
  const proactiveRes = await orchestrator.orchestrate({
    input: "Suggeriscimi il prossimo passo",
    consentEnabled: false,
    storage,
  });
  assert.equal(proactiveRes.intent, "PROACTIVE_SUGGESTION");
  assert.equal(proactiveRes.proactiveResult?.safetyBlocked, false);

  // CREATE / UPDATE / DELETE senza autorizzazione -> bloccati
  const createBlocked = await orchestrator.orchestrate({
    input: "Crea un nuovo piano per studiare",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "c-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Studiare", horizon: "daily" },
      },
    ],
  });
  assert.equal(createBlocked.cognitiveResult?.status, "awaiting_authorization");

  const updateBlocked = await orchestrator.orchestrate({
    input: "Modifica il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "u-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: plan.id, title: "Modificato" },
      },
    ],
  });
  assert.equal(updateBlocked.cognitiveResult?.status, "awaiting_authorization");

  const deleteBlocked = await orchestrator.orchestrate({
    input: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "d-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
  });
  assert.equal(deleteBlocked.cognitiveResult?.status, "awaiting_authorization");
  assert.equal(repo.getPlans().length, 1);

  // Conferma esplicita -> eseguito
  const deleteConfirmed = await orchestrator.orchestrate({
    input: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "d-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
    approvedOperationIds: ["d-1"],
  });
  assert.equal(deleteConfirmed.cognitiveResult?.status, "completed");
  assert.equal(repo.getPlans().length, 0);
});

test("F6.21. Isolamento tra utenti e richieste simultanee", async () => {
  const storageA = new MemoryStorageAdapter();
  const storageB = new MemoryStorageAdapter();
  const repoA = new DataRepository(storageA);
  const repoB = new DataRepository(storageB);

  const planA = createPlan({ declaredGoal: "Obiettivo A", horizon: "daily", consentEnabled: false });
  const planB = createPlan({ declaredGoal: "Obiettivo B", horizon: "daily", consentEnabled: false });
  repoA.savePlans([planA]);
  repoB.savePlans([planB]);

  const orch = new UnifiedCognitiveOrchestrator();
  const [resA, resB] = await Promise.all([
    orch.orchestrate({ input: "Mostrami i miei piani", consentEnabled: false, storage: storageA }),
    orch.orchestrate({ input: "Mostrami i miei piani", consentEnabled: false, storage: storageB }),
  ]);

  assert.equal(resA.cognitiveResult?.data?.operational?.plans[0].id, planA.id);
  assert.equal(resB.cognitiveResult?.data?.operational?.plans[0].id, planB.id);
});
