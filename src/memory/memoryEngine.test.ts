import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemorySummaryForGemini,
  createEmptyLongTermMemory,
  extractLongTermMemoryUpdate,
  syncCompletedMissionsToMemory,
} from "./extractor";
import { isSafeForLongTermMemory, redactSensitiveTokens } from "./privacyFilter";
import { AuraMemoryStore, MEMORY_STORAGE_KEYS } from "./storage";
import type { StorageDriver } from "./types";

function createMemoryDriver(): StorageDriver & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

test("memory consent starts disabled and blocks saving personal data without consent", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);

  assert.equal(store.getConsent().enabled, false);

  const savedShort = store.saveShortTermMemory([
    { role: "user", text: "Preferisco esercizi brevi la sera", time: "10:00" },
  ]);
  const savedLong = store.saveLongTermMemory({
    ...createEmptyLongTermMemory(),
    preferences: ["Preferisco esercizi brevi la sera"],
  });
  const savedCheckins = store.saveCheckIn({
    date: "2026-11-15T10:00:00Z",
    stress: 6,
    mood: "Teso",
  });

  assert.equal(savedShort, false);
  assert.equal(savedLong, false);
  assert.deepEqual(savedCheckins, []);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.shortTerm), null);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.longTerm), null);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.checkIns), null);
});

test("enabling consent persists and restores short-term, long-term memory, and check-ins", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);
  store.setConsent(true);

  store.saveShortTermMemory([
    { role: "assistant", text: "Buongiorno.", time: "09:00" },
    { role: "user", text: "Preferisco respirazioni lente.", time: "09:01" },
  ]);

  let longTerm = extractLongTermMemoryUpdate({
    current: createEmptyLongTermMemory(),
    userMessage: "Preferisco respirazioni lente. Il mio obiettivo è dormire più sereno.",
    crisisDetected: false,
  });
  longTerm = syncCompletedMissionsToMemory(longTerm, ["Pausa consapevole"]);
  store.saveLongTermMemory(longTerm);
  store.saveCheckIn({ date: "2026-11-15T09:02:00Z", stress: 4, mood: "Bene" });

  // Simula reload creando una nuova istanza sullo stesso driver
  const reloadedStore = new AuraMemoryStore(driver);
  assert.equal(reloadedStore.getConsent().enabled, true);
  assert.equal(reloadedStore.getShortTermMemory().messages.length, 2);
  assert.equal(reloadedStore.getLongTermMemory().preferences[0], "Preferisco respirazioni lente.");
  assert.equal(
    reloadedStore.getLongTermMemory().goalsAndStrategies[0],
    "Il mio obiettivo è dormire più sereno."
  );
  assert.deepEqual(reloadedStore.getLongTermMemory().completedMissions, ["Pausa consapevole"]);
  assert.equal(reloadedStore.getCheckIns().length, 1);
});

test("long-term memory deduplicates repeated preferences and topics", () => {
  let mem = createEmptyLongTermMemory();
  mem = extractLongTermMemoryUpdate({
    current: mem,
    userMessage: "Preferisco esercizi brevi di respirazione.",
    crisisDetected: false,
  });
  mem = extractLongTermMemoryUpdate({
    current: mem,
    userMessage: "Preferisco esercizi brevi di respirazione",
    crisisDetected: false,
  });

  assert.equal(mem.preferences.length, 1);
  assert.equal(mem.conversationTopics.length, 1);
});

test("privacy filter blocks crisis, clinical/medical diagnoses, medications, and redacts contact PII", () => {
  assert.equal(isSafeForLongTermMemory("Penso di farla finita stasera"), false);
  assert.equal(isSafeForLongTermMemory("Ho una diagnosi di disturbo bipolare"), false);
  assert.equal(isSafeForLongTermMemory("Prendo Xanax 0.5 mg prima di dormire"), false);

  const memAfterCrisis = extractLongTermMemoryUpdate({
    current: createEmptyLongTermMemory(),
    userMessage: "Non voglio vivere più",
    crisisDetected: true,
  });
  assert.deepEqual(memAfterCrisis.conversationTopics, []);
  assert.deepEqual(memAfterCrisis.preferences, []);

  const redacted = redactSensitiveTokens("Scrivimi a mario.rossi@example.com o al 3471234567");
  assert.doesNotMatch(redacted, /mario\.rossi@example\.com/);
  assert.doesNotMatch(redacted, /3471234567/);
});

test("revoking consent and clearAllPersonalMemory completely remove stored data and stop Gemini injection", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);
  store.setConsent(true);
  store.saveShortTermMemory([{ role: "user", text: "Ciao AURA", time: "10:00" }]);
  store.saveLongTermMemory({
    ...createEmptyLongTermMemory(),
    preferences: ["Preferisco camminare al mattino"],
  });
  store.saveCheckIn({ date: "2026-11-15T10:00:00Z", stress: 5, mood: "Così così" });

  // Export before deletion
  const exported = store.exportBundle();
  assert.equal(exported.version, "aura-memory-v1");
  assert.equal(exported.longTermMemory.preferences.length, 1);
  assert.equal(exported.shortTermMemory.messages.length, 1);
  assert.equal(exported.checkIns.length, 1);

  // Revoca consenso -> cancella immediatamente i dati personali salvati
  store.setConsent(false);
  assert.equal(store.getConsent().enabled, false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.shortTerm), null);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.longTerm), null);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.checkIns), null);

  // Senza consenso, buildMemorySummaryForGemini restituisce undefined (nessun invio a Gemini)
  const summaryWhenOff = buildMemorySummaryForGemini({
    consentEnabled: false,
    memory: {
      ...createEmptyLongTermMemory(),
      preferences: ["Qualcosa"],
    },
  });
  assert.equal(summaryWhenOff, undefined);

  // Quando attivo, genera il riepilogo sintetico pertinente
  const summaryWhenOn = buildMemorySummaryForGemini({
    consentEnabled: true,
    memory: {
      ...createEmptyLongTermMemory(),
      preferences: ["Preferisco esercizi brevi"],
      completedMissions: ["Pausa consapevole"],
    },
  });
  assert.match(summaryWhenOn ?? "", /Preferisco esercizi brevi/);
  assert.match(summaryWhenOn ?? "", /Pausa consapevole/);
});
