import assert from "node:assert/strict";
import test from "node:test";
import {
  addGrowthGoalStep,
  createGrowthGoal,
  setGrowthGoalStatus,
  toggleGrowthGoalStep,
} from "../growth/engine";
import { AuraMemoryStore } from "../memory/storage";
import {
  generateAdaptiveMissionsLocal,
  transitionMissionStatus,
} from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { CognitiveTimeline } from "./cognitiveTimeline";
import { buildContinuitySnapshot } from "./continuityEngine";
import { UnifiedCognitiveOrchestrator } from "./unifiedCognitiveOrchestrator";

test("P7.1 & P7.2. Recupero del contesto tra sessioni e persistenza della CognitiveTimeline", () => {
  const sharedStorage = new MemoryStorageAdapter();

  // Sessione 1: salvataggio piano + evento in cronologia
  const repo1 = new DataRepository(sharedStorage);
  const timeline1 = new CognitiveTimeline(sharedStorage);
  const plan = createPlan({
    declaredGoal: "Preparare esame universitario",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo1.savePlans([plan]);
  timeline1.recordEvent({
    source: "Planning Engine",
    category: "new_goal",
    title: "Creato piano esame universitario",
    description: "Piano settimanale salvato localmente.",
    epistemicTag: "fatto_osservato",
    reliability: 0.95,
    entityId: plan.id,
  });

  // Sessione 2 (simulazione refresh con nuove istanze)
  const repo2 = new DataRepository(sharedStorage);
  const timeline2 = new CognitiveTimeline(sharedStorage);
  assert.equal(timeline2.getEvents().length, 1);

  const snapshot = buildContinuitySnapshot({
    plans: repo2.getPlans(),
    missions: repo2.getMissions(),
    growthGoals: repo2.getGrowthGoals(),
    consentEnabled: false,
    timeline: timeline2,
  });

  assert.equal(snapshot.insufficientData, false);
  assert.equal(snapshot.timelineEventsCount, 1);
  assert.ok(
    snapshot.recoveredOperationalContext.some((c) =>
      c.includes("Preparare esame universitario")
    )
  );
});

test("P7.3 & P7.4. Separazione tra Memoria AI e cronologia operativa con Memoria AI OFF", () => {
  const storage = new MemoryStorageAdapter();
  const memoryStore = new AuraMemoryStore(storage);
  assert.equal(memoryStore.getConsent().enabled, false);

  const timeline = new CognitiveTimeline(storage);
  timeline.recordEvent({
    source: "Personal Growth",
    category: "progress",
    title: "Primo passo completato",
    description: "Registrato con Memoria AI OFF.",
    epistemicTag: "fatto_osservato",
    reliability: 0.9,
  });

  // Revoca/cancellazione memoria AI non cancella la cronologia operativa
  memoryStore.clearAllPersonalMemory();
  assert.equal(timeline.getEvents().length, 1);
  assert.deepEqual(memoryStore.getLongTermMemory().goalsAndStrategies, []);
});

test("P7.5. Informazioni mancanti o contraddittorie rilevate senza inventare ricordi", () => {
  // Caso 1: nessun dato
  const empty = buildContinuitySnapshot({
    plans: [],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(empty.insufficientData, true);
  assert.equal(empty.needsClarification, true);
  assert.ok(empty.statusMessage.includes("non inventa ricordi"));

  // Caso 2: contraddizione (obiettivo completato con passo non spuntato)
  const baseGoal = createGrowthGoal({ title: "Correre 5 km" });
  assert.ok(baseGoal);
  const withStep = addGrowthGoalStep(baseGoal, "Uscire 3 volte a settimana");
  const contradictory = setGrowthGoalStatus(withStep, "completato");

  const snap = buildContinuitySnapshot({
    plans: [],
    missions: [],
    growthGoals: [contradictory],
    consentEnabled: false,
  });
  assert.equal(snap.contradictionsDetected.length, 1);
  assert.equal(snap.needsClarification, true);
  assert.ok(snap.clarificationQuestion);
});

test("P7.6 & P7.7. Identificazione dei progressi e riconoscimento delle difficoltà ricorrenti", () => {
  const baseGoal = createGrowthGoal({ title: "Meditare 10 minuti" });
  assert.ok(baseGoal);
  const withStep = addGrowthGoalStep(baseGoal, "Sessione mattutina");
  const progressedGoal = toggleGrowthGoalStep(withStep, withStep.steps[0].id);

  const plan = createPlan({
    declaredGoal: "Consegnare progetto",
    horizon: "weekly",
    consentEnabled: false,
  });
  plan.tasks[0].status = "overdue";
  if (plan.tasks[1]) plan.tasks[1].status = "overdue";

  const mission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions[0];
  const completedMission = transitionMissionStatus(mission, "completata");

  const learning = new ControlledLearningEngine(true);
  learning.recordInteraction("missions", "rejected");
  learning.recordInteraction("missions", "rejected");

  const snap = buildContinuitySnapshot({
    plans: [plan],
    missions: [completedMission],
    growthGoals: [progressedGoal],
    consentEnabled: false,
    learningEngine: learning,
  });

  assert.ok(snap.recentProgress.length >= 2);
  assert.equal(snap.goalEvolution[0].trend, "in_crescita");
  assert.ok(snap.recurringDifficulties.some((d) => d.id === "diff-overdue-tasks"));
  assert.ok(snap.recurringDifficulties.some((d) => d.id === "diff-rejected-missions"));
  assert.ok(snap.averageReliability > 0.7);
});

test("P7.8 & P7.9. Esportazione, cancellazione con conferma esplicita e preservazione autorizzazioni", async () => {
  const storage = new MemoryStorageAdapter();
  const timeline = new CognitiveTimeline(storage);
  timeline.recordEvent({
    source: "User",
    category: "confirmed_decision",
    title: "Decisione confermata",
    description: "Conferma esplicita dell'utente.",
    epistemicTag: "fatto_osservato",
    reliability: 1,
  });

  const exported = timeline.exportTimelineJson();
  assert.ok(exported.includes("aura_cognitive_timeline"));

  // Cancellazione senza conferma -> bloccata
  assert.equal(timeline.clearTimeline(false), false);
  assert.equal(timeline.getEvents().length, 1);

  // Cancellazione con conferma -> eseguita
  assert.equal(timeline.clearTimeline(true), true);
  assert.equal(timeline.getEvents().length, 0);

  // Preservazione autorizzazioni: DELETE tramite UnifiedCognitiveOrchestrator resta bloccato senza conferma
  const repo = new DataRepository(storage);
  const plan = createPlan({ declaredGoal: "Piano protetto", horizon: "daily", consentEnabled: false });
  repo.savePlans([plan]);
  const orch = new UnifiedCognitiveOrchestrator({ repository: repo });
  const delBlocked = await orch.orchestrate({
    input: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      { id: "del-p7", toolId: "planning_engine", operation: "DELETE", input: { planId: plan.id } },
    ],
  });
  assert.equal(delBlocked.cognitiveResult?.status, "awaiting_authorization");
  assert.equal(repo.getPlans().length, 1);
});
