import test from "node:test";
import assert from "node:assert/strict";
import {
  generateAdaptiveMissions,
  validateMissionGenerateRequest,
} from "../../server/missionEngine";
import { AuraMemoryStore, MEMORY_STORAGE_KEYS } from "../memory/storage";
import type { StorageDriver } from "../memory/types";
import {
  MISSION_CATALOG,
  generateAdaptiveMissionsLocal,
  parseAndValidateMissionsJson,
  transitionMissionStatus,
  updateMissionDetails,
} from "./engine";
import {
  MISSION_CATEGORIES,
  type AdaptiveMission,
  type MissionGenerationContext,
} from "./types";

function createMemoryDriver(): StorageDriver {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function makeBaseContext(
  overrides: Partial<MissionGenerationContext> = {}
): MissionGenerationContext {
  return {
    availableMinutes: 15,
    energyLevel: "media",
    goals: [],
    preferences: [],
    consentEnabled: false,
    existingMissions: [],
    ...overrides,
  };
}

test("1. Mission catalog and generated missions cover all 10 required categories and fields", () => {
  assert.equal(MISSION_CATEGORIES.length, 10);
  const catalogCategories = new Set(MISSION_CATALOG.map((item) => item.category));
  for (const cat of MISSION_CATEGORIES) {
    assert.ok(catalogCategories.has(cat), `Categoria mancante nel catalogo: ${cat}`);
  }

  const result = generateAdaptiveMissionsLocal(makeBaseContext(), 3, "2026-11-15T12:00:00Z");
  assert.equal(result.missions.length, 3);
  const ids = new Set<string>();
  for (const mission of result.missions) {
    assert.ok(mission.id.length > 4);
    assert.ok(!ids.has(mission.id), "Gli ID missione devono essere univoci");
    ids.add(mission.id);
    assert.ok(mission.title.length > 0);
    assert.ok(mission.description.length > 0);
    assert.ok(MISSION_CATEGORIES.includes(mission.category));
    assert.ok(mission.estimatedMinutes >= 1);
    assert.ok(mission.durationLabel.includes("minut"));
    assert.ok(["basso", "medio", "alto"].includes(mission.effortLevel));
    assert.ok(mission.goal.length > 0);
    assert.ok(Array.isArray(mission.instructions) && mission.instructions.length >= 2);
    assert.equal(mission.createdAt, "2026-11-15T12:00:00Z");
    assert.equal(mission.status, "proposta");
  }
});

test("2. Low energy reduces effort to basso and avoids pressure or penalties", () => {
  const result = generateAdaptiveMissionsLocal(
    makeBaseContext({
      energyLevel: "bassa",
      availableMinutes: 20,
      recentStress: 8,
    }),
    3
  );

  assert.equal(result.missions.length, 3);
  for (const mission of result.missions) {
    assert.equal(mission.effortLevel, "basso");
    assert.doesNotMatch(
      `${mission.description} ${mission.adaptationNote ?? ""}`,
      /(penalità|fallito|colpa|classifica|streak perso)/i
    );
  }
});

test("3. Limited available time strictly caps mission duration", () => {
  const result = generateAdaptiveMissionsLocal(
    makeBaseContext({
      availableMinutes: 5,
      energyLevel: "media",
    }),
    3
  );

  assert.equal(result.missions.length, 3);
  for (const mission of result.missions) {
    assert.ok(
      mission.estimatedMinutes <= 5,
      `Durata attesa <= 5 min, ottenuta ${mission.estimatedMinutes}`
    );
    assert.equal(mission.effortLevel, "basso");
  }
});

test("4. Rejected and cancelled missions are excluded from immediate re-proposal", () => {
  const firstBatch = generateAdaptiveMissionsLocal(makeBaseContext(), 3);
  const rejected = transitionMissionStatus(firstBatch.missions[0], "rifiutata");
  const cancelled = transitionMissionStatus(firstBatch.missions[1], "annullata");

  const secondBatch = generateAdaptiveMissionsLocal(
    makeBaseContext({
      existingMissions: [rejected, cancelled],
    }),
    3
  );

  const secondTitles = new Set(secondBatch.missions.map((m) => m.title));
  assert.equal(secondTitles.has(rejected.title), false);
  assert.equal(secondTitles.has(cancelled.title), false);
});

test("5. Complexity increases gradually only when energy is good, stress low, time >= 15 and >= 2 completed", () => {
  const withoutProgress = generateAdaptiveMissionsLocal(
    makeBaseContext({
      energyLevel: "buona",
      recentStress: 2,
      availableMinutes: 20,
      existingMissions: [],
    }),
    3
  );
  assert.equal(
    withoutProgress.missions.some((m) => m.effortLevel === "alto"),
    false
  );

  const completedMissions: AdaptiveMission[] = [0, 1].map((idx) => ({
    ...withoutProgress.missions[idx],
    id: `done-${idx}`,
    status: "completata",
  }));

  const withProgress = generateAdaptiveMissionsLocal(
    makeBaseContext({
      energyLevel: "buona",
      recentStress: 2,
      availableMinutes: 20,
      existingMissions: completedMissions,
    }),
    3
  );
  assert.equal(
    withProgress.missions.some((m) => m.effortLevel === "alto"),
    true
  );
});

test("6. Strict JSON schema parser rejects malformed JSON, missing fields, invalid categories, and clinical/crisis content", () => {
  assert.equal(parseAndValidateMissionsJson("").ok, false);
  assert.equal(parseAndValidateMissionsJson("{broken json").ok, false);
  assert.equal(parseAndValidateMissionsJson("[]").ok, false);

  assert.equal(
    parseAndValidateMissionsJson(
      JSON.stringify({
        missions: [
          {
            title: "Titolo",
            description: "Descrizione",
            category: "CategoriaNonEsistente",
            estimatedMinutes: 5,
            effortLevel: "basso",
            goal: "Obiettivo",
            instructions: ["Passo 1", "Passo 2"],
          },
        ],
      })
    ).ok,
    false
  );

  // Blocca contenuti clinici / farmacologici / di crisi
  assert.equal(
    parseAndValidateMissionsJson(
      JSON.stringify({
        missions: [
          {
            title: "Prendi Xanax per la diagnosi di depressione",
            description: "Assumi terapia farmacologica subito",
            category: "Pausa e recupero",
            estimatedMinutes: 5,
            effortLevel: "basso",
            goal: "Gestire diagnosi clinica",
            instructions: ["Prendi il farmaco"],
          },
        ],
      })
    ).ok,
    false
  );

  // Accetta JSON valido (anche con fence markdown) e applica clamp di minuti ed energia bassa
  const valid = parseAndValidateMissionsJson(
    "```json\n" +
      JSON.stringify({
        missions: [
          {
            title: "Respiro guidato breve",
            description: "Prenditi una pausa lenta e gentile.",
            category: "respirazione e rilassamento",
            estimatedMinutes: 25,
            effortLevel: "alto",
            goal: "Allentare la tensione",
            instructions: ["Siediti comodo", "Fai 5 respiri lenti"],
          },
        ],
      }) +
      "\n```",
    { maxMinutes: 5, energyLevel: "bassa" }
  );

  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.missions[0].category, "Respirazione e rilassamento");
    assert.equal(valid.missions[0].estimatedMinutes, 5);
    assert.equal(valid.missions[0].effortLevel, "basso");
  }
});

test("7. Server generator falls back cleanly without Gemini API key and on 429 RATE_LIMIT", async () => {
  const noKey = await generateAdaptiveMissions({
    context: makeBaseContext({ availableMinutes: 5, energyLevel: "bassa" }),
    apiKey: "",
    useGemini: true,
  });
  assert.equal(noKey.source, "local-adaptive");
  assert.equal(noKey.fallbackUsed, true);
  assert.equal(noKey.fallbackReason, "MISSING_API_KEY");
  assert.equal(noKey.missions.length, 3);

  const rateLimited = await generateAdaptiveMissions({
    context: makeBaseContext({ availableMinutes: 10, energyLevel: "media" }),
    useGemini: true,
    generateJsonFn: async () => {
      throw Object.assign(new Error("429 RESOURCE_EXHAUSTED quota exceeded"), { status: 429 });
    },
  });
  assert.equal(rateLimited.source, "local-adaptive");
  assert.equal(rateLimited.fallbackUsed, true);
  assert.equal(rateLimited.fallbackReason, "RATE_LIMIT");
  assert.equal(rateLimited.missions.length, 3);
});

test("8. Gemini valid JSON path works and still filters out previously rejected missions", async () => {
  const rejectedPrior: AdaptiveMission = {
    ...generateAdaptiveMissionsLocal(makeBaseContext(), 1).missions[0],
    title: "Respiro già rifiutato",
    status: "rifiutata",
  };

  const res = await generateAdaptiveMissions({
    context: makeBaseContext({
      availableMinutes: 10,
      energyLevel: "media",
      existingMissions: [rejectedPrior],
    }),
    useGemini: true,
    generateJsonFn: async () =>
      JSON.stringify({
        missions: [
          {
            title: "Respiro già rifiutato",
            description: "Non deve comparire.",
            category: "Respirazione e rilassamento",
            estimatedMinutes: 4,
            effortLevel: "basso",
            goal: "Calma",
            instructions: ["Respira piano", "Rilassa le spalle"],
          },
          {
            title: "Nota di gratitudine serale",
            description: "Annota un momento sereno di oggi.",
            category: "Gratitudine",
            estimatedMinutes: 5,
            effortLevel: "basso",
            goal: "Coltivare attenzione gentile",
            instructions: ["Pensa a un dettaglio positivo", "Scrivilo in due righe"],
          },
        ],
      }),
  });

  assert.equal(res.source, "gemini-json");
  assert.equal(res.fallbackUsed, false);
  assert.equal(res.missions.length, 1);
  assert.equal(res.missions[0].title, "Nota di gratitudine serale");
});

test("9. Personalizes using declared user goals without inventing undeclared goals", () => {
  const withGoal = generateAdaptiveMissionsLocal(
    makeBaseContext({
      goals: ["camminata quotidiana all'aperto"],
      availableMinutes: 15,
    }),
    3
  );
  assert.ok(
    withGoal.missions.some((m) => m.goal.includes("camminata quotidiana")),
    "Deve collegare esplicitamente l'obiettivo dichiarato dall'utente"
  );

  const withoutGoals = generateAdaptiveMissionsLocal(
    makeBaseContext({ goals: [], preferences: [] }),
    3
  );
  for (const m of withoutGoals.missions) {
    assert.equal(m.goal.includes("camminata quotidiana"), false);
  }
});

test("10. Emotional analysis uncertainty triggers neutral optional proposals and preference prompt", () => {
  const res = generateAdaptiveMissionsLocal(
    makeBaseContext({
      emotionalAnalysis: {
        primaryEmotion: "Incerto",
        secondaryEmotions: [],
        intensity: 3,
        confidence: 0.35,
        uncertain: true,
        evidence: [],
        stressSignals: [],
        empathyStrategy: {
          tone: "neutro, accogliente",
          activeListeningFocus: "esplorazione aperta",
          questionStyle: "domanda leggera",
          pacing: "light-open",
          suggestedExercise: null,
        },
        analyzedAt: "2026-11-15T12:00:00Z",
        source: "heuristic",
      },
    }),
    3
  );

  assert.equal(res.askUserPreference, true);
  assert.ok(res.preferencePrompt && res.preferencePrompt.length > 10);
  assert.ok(
    res.missions.some((m) =>
      (m.adaptationNote ?? "").toLowerCase().includes("neutra e facoltativa")
    )
  );
});

test("11. Status transitions and mission editing preserve safety and update fields properly", () => {
  const initial = generateAdaptiveMissionsLocal(makeBaseContext(), 1).missions[0];
  const accepted = transitionMissionStatus(initial, "accettata", "2026-11-15T13:00:00Z");
  assert.equal(accepted.status, "accettata");
  assert.equal(accepted.updatedAt, "2026-11-15T13:00:00Z");

  const interrupted = transitionMissionStatus(accepted, "annullata", "2026-11-15T13:05:00Z");
  assert.equal(interrupted.status, "annullata");

  const edited = updateMissionDetails(
    accepted,
    {
      title: "Pausa dolce con tè caldo",
      estimatedMinutes: 8,
      goal: "Staccare 8 minuti senza schermi",
    },
    "2026-11-15T13:10:00Z"
  );
  assert.equal(edited.title, "Pausa dolce con tè caldo");
  assert.equal(edited.estimatedMinutes, 8);
  assert.equal(edited.durationLabel, "8 minuti");
  assert.equal(edited.goal, "Staccare 8 minuti senza schermi");

  // Tentativo di modifica con contenuto clinico non consentito mantiene i valori precedenti
  const blockedEdit = updateMissionDetails(edited, {
    title: "Prendi benzodiazepine prescritte per depressione",
  });
  assert.equal(blockedEdit.title, "Pausa dolce con tè caldo");
});

test("12. Memory Engine V1 consent gates mission persistence, export, and full deletion", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);
  const sampleMissions = generateAdaptiveMissionsLocal(makeBaseContext(), 2).missions;

  // Senza consenso -> nessun salvataggio persistente
  assert.equal(store.saveMissions(sampleMissions), false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.missions), null);
  assert.deepEqual(store.getMissions(), []);

  // Con consenso -> salva, ripristina ed esporta
  store.setConsent(true);
  assert.equal(store.saveMissions(sampleMissions), true);
  assert.equal(store.getMissions().length, 2);
  assert.equal(store.exportBundle().missions.length, 2);

  // Revoca consenso o eliminazione -> rimuove completamente
  store.setConsent(false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.missions), null);
  assert.deepEqual(store.getMissions(), []);
});

test("13. Pre-model safety blocks mission generation on crisis signals in focusNote or goals", async () => {
  const crisisFocus = await generateAdaptiveMissions({
    context: makeBaseContext({
      focusNote: "Non voglio più vivere",
    }),
    useGemini: false,
  });
  assert.equal(crisisFocus.blockedBySafety, true);
  assert.equal(crisisFocus.missions.length, 0);
  assert.match(crisisFocus.safetyReply ?? "", /112/);

  const crisisGoal = await generateAdaptiveMissions({
    context: makeBaseContext({
      goals: ["voglio uccidermi stasera"],
    }),
    useGemini: false,
  });
  assert.equal(crisisGoal.blockedBySafety, true);
  assert.equal(crisisGoal.missions.length, 0);
  assert.match(crisisGoal.safetyReply ?? "", /112/);
});

test("14. Request validator clamps bounds and sanitizes invalid payloads", () => {
  assert.equal(validateMissionGenerateRequest(null).ok, false);

  const valid = validateMissionGenerateRequest({
    availableMinutes: 999,
    energyLevel: "sconosciuta",
    recentStress: -4,
    goals: ["  Dormire meglio  ", "", 123],
    consentEnabled: true,
    useGemini: false,
  });

  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.data.availableMinutes, 60);
    assert.equal(valid.data.energyLevel, "media");
    assert.equal(valid.data.recentStress, 0);
    assert.deepEqual(valid.data.goals, ["Dormire meglio"]);
    assert.equal(valid.data.consentEnabled, true);
    assert.equal(valid.data.useGemini, false);
  }
});
