import type { EmotionalTrendEntry } from "../emotion/types";
import {
  isSafeForLongTermMemory,
  normalizeText,
  redactSensitiveTokens,
} from "../memory/privacyFilter";
import type { CheckInRecord } from "../memory/types";
import type { AdaptiveMission } from "../missions/types";
import type {
  GoalChangeEvent,
  GrowthAchievement,
  GrowthGoal,
  GrowthGoalStatus,
  GrowthGoalStep,
  PersonalGrowthProfile,
  PersonalInsightItem,
  PersonalInsightsContext,
  PersonalInsightsResult,
  ProgressTimelineEntry,
  TimelinePeriodFilter,
  WeeklyReflection,
} from "./types";

const DIAGNOSTIC_OR_DOGMA_PATTERN =
  /\b(diagnosi clinica|disturbo\b|patologia\b|depressione clinica|soffri sicuramente di|dimostra con certezza|devi assolutamente|hai fallito)\b/i;

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function createGoalEvent(
  type: GoalChangeEvent["type"],
  summary: string,
  nowIso: string
): GoalChangeEvent {
  return {
    id: createId("gev"),
    date: nowIso,
    type,
    summary: redactSensitiveTokens(summary).slice(0, 140),
  };
}

export function createGrowthGoal(
  params: {
    title: string;
    description?: string;
    steps?: string[];
  },
  nowIso = new Date().toISOString()
): GrowthGoal | null {
  const cleanTitle = redactSensitiveTokens(params.title).trim().slice(0, 120);
  if (!cleanTitle || !isSafeForLongTermMemory(cleanTitle)) {
    return null;
  }

  const rawDesc = params.description?.trim() ?? "";
  const cleanDescription =
    rawDesc && isSafeForLongTermMemory(rawDesc)
      ? redactSensitiveTokens(rawDesc).trim().slice(0, 280)
      : undefined;

  const cleanSteps: GrowthGoalStep[] = (params.steps ?? [])
    .map((s) => redactSensitiveTokens(s).trim().slice(0, 120))
    .filter((s) => s.length > 0 && isSafeForLongTermMemory(s))
    .slice(0, 10)
    .map((title) => ({
      id: createId("step"),
      title,
      done: false,
    }));

  return {
    id: createId("goal"),
    title: cleanTitle,
    description: cleanDescription,
    status: "attivo",
    steps: cleanSteps,
    createdAt: nowIso,
    updatedAt: nowIso,
    history: [
      createGoalEvent("created", `Obiettivo creato: "${cleanTitle}"`, nowIso),
    ],
  };
}

export function updateGrowthGoal(
  goal: GrowthGoal,
  patch: { title?: string; description?: string },
  nowIso = new Date().toISOString()
): GrowthGoal {
  let nextTitle = goal.title;
  let nextDescription = goal.description;
  let changed = false;

  if (patch.title !== undefined) {
    const clean = redactSensitiveTokens(patch.title).trim().slice(0, 120);
    if (clean && isSafeForLongTermMemory(clean) && clean !== goal.title) {
      nextTitle = clean;
      changed = true;
    }
  }

  if (patch.description !== undefined) {
    const raw = patch.description.trim();
    if (!raw) {
      if (goal.description) {
        nextDescription = undefined;
        changed = true;
      }
    } else if (isSafeForLongTermMemory(raw)) {
      const cleanDesc = redactSensitiveTokens(raw).trim().slice(0, 280);
      if (cleanDesc !== goal.description) {
        nextDescription = cleanDesc;
        changed = true;
      }
    }
  }

  if (!changed) return goal;

  return {
    ...goal,
    title: nextTitle,
    description: nextDescription,
    updatedAt: nowIso,
    history: [
      ...goal.history.slice(-19),
      createGoalEvent("edited", `Obiettivo aggiornato: "${nextTitle}"`, nowIso),
    ],
  };
}

export function setGrowthGoalStatus(
  goal: GrowthGoal,
  nextStatus: GrowthGoalStatus,
  nowIso = new Date().toISOString()
): GrowthGoal {
  if (goal.status === nextStatus) return goal;

  const eventType: GoalChangeEvent["type"] =
    nextStatus === "in_pausa"
      ? "paused"
      : nextStatus === "completato"
        ? "completed"
        : "resumed";

  const summaryMap: Record<GoalChangeEvent["type"], string> = {
    created: "",
    edited: "",
    paused: `Obiettivo messo in pausa senza pressioni: "${goal.title}"`,
    resumed: `Obiettivo ripreso come attivo: "${goal.title}"`,
    completed: `Obiettivo completato: "${goal.title}"`,
    step_added: "",
    step_completed: "",
  };

  return {
    ...goal,
    status: nextStatus,
    updatedAt: nowIso,
    completedAt: nextStatus === "completato" ? nowIso : undefined,
    history: [
      ...goal.history.slice(-19),
      createGoalEvent(eventType, summaryMap[eventType], nowIso),
    ],
  };
}

export function addGrowthGoalStep(
  goal: GrowthGoal,
  stepTitle: string,
  nowIso = new Date().toISOString()
): GrowthGoal {
  const clean = redactSensitiveTokens(stepTitle).trim().slice(0, 120);
  if (!clean || !isSafeForLongTermMemory(clean)) return goal;
  if (goal.steps.length >= 12) return goal;

  const nextStep: GrowthGoalStep = {
    id: createId("step"),
    title: clean,
    done: false,
  };

  return {
    ...goal,
    steps: [...goal.steps, nextStep],
    updatedAt: nowIso,
    history: [
      ...goal.history.slice(-19),
      createGoalEvent("step_added", `Nuovo passaggio aggiunto: "${clean}"`, nowIso),
    ],
  };
}

export function toggleGrowthGoalStep(
  goal: GrowthGoal,
  stepId: string,
  nowIso = new Date().toISOString()
): GrowthGoal {
  let toggledStep: GrowthGoalStep | null = null;
  const nextSteps = goal.steps.map((s) => {
    if (s.id !== stepId) return s;
    toggledStep = { ...s, done: !s.done };
    return toggledStep;
  });

  if (!toggledStep) return goal;
  const stepSnapshot = toggledStep as GrowthGoalStep;

  return {
    ...goal,
    steps: nextSteps,
    updatedAt: nowIso,
    history: stepSnapshot.done
      ? [
          ...goal.history.slice(-19),
          createGoalEvent(
            "step_completed",
            `Passaggio completato: "${stepSnapshot.title}"`,
            nowIso
          ),
        ]
      : goal.history,
  };
}

export function removeGrowthGoalStep(
  goal: GrowthGoal,
  stepId: string,
  nowIso = new Date().toISOString()
): GrowthGoal {
  const nextSteps = goal.steps.filter((s) => s.id !== stepId);
  if (nextSteps.length === goal.steps.length) return goal;
  return {
    ...goal,
    steps: nextSteps,
    updatedAt: nowIso,
  };
}

export function deleteGrowthGoal(goals: GrowthGoal[], goalId: string): GrowthGoal[] {
  return goals.filter((g) => g.id !== goalId);
}

export function sanitizeGrowthGoalList(raw: unknown): GrowthGoal[] {
  if (!Array.isArray(raw)) return [];
  const cleanList: GrowthGoal[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.title !== "string") continue;
    if (!isSafeForLongTermMemory(rec.title)) continue;

    const status: GrowthGoalStatus =
      rec.status === "attivo" || rec.status === "in_pausa" || rec.status === "completato"
        ? rec.status
        : "attivo";

    const description =
      typeof rec.description === "string" &&
      rec.description.trim() &&
      isSafeForLongTermMemory(rec.description)
        ? redactSensitiveTokens(rec.description).trim().slice(0, 280)
        : undefined;

    const steps: GrowthGoalStep[] = Array.isArray(rec.steps)
      ? rec.steps
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .filter(
            (s) =>
              typeof s.id === "string" &&
              typeof s.title === "string" &&
              isSafeForLongTermMemory(s.title)
          )
          .map((s) => ({
            id: String(s.id),
            title: redactSensitiveTokens(String(s.title)).trim().slice(0, 120),
            done: s.done === true,
          }))
          .slice(0, 12)
      : [];

    const history: GoalChangeEvent[] = Array.isArray(rec.history)
      ? rec.history
          .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === "object")
          .filter(
            (h) =>
              typeof h.id === "string" &&
              typeof h.date === "string" &&
              typeof h.summary === "string" &&
              isSafeForLongTermMemory(h.summary)
          )
          .map((h): GoalChangeEvent => ({
            id: String(h.id),
            date: String(h.date),
            type:
              h.type === "created" ||
              h.type === "edited" ||
              h.type === "paused" ||
              h.type === "resumed" ||
              h.type === "completed" ||
              h.type === "step_added" ||
              h.type === "step_completed"
                ? h.type
                : "edited",
            summary: redactSensitiveTokens(String(h.summary)).slice(0, 140),
          }))
          .slice(-20)
      : [];

    cleanList.push({
      id: rec.id,
      title: redactSensitiveTokens(rec.title).trim().slice(0, 120),
      description,
      status,
      steps,
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
      updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
      completedAt: typeof rec.completedAt === "string" ? rec.completedAt : undefined,
      history,
    });

    if (cleanList.length >= 25) break;
  }

  return cleanList;
}

export function buildPersonalGrowthProfile(input: {
  goals: GrowthGoal[];
  preferences: string[];
  missions: AdaptiveMission[];
  checkIns: CheckInRecord[];
  consentEnabled: boolean;
}): PersonalGrowthProfile {
  const safePreferences = input.preferences
    .map((p) => redactSensitiveTokens(p).trim())
    .filter((p) => p.length > 0 && isSafeForLongTermMemory(p));

  const acceptedMissionsCount = input.missions.filter(
    (m) => m.status === "accettata" || m.status === "completata"
  ).length;
  const completedMissionsCount = input.missions.filter(
    (m) => m.status === "completata"
  ).length;
  const goalModificationsCount = input.goals.reduce(
    (acc, goal) => acc + Math.max(0, goal.history.length),
    0
  );

  return {
    declaredGoalsCount: input.goals.length,
    activeGoalsCount: input.goals.filter((g) => g.status === "attivo").length,
    pausedGoalsCount: input.goals.filter((g) => g.status === "in_pausa").length,
    completedGoalsCount: input.goals.filter((g) => g.status === "completato").length,
    expressedPreferences: safePreferences,
    acceptedMissionsCount,
    completedMissionsCount,
    availableCheckInsCount: input.checkIns.length,
    goalModificationsCount,
    consentedStorageActive: input.consentEnabled,
  };
}

export function evaluateAchievements(
  input: {
    goals: GrowthGoal[];
    missions: AdaptiveMission[];
    checkIns: CheckInRecord[];
  },
  nowIso = new Date().toISOString()
): GrowthAchievement[] {
  const completedGoals = input.goals.filter((g) => g.status === "completato");
  const completedMissions = input.missions.filter((m) => m.status === "completata");
  const distinctCategories = new Set(completedMissions.map((m) => m.category));
  const activityDays = new Set<string>([
    ...input.checkIns.map((c) => c.date.slice(0, 10)),
    ...completedMissions.map((m) => (m.updatedAt || m.createdAt).slice(0, 10)),
  ]);
  const totalCheckInsAndDone = input.checkIns.length + completedMissions.length;
  const declaredStepsDone = input.goals.reduce(
    (sum, g) => sum + g.steps.filter((s) => s.done).length,
    0
  );
  const declaredGoalEdits = input.goals.filter((g) => g.history.length > 1).length;

  return [
    {
      id: "first_goal_completed",
      title: "Primo obiettivo completato",
      description: "Hai portato a termine un obiettivo che hai scelto per te.",
      unlocked: completedGoals.length >= 1,
      unlockedAt: completedGoals[0]?.completedAt || completedGoals[0]?.updatedAt,
      progressLabel:
        completedGoals.length >= 1
          ? `${completedGoals.length} obiettivo/i completato/i`
          : "0 / 1 obiettivo completato",
    },
    {
      id: "first_missions_completed",
      title: "Prime missioni completate",
      description: "Hai completato almeno 2 piccole missioni di benessere al tuo ritmo.",
      unlocked: completedMissions.length >= 2,
      unlockedAt:
        completedMissions.length >= 2
          ? completedMissions[1]?.updatedAt || completedMissions[1]?.createdAt || nowIso
          : undefined,
      progressLabel: `${Math.min(completedMissions.length, 2)} / 2 missioni completate`,
    },
    {
      id: "personal_consistency",
      title: "Costanza personale",
      description:
        "Ti sei preso spazio per registrare check-in o attività in almeno 3 momenti distinti, senza alcuna pressione di serie consecutive.",
      unlocked: activityDays.size >= 3 || totalCheckInsAndDone >= 4,
      unlockedAt:
        activityDays.size >= 3 || totalCheckInsAndDone >= 4 ? nowIso : undefined,
      progressLabel: `${Math.min(Math.max(activityDays.size, totalCheckInsAndDone), 4)} momenti registrati`,
    },
    {
      id: "new_habits_explored",
      title: "Nuove abitudini sperimentate",
      description: "Hai esplorato almeno 3 diverse aree tra le categorie di benessere.",
      unlocked: distinctCategories.size >= 3,
      unlockedAt: distinctCategories.size >= 3 ? nowIso : undefined,
      progressLabel: `${distinctCategories.size} / 3 aree sperimentate`,
    },
    {
      id: "user_declared_progress",
      title: "Progressi dichiarati da te",
      description:
        "Hai definito o affinato un obiettivo personale o completato almeno un piccolo passaggio.",
      unlocked: input.goals.length >= 1 && (declaredStepsDone >= 1 || declaredGoalEdits >= 1 || completedGoals.length >= 1),
      unlockedAt:
        input.goals.length >= 1 && (declaredStepsDone >= 1 || declaredGoalEdits >= 1 || completedGoals.length >= 1)
          ? input.goals[0]?.updatedAt
          : undefined,
      progressLabel:
        input.goals.length === 0
          ? "Nessun obiettivo ancora impostato"
          : `${declaredStepsDone} passaggi completati · ${input.goals.length} obiettivi`,
    },
  ];
}

function getPeriodCutoffMs(period: TimelinePeriodFilter, nowMs: number): number | null {
  if (period === "7d") return nowMs - 7 * 24 * 60 * 60 * 1000;
  if (period === "30d") return nowMs - 30 * 24 * 60 * 60 * 1000;
  return null;
}

export function buildProgressTimeline(
  input: {
    goals: GrowthGoal[];
    missions: AdaptiveMission[];
    checkIns: CheckInRecord[];
    achievements?: GrowthAchievement[];
  },
  period: TimelinePeriodFilter = "all",
  nowIso = new Date().toISOString()
): ProgressTimelineEntry[] {
  const nowMs = Date.parse(nowIso) || Date.now();
  const cutoffMs = getPeriodCutoffMs(period, nowMs);
  const entries: ProgressTimelineEntry[] = [];

  for (const m of input.missions) {
    const eventDate = m.updatedAt || m.createdAt;
    if (m.status === "completata") {
      entries.push({
        id: `tl-mis-${m.id}`,
        date: eventDate,
        kind: "mission_completed",
        title: m.title,
        detail: `${m.category} · ${m.durationLabel}`,
        badge: "Missione completata",
      });
    } else if (m.status === "rifiutata" || m.status === "annullata") {
      entries.push({
        id: `tl-mis-skip-${m.id}`,
        date: eventDate,
        kind: "mission_skipped_or_paused",
        title: m.title,
        detail:
          m.status === "annullata"
            ? "Attività interrotta liberamente, nessuna penalità."
            : "Proposta saltata o sostituita secondo le tue preferenze.",
        badge: m.status === "annullata" ? "Interrotta" : "Saltata",
      });
    }
  }

  for (const goal of input.goals) {
    if (goal.status === "completato") {
      entries.push({
        id: `tl-goal-done-${goal.id}`,
        date: goal.completedAt || goal.updatedAt,
        kind: "goal_completed",
        title: goal.title,
        detail: "Obiettivo personale raggiunto.",
        badge: "Obiettivo raggiunto",
      });
    }
    for (const ev of goal.history) {
      if (ev.type === "completed") continue;
      entries.push({
        id: `tl-gev-${ev.id}`,
        date: ev.date,
        kind: "goal_evolved",
        title: goal.title,
        detail: ev.summary,
        badge: ev.type === "paused" ? "Obiettivo in pausa" : "Evoluzione obiettivo",
      });
    }
  }

  for (let i = 0; i < input.checkIns.length; i += 1) {
    const c = input.checkIns[i];
    entries.push({
      id: `tl-chk-${i}-${c.date}`,
      date: c.date,
      kind: "checkin",
      title: `Check-in: umore "${c.mood}"`,
      detail: `Stress percepito: ${c.stress}/10`,
      badge: "Check-in",
    });
  }

  const achievements =
    input.achievements ??
    evaluateAchievements(
      { goals: input.goals, missions: input.missions, checkIns: input.checkIns },
      nowIso
    );
  for (const ach of achievements) {
    if (ach.unlocked) {
      entries.push({
        id: `tl-ach-${ach.id}`,
        date: ach.unlockedAt || nowIso,
        kind: "achievement",
        title: ach.title,
        detail: ach.description,
        badge: "Traguardo",
      });
    }
  }

  return entries
    .filter((entry) => {
      if (cutoffMs === null) return true;
      const ts = Date.parse(entry.date);
      return Number.isFinite(ts) ? ts >= cutoffMs : true;
    })
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}

export function buildWeeklyReflection(
  input: {
    goals: GrowthGoal[];
    missions: AdaptiveMission[];
    checkIns: CheckInRecord[];
    emotionalTrends?: EmotionalTrendEntry[];
  },
  nowIso = new Date().toISOString()
): WeeklyReflection {
  const nowMs = Date.parse(nowIso) || Date.now();
  const weekCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const periodStart = new Date(weekCutoffMs).toISOString();

  const isInLastWeek = (iso: string) => {
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? ts >= weekCutoffMs : false;
  };

  const weeklyMissionsDone = input.missions.filter(
    (m) => m.status === "completata" && isInLastWeek(m.updatedAt || m.createdAt)
  );
  const weeklyCheckIns = input.checkIns.filter((c) => isInLastWeek(c.date));
  const weeklyGoalChanges = input.goals.filter(
    (g) => isInLastWeek(g.updatedAt) || g.history.some((h) => isInLastWeek(h.date))
  );
  const weeklyTrends = (input.emotionalTrends ?? []).filter((t) => isInLastWeek(t.date));

  const activitiesCount =
    weeklyMissionsDone.length + weeklyCheckIns.length + weeklyGoalChanges.length;
  const hasSufficientData = activitiesCount >= 2;

  const difficulties = new Set<string>();
  for (const c of weeklyCheckIns) {
    if (c.stress >= 7) {
      difficulties.add(`Stress percepito elevato (${c.stress}/10) durante un check-in`);
    }
    if (c.mood === "Teso" || c.mood === "Giù") {
      difficulties.add(`Umore dichiarato "${c.mood}" in questa settimana`);
    }
  }
  for (const t of weeklyTrends) {
    for (const sig of t.stressSignals) {
      if (isSafeForLongTermMemory(sig)) {
        difficulties.add(`Segnale dichiarato: ${sig}`);
      }
    }
  }
  const interruptedOrSkipped = input.missions.filter(
    (m) =>
      (m.status === "annullata" || m.status === "rifiutata") &&
      isInLastWeek(m.updatedAt || m.createdAt)
  );
  if (interruptedOrSkipped.length > 0) {
    difficulties.add(
      `${interruptedOrSkipped.length} attività saltata/interrotta (segnale utile per ridurre carico o durata)`
    );
  }

  const progressList: string[] = [];
  if (weeklyMissionsDone.length > 0) {
    progressList.push(
      `Completate ${weeklyMissionsDone.length} micro-missioni negli ultimi 7 giorni.`
    );
  }
  const completedStepsCount = weeklyGoalChanges.reduce(
    (sum, g) => sum + g.steps.filter((s) => s.done).length,
    0
  );
  if (completedStepsCount > 0) {
    progressList.push(
      `Completati ${completedStepsCount} piccoli passaggi nei tuoi obiettivi.`
    );
  }
  const completedGoalsCount = weeklyGoalChanges.filter(
    (g) => g.status === "completato"
  ).length;
  if (completedGoalsCount > 0) {
    progressList.push(`Raggiunto/i ${completedGoalsCount} obiettivo/i personale/i.`);
  }
  if (weeklyCheckIns.length >= 2) {
    progressList.push(
      `Registrati ${weeklyCheckIns.length} check-in per osservare il tuo ritmo.`
    );
  }

  const suggestions: string[] = [];
  if (!hasSufficientData) {
    suggestions.push(
      "Se ti va, registra almeno un check-in o prova una micro-missione breve per costruire una prima traccia settimanale."
    );
  } else {
    if (difficulties.size > 0) {
      suggestions.push(
        "Vista la fatica o lo stress registrati, potresti privilegiare missioni brevi (3–5 minuti) a basso impegno."
      );
    }
    if (weeklyGoalChanges.some((g) => g.status === "attivo" && g.steps.length === 0)) {
      suggestions.push(
        "Puoi suddividere un obiettivo attivo in 2 piccoli passaggi concreti per renderlo più leggero."
      );
    }
    if (suggestions.length === 0) {
      suggestions.push(
        "Puoi proseguire con il tuo ritmo attuale o mettere in pausa qualsiasi obiettivo quando senti di aver bisogno di recupero."
      );
    }
  }

  return {
    periodStart,
    periodEnd: nowIso,
    hasSufficientData,
    dataSufficiencyNote: hasSufficientData
      ? `Riepilogo basato su ${activitiesCount} eventi registrati negli ultimi 7 giorni.`
      : "Dati settimanali insufficienti per tracciare un andamento significativo: i dettagli sotto mostrano solo ciò che è effettivamente presente finora.",
    activitiesCount,
    completedMissions: weeklyMissionsDone.map((m) => m.title),
    goalsWorkedOn: weeklyGoalChanges.map((g) => g.title),
    declaredDifficulties: Array.from(difficulties).slice(0, 5),
    observableSmallProgress: progressList,
    optionalNextWeekSuggestions: suggestions.slice(0, 3),
  };
}

export function generateLocalPersonalInsights(
  ctx: PersonalInsightsContext,
  nowIso = new Date().toISOString()
): PersonalInsightsResult {
  const safeGoals = ctx.goals.filter((g) => isSafeForLongTermMemory(g.title));
  const completedMissions = ctx.missions.filter((m) => m.status === "completata");
  const totalDataPoints =
    safeGoals.length + completedMissions.length + ctx.checkIns.length;

  if (totalDataPoints < 2) {
    return {
      insights: [],
      insufficientData: true,
      insufficientDataMessage:
        "Dati ancora insufficienti per formulare osservazioni personali affidabili. Aggiungi almeno un obiettivo, un check-in o completa una missione per visualizzare un'analisi basata sui tuoi dati reali.",
      source: "local-reflective",
      fallbackUsed: false,
      generatedAt: nowIso,
    };
  }

  const insights: PersonalInsightItem[] = [];

  if (ctx.checkIns.length > 0 || completedMissions.length > 0) {
    const facts: string[] = [];
    if (ctx.checkIns.length > 0) {
      const avgStress = (
        ctx.checkIns.reduce((sum, c) => sum + c.stress, 0) / ctx.checkIns.length
      ).toFixed(1);
      facts.push(
        `Check-in registrati: ${ctx.checkIns.length} (stress medio dichiarato: ${avgStress}/10).`
      );
    }
    if (completedMissions.length > 0) {
      const topCat = completedMissions[completedMissions.length - 1].category;
      facts.push(
        `Missioni completate: ${completedMissions.length} (ultima area scelta: ${topCat}).`
      );
    }

    insights.push({
      id: createId("ins"),
      title: "Ritmo di attività e carico percepito",
      observedFacts: facts,
      cautiousInterpretation:
        "Questi elementi descrivono i momenti che hai scelto di annotare finora; non rappresentano una valutazione clinica né una correlazione certa.",
      confidenceNote:
        ctx.checkIns.length >= 3
          ? "Base dati moderata sui check-in effettivi."
          : "Base dati iniziale: osservazione esplorativa.",
    });
  }

  if (safeGoals.length > 0) {
    const activeCount = safeGoals.filter((g) => g.status === "attivo").length;
    const pausedCount = safeGoals.filter((g) => g.status === "in_pausa").length;
    const doneCount = safeGoals.filter((g) => g.status === "completato").length;
    const facts = [
      `Obiettivi dichiarati: ${safeGoals.length} (${activeCount} attivi, ${pausedCount} in pausa, ${doneCount} completati).`,
    ];
    if (ctx.preferences.length > 0) {
      facts.push(
        `Preferenze espresse: ${ctx.preferences.slice(0, 3).join(", ")}.`
      );
    }

    insights.push({
      id: createId("ins"),
      title: "Evoluzione degli obiettivi personali",
      observedFacts: facts,
      cautiousInterpretation:
        pausedCount > 0
          ? "Mettere in pausa un obiettivo può essere un modo sano per adattare le priorità alle energie disponibili."
          : "Mantenere obiettivi modificabili e suddivisi in piccoli passaggi può facilitare un avanzamento sostenibile e senza pressioni.",
      confidenceNote: "Basato esclusivamente sugli obiettivi da te dichiarati.",
    });
  }

  return {
    insights,
    insufficientData: false,
    source: "local-reflective",
    fallbackUsed: false,
    generatedAt: nowIso,
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parseAndValidateInsightsJson(
  raw: unknown,
  options?: { nowIso?: string }
): { ok: true; insights: PersonalInsightItem[]; insufficientData: boolean; insufficientDataMessage?: string } | { ok: false; error: string } {
  let parsed: unknown = raw;

  if (typeof raw === "string") {
    const cleaned = stripJsonFence(raw);
    if (!cleaned) {
      return { ok: false, error: "Risposta JSON vuota." };
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, error: "JSON delle osservazioni malformato." };
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Oggetto JSON osservazioni non valido." };
  }

  const obj = parsed as Record<string, unknown>;
  const insufficientData = obj.insufficientData === true;
  const insufficientDataMessage =
    typeof obj.insufficientDataMessage === "string" &&
    isSafeForLongTermMemory(obj.insufficientDataMessage) &&
    !DIAGNOSTIC_OR_DOGMA_PATTERN.test(normalizeText(obj.insufficientDataMessage))
      ? redactSensitiveTokens(obj.insufficientDataMessage).trim().slice(0, 260)
      : undefined;

  if (!Array.isArray(obj.insights)) {
    if (insufficientData && insufficientDataMessage) {
      return {
        ok: true,
        insights: [],
        insufficientData: true,
        insufficientDataMessage,
      };
    }
    return { ok: false, error: "Campo insights mancante." };
  }

  const validated: PersonalInsightItem[] = [];
  for (const item of obj.insights) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;

    const title =
      typeof rec.title === "string"
        ? redactSensitiveTokens(rec.title).trim().slice(0, 100)
        : "";
    const cautiousInterpretation =
      typeof rec.cautiousInterpretation === "string"
        ? redactSensitiveTokens(rec.cautiousInterpretation).trim().slice(0, 320)
        : "";
    const confidenceNote =
      typeof rec.confidenceNote === "string"
        ? redactSensitiveTokens(rec.confidenceNote).trim().slice(0, 140)
        : "Osservazione prudente sui dati disponibili.";

    const observedFacts = Array.isArray(rec.observedFacts)
      ? rec.observedFacts
          .filter((f): f is string => typeof f === "string")
          .map((f) => redactSensitiveTokens(f).trim().slice(0, 180))
          .filter(
            (f) =>
              f.length >= 4 &&
              isSafeForLongTermMemory(f) &&
              !DIAGNOSTIC_OR_DOGMA_PATTERN.test(normalizeText(f))
          )
          .slice(0, 5)
      : [];

    if (!title || !cautiousInterpretation || observedFacts.length === 0) {
      continue;
    }

    if (
      !isSafeForLongTermMemory(title) ||
      !isSafeForLongTermMemory(cautiousInterpretation) ||
      !isSafeForLongTermMemory(confidenceNote) ||
      DIAGNOSTIC_OR_DOGMA_PATTERN.test(normalizeText(title)) ||
      DIAGNOSTIC_OR_DOGMA_PATTERN.test(normalizeText(cautiousInterpretation))
    ) {
      continue;
    }

    validated.push({
      id: createId("gins"),
      title,
      observedFacts,
      cautiousInterpretation,
      confidenceNote,
    });

    if (validated.length >= 4) break;
  }

  if (validated.length === 0 && !insufficientData) {
    return { ok: false, error: "Nessuna osservazione valida conforme allo schema." };
  }

  return {
    ok: true,
    insights: validated,
    insufficientData,
    insufficientDataMessage,
  };
}

export { type WeeklyReflection, type PersonalGrowthProfile, type GrowthAchievement, type ProgressTimelineEntry };
