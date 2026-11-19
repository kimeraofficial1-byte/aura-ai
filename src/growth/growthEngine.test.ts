import test from "node:test";
import assert from "node:assert/strict";
import {
  generatePersonalInsights,
  validateGrowthInsightsRequest,
} from "../../server/growthEngine";
import { AuraMemoryStore, MEMORY_STORAGE_KEYS } from "../memory/storage";
import type { CheckInRecord, StorageDriver } from "../memory/types";
import { generateAdaptiveMissionsLocal, transitionMissionStatus } from "../missions/engine";
import {
  addGrowthGoalStep,
  buildPersonalGrowthProfile,
  buildProgressTimeline,
  buildWeeklyReflection,
  createGrowthGoal,
  deleteGrowthGoal,
  evaluateAchievements,
  generateLocalPersonalInsights,
  parseAndValidateInsightsJson,
  setGrowthGoalStatus,
  toggleGrowthGoalStep,
  updateGrowthGoal,
} from "./engine";
import type { GrowthGoal, PersonalInsightsContext } from "./types";

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

function makeInsightsContext(
  overrides: Partial<PersonalInsightsContext> = {}
): PersonalInsightsContext {
  return {
    goals: [],
    preferences: [],
    missions: [],
    checkIns: [],
    emotionalTrends: [],
    latestAnalysis: null,
    consentEnabled: false,
    ...overrides,
  };
}

test("1. Goal creation, editing, and sub-steps evolution track history and block unsafe text", () => {
  const blocked = createGrowthGoal({
    title: "Prendere Xanax per la diagnosi di depressione",
  });
  assert.equal(blocked, null);

  const created = createGrowthGoal(
    { title: "Routine serale tranquilla", description: "Staccare prima di dormire" },
    "2026-11-10T10:00:00Z"
  );
  assert.ok(created);
  assert.equal(created.status, "attivo");
  assert.equal(created.history.length, 1);

  const edited = updateGrowthGoal(
    created,
    { title: "Routine serale leggera", description: "10 minuti di calma" },
    "2026-11-11T10:00:00Z"
  );
  assert.equal(edited.title, "Routine serale leggera");
  assert.equal(edited.history.length, 2);

  const withStep = addGrowthGoalStep(edited, "Spegnere gli schermi alle 22:30", "2026-11-11T11:00:00Z");
  assert.equal(withStep.steps.length, 1);
  assert.equal(withStep.steps[0].done, false);

  const toggled = toggleGrowthGoalStep(withStep, withStep.steps[0].id, "2026-11-12T10:00:00Z");
  assert.equal(toggled.steps[0].done, true);
  assert.equal(toggled.history[toggled.history.length - 1].type, "step_completed");
});

test("2. Goal pausing, resuming, completion, and deletion work cleanly at any time", () => {
  const goal = createGrowthGoal({ title: "Camminare 10 minuti" }, "2026-11-10T09:00:00Z")!;
  const paused = setGrowthGoalStatus(goal, "in_pausa", "2026-11-11T09:00:00Z");
  assert.equal(paused.status, "in_pausa");
  assert.equal(paused.completedAt, undefined);

  const resumed = setGrowthGoalStatus(paused, "attivo", "2026-11-12T09:00:00Z");
  assert.equal(resumed.status, "attivo");

  const completed = setGrowthGoalStatus(resumed, "completato", "2026-11-13T09:00:00Z");
  assert.equal(completed.status, "completato");
  assert.equal(completed.completedAt, "2026-11-13T09:00:00Z");

  // Rimane modificabile e poi eliminabile
  const editedCompleted = updateGrowthGoal(completed, { title: "Camminare 10 minuti al parco" });
  assert.equal(editedCompleted.title, "Camminare 10 minuti al parco");

  const remaining = deleteGrowthGoal([editedCompleted], editedCompleted.id);
  assert.equal(remaining.length, 0);
});

test("3. Progress timeline aggregates events and filters accurately by 7d, 30d, and all", () => {
  const nowIso = "2026-11-15T12:00:00Z";
  const recentGoal = setGrowthGoalStatus(
    createGrowthGoal({ title: "Obiettivo recente" }, "2026-11-12T10:00:00Z")!,
    "completato",
    "2026-11-14T10:00:00Z"
  );
  const oldCheckIn: CheckInRecord = {
    date: "2026-10-01T10:00:00Z", // > 30 giorni fa
    mood: "Sereno",
    stress: 3,
  };
  const recentCheckIn: CheckInRecord = {
    date: "2026-11-13T10:00:00Z", // entro 7 giorni
    mood: "Bene",
    stress: 4,
  };

  const missionSkipped = transitionMissionStatus(
    generateAdaptiveMissionsLocal(
      {
        availableMinutes: 10,
        energyLevel: "media",
        goals: [],
        preferences: [],
        consentEnabled: false,
        existingMissions: [],
      },
      1,
      "2026-11-14T08:00:00Z"
    ).missions[0],
    "annullata",
    "2026-11-14T09:00:00Z"
  );

  const allEvents = buildProgressTimeline(
    {
      goals: [recentGoal],
      missions: [missionSkipped],
      checkIns: [oldCheckIn, recentCheckIn],
    },
    "all",
    nowIso
  );
  assert.ok(allEvents.some((e) => e.kind === "goal_completed"));
  assert.ok(allEvents.some((e) => e.kind === "mission_skipped_or_paused"));
  assert.ok(allEvents.some((e) => e.id.includes("2026-10-01")));

  const last7Days = buildProgressTimeline(
    {
      goals: [recentGoal],
      missions: [missionSkipped],
      checkIns: [oldCheckIn, recentCheckIn],
    },
    "7d",
    nowIso
  );
  assert.equal(
    last7Days.some((e) => e.id.includes("2026-10-01")),
    false,
    "Il filtro 7 giorni deve escludere il check-in di ottobre"
  );
  assert.ok(last7Days.some((e) => e.kind === "goal_completed"));
});

test("4. Weekly reflection summarizes real activities, difficulties, progress, and suggestions", () => {
  const nowIso = "2026-11-15T12:00:00Z";
  const g1 = setGrowthGoalStatus(
    createGrowthGoal({ title: "Pause di respiro" }, "2026-11-10T10:00:00Z")!,
    "completato",
    "2026-11-14T10:00:00Z"
  );
  const mDone = transitionMissionStatus(
    generateAdaptiveMissionsLocal(
      {
        availableMinutes: 10,
        energyLevel: "media",
        goals: [],
        preferences: [],
        consentEnabled: false,
        existingMissions: [],
      },
      1,
      "2026-11-14T08:00:00Z"
    ).missions[0],
    "completata",
    "2026-11-14T08:30:00Z"
  );

  const weekly = buildWeeklyReflection(
    {
      goals: [g1],
      missions: [mDone],
      checkIns: [{ date: "2026-11-14T09:00:00Z", mood: "Teso", stress: 8 }],
    },
    nowIso
  );

  assert.equal(weekly.hasSufficientData, true);
  assert.equal(weekly.completedMissions.length, 1);
  assert.deepEqual(weekly.goalsWorkedOn, ["Pause di respiro"]);
  assert.ok(weekly.declaredDifficulties.some((d) => d.includes("8/10")));
  assert.ok(weekly.observableSmallProgress.length >= 2);
  assert.ok(weekly.optionalNextWeekSuggestions.length >= 1);
});

test("5. Insufficient data is declared transparently in weekly reflection and personal insights", async () => {
  const emptyWeekly = buildWeeklyReflection(
    { goals: [], missions: [], checkIns: [] },
    "2026-11-15T12:00:00Z"
  );
  assert.equal(emptyWeekly.hasSufficientData, false);
  assert.match(emptyWeekly.dataSufficiencyNote, /insufficienti/i);

  const localInsights = generateLocalPersonalInsights(makeInsightsContext());
  assert.equal(localInsights.insufficientData, true);
  assert.equal(localInsights.insights.length, 0);
  assert.match(localInsights.insufficientDataMessage ?? "", /insufficienti/i);

  const serverInsights = await generatePersonalInsights({
    context: makeInsightsContext(),
    useGemini: true,
    generateJsonFn: async () => {
      throw new Error("Should not call Gemini when data is insufficient");
    },
  });
  assert.equal(serverInsights.insufficientData, true);
});

test("6. Non-competitive achievement system evaluates all 5 milestones without penalties or rankings", () => {
  const goal = setGrowthGoalStatus(
    addGrowthGoalStep(
      createGrowthGoal({ title: "Dormire meglio" }, "2026-11-10T09:00:00Z")!,
      "Leggere 5 minuti",
      "2026-11-10T09:05:00Z"
    ),
    "completato",
    "2026-11-14T09:00:00Z"
  );
  goal.steps[0].done = true;

  const baseMissions = generateAdaptiveMissionsLocal(
    {
      availableMinutes: 15,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    3,
    "2026-11-12T09:00:00Z"
  ).missions;
  const doneMissions = baseMissions.map((m, idx) =>
    transitionMissionStatus(m, "completata", `2026-11-1${idx + 1}T10:00:00Z`)
  );

  const achievements = evaluateAchievements({
    goals: [goal],
    missions: doneMissions,
    checkIns: [
      { date: "2026-11-10T08:00:00Z", mood: "Così così", stress: 5 },
      { date: "2026-11-11T08:00:00Z", mood: "Bene", stress: 4 },
      { date: "2026-11-12T08:00:00Z", mood: "Sereno", stress: 3 },
    ],
  });

  assert.equal(achievements.length, 5);
  for (const a of achievements) {
    assert.equal(a.unlocked, true, `Achievement atteso sbloccato: ${a.id}`);
    assert.doesNotMatch(`${a.title} ${a.description}`, /(classifica|podio|penalità|streak perso)/i);
  }
});

test("7. Strict JSON parser rejects malformed JSON, missing fields, and diagnostic language", () => {
  assert.equal(parseAndValidateInsightsJson("").ok, false);
  assert.equal(parseAndValidateInsightsJson("{bad json").ok, false);
  assert.equal(
    parseAndValidateInsightsJson(
      JSON.stringify({
        insufficientData: false,
        insights: [
          {
            title: "Osservazione clinica",
            observedFacts: ["Hai registrato 3 check-in"],
            cautiousInterpretation: "Questa è una diagnosi clinica di disturbo ansioso.",
            confidenceNote: "Alta",
          },
        ],
      })
    ).ok,
    false
  );

  const valid = parseAndValidateInsightsJson(
    "```json\n" +
      JSON.stringify({
        insufficientData: false,
        insights: [
          {
            title: "Continuità nelle pause brevi",
            observedFacts: ["Hai completato 2 missioni brevi", "Hai registrato 2 check-in"],
            cautiousInterpretation:
              "Le attività scelte finora indicano una preferenza pratica per pause contenute; resta una lettura ipotetica.",
            confidenceNote: "Basato sui 4 eventi registrati.",
          },
        ],
      }) +
      "\n```"
  );
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.insights.length, 1);
    assert.equal(valid.insights[0].observedFacts.length, 2);
  }
});

test("8. Server Personal Insights works with Gemini JSON and falls back cleanly without API key or on RATE_LIMIT", async () => {
  const richCtx = makeInsightsContext({
    goals: [createGrowthGoal({ title: "Pause consapevoli" })!],
    checkIns: [
      { date: "2026-11-13T10:00:00Z", mood: "Bene", stress: 4 },
      { date: "2026-11-14T10:00:00Z", mood: "Sereno", stress: 3 },
    ],
  });

  const geminiRes = await generatePersonalInsights({
    context: richCtx,
    useGemini: true,
    generateJsonFn: async () =>
      JSON.stringify({
        insufficientData: false,
        insights: [
          {
            title: "Andamento degli ultimi check-in",
            observedFacts: ["Check-in 1: stress 4/10", "Check-in 2: stress 3/10"],
            cautiousInterpretation:
              "Nei due check-in recenti hai segnalato valori moderati/bassi; servono più rilevazioni nel tempo per capire se sia un ritmo stabile.",
            confidenceNote: "Dati iniziali basati su 2 check-in.",
          },
        ],
      }),
  });
  assert.equal(geminiRes.source, "gemini-json");
  assert.equal(geminiRes.fallbackUsed, false);

  const noKeyRes = await generatePersonalInsights({
    context: richCtx,
    apiKey: "",
    useGemini: true,
  });
  assert.equal(noKeyRes.source, "local-reflective");
  assert.equal(noKeyRes.fallbackUsed, true);
  assert.equal(noKeyRes.fallbackReason, "MISSING_API_KEY");

  const rateLimitedRes = await generatePersonalInsights({
    context: richCtx,
    useGemini: true,
    generateJsonFn: async () => {
      throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
    },
  });
  assert.equal(rateLimitedRes.source, "local-reflective");
  assert.equal(rateLimitedRes.fallbackUsed, true);
  assert.equal(rateLimitedRes.fallbackReason, "RATE_LIMIT");
});

test("9. Memory Engine V1 gates growth goals persistence, export, revocation, and full deletion", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);
  const g = createGrowthGoal({ title: "Camminare dopo pranzo" })!;

  // Consenso disattivato -> zero persistenza
  assert.equal(store.saveGrowthGoals([g]), false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.growthGoals), null);
  assert.deepEqual(store.getGrowthGoals(), []);

  // Consenso attivo -> salva, ripristina ed esporta
  store.setConsent(true);
  assert.equal(store.saveGrowthGoals([g]), true);
  assert.equal(store.getGrowthGoals().length, 1);
  assert.equal(store.exportBundle().growthGoals.length, 1);

  // Revoca consenso -> elimina tutto
  store.setConsent(false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.growthGoals), null);
  assert.deepEqual(store.getGrowthGoals(), []);

  // clearAllPersonalMemory rimuove esplicitamente
  store.setConsent(true);
  store.saveGrowthGoals([g]);
  store.clearAllPersonalMemory();
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.growthGoals), null);
});

test("10. Pre-model safety blocks Personal Insights on crisis content in focusPrompt or goals and profile uses declared data only", async () => {
  const profile = buildPersonalGrowthProfile({
    goals: [createGrowthGoal({ title: "Respirare 3 minuti" })!],
    preferences: ["esercizi brevi la sera"],
    missions: [],
    checkIns: [{ date: "2026-11-14T10:00:00Z", mood: "Così così", stress: 5 }],
    consentEnabled: false,
  });
  assert.equal(profile.declaredGoalsCount, 1);
  assert.deepEqual(profile.expressedPreferences, ["esercizi brevi la sera"]);

  const crisisFocus = await generatePersonalInsights({
    context: makeInsightsContext({
      focusPrompt: "Non voglio più vivere",
    }),
    useGemini: false,
  });
  assert.equal(crisisFocus.blockedBySafety, true);
  assert.match(crisisFocus.safetyReply ?? "", /112/);

  const rawGoal: GrowthGoal = {
    id: "g-unsafe",
    title: "voglio farla finita",
    status: "attivo",
    steps: [],
    createdAt: "2026-11-15T10:00:00Z",
    updatedAt: "2026-11-15T10:00:00Z",
    history: [],
  };
  const crisisGoal = await generatePersonalInsights({
    context: makeInsightsContext({ goals: [rawGoal] }),
    useGemini: false,
  });
  assert.equal(crisisGoal.blockedBySafety, true);

  assert.equal(validateGrowthInsightsRequest(null).ok, false);
});
