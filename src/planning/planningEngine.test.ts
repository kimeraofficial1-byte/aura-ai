import assert from "node:assert/strict";
import test from "node:test";
import { executeServerPlanning } from "../../server/planningEngine";
import {
  clearPlansFromStorage,
  createPlan,
  detectOverdueTasks,
  exportPlansData,
  getPlanProgressMetrics,
  hasUnmetDependencies,
  loadPlansFromStorage,
  PLANS_STORAGE_KEY,
  recalculatePlan,
  savePlansToStorage,
  togglePlanPause,
  transitionTaskStatus,
} from "./planningEngine";

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    size: () => store.size,
  };
}

test("1. Creazione di un piano semplice con orizzonte giornaliero", () => {
  const plan = createPlan(
    {
      declaredGoal: "Riordinare la scrivania",
      horizon: "daily",
      dailyMinutesLimit: 25,
      consentEnabled: false,
    },
    "2026-11-17T10:00:00.000Z"
  );

  assert.equal(plan.status, "active");
  assert.equal(plan.horizon, "daily");
  assert.equal(plan.sessionOnly, true);
  assert.ok(plan.tasks.length >= 2);
  assert.ok(plan.uncertainties.length >= 1);
  assert.equal(plan.revisions.length, 1);
});

test("2. Decomposizione di obiettivi complessi tramite Reasoning Engine V1", () => {
  const plan = createPlan(
    {
      declaredGoal:
        "Voglio cambiare lavoro entro un mese ma ho poco tempo la sera, devo aggiornare il CV e preparare i colloqui",
      horizon: "monthly",
      dailyMinutesLimit: 40,
      consentEnabled: true,
      growthGoalTitles: ["Crescita professionale"],
    },
    "2026-11-17T10:00:00.000Z"
  );

  assert.ok(plan.tasks.length >= 3);
  assert.ok(plan.reasoningSummary.length > 10);
  assert.ok(plan.reasoningSummary.includes("Crescita professionale"));
  assert.equal(plan.sessionOnly, false);
});

test("3. Gestione delle priorità e dipendenze tra attività", () => {
  const plan = createPlan(
    {
      declaredGoal: "Preparare una presentazione di progetto per lunedì",
      horizon: "weekly",
      dailyMinutesLimit: 30,
      consentEnabled: false,
    },
    "2026-11-17T10:00:00.000Z"
  );

  assert.equal(plan.tasks[0].priority, "alta");
  assert.equal(plan.tasks[0].dependencies.length, 0);
  assert.equal(hasUnmetDependencies(plan, plan.tasks[0].id), false);

  assert.deepEqual(plan.tasks[1].dependencies, [plan.tasks[0].id]);
  assert.equal(hasUnmetDependencies(plan, plan.tasks[1].id), true);

  // Completando la prima attività si sblocca la seconda
  const afterFirst = transitionTaskStatus(plan, plan.tasks[0].id, "completed");
  assert.equal(hasUnmetDependencies(afterFirst, afterFirst.tasks[1].id), false);
});

test("4. Gestione scadenze, attività completate e in ritardo", () => {
  const plan = createPlan(
    {
      declaredGoal: "Completare il corso online di inglese",
      horizon: "weekly",
      dailyMinutesLimit: 30,
      consentEnabled: false,
    },
    "2026-11-10T10:00:00.000Z"
  );

  // Simuliamo 5 giorni dopo: la prima attività (scadenza 2026-11-10) risulta in ritardo
  const checked = detectOverdueTasks(plan, "2026-11-15T10:00:00.000Z");
  assert.equal(checked.tasks[0].status, "overdue");

  const metricsBefore = getPlanProgressMetrics(checked, "2026-11-15T10:00:00.000Z");
  assert.ok(metricsBefore.overdueTasks >= 1);

  const completedFirst = transitionTaskStatus(
    checked,
    checked.tasks[0].id,
    "completed",
    "2026-11-15T11:00:00.000Z"
  );
  assert.ok(completedFirst.progressPercent > 0);
  assert.equal(completedFirst.tasks[0].status, "completed");
});

test("5. Vincoli temporali e ricalcolo automatico dopo un imprevisto con alternative", () => {
  const plan = createPlan(
    {
      declaredGoal: "Studiare per l'esame di economia",
      horizon: "weekly",
      dailyMinutesLimit: 60,
      constraints: ["Solo dopo le 18"],
      consentEnabled: false,
    },
    "2026-11-10T10:00:00.000Z"
  );

  const overduePlan = detectOverdueTasks(plan, "2026-11-15T10:00:00.000Z");
  const recalculated = recalculatePlan(overduePlan, {
    reason: "Imprevisto lavorativo, tempo ridotto a 20 minuti al giorno",
    unavailableTaskIds: [overduePlan.tasks[1].id],
    newDailyMinutesLimit: 20,
    nowIso: "2026-11-15T12:00:00.000Z",
  });

  assert.equal(recalculated.dailyMinutesLimit, 20);
  assert.equal(recalculated.tasks[1].status, "paused");
  assert.ok(recalculated.tasks[1].alternatives.length >= 2);
  assert.equal(recalculated.tasks[0].status, "pending");
  assert.ok(recalculated.tasks[0].dueDate > "2026-11-15");
  assert.ok(recalculated.tasks.every((t) => t.estimatedMinutes <= 20));
  assert.ok(recalculated.revisions[0].explanation.includes("Imprevisto lavorativo"));
});

test("6. Pausa e ripresa del piano registrano spiegazioni chiare", () => {
  const plan = createPlan({
    declaredGoal: "Camminare 30 minuti tre volte a settimana",
    horizon: "weekly",
    consentEnabled: false,
  });

  const paused = togglePlanPause(plan);
  assert.equal(paused.status, "paused");
  assert.ok(paused.revisions[0].explanation.includes("sospeso"));

  const resumed = togglePlanPause(paused);
  assert.equal(resumed.status, "active");
  assert.ok(resumed.revisions[0].explanation.includes("attivo"));
});

test("7. Memoria disattivata, consenso revocato, esportazione e cancellazione dati", () => {
  const storage = createMockStorage();
  const plan = createPlan({
    declaredGoal: "Leggere un libro questo mese",
    horizon: "monthly",
    consentEnabled: false,
  });

  // Con consenso disattivato non salva nulla in storage
  savePlansToStorage([plan], false, storage);
  assert.equal(storage.size(), 0);
  assert.deepEqual(loadPlansFromStorage(false, storage), []);

  // Con consenso attivo salva e ricarica
  savePlansToStorage([plan], true, storage);
  assert.equal(storage.getItem(PLANS_STORAGE_KEY) !== null, true);
  assert.equal(loadPlansFromStorage(true, storage).length, 1);

  // Esportazione JSON valida
  const exported = exportPlansData([plan], true);
  const parsed = JSON.parse(exported);
  assert.equal(parsed.plans.length, 1);
  assert.equal(parsed.plans[0].declaredGoal, "Leggere un libro questo mese");

  // Revoca consenso o cancellazione rimuove tutto
  savePlansToStorage([plan], false, storage);
  assert.equal(storage.size(), 0);

  savePlansToStorage([plan], true, storage);
  clearPlansFromStorage(storage);
  assert.equal(storage.size(), 0);
});

test("8. Priorità Safety Engine: blocca pianificazione in caso di crisi", async () => {
  const output = await executeServerPlanning({
    declaredGoal: "Non ce la faccio più, voglio farmi del male e farla finita",
    horizon: "daily",
    consentEnabled: false,
    useGemini: true,
  });

  assert.equal(output.crisisDetected, true);
  assert.equal(output.plan, undefined);
  assert.ok(output.safetyReply && output.safetyReply.length > 20);
});

test("9. Fallback locale garantito in caso di errore o timeout Gemini", async () => {
  const output = await executeServerPlanning({
    declaredGoal: "Organizzare il trasloco in due settimane",
    horizon: "weekly",
    dailyMinutesLimit: 45,
    consentEnabled: false,
    useGemini: true,
    timeoutMs: 30,
    geminiCaller: async () => {
      throw new Error("Simulated Gemini 503 error");
    },
  });

  assert.equal(output.crisisDetected, false);
  assert.equal(output.usedFallback, true);
  assert.ok(output.fallbackReason?.includes("Simulated Gemini 503"));
  assert.ok(output.plan);
  assert.equal(output.plan?.source, "local");
  assert.ok((output.plan?.tasks.length ?? 0) >= 2);
});

test("10. Arricchimento server-side via Gemini JSON valido", async () => {
  const output = await executeServerPlanning({
    declaredGoal: "Migliorare l'organizzazione settimanale",
    horizon: "weekly",
    dailyMinutesLimit: 30,
    consentEnabled: false,
    useGemini: true,
    geminiCaller: async () =>
      JSON.stringify({
        desiredOutcome: "Settimana pianificata con 3 priorità chiare.",
        tasks: [
          {
            title: "Elenco priorità settimanali",
            description: "Scegli le 3 attività più importanti della settimana.",
            priority: "alta",
            estimatedMinutes: 20,
          },
        ],
        uncertainties: ["Possibili imprevisti lavorativi nel pomeriggio."],
      }),
  });

  assert.equal(output.crisisDetected, false);
  assert.equal(output.usedFallback, false);
  assert.equal(output.plan?.source, "gemini");
  assert.equal(output.plan?.tasks[0].title, "Elenco priorità settimanali");
  assert.equal(output.plan?.desiredOutcome, "Settimana pianificata con 3 priorità chiare.");
});
