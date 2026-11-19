import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { ProactiveOpportunityV2 } from "../proactive/types";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import type {
  ContinuitySnapshot,
  GoalEvolutionEntry,
  ProgressEntry,
  RecurringDifficultyEntry,
} from "./continuityTypes";
import { generateProactiveOpportunitiesV2 } from "./unifiedCognitiveOrchestrator";

export interface ContinuityAnalysisInput {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  stressLevel?: number;
  nowIso?: string;
  timeline?: CognitiveTimeline;
  learningEngine?: ControlledLearningEngine;
  previousOpportunities?: ProactiveOpportunityV2[];
}

/**
 * Long-Term Context & Continuity Engine V1.
 * Ricostruisce evoluzione degli obiettivi, progressi documentati, difficoltà ricorrenti
 * e contesto operativo tra sessioni senza inventare ricordi né formulare diagnosi.
 */
export function buildContinuitySnapshot(
  input: ContinuityAnalysisInput
): ContinuitySnapshot {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const timelineEvents = input.timeline?.getEvents() ?? [];

  if (input.crisisBlocked) {
    return {
      generatedAt: nowIso,
      safetyBlocked: true,
      insufficientData: false,
      statusMessage:
        "Continuità cognitiva sospesa dal Safety Engine: priorità assoluta al supporto immediato.",
      goalEvolution: [],
      recentProgress: [],
      recurringDifficulties: [],
      recoveredOperationalContext: [],
      suggestedOpportunities: [],
      contradictionsDetected: [],
      needsClarification: false,
      timelineEventsCount: timelineEvents.length,
      averageReliability: 1,
    };
  }

  const hasOperationalData =
    input.plans.length > 0 ||
    input.missions.length > 0 ||
    input.growthGoals.length > 0 ||
    timelineEvents.length > 0;

  if (!hasOperationalData) {
    return {
      generatedAt: nowIso,
      safetyBlocked: false,
      insufficientData: true,
      statusMessage:
        "Nessun dato operativo o cronologia disponibile: AURA non inventa ricordi. Aggiungi un piano, una missione o un obiettivo per avviare la continuità cognitiva.",
      goalEvolution: [],
      recentProgress: [],
      recurringDifficulties: [],
      recoveredOperationalContext: [],
      suggestedOpportunities: [],
      contradictionsDetected: [],
      needsClarification: true,
      clarificationQuestion:
        "Quale obiettivo o attività desideri monitorare nel tempo?",
      timelineEventsCount: 0,
      averageReliability: 0,
    };
  }

  const contradictionsDetected: string[] = [];
  const goalEvolution: GoalEvolutionEntry[] = [];
  const recentProgress: ProgressEntry[] = [];
  const recurringDifficulties: RecurringDifficultyEntry[] = [];
  const recoveredOperationalContext: string[] = [];

  // 1. Evoluzione degli obiettivi di crescita (FATTO OSSERVATO)
  for (const goal of input.growthGoals) {
    const totalSteps = goal.steps.length;
    const completedSteps = goal.steps.filter((s) => s.done).length;
    const progressPercent =
      totalSteps > 0
        ? Math.round((completedSteps / totalSteps) * 100)
        : goal.status === "completato"
        ? 100
        : 0;

    // Rilevazione contraddizioni (es. stato "completato" ma tutti i passi non spuntati)
    if (goal.status === "completato" && totalSteps > 0 && completedSteps < totalSteps) {
      contradictionsDetected.push(
        `L'obiettivo "${goal.title}" risulta completato ma ha ancora ${
          totalSteps - completedSteps
        } passi non spuntati.`
      );
    }

    const trend: GoalEvolutionEntry["trend"] =
      goal.status === "completato"
        ? "completato"
        : goal.status === "in_pausa"
        ? "sospeso_o_rimandato"
        : completedSteps > 0
        ? "in_crescita"
        : "stabile";

    goalEvolution.push({
      goalId: goal.id,
      title: goal.title,
      currentStatus: goal.status,
      completedSteps,
      totalSteps,
      progressPercent,
      trend,
      epistemicTag: "fatto_osservato",
      reliability: 0.95,
      dataSource: `DataRepository · GrowthGoal (${goal.id})`,
    });

    if (goal.status === "completato" || completedSteps > 0) {
      recentProgress.push({
        id: `prog-goal-${goal.id}`,
        title: goal.title,
        detail:
          goal.status === "completato"
            ? "Obiettivo di crescita completato."
            : `${completedSteps}/${totalSteps} passi completati (${progressPercent}%).`,
        date: goal.updatedAt ?? nowIso,
        epistemicTag: "fatto_osservato",
        reliability: 0.95,
        dataSource: "DataRepository · Personal Growth",
      });
    }

    if (goal.status === "in_pausa") {
      recoveredOperationalContext.push(
        `Obiettivo in sospeso recuperabile: "${goal.title}".`
      );
    }
  }

  // 2. Progressi e difficoltà dai Piani operativi
  let overdueCount = 0;
  let pausedPlansCount = 0;
  for (const plan of input.plans) {
    if (plan.status === "paused") {
      pausedPlansCount += 1;
      recoveredOperationalContext.push(
        `Piano in pausa riprendibile: "${plan.title}".`
      );
    } else {
      recoveredOperationalContext.push(
        `Piano attivo: "${plan.title}" (${plan.tasks.length} attività).`
      );
    }

    const completedTasks = plan.tasks.filter((t) => t.status === "completed");
    if (completedTasks.length > 0) {
      recentProgress.push({
        id: `prog-plan-${plan.id}`,
        title: plan.title,
        detail: `${completedTasks.length}/${plan.tasks.length} attività completate nel piano.`,
        date: plan.updatedAt ?? nowIso,
        epistemicTag: "fatto_osservato",
        reliability: 0.95,
        dataSource: "DataRepository · Planning Engine",
      });
    }

    overdueCount += plan.tasks.filter((t) => t.status === "overdue").length;
  }

  // 3. Progressi dalle Missioni completate
  const completedMissions = input.missions.filter((m) => m.status === "completata");
  if (completedMissions.length > 0) {
    recentProgress.push({
      id: `prog-missions-${completedMissions.length}`,
      title: "Missioni adattive completate",
      detail: `${completedMissions.length} micro-missioni portate a termine.`,
      date: nowIso,
      epistemicTag: "fatto_osservato",
      reliability: 0.92,
      dataSource: "DataRepository · Adaptive Missions",
    });
  }

  // 4. Difficoltà ricorrenti (fatti osservati + interpretazioni prudenti)
  if (overdueCount >= 2) {
    recurringDifficulties.push({
      id: "diff-overdue-tasks",
      label: "Attività in ritardo ricorrenti",
      occurrences: overdueCount,
      description: `Sono presenti ${overdueCount} attività in ritardo nei piani correnti: potrebbe essere utile rivedere il carico giornaliero.`,
      epistemicTag: "fatto_osservato",
      reliability: 0.9,
      dataSource: "DataRepository · Planning Engine",
    });
  }

  if (pausedPlansCount >= 1) {
    recurringDifficulties.push({
      id: "diff-paused-plans",
      label: "Piani lasciati in sospeso",
      occurrences: pausedPlansCount,
      description: `${pausedPlansCount} piano/i risultano in pausa: puoi decidere se riprenderli o archiviarli.`,
      epistemicTag: "fatto_osservato",
      reliability: 0.9,
      dataSource: "DataRepository · Planning Engine",
    });
  }

  const rejectedMissions = input.learningEngine?.getRejectedCount("missions") ?? 0;
  if (rejectedMissions >= 2) {
    recurringDifficulties.push({
      id: "diff-rejected-missions",
      label: "Rifiuti ripetuti su missioni proposte",
      occurrences: rejectedMissions,
      description:
        "Diverse proposte recenti sono state rifiutate o sospese: ipotesi di carico o formato non ottimale.",
      epistemicTag: "ipotesi_da_verificare",
      reliability: 0.68,
      dataSource: "Controlled Learning V2",
    });
  }

  // 5. Confronto con la Cognitive Timeline (cambiamenti tra sessioni)
  if (timelineEvents.length > 0) {
    const latest = timelineEvents[0];
    recoveredOperationalContext.push(
      `Ultimo evento registrato in cronologia (${latest.category}): "${latest.title}".`
    );
  }

  // 6. Opportunità suggerite tramite Proactive Intelligence V2 (evita già rifiutati/sospesi)
  const proactiveV2 = generateProactiveOpportunitiesV2({
    plans: input.plans,
    missions: input.missions,
    growthGoals: input.growthGoals,
    availableMinutes: input.availableMinutes,
    energyLevel: input.energyLevel,
    stressLevel: input.stressLevel,
    consentEnabled: input.consentEnabled,
    crisisBlocked: false,
    nowIso,
    previousOpportunities: input.previousOpportunities,
    learningEngine: input.learningEngine,
  });

  const reliabilityValues = [
    ...goalEvolution.map((g) => g.reliability),
    ...recentProgress.map((p) => p.reliability),
    ...recurringDifficulties.map((d) => d.reliability),
  ];
  const averageReliability =
    reliabilityValues.length > 0
      ? Number(
          (
            reliabilityValues.reduce((acc, v) => acc + v, 0) /
            reliabilityValues.length
          ).toFixed(2)
        )
      : 0.85;

  const needsClarification = contradictionsDetected.length > 0;
  const clarificationQuestion = needsClarification
    ? `Ho rilevato una possibile incoerenza: ${contradictionsDetected[0]} Vuoi confermare lo stato reale?`
    : undefined;

  return {
    generatedAt: nowIso,
    safetyBlocked: false,
    insufficientData: false,
    statusMessage: `Continuità ricostruita su ${input.plans.length} piani, ${input.growthGoals.length} obiettivi e ${timelineEvents.length} eventi in cronologia (Memoria AI ${
      input.consentEnabled ? "ON" : "OFF"
    }).`,
    goalEvolution,
    recentProgress,
    recurringDifficulties,
    recoveredOperationalContext,
    suggestedOpportunities: proactiveV2.opportunities,
    contradictionsDetected,
    needsClarification,
    clarificationQuestion,
    timelineEventsCount: timelineEvents.length,
    averageReliability,
  };
}
