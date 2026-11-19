import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrowthGoal,
  deleteGrowthGoal,
  setGrowthGoalStatus,
  updateGrowthGoal,
} from "../growth/engine";
import { buildMemorySummaryForGemini, createEmptyLongTermMemory } from "../memory/extractor";
import { AuraMemoryStore, MEMORY_STORAGE_KEYS } from "../memory/storage";
import {
  generateAdaptiveMissionsLocal,
  transitionMissionStatus,
  updateMissionDetails,
} from "../missions/engine";
import { runOrchestration } from "../orchestration/orchestrationEngine";
import { createPlan, PLANS_STORAGE_KEY } from "../planning/planningEngine";
import { analyzeProactiveOpportunities } from "../proactive/proactiveEngine";
import {
  DataExportManager,
  DataImportManager,
  DataRepository,
  OPERATIONAL_STORAGE_KEY,
} from "./dataManagement";
import { MemoryStorageAdapter } from "./storageAdapters";
import { CURRENT_SCHEMA_VERSION } from "./types";

test("1 & 2. Creazione, salvataggio e recupero di un piano dopo simulazione di riavvio", () => {
  const sharedStorage = new MemoryStorageAdapter();
  const repo1 = new DataRepository(sharedStorage);
  const plan = createPlan({
    declaredGoal: "Completare il progetto AURA",
    horizon: "weekly",
    consentEnabled: false,
  });

  repo1.savePlans([plan]);

  // Simulazione riavvio app con nuova istanza DataRepository sullo stesso storage
  const repo2 = new DataRepository(sharedStorage);
  const restored = repo2.getPlans();

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, plan.id);
  assert.equal(restored[0].declaredGoal, "Completare il progetto AURA");
});

test("3 & 4. Recupero delle missioni e degli obiettivi esistenti senza rigenerazione", () => {
  const storage = new MemoryStorageAdapter();
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
  const goal = createGrowthGoal({ title: "Meditare 10 minuti al giorno" });
  assert.ok(goal);

  repo.saveMissions(missions);
  repo.saveGrowthGoals([goal]);

  const restarted = new DataRepository(storage);
  assert.deepEqual(
    restarted.getMissions().map((m) => m.id),
    missions.map((m) => m.id)
  );
  assert.equal(restarted.getGrowthGoals().length, 1);
  assert.equal(restarted.getGrowthGoals()[0].title, "Meditare 10 minuti al giorno");
});

test("5 & 6. Storage operativo funzionante con memoria AI OFF e memoria AI non trasmessa senza consenso", () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const exportManager = new DataExportManager();

  const plan = createPlan({
    declaredGoal: "Studiare inglese 20 minuti al giorno",
    horizon: "daily",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  // I dati operativi sono salvati anche con consenso AI OFF
  assert.equal(repo.getPlans().length, 1);

  // La memoria AI NON viene trasmessa a Gemini quando consentEnabled è false
  const memory = {
    ...createEmptyLongTermMemory(),
    goalsAndStrategies: ["Obiettivo privato"],
  };
  const geminiSummary = buildMemorySummaryForGemini({ consentEnabled: false, memory });
  assert.equal(geminiSummary, undefined);

  // Esportazione memoria AI bloccata senza consenso
  assert.throws(() => {
    exportManager.exportAiMemoryJson(false, memory);
  }, /consenso alla memoria personale non è attivo/i);
});

test("7, 8, 9 & 10. Esportazione JSON, importazione valida, rifiuto JSON non valido e gestione duplicati", () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const exporter = new DataExportManager();
  const importer = new DataImportManager();

  const plan = createPlan({
    declaredGoal: "Correre 5 km",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  const exportedJson = exporter.exportOperationalJson(repo);
  assert.ok(exportedJson.includes("aura_operational_data"));

  // Rifiuto JSON non valido
  const badPreview = importer.previewImport("{invalid json", repo.loadSnapshot());
  assert.equal(badPreview.valid, false);

  // Anteprima importazione valida con rilevamento duplicati
  const goodPreview = importer.previewImport(exportedJson, repo.loadSnapshot());
  assert.equal(goodPreview.valid, true);
  assert.equal(goodPreview.incomingPlans, 1);
  assert.deepEqual(goodPreview.duplicatePlanIds, [plan.id]);

  // Overwrite senza conferma viene bloccato
  assert.throws(() => {
    importer.applyImport(repo, goodPreview, { mode: "overwrite", confirmed: false });
  }, /Conferma esplicita richiesta/i);

  // Merge deduplica correttamente mantenendo 1 solo piano
  const merged = importer.applyImport(repo, goodPreview, { mode: "merge", confirmed: true });
  assert.equal(merged.plans.length, 1);
});

test("11 & 12. Migrazione dello schema da legacy e recupero sicuro da record danneggiati", () => {
  const storage = new MemoryStorageAdapter();
  const legacyPlan = createPlan({
    declaredGoal: "Piano legacy da migrare",
    horizon: "monthly",
    consentEnabled: true,
  });
  // Simuliamo dati legacy v0 nella vecchia chiave
  storage.setItem(PLANS_STORAGE_KEY, JSON.stringify([legacyPlan]));

  const repo = new DataRepository(storage);
  const migrated = repo.loadSnapshot();
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(migrated.plans.length, 1);
  assert.equal(migrated.plans[0].id, legacyPlan.id);

  // Simuliamo un record danneggiato insieme a uno valido
  storage.setItem(
    OPERATIONAL_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      payload: {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        revision: 2,
        plans: [legacyPlan, { broken: true }],
        missions: [{ invalid: true }],
        growthGoals: [],
        preferences: {},
      },
    })
  );

  const report = repo.verifyIntegrity();
  assert.equal(report.valid, false);
  assert.equal(report.corruptedRecords, 2);
  assert.equal(report.validRecords, 1);

  const safeSnapshot = repo.loadSnapshot();
  assert.equal(safeSnapshot.plans.length, 1);
  assert.equal(safeSnapshot.plans[0].id, legacyPlan.id);
});

test("13 & 14. Eliminazione con conferma esplicita e compatibilità con Tool Orchestration V1.1", async () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);
  const plan = createPlan({
    declaredGoal: "Piano da eliminare con conferma",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);

  // Eliminazione senza conferma -> bloccata
  assert.equal(repo.deleteOperationalData(false), false);
  assert.equal(repo.getPlans().length, 1);

  // Eliminazione con conferma -> eseguita
  assert.equal(repo.deleteOperationalData(true), true);
  assert.equal(repo.getPlans().length, 0);

  // Compatibilità con Tool Orchestration V1.1 (READ non crea piani)
  const run = await runOrchestration({
    request: "Mostrami i miei piani",
    consentEnabled: false,
    storage,
  });
  assert.equal(run.intent, "READ");
  assert.equal(run.status, "completed");
  assert.equal(repo.getPlans().length, 0);
});

test("V2.1 & V2.2. Creazione missione con memoria OFF e persistenza dopo refresh", () => {
  const storage = new MemoryStorageAdapter();
  const memoryStore = new AuraMemoryStore(storage);
  assert.equal(memoryStore.getConsent().enabled, false);

  const repo = new DataRepository(storage);
  const generated = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 15,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions;
  assert.equal(generated.length, 1);

  repo.saveMissions(generated);

  // Simulazione refresh app
  const afterRefreshRepo = new DataRepository(storage);
  const restored = afterRefreshRepo.getMissions();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, generated[0].id);
  assert.equal(restored[0].title, generated[0].title);
  // AuraMemoryStore rimane vuoto con memoria OFF
  assert.deepEqual(memoryStore.getMissions(), []);
});

test("V2.3 & V2.4. Creazione obiettivo con memoria OFF e persistenza dopo refresh", () => {
  const storage = new MemoryStorageAdapter();
  const memoryStore = new AuraMemoryStore(storage);
  assert.equal(memoryStore.getConsent().enabled, false);

  const repo = new DataRepository(storage);
  const goal = createGrowthGoal({
    title: "Leggere 15 pagine ogni sera",
    description: "Ridurre lo schermo prima di dormire",
  });
  assert.ok(goal);
  repo.saveGrowthGoals([goal]);

  // Simulazione refresh app
  const afterRefreshRepo = new DataRepository(storage);
  const restored = afterRefreshRepo.getGrowthGoals();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, goal.id);
  assert.equal(restored[0].title, "Leggere 15 pagine ogni sera");
  assert.deepEqual(memoryStore.getGrowthGoals(), []);
});

test("V2.5 & V2.6. Aggiornamento, completamento ed eliminazione di missioni e obiettivi", () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);

  const mission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "buona",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions[0];
  const goal = createGrowthGoal({ title: "Camminare 30 minuti" });
  assert.ok(goal);

  repo.saveMissions([mission]);
  repo.saveGrowthGoals([goal]);

  // Aggiornamento e completamento
  const updatedMission = transitionMissionStatus(
    updateMissionDetails(mission, { title: "Respirazione guidata 5 min" }),
    "completata"
  );
  const updatedGoal = setGrowthGoalStatus(
    updateGrowthGoal(goal, { title: "Camminare 40 minuti al giorno" }),
    "completato"
  );

  repo.saveMissions([updatedMission]);
  repo.saveGrowthGoals([updatedGoal]);

  const reloaded = new DataRepository(storage);
  assert.equal(reloaded.getMissions()[0].title, "Respirazione guidata 5 min");
  assert.equal(reloaded.getMissions()[0].status, "completata");
  assert.equal(reloaded.getGrowthGoals()[0].title, "Camminare 40 minuti al giorno");
  assert.equal(reloaded.getGrowthGoals()[0].status, "completato");

  // Eliminazione
  reloaded.saveMissions([]);
  reloaded.saveGrowthGoals(deleteGrowthGoal(reloaded.getGrowthGoals(), goal.id));

  const afterDelete = new DataRepository(storage);
  assert.equal(afterDelete.getMissions().length, 0);
  assert.equal(afterDelete.getGrowthGoals().length, 0);
});

test("V2.7 & V2.8. Migrazione legacy (plans, missions, growthGoals), idempotenza e prevenzione duplicati", () => {
  const storage = new MemoryStorageAdapter();

  const legacyPlan = createPlan({
    declaredGoal: "Piano legacy V1",
    horizon: "weekly",
    consentEnabled: true,
  });
  const legacyMission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: true,
      existingMissions: [],
    },
    1
  ).missions[0];
  const legacyGoal = createGrowthGoal({ title: "Obiettivo legacy V1" });
  assert.ok(legacyGoal);

  // Popoliamo tutte e 3 le chiavi legacy (includendo un duplicato intenzionale)
  storage.setItem(PLANS_STORAGE_KEY, JSON.stringify([legacyPlan, legacyPlan]));
  storage.setItem(MEMORY_STORAGE_KEYS.missions, JSON.stringify([legacyMission, legacyMission]));
  storage.setItem(MEMORY_STORAGE_KEYS.growthGoals, JSON.stringify([legacyGoal, legacyGoal]));

  const repo = new DataRepository(storage);
  const firstLoad = repo.loadSnapshot();
  assert.equal(firstLoad.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(firstLoad.legacyMigrationCompleted, true);
  assert.equal(firstLoad.plans.length, 1);
  assert.equal(firstLoad.missions.length, 1);
  assert.equal(firstLoad.growthGoals.length, 1);

  // Idempotenza: se l'utente elimina l'obiettivo, un reload successivo NON deve re-importarlo dalla chiave legacy
  repo.saveGrowthGoals([]);
  const secondLoad = new DataRepository(storage).loadSnapshot();
  assert.equal(secondLoad.growthGoals.length, 0);
  assert.equal(secondLoad.plans.length, 1);
  assert.equal(secondLoad.missions.length, 1);
});

test("V2.9. Ripristino sicuro dopo dati corrotti in chiavi legacy e nello storage operativo", () => {
  const storage = new MemoryStorageAdapter();
  const validGoal = createGrowthGoal({ title: "Obiettivo valido superstite" });
  assert.ok(validGoal);

  // Legacy missions con JSON corrotto, legacy goals con 1 record valido e 2 corrotti
  storage.setItem(MEMORY_STORAGE_KEYS.missions, "{broken-json");
  storage.setItem(
    MEMORY_STORAGE_KEYS.growthGoals,
    JSON.stringify([validGoal, { broken: true }, null])
  );

  const repo = new DataRepository(storage);
  const migrated = repo.loadSnapshot();
  assert.equal(migrated.growthGoals.length, 1);
  assert.equal(migrated.growthGoals[0].id, validGoal.id);
  assert.equal(migrated.missions.length, 0);

  // Corrompiamo lo storage operativo principale: deve recuperare dal backup senza crash
  storage.setItem(OPERATIONAL_STORAGE_KEY, "{not-valid-json");
  const recovered = new DataRepository(storage).loadSnapshot();
  assert.ok(Array.isArray(recovered.plans));
  assert.ok(Array.isArray(recovered.missions));
  assert.ok(Array.isArray(recovered.growthGoals));
});

test("V2.10. Compatibilità con Planning, Missions, Growth e Proactivity", () => {
  const storage = new MemoryStorageAdapter();
  const repo = new DataRepository(storage);

  const plan = createPlan({
    declaredGoal: "Preparare presentazione settimanale",
    horizon: "weekly",
    consentEnabled: false,
  });
  const mission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "bassa",
      goals: ["Ridurre stress serale"],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    1
  ).missions[0];
  const goal = createGrowthGoal({ title: "Ridurre stress serale" });
  assert.ok(goal);

  repo.savePlans([plan]);
  repo.saveMissions([mission]);
  repo.saveGrowthGoals([goal]);

  const snap = new DataRepository(storage).loadSnapshot();
  const proactive = analyzeProactiveOpportunities({
    plans: snap.plans,
    missions: snap.missions,
    growthGoals: snap.growthGoals,
    consentEnabled: false,
    crisisBlocked: false,
  });

  assert.equal(proactive.safetyBlocked, false);
  assert.ok(Array.isArray(proactive.suggestions));
});

test("V2.11. Revoca consenso memoria AI senza perdita dei dati operativi", () => {
  const storage = new MemoryStorageAdapter();
  const memoryStore = new AuraMemoryStore(storage);
  const repo = new DataRepository(storage);

  // Utente attiva consenso AI e salva dati operativi + memoria AI
  memoryStore.setConsent(true);
  memoryStore.saveLongTermMemory({
    ...createEmptyLongTermMemory(),
    preferences: ["Preferisco sessioni brevi"],
    updatedAt: new Date().toISOString(),
  });

  const plan = createPlan({
    declaredGoal: "Piano operativo protetto",
    horizon: "daily",
    consentEnabled: true,
  });
  const mission = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: true,
      existingMissions: [],
    },
    1
  ).missions[0];
  const goal = createGrowthGoal({ title: "Obiettivo operativo protetto" });
  assert.ok(goal);

  repo.savePlans([plan]);
  repo.saveMissions([mission]);
  repo.saveGrowthGoals([goal]);

  // Revoca consenso memoria AI
  memoryStore.setConsent(false);

  // Memoria AI cancellata
  assert.equal(memoryStore.getConsent().enabled, false);
  assert.deepEqual(memoryStore.getLongTermMemory().preferences, []);

  // Dati operativi completamente preservati dopo revoca e refresh
  const afterRevoke = new DataRepository(storage);
  assert.equal(afterRevoke.getPlans().length, 1);
  assert.equal(afterRevoke.getPlans()[0].id, plan.id);
  assert.equal(afterRevoke.getMissions().length, 1);
  assert.equal(afterRevoke.getMissions()[0].id, mission.id);
  assert.equal(afterRevoke.getGrowthGoals().length, 1);
  assert.equal(afterRevoke.getGrowthGoals()[0].id, goal.id);
});
