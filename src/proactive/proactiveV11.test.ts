import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthGoal } from "../growth/engine";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { createPlan } from "../planning/planningEngine";
import { generateContextualSuggestions } from "./contextualSuggestionEngine";
import { ControlledLearningEngine } from "./controlledLearningEngine";
import {
  generatePriorityProposals,
  transitionPriorityProposalStatus,
} from "./dynamicPriorityEngine";
import { analyzeHabitPatterns } from "./habitPatternEngine";
import { runPredictiveAnalysis } from "./predictiveEngine";

test("1. V1.1 Previsioni con dati insufficienti dichiarano esplicitamente Dati insufficienti", () => {
  const res = runPredictiveAnalysis({
    plans: [],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });

  assert.equal(res.safetyBlocked, false);
  assert.equal(res.insufficientData, true);
  assert.equal(res.alerts.length, 0);
  assert.ok(res.statusMessage.includes("Dati insufficienti"));
});

test("2. V1.1 Rilevamento sovraccarichi futuri, scadenze imminenti e dipendenze", () => {
  const plan = createPlan(
    {
      declaredGoal: "Completare la tesi",
      horizon: "daily",
      dailyMinutesLimit: 15,
      consentEnabled: false,
    },
    "2026-11-18T08:00:00.000Z"
  );

  const res = runPredictiveAnalysis({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
    nowIso: "2026-11-18T09:00:00.000Z",
  });

  assert.equal(res.insufficientData, false);
  assert.ok(res.alerts.some((a) => a.category === "overload"));
  assert.ok(res.alerts.some((a) => a.category === "deadline"));
  assert.ok(res.alerts.some((a) => a.category === "dependency"));
});

test("3. V1.1 Analisi delle abitudini: Dati insufficienti sotto soglia e schemi reali sopra soglia", () => {
  const emptyPatterns = analyzeHabitPatterns({
    plans: [],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(emptyPatterns[0].insufficientData, true);
  assert.ok(emptyPatterns[0].label.includes("Dati insufficienti"));

  const missions = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 15,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    3
  ).missions;
  missions[0] = { ...missions[0], status: "completata" };

  const patterns = analyzeHabitPatterns({
    plans: [],
    missions,
    growthGoals: [],
    consentEnabled: false,
  });
  assert.equal(patterns[0].insufficientData, false);
  assert.equal(patterns[0].observationCount, 3);
  assert.equal(patterns[0].dataSource, "Adaptive Mission Engine");
});

test("4 & 5. V1.1 Dynamic Priority Engine: calcolo proposte e gestione senza modificare il piano", () => {
  const plan = createPlan(
    {
      declaredGoal: "Preparare il lancio",
      horizon: "weekly",
      dailyMinutesLimit: 30,
      consentEnabled: false,
    },
    "2026-11-10T10:00:00.000Z"
  );
  // Portiamo un'attività in ritardo con priorità bassa per generare una proposta
  plan.tasks[2] = { ...plan.tasks[2], priority: "bassa", dueDate: "2026-11-12" };
  const planSnapshotBefore = JSON.stringify(plan);

  const proposals = generatePriorityProposals({
    plans: [plan],
    missions: [],
    growthGoals: [],
    consentEnabled: false,
    nowIso: "2026-11-18T10:00:00.000Z",
  });

  assert.ok(proposals.length >= 1);
  assert.equal(proposals[0].previousPriority !== proposals[0].suggestedPriority, true);
  // Il piano originale NON è stato modificato automaticamente
  assert.equal(JSON.stringify(plan), planSnapshotBefore);

  const accepted = transitionPriorityProposalStatus(proposals, proposals[0].id, "accepted");
  assert.equal(accepted[0].status, "accepted");

  const rejected = transitionPriorityProposalStatus(proposals, proposals[0].id, "rejected");
  assert.equal(rejected[0].status, "rejected");

  const snoozed = transitionPriorityProposalStatus(proposals, proposals[0].id, "snoozed");
  assert.equal(snoozed[0].status, "snoozed");
});

test("6, 7 & 8. V1.1 Apprendimento controllato, disattivazione, esportazione e cancellazione", () => {
  const learning = new ControlledLearningEngine(true);

  learning.recordInteraction("mission_ready", "completed");
  learning.recordInteraction("mission_ready", "accepted");
  learning.recordInteraction("overdue", "rejected");

  assert.ok(learning.getCategoryWeight("mission_ready") > 1.0);
  assert.ok(learning.getCategoryWeight("overdue") < 1.0);
  assert.equal(learning.getInteractionCount(), 3);

  const exported = JSON.parse(learning.exportLearningJson());
  assert.equal(exported.totalInteractions, 3);

  // Disattivazione: pesi neutri (1.0) e nessuna nuova registrazione
  learning.setEnabled(false);
  assert.equal(learning.getCategoryWeight("mission_ready"), 1.0);
  learning.recordInteraction("conflict", "accepted");
  assert.equal(learning.getInteractionCount(), 3);

  // Cancellazione completa dei dati di apprendimento
  learning.setEnabled(true);
  learning.clearLearningData();
  assert.equal(learning.getInteractionCount(), 0);
  assert.equal(learning.getCategoryWeight("mission_ready"), 1.0);
});

test("9 & 10. V1.1 Protezione Safety Engine e funzionamento con Memoria AI disattivata", () => {
  const goal = createGrowthGoal({ title: "Obiettivo test" });
  assert.ok(goal);

  const blockedPred = runPredictiveAnalysis({
    plans: [],
    missions: [],
    growthGoals: [goal],
    consentEnabled: false,
    crisisBlocked: true,
  });
  assert.equal(blockedPred.safetyBlocked, true);
  assert.equal(blockedPred.alerts.length, 0);

  assert.deepEqual(
    analyzeHabitPatterns({
      plans: [],
      missions: [],
      growthGoals: [goal],
      consentEnabled: false,
      crisisBlocked: true,
    }),
    []
  );

  assert.deepEqual(
    generatePriorityProposals({
      plans: [],
      missions: [],
      growthGoals: [goal],
      consentEnabled: false,
      crisisBlocked: true,
    }),
    []
  );

  const learning = new ControlledLearningEngine(true);
  const blockedCtx = generateContextualSuggestions(
    {
      plans: [],
      missions: [],
      growthGoals: [goal],
      consentEnabled: false,
      crisisBlocked: true,
    },
    learning
  );
  assert.equal(blockedCtx.length, 0);
});
