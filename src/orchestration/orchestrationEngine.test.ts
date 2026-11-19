import assert from "node:assert/strict";
import test from "node:test";
import { executeServerOrchestration } from "../../server/orchestrationEngine";
import { createGrowthGoal } from "../growth/engine";
import { AuraMemoryStore } from "../memory/storage";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import {
  createPlan,
  loadPlansFromStorage,
  savePlansToStorage,
} from "../planning/planningEngine";
import {
  classifyOrchestrationIntent,
  runOrchestration,
  selectToolsForRequest,
} from "./orchestrationEngine";
import { createDefaultAuraToolRegistry, ToolRegistry } from "./toolRegistry";

function createMockStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

test("1. Registrazione dei 7 strumenti interni reali e rifiuto strumenti non implementati", () => {
  const registry = createDefaultAuraToolRegistry();
  const ids = registry.list().map((t) => t.id);

  assert.equal(ids.length, 7);
  for (const expected of [
    "reasoning_engine",
    "planning_engine",
    "memory_engine",
    "emotion_engine",
    "growth_engine",
    "mission_engine",
    "context_engine",
  ]) {
    assert.ok(ids.includes(expected), `Manca lo strumento ${expected}`);
  }

  // Ogni strumento dichiara esplicitamente i metadati V1.1
  for (const tool of registry.list()) {
    assert.ok(tool.supportedOperations.length > 0);
    assert.equal(typeof tool.readOnly, "boolean");
    assert.equal(typeof tool.modifiesData, "boolean");
    assert.equal(typeof tool.requiresConsent, "boolean");
    assert.equal(typeof tool.requiresConfirmation, "boolean");
  }

  assert.throws(() => {
    registry.register({
      id: "fake_unimplemented",
      name: "Fake",
      description: "Non implementato",
      category: "external",
      riskLevel: "ALTO",
      requiredPermissions: ["external_action"],
      supportedOperations: ["CREATE"],
      readOnly: false,
      modifiesData: true,
      requiresConsent: false,
      requiresConfirmation: true,
      timeoutMs: 1000,
      maxRetries: 0,
      implemented: false,
      validateInput: () => ({ valid: true }),
      execute: async () => ({ verified: false, data: null, summary: "" }),
    });
  }, /implementazione reale non verificata/i);
});

test("2. Selezione automatica dello strumento corretto in base alla richiesta CREATE", () => {
  const registry = createDefaultAuraToolRegistry();
  const selected = selectToolsForRequest(
    "Crea e organizza un piano settimanale con una nuova missione pratica",
    registry,
    false
  );
  const ids = selected.map((s) => s.toolId);

  assert.ok(ids.includes("emotion_engine"));
  assert.ok(ids.includes("reasoning_engine"));
  assert.ok(ids.includes("planning_engine"));
  assert.ok(ids.includes("mission_engine"));
  assert.ok(!ids.includes("memory_engine"));
});

test("3. Esecuzione sequenziale e dipendenze tra strumenti", async () => {
  const registry = createDefaultAuraToolRegistry();
  const run = await runOrchestration(
    {
      request: "Organizza la mia settimana di studio",
      consentEnabled: false,
    },
    registry
  );

  assert.equal(run.status, "completed");
  assert.equal(run.intent, "CREATE");
  assert.ok(run.completedPhases.includes("RICEZIONE"));
  assert.ok(run.completedPhases.includes("ESECUZIONE"));
  assert.ok(run.completedPhases.includes("VERIFICA"));
  assert.ok(run.completedPhases.includes("RISPOSTA"));
  assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("4. Validazione dei parametri e gestione errori", async () => {
  const registry = createDefaultAuraToolRegistry();
  const run = await runOrchestration(
    {
      request: "Test parametri mancanti",
      consentEnabled: false,
      explicitSteps: [
        {
          id: "bad-step",
          toolId: "reasoning_engine",
          operation: "ANALYZE",
          input: {},
        },
      ],
    },
    registry
  );

  assert.equal(run.status, "failed");
  assert.equal(run.steps[0].status, "failed");
  assert.ok(run.steps[0].error?.includes("message"));
});

test("5. Autorizzazioni: CREATE su livello MEDIO richiede approvazione esplicita su dati persistenti", async () => {
  const registry = createDefaultAuraToolRegistry();
  const firstRun = await runOrchestration(
    {
      request: "Crea un piano settimanale per il mio progetto",
      consentEnabled: true,
      explicitSteps: [
        {
          id: "plan-step-1",
          toolId: "planning_engine",
          operation: "CREATE",
          input: { declaredGoal: "Completare il progetto", horizon: "weekly" },
        },
      ],
    },
    registry
  );

  assert.equal(firstRun.status, "awaiting_approval");
  assert.equal(firstRun.steps[0].status, "awaiting_approval");

  const approvedRun = await runOrchestration(
    {
      request: "Crea un piano settimanale per il mio progetto",
      consentEnabled: true,
      explicitSteps: [
        {
          id: "plan-step-1",
          toolId: "planning_engine",
          operation: "CREATE",
          input: { declaredGoal: "Completare il progetto", horizon: "weekly" },
        },
      ],
      approvedStepIds: ["plan-step-1"],
    },
    registry
  );

  assert.equal(approvedRun.status, "completed");
  assert.equal(approvedRun.steps[0].status, "completed");
});

test("6. Blocco assoluto delle operazioni ad ALTO rischio e consenso memoria negato", async () => {
  const registry = createDefaultAuraToolRegistry();
  registry.register({
    id: "external_payment",
    name: "Pagamento Esterno",
    description: "Operazione finanziaria esterna",
    category: "external",
    riskLevel: "ALTO",
    requiredPermissions: ["external_action"],
    supportedOperations: ["CREATE"],
    readOnly: false,
    modifiesData: true,
    requiresConsent: false,
    requiresConfirmation: true,
    timeoutMs: 1000,
    maxRetries: 0,
    implemented: true,
    validateInput: () => ({ valid: true }),
    execute: async () => ({ verified: true, data: {}, summary: "Non deve mai eseguire" }),
  });

  const run = await runOrchestration(
    {
      request: "Esegui operazione esterna e leggi memoria senza consenso",
      consentEnabled: false,
      explicitSteps: [
        { id: "ext-1", toolId: "external_payment", operation: "CREATE", input: {} },
        { id: "mem-1", toolId: "memory_engine", operation: "READ", input: {} },
      ],
    },
    registry
  );

  assert.equal(run.steps[0].status, "blocked");
  assert.equal(run.steps[1].status, "blocked");
  assert.equal(run.status, "failed");
});

test("7. Priorità Safety Engine pre-modello blocca l'orchestrazione", async () => {
  const { run } = await executeServerOrchestration({
    request: "Voglio farmi del male e farla finita",
    consentEnabled: false,
    useGemini: true,
  });

  assert.equal(run.safetyBlocked, true);
  assert.equal(run.status, "safety_blocked");
  assert.equal(run.steps.length, 0);
  assert.ok(run.safetyReply && run.safetyReply.length > 20);
});

test("8. Timeout, retry limitati e risultati non verificabili", async () => {
  const registry = new ToolRegistry();
  let flakyAttempts = 0;

  registry.register({
    id: "flaky_tool",
    name: "Flaky Tool",
    description: "Fallisce una volta poi riesce",
    category: "reasoning",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 500,
    maxRetries: 1,
    implemented: true,
    validateInput: () => ({ valid: true }),
    execute: async () => {
      flakyAttempts += 1;
      if (flakyAttempts === 1) throw new Error("Transient failure");
      return { verified: true, data: { ok: true }, summary: "Riuscito al secondo tentativo" };
    },
  });

  registry.register({
    id: "slow_tool",
    name: "Slow Tool",
    description: "Va in timeout",
    category: "reasoning",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 25,
    maxRetries: 0,
    implemented: true,
    validateInput: () => ({ valid: true }),
    execute: async (_input, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });

  registry.register({
    id: "unverified_tool",
    name: "Unverified Tool",
    description: "Restituisce risultato non verificabile",
    category: "reasoning",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 500,
    maxRetries: 0,
    implemented: true,
    validateInput: () => ({ valid: true }),
    execute: async () => ({ verified: false, data: null, summary: "Non verificato" }),
  });

  const run = await runOrchestration(
    {
      request: "Test retry, timeout e verifica",
      consentEnabled: false,
      explicitSteps: [
        { id: "s1", toolId: "flaky_tool", operation: "ANALYZE", input: {} },
        { id: "s2", toolId: "slow_tool", operation: "ANALYZE", input: {} },
        { id: "s3", toolId: "unverified_tool", operation: "ANALYZE", input: {} },
      ],
    },
    registry
  );

  assert.equal(run.steps[0].status, "completed");
  assert.equal(run.steps[0].result?.attempts, 2);
  assert.equal(run.steps[1].status, "failed");
  assert.ok(run.steps[1].error?.includes("Timeout"));
  assert.equal(run.steps[2].status, "failed");
  assert.equal(run.steps[2].error, "unverified_result");
});

test("9. Prevenzione chiamate duplicate, rilevamento cicli infiniti e interruzione utente", async () => {
  const registry = createDefaultAuraToolRegistry();

  const dedupRun = await runOrchestration(
    {
      request: "Test deduplicazione",
      consentEnabled: false,
      explicitSteps: [
        { id: "d1", toolId: "emotion_engine", operation: "ANALYZE", input: { message: "Ciao" } },
        { id: "d2", toolId: "emotion_engine", operation: "ANALYZE", input: { message: "Ciao" } },
      ],
    },
    registry
  );
  assert.equal(dedupRun.steps.length, 1);

  const cycleRun = await runOrchestration(
    {
      request: "Test ciclo",
      consentEnabled: false,
      explicitSteps: [
        { id: "a", toolId: "emotion_engine", operation: "ANALYZE", input: { message: "A" }, dependsOn: ["b"] },
        { id: "b", toolId: "reasoning_engine", operation: "ANALYZE", input: { message: "B" }, dependsOn: ["a"] },
      ],
    },
    registry
  );
  assert.equal(cycleRun.status, "failed");
  assert.ok(cycleRun.errors.some((e) => e.includes("ciclo infinito")));

  const controller = new AbortController();
  controller.abort();
  const abortedRun = await runOrchestration(
    {
      request: "Test interruzione",
      consentEnabled: false,
      signal: controller.signal,
    },
    registry
  );
  assert.equal(abortedRun.status, "cancelled");
  assert.ok(abortedRun.steps.every((s) => s.status === "cancelled"));
});

test("10. Integrazione server con Gemini: validazione autonoma e fallback su errore", async () => {
  const { run: geminiRun, usedFallback: f1 } = await executeServerOrchestration({
    request: "Crea una proposta di missione dopo analisi emotiva",
    consentEnabled: false,
    useGemini: true,
    geminiCaller: async () =>
      JSON.stringify({
        steps: [
          { toolId: "emotion_engine", input: { message: "Mi sento un po' teso" } },
          { toolId: "mission_engine", input: { availableMinutes: 10, energyLevel: "media" } },
        ],
      }),
  });

  assert.equal(f1, false);
  assert.equal(geminiRun.source, "gemini");
  assert.equal(geminiRun.status, "completed");
  assert.equal(geminiRun.steps.length, 2);

  const { run: fallbackRun, usedFallback: f2 } = await executeServerOrchestration({
    request: "Aiutami a fare chiarezza",
    consentEnabled: false,
    useGemini: true,
    geminiCaller: async () => {
      throw new Error("Simulated Gemini error");
    },
  });

  assert.equal(f2, true);
  assert.equal(fallbackRun.source, "local");
  assert.equal(fallbackRun.status, "completed");
});

// ==================== V1.1 READ-ONLY INTENT DETECTION TESTS ====================

test("11. V1.1 READ di un piano esistente senza crearne uno nuovo", async () => {
  const storage = createMockStorage();
  const existingPlan = createPlan({
    declaredGoal: "Imparare TypeScript",
    horizon: "weekly",
    consentEnabled: true,
  });
  savePlansToStorage([existingPlan], true, storage);

  const run = await runOrchestration({
    request: "Mostrami i miei piani esistenti",
    consentEnabled: true,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "planning_engine");
  assert.equal(run.steps[0].operation, "READ");
  // Verifica che lo storage contenga ancora ESATTAMENTE 1 piano (nessuna creazione)
  const storedAfter = loadPlansFromStorage(true, storage);
  assert.equal(storedAfter.length, 1);
  assert.equal(storedAfter[0].id, existingPlan.id);
});

test("12. V1.1 READ delle missioni esistenti senza rigenerarle", async () => {
  const storage = createMockStorage();
  const store = new AuraMemoryStore(storage);
  store.setConsent(true);
  const initialMissions = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: true,
      existingMissions: [],
    },
    2
  ).missions;
  store.saveMissions(initialMissions);

  const run = await runOrchestration({
    request: "Recupera le mie missioni",
    consentEnabled: true,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "mission_engine");
  assert.equal(run.steps[0].operation, "READ");
  assert.deepEqual(
    store.getMissions().map((m) => m.id),
    initialMissions.map((m) => m.id)
  );
});

test("13. V1.1 READ di un obiettivo di crescita senza modificarlo", async () => {
  const storage = createMockStorage();
  const store = new AuraMemoryStore(storage);
  store.setConsent(true);
  const goal = createGrowthGoal({
    title: "Dormire 8 ore a notte",
  });
  assert.ok(goal);
  store.saveGrowthGoals([goal]);

  const run = await runOrchestration({
    request: "Visualizza i miei obiettivi di crescita",
    consentEnabled: true,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "growth_engine");
  assert.equal(store.getGrowthGoals().length, 1);
  assert.equal(store.getGrowthGoals()[0].title, "Dormire 8 ore a notte");
});

test("14. V1.1 READ senza consenso alla memoria rispetta il consenso e non crea nulla", async () => {
  const storage = createMockStorage();

  const memRun = await runOrchestration({
    request: "Leggi la mia memoria salvata",
    consentEnabled: false,
    storage,
  });
  assert.equal(memRun.intent, "READ");
  assert.equal(memRun.steps[0].status, "blocked");

  const planRun = await runOrchestration({
    request: "Mostra i miei piani",
    consentEnabled: false,
    storage,
  });
  assert.equal(planRun.intent, "READ");
  assert.equal(planRun.status, "completed");
  assert.ok(planRun.finalSummary.includes("Nessun piano esistente trovato"));
  assert.equal(new DataRepository(storage).getPlans().length, 0);
});

test("15. V1.1 UPDATE e DELETE richiedono autorizzazione/conferma esplicita", async () => {
  const storage = createMockStorage();
  const plan = createPlan({
    declaredGoal: "Allenarsi 3 volte a settimana",
    horizon: "weekly",
    consentEnabled: true,
  });
  savePlansToStorage([plan], true, storage);

  // UPDATE senza approvazione -> awaiting_approval
  const updatePending = await runOrchestration({
    request: "Modifica il mio piano",
    consentEnabled: true,
    storage,
    explicitSteps: [
      {
        id: "upd-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: plan.id, title: "Allenarsi 4 volte" },
      },
    ],
  });
  assert.equal(updatePending.intent, "UPDATE");
  assert.equal(updatePending.status, "awaiting_approval");

  // DELETE senza conferma -> awaiting_approval
  const deletePending = await runOrchestration({
    request: "Elimina il mio piano",
    consentEnabled: true,
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
  assert.equal(deletePending.intent, "DELETE");
  assert.equal(deletePending.status, "awaiting_approval");

  // DELETE con conferma esplicita -> eseguito
  const deleteConfirmed = await runOrchestration({
    request: "Elimina il mio piano",
    consentEnabled: true,
    storage,
    explicitSteps: [
      {
        id: "del-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: plan.id },
      },
    ],
    approvedStepIds: ["del-1"],
  });
  assert.equal(deleteConfirmed.status, "completed");
  assert.equal(new DataRepository(storage).getPlans().length, 0);
});

test("16. V1.1 READ quando non esistono dati: risposta chiara, nessuna creazione automatica", async () => {
  const storage = createMockStorage();
  const store = new AuraMemoryStore(storage);
  store.setConsent(true);

  const run = await runOrchestration({
    request: "Mostrami i miei piani e le mie missioni",
    consentEnabled: true,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.ok(run.finalSummary.includes("Nessun piano esistente trovato"));
  assert.ok(run.finalSummary.includes("Nessuna missione esistente trovata"));
  assert.equal(loadPlansFromStorage(true, storage).length, 0);
  assert.equal(store.getMissions().length, 0);
  assert.equal(classifyOrchestrationIntent("Analizza il mio stato"), "ANALYZE");
});

// ==================== FASE 2: TOOLREGISTRY DATAREPOSITORY ALIGNMENT ====================

test("17. Fase 2 READ dei piani con Memoria AI OFF legge da DataRepository senza mutazioni", async () => {
  const storage = createMockStorage();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Studiare architettura software",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const run = await runOrchestration({
    request: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "planning_engine");
  assert.equal(run.steps[0].operation, "READ");
  assert.ok(run.finalSummary.includes("Recuperati 1 piani esistenti da DataRepository"));
  assert.equal(repo.getPlans().length, 1);
  assert.equal(repo.getPlans()[0].id, plan.id);
});

test("18. Fase 2 READ delle missioni con Memoria AI OFF legge da DataRepository senza rigenerare", async () => {
  const storage = createMockStorage();
  const repo = new DataRepository(storage);
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
  repo.saveMissions(missions);

  const run = await runOrchestration({
    request: "Recupera le mie missioni",
    consentEnabled: false,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "mission_engine");
  assert.equal(run.steps[0].operation, "READ");
  assert.ok(run.finalSummary.includes("Recuperate 2 missioni esistenti da DataRepository"));
  assert.deepEqual(
    repo.getMissions().map((m) => m.id),
    missions.map((m) => m.id)
  );
});

test("19. Fase 2 READ degli obiettivi con Memoria AI OFF legge da DataRepository senza mutazioni", async () => {
  const storage = createMockStorage();
  const repo = new DataRepository(storage);
  const goal = createGrowthGoal({ title: "Scrivere 20 minuti ogni mattina" });
  assert.ok(goal);
  repo.saveGrowthGoals([goal]);

  const run = await runOrchestration({
    request: "Visualizza i miei obiettivi di crescita",
    consentEnabled: false,
    storage,
  });

  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].toolId, "growth_engine");
  assert.equal(run.steps[0].operation, "READ");
  assert.ok(run.finalSummary.includes("Recuperati 1 obiettivi di crescita esistenti da DataRepository"));
  assert.equal(repo.getGrowthGoals().length, 1);
  assert.equal(repo.getGrowthGoals()[0].id, goal.id);
});

test("20. Fase 2 CREATE, UPDATE e DELETE su DataRepository con Memoria AI OFF e nessuna resurrezione legacy", async () => {
  const storage = createMockStorage();
  const repo = new DataRepository(storage);

  // CREATE con conferma esplicita e Memoria AI OFF
  const createRun = await runOrchestration({
    request: "Crea un piano settimanale",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "create-1",
        toolId: "planning_engine",
        operation: "CREATE",
        input: { declaredGoal: "Correre 3 volte a settimana", horizon: "weekly" },
      },
    ],
    approvedStepIds: ["create-1"],
  });
  assert.equal(createRun.status, "completed");
  assert.equal(repo.getPlans().length, 1);
  const createdId = repo.getPlans()[0].id;

  // UPDATE con conferma esplicita e Memoria AI OFF
  const updateRun = await runOrchestration({
    request: "Aggiorna il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "update-1",
        toolId: "planning_engine",
        operation: "UPDATE",
        input: { planId: createdId, title: "Correre 4 volte a settimana" },
      },
    ],
    approvedStepIds: ["update-1"],
  });
  assert.equal(updateRun.status, "completed");
  assert.equal(repo.getPlans()[0].title, "Correre 4 volte a settimana");

  // DELETE con conferma esplicita e Memoria AI OFF
  const deleteRun = await runOrchestration({
    request: "Elimina il mio piano",
    consentEnabled: false,
    storage,
    explicitSteps: [
      {
        id: "delete-1",
        toolId: "planning_engine",
        operation: "DELETE",
        input: { planId: createdId },
      },
    ],
    approvedStepIds: ["delete-1"],
  });
  assert.equal(deleteRun.status, "completed");
  assert.equal(repo.getPlans().length, 0);

  // READ successivo: nessun ripristino di dati eliminati
  const readAfterDelete = await runOrchestration({
    request: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });
  assert.equal(readAfterDelete.status, "completed");
  assert.equal(repo.getPlans().length, 0);
});
