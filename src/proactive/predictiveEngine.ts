import { hasUnmetDependencies } from "../planning/planningEngine";
import type {
  PredictiveAlert,
  PredictiveAnalysisResult,
  ProactiveAnalysisInput,
} from "./types";

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(olderIso: string, newerIso: string): number {
  const a = new Date(`${toDateOnly(olderIso)}T12:00:00Z`).getTime();
  const b = new Date(`${toDateOnly(newerIso)}T12:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Motore Predittivo Deterministico V1.1.
 * Analizza esclusivamente dati operativi disponibili, distinguendo sempre
 * FATTO OSSERVATO, INTERPRETAZIONE PRUDENTE e IPOTESI DA VERIFICARE.
 */
export function runPredictiveAnalysis(
  input: ProactiveAnalysisInput
): PredictiveAnalysisResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const today = toDateOnly(nowIso);

  if (input.crisisBlocked) {
    return {
      safetyBlocked: true,
      insufficientData: false,
      statusMessage: "Analisi predittiva sospesa: priorità al Safety Engine.",
      generatedAt: nowIso,
      alerts: [],
    };
  }

  const activePlans = input.plans.filter((p) => p.status === "active");
  const activeGoals = input.growthGoals.filter((g) => g.status === "attivo");

  if (activePlans.length === 0 && activeGoals.length === 0) {
    return {
      safetyBlocked: false,
      insufficientData: true,
      statusMessage: "Dati insufficienti per generare previsioni affidabili.",
      generatedAt: nowIso,
      alerts: [],
    };
  }

  const alerts: PredictiveAlert[] = [];

  for (const plan of activePlans) {
    const openTasks = plan.tasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress" || t.status === "overdue"
    );

    // 1. Sovraccarico futuro e conflitto tempo disponibile vs carico
    const minutesByDate = new Map<string, number>();
    for (const t of openTasks) {
      minutesByDate.set(t.dueDate, (minutesByDate.get(t.dueDate) ?? 0) + t.estimatedMinutes);
    }
    for (const [date, minutes] of minutesByDate.entries()) {
      if (minutes > plan.dailyMinutesLimit) {
        alerts.push({
          id: `pred-overload-${plan.id}-${date}`,
          category: "overload",
          title: `Rischio sovraccarico il ${date}`,
          description: `Carico stimato di ${minutes} min contro il limite dichiarato di ${plan.dailyMinutesLimit} min/giorno nel piano "${plan.title}".`,
          epistemicTag: "interpretazione_prudente",
          riskLevel: "alta",
          confidence: 0.85,
          dataSource: `Planning Engine · Piano "${plan.title}"`,
        });
      }
    }

    // 2. Scadenze imminenti (entro 3 giorni)
    const imminent = openTasks.filter((t) => {
      const diff = daysBetween(today, t.dueDate);
      return diff >= 0 && diff <= 3;
    });
    if (imminent.length > 0) {
      alerts.push({
        id: `pred-deadline-${plan.id}`,
        category: "deadline",
        title: `${imminent.length} scadenze imminenti in "${plan.title}"`,
        description: `Attività con scadenza entro 3 giorni: ${imminent
          .slice(0, 2)
          .map((t) => t.title)
          .join(", ")}.`,
        epistemicTag: "fatto_osservato",
        riskLevel: imminent.length >= 2 ? "alta" : "media",
        confidence: 0.95,
        dataSource: `Planning Engine · Scadenze "${plan.title}"`,
      });
    }

    // 3. Dipendenze che possono bloccare attività successive
    const blockedCount = openTasks.filter((t) => hasUnmetDependencies(plan, t.id)).length;
    if (blockedCount > 0) {
      alerts.push({
        id: `pred-dep-${plan.id}`,
        category: "dependency",
        title: `${blockedCount} attività in attesa di prerequisiti`,
        description: `Nel piano "${plan.title}" alcune attività dipendono da passi ancora aperti; un ritardo sul prerequisito può spostare la sequenza.`,
        epistemicTag: "fatto_osservato",
        riskLevel: "media",
        confidence: 0.9,
        dataSource: `Planning Engine · Dipendenze "${plan.title}"`,
      });
    }

    // 4. Stima rischio di ritardo basata su attività già overdue
    const overdueCount = openTasks.filter(
      (t) => t.status === "overdue" || t.dueDate < today
    ).length;
    if (overdueCount > 0) {
      alerts.push({
        id: `pred-delay-${plan.id}`,
        category: "delay_risk",
        title: `Possibile slittamento della scadenza finale (${plan.targetDate})`,
        description: `Sono presenti ${overdueCount} attività già oltre la scadenza prevista; senza ricalcolo il completamento potrebbe slittare.`,
        epistemicTag: "ipotesi_da_verificare",
        riskLevel: "alta",
        confidence: 0.78,
        dataSource: `Planning Engine · Avanzamento "${plan.title}"`,
      });
    }
  }

  // 5. Obiettivi a rischio inattività
  for (const goal of activeGoals) {
    const idleDays = daysBetween(goal.updatedAt || goal.createdAt, nowIso);
    if (idleDays >= 5) {
      alerts.push({
        id: `pred-goal-${goal.id}`,
        category: "stalled_goal",
        title: `Obiettivo a rischio inattività: ${goal.title}`,
        description: `Nessun aggiornamento registrato negli ultimi ${idleDays} giorni.`,
        epistemicTag: "interpretazione_prudente",
        riskLevel: "media",
        confidence: 0.8,
        dataSource: `Personal Growth Engine · "${goal.title}"`,
      });
    }
  }

  return {
    safetyBlocked: false,
    insufficientData: alerts.length === 0 && activePlans.length === 0,
    statusMessage:
      alerts.length > 0
        ? `Individuate ${alerts.length} previsioni basate sui dati operativi correnti.`
        : "Nessun rischio rilevante individuato nei dati attuali.",
    generatedAt: nowIso,
    alerts,
  };
}
