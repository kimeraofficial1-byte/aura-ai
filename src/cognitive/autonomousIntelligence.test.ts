import assert from "node:assert/strict";
import test from "node:test";
import { addGrowthGoalStep, createGrowthGoal, toggleGrowthGoalStep } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import {
  evaluateAlternativeStrategies,
  runAutonomousCognitiveCycle,
  synthesizeAutonomousSituation,
} from "./autonomousIntelligenceEngine";

function buildPopulatedFixtures() {
  const plan = createPlan({
    declaredGoal: "Completare documentazione tecnica",
    horizon: "weekly",
    consentEnabled: false,
  });
  plan.tasks[0].status = "overdue";
  if (plan.tasks[1]) plan.tasks[1].status = "overdue";

  const baseGoal = createGrowthGoal({ title: "Studio quotidiano 20 min" });
  assert.ok(baseGoal);
  const goalWithStep = addGrowthGoalStep(baseGoal, "Leggere capitolo 1");
  const progressedGoal = toggleGrowthGoalStep(goalWithStep, goalWithStep.steps[0].id);

  const mission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 15,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions[0];

  const repo = new DataRepository(new MemoryStorageAdapter());
  repo.savePlans([plan]);
  repo.saveMissions([mission]);
  repo.saveGrowthGoals([progressedGoal]);

  return { repo, plan, mission, progressedGoal };
}

test("8.2.1. Sintesi corretta con dati disponibili tramite DataRepository", () => {
  const { repo } = buildPopulatedFixtures();
  const learning = new ControlledLearningEngine(true);

  const situation = synthesizeAutonomousSituation({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
    availableMinutes: 25,
    energyLevel: "media",
    learningEngine: learning,
  });

  assert.equal(situation.insufficientData, false);
  assert.ok(situation.activeGoals.length >= 1);
  assert.ok(situation.documentedProgress.length >= 1);
  assert.ok(situation.detectedDifficulties.length >= 1);
  assert.ok(situation.potentialFutureNeeds.length >= 1);
  assert.equal(situation.emotionalContextAuthorized, false);
  assert.equal(situation.emotionalSummary, undefined);
});

test("8.2.2. Funzionamento completo con Memoria AI OFF", () => {
  const { repo } = buildPopulatedFixtures();

  const result = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
  });

  assert.equal(result.safetyBlocked, false);
  assert.equal(result.insufficientData, false);
  assert.ok(result.situation.currentSituationSummary.includes("Memoria AI OFF"));
  assert.ok(result.strategies.length >= 2);
});

test("8.2.3 & 8.2.4. Gestione dei dati mancanti e assenza di informazioni inventate", () => {
  const emptyRepo = new DataRepository(new MemoryStorageAdapter());

  const result = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: emptyRepo,
    consentEnabled: false,
  });

  assert.equal(result.insufficientData, true);
  assert.equal(result.situation.insufficientData, true);
  assert.equal(result.situation.activeGoals.length, 0);
  assert.equal(result.situation.potentialFutureNeeds.length, 0);
  assert.equal(result.strategies.length, 0);
  assert.ok(result.situation.uncertaintyFactors.length >= 1);
  assert.equal(result.situation.emotionalSummary, undefined);
});

test("8.2.5. Corretta distinzione epistemica su ogni elemento cognitivo", () => {
  const { repo } = buildPopulatedFixtures();
  const validTags = new Set([
    "fatto_osservato",
    "interpretazione_prudente",
    "ipotesi_da_verificare",
  ]);

  const result = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
    authorizedEmotionalSignal: {
      primaryEmotion: "affaticato",
      intensity: 7,
      uncertain: true,
      dataSource: "EmotionEngine (autorizzato)",
    },
  });

  assert.equal(result.situation.emotionalContextAuthorized, true);
  assert.ok(result.situation.emotionalSummary);
  assert.equal(result.situation.emotionalSummary.epistemicTag, "ipotesi_da_verificare");

  const allItems = [
    ...result.situation.activeGoals,
    ...result.situation.documentedProgress,
    ...result.situation.detectedDifficulties,
    ...result.situation.deadlinesAndDependencies,
    ...result.situation.potentialFutureNeeds,
  ];
  for (const item of allItems) {
    assert.ok(validTags.has(item.epistemicTag));
    assert.ok(item.confidence >= 0 && item.confidence <= 1);
    assert.ok(item.dataSource.length > 0);
    assert.ok(item.uncertaintyNote.length > 0);
  }
});

test("8.2.6. Generazione e confronto di 2-3 strategie alternative (STANDARD, LIGHT, DEFERRED)", () => {
  const { repo } = buildPopulatedFixtures();
  const situation = synthesizeAutonomousSituation({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
    energyLevel: "bassa",
    availableMinutes: 15,
  });

  const strategies = evaluateAlternativeStrategies(situation, {
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
    energyLevel: "bassa",
    availableMinutes: 15,
  });

  assert.equal(strategies.length, 3);
  assert.deepEqual(
    strategies.map((s) => s.category),
    ["STANDARD", "LIGHT", "DEFERRED"]
  );
  for (const s of strategies) {
    assert.ok(s.goal.length > 0);
    assert.ok(s.suggestedActions.length >= 1);
    assert.ok(s.potentialBenefits.length >= 1);
    assert.ok(s.risks.length >= 1);
    assert.ok(s.impactOnOtherGoals.length > 0);
    assert.ok(s.dependencies.length >= 1);
    assert.equal(s.reversibility, "reversibile");
    assert.ok(s.uncertaintyNote.length > 0);
  }
});

test("8.2.7. Modalità PASSIVE: solo sintesi locale, nessuna strategia e nessuna esecuzione", () => {
  const { repo } = buildPopulatedFixtures();
  const result = runAutonomousCognitiveCycle({
    mode: "PASSIVE",
    repository: repo,
    consentEnabled: false,
  });

  assert.equal(result.mode, "PASSIVE");
  assert.equal(result.effectivePolicyMode, "PASSIVE");
  assert.equal(result.executedActionsCount, 0);
  assert.equal(result.strategies.length, 0);
  assert.equal(result.situation.insufficientData, false);
});

test("8.2.8. Modalità ASSISTED: propone strategie senza eseguire alcuna azione", () => {
  const { repo } = buildPopulatedFixtures();
  const result = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
  });

  assert.equal(result.mode, "ASSISTED");
  assert.equal(result.effectivePolicyMode, "ASSISTED");
  assert.equal(result.executedActionsCount, 0);
  assert.ok(result.strategies.length >= 2);
});

test("8.2.9. Modalità USER-AUTHORIZED in Fase 8.2 si comporta come ASSISTED senza esecuzioni", () => {
  const { repo } = buildPopulatedFixtures();
  const result = runAutonomousCognitiveCycle({
    mode: "USER-AUTHORIZED",
    repository: repo,
    consentEnabled: false,
  });

  assert.equal(result.mode, "USER-AUTHORIZED");
  assert.equal(result.effectivePolicyMode, "ASSISTED");
  assert.equal(result.executedActionsCount, 0);
  assert.ok(result.executionBlockedReason.includes("Fase 8.3"));
  assert.ok(result.strategies.length >= 2);
});

test("8.2.10. Safety Gate: blocco immediato in caso di crisi (flag o testo utente)", () => {
  const { repo } = buildPopulatedFixtures();

  const byFlag = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: repo,
    consentEnabled: false,
    crisisBlocked: true,
  });
  assert.equal(byFlag.safetyBlocked, true);
  assert.equal(byFlag.executedActionsCount, 0);
  assert.equal(byFlag.strategies.length, 0);

  const byText = runAutonomousCognitiveCycle({
    mode: "USER-AUTHORIZED",
    repository: repo,
    consentEnabled: false,
    userTextForSafetyCheck: "Non ce la faccio più, voglio farla finita",
  });
  assert.equal(byText.safetyBlocked, true);
  assert.equal(byText.executedActionsCount, 0);
  assert.equal(byText.strategies.length, 0);
});

test("8.2.11. Nessuna modifica ai dati originali in DataRepository", () => {
  const { repo } = buildPopulatedFixtures();
  const plansBefore = JSON.stringify(repo.getPlans());
  const missionsBefore = JSON.stringify(repo.getMissions());
  const goalsBefore = JSON.stringify(repo.getGrowthGoals());

  runAutonomousCognitiveCycle({
    mode: "USER-AUTHORIZED",
    repository: repo,
    consentEnabled: false,
  });

  assert.equal(JSON.stringify(repo.getPlans()), plansBefore);
  assert.equal(JSON.stringify(repo.getMissions()), missionsBefore);
  assert.equal(JSON.stringify(repo.getGrowthGoals()), goalsBefore);
});

test("8.2.12. Gestione sicura di errori e dipendenze mancanti", () => {
  const brokenRepo = {
    getPlans() {
      throw new Error("Storage corrotto");
    },
    getMissions() {
      throw new Error("Storage corrotto");
    },
    getGrowthGoals() {
      throw new Error("Storage corrotto");
    },
  } as unknown as DataRepository;

  const result = runAutonomousCognitiveCycle({
    mode: "ASSISTED",
    repository: brokenRepo,
    consentEnabled: false,
  });

  assert.equal(result.safetyBlocked, false);
  assert.equal(result.executedActionsCount, 0);
  assert.equal(result.insufficientData, true);
  assert.ok(result.situation.missingData.some((m) => m.id === "dep-warn-repository"));
});
