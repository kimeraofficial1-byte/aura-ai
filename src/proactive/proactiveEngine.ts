import { hasUnmetDependencies } from "../planning/planningEngine";
import type {
  ProactiveAnalysisInput,
  ProactiveAnalysisResult,
  ProactiveSuggestion,
  SuggestionStatus,
} from "./types";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function daysBetween(olderIso: string, newerIso: string): number {
  const a = new Date(`${toDateOnly(olderIso)}T12:00:00Z`).getTime();
  const b = new Date(`${toDateOnly(newerIso)}T12:00:00Z`).getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/**
 * Analizza esclusivamente dati operativi reali e autorizzati per generare
 * suggerimenti proattivi sostenibili, senza inventare scadenze o eventi
 * e senza modificare automaticamente piani, missioni o obiettivi.
 */
export function analyzeProactiveOpportunities(
  input: ProactiveAnalysisInput
): ProactiveAnalysisResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const today = toDateOnly(nowIso);

  // Priorità assoluta al Safety Engine
  if (input.crisisBlocked) {
    return {
      safetyBlocked: true,
      generatedAt: nowIso,
      suggestions: [],
      skippedDuplicates: 0,
    };
  }

  const existingKeys = new Set(
    (input.existingSuggestions ?? [])
      .filter((s) => s.status !== "expired")
      .map((s) => s.dedupeKey)
  );

  const candidates: ProactiveSuggestion[] = [];

  // 1. Analisi Piani e Attività (Planning Engine V1)
  for (const plan of input.plans) {
    if (plan.status !== "active") continue;

    // 1a. Attività in ritardo
    const overdueTasks = plan.tasks.filter(
      (t) =>
        t.status === "overdue" ||
        ((t.status === "pending" || t.status === "in_progress") && t.dueDate < today)
    );
    for (const task of overdueTasks.slice(0, 2)) {
      candidates.push({
        id: makeId("sug"),
        dedupeKey: `overdue:${plan.id}:${task.id}`,
        title: `Riprendi o riprogramma: ${task.title}`,
        description: `L'attività "${task.title}" del piano "${plan.title}" aveva scadenza ${task.dueDate}.`,
        rationale:
          "Fatto osservato: la data di scadenza dichiarata è trascorsa e l'attività risulta ancora aperta.",
        dataSource: `Planning Engine · Piano "${plan.title}"`,
        epistemicTag: "fatto_osservato",
        priority: "alta",
        confidence: 0.95,
        proposedAction: `Apri il piano "${plan.title}" e scegli se completare "${task.title}" o ricalcolare la scadenza.`,
        estimatedMinutes: task.estimatedMinutes,
        generatedAt: nowIso,
        status: "proposed",
      });
    }

    // 1b. Scadenze imminenti (entro 2 giorni)
    const upcomingTasks = plan.tasks.filter((t) => {
      if (t.status !== "pending" && t.status !== "in_progress") return false;
      const diff = daysBetween(today, t.dueDate);
      return diff >= 0 && diff <= 2;
    });
    for (const task of upcomingTasks.slice(0, 2)) {
      candidates.push({
        id: makeId("sug"),
        dedupeKey: `upcoming:${plan.id}:${task.id}`,
        title: `Scadenza vicina: ${task.title}`,
        description: `Prevista entro il ${task.dueDate} (~${task.estimatedMinutes} min) nel piano "${plan.title}".`,
        rationale:
          "Fatto osservato: questa attività scade nei prossimi 2 giorni secondo il piano dichiarato.",
        dataSource: `Planning Engine · Piano "${plan.title}"`,
        epistemicTag: "fatto_osservato",
        priority: "media",
        confidence: 0.9,
        proposedAction: `Dedica ~${task.estimatedMinutes} minuti al prossimo passo di "${task.title}".`,
        estimatedMinutes: task.estimatedMinutes,
        generatedAt: nowIso,
        status: "proposed",
      });
    }

    // 1c. Conflitti di carico giornaliero (somma minuti sullo stesso giorno > dailyMinutesLimit)
    const minutesByDate = new Map<string, number>();
    for (const task of plan.tasks) {
      if (task.status === "pending" || task.status === "in_progress" || task.status === "overdue") {
        minutesByDate.set(
          task.dueDate,
          (minutesByDate.get(task.dueDate) ?? 0) + task.estimatedMinutes
        );
      }
    }
    for (const [date, totalMinutes] of minutesByDate.entries()) {
      if (totalMinutes > plan.dailyMinutesLimit) {
        candidates.push({
          id: makeId("sug"),
          dedupeKey: `conflict:${plan.id}:${date}`,
          title: `Possibile sovraccarico il ${date}`,
          description: `Le attività previste per il ${date} sommano ~${totalMinutes} min contro il limite dichiarato di ${plan.dailyMinutesLimit} min/giorno.`,
          rationale:
            "Interpretazione prudente: il carico stimato supera il tempo giornaliero che hai indicato.",
          dataSource: `Planning Engine · Vincoli piano "${plan.title}"`,
          epistemicTag: "interpretazione_prudente",
          priority: "alta",
          confidence: 0.85,
          proposedAction: `Valuta di usare "Aggiorna / Ricalcola piano" su "${plan.title}" per distribuire meglio le attività.`,
          estimatedMinutes: 5,
          generatedAt: nowIso,
          status: "proposed",
        });
      }
    }

    // 1d. Dipendenze bloccanti
    const blockedTask = plan.tasks.find(
      (t) =>
        (t.status === "pending" || t.status === "in_progress") &&
        hasUnmetDependencies(plan, t.id)
    );
    if (blockedTask) {
      const prereq = plan.tasks.find((t) => blockedTask.dependencies.includes(t.id));
      if (prereq) {
        candidates.push({
          id: makeId("sug"),
          dedupeKey: `dependency:${plan.id}:${prereq.id}`,
          title: `Sblocca il passo successivo completando: ${prereq.title}`,
          description: `L'attività "${blockedTask.title}" dipende dal completamento di "${prereq.title}".`,
          rationale:
            "Fatto osservato: completare il prerequisito sblocca la sequenza del piano.",
          dataSource: `Planning Engine · Dipendenze "${plan.title}"`,
          epistemicTag: "fatto_osservato",
          priority: "media",
          confidence: 0.9,
          proposedAction: `Inizia dal prerequisito "${prereq.title}" (~${prereq.estimatedMinutes} min).`,
          estimatedMinutes: prereq.estimatedMinutes,
          generatedAt: nowIso,
          status: "proposed",
        });
      }
    }
  }

  // 2. Analisi Obiettivi di Crescita (Personal Growth Engine V1)
  for (const goal of input.growthGoals) {
    if (goal.status !== "attivo") continue;
    const daysSinceUpdate = daysBetween(goal.updatedAt || goal.createdAt, nowIso);
    const completedSteps = goal.steps.filter((s) => s.done).length;

    if (daysSinceUpdate >= 7 || (goal.steps.length > 0 && completedSteps === 0)) {
      candidates.push({
        id: makeId("sug"),
        dedupeKey: `goal_stalled:${goal.id}`,
        title: `Obiettivo in pausa di fatto: ${goal.title}`,
        description:
          daysSinceUpdate >= 7
            ? `L'obiettivo "${goal.title}" non registra aggiornamenti da ${daysSinceUpdate} giorni.`
            : `L'obiettivo "${goal.title}" ha ${goal.steps.length} passi ma nessuno completato finora.`,
        rationale:
          "Interpretazione prudente: potrebbe essere utile ridurre il primo passo o verificare se l'obiettivo è ancora prioritario per te.",
        dataSource: `Personal Growth Engine · Obiettivo "${goal.title}"`,
        epistemicTag: "interpretazione_prudente",
        priority: "media",
        confidence: 0.78,
        proposedAction: `Scegli un micro-passo da 10 minuti per "${goal.title}" oppure metti in pausa l'obiettivo.`,
        estimatedMinutes: 10,
        generatedAt: nowIso,
        status: "proposed",
      });
    }
  }

  // 3. Analisi Missioni Adattive (Adaptive Mission Engine V1)
  const readyMission = input.missions.find(
    (m) => m.status === "proposta" || m.status === "accettata"
  );
  if (readyMission) {
    candidates.push({
      id: makeId("sug"),
      dedupeKey: `mission_ready:${readyMission.id}`,
      title: `Micro-azione rapida disponibile: ${readyMission.title}`,
      description: `Hai una missione da ${readyMission.estimatedMinutes} min pronta per oggi.`,
      rationale:
        "Ipotesi da verificare: se hai qualche minuto libero, questa micro-azione può darti slancio senza sovraccaricarti.",
      dataSource: `Adaptive Mission Engine · "${readyMission.title}"`,
      epistemicTag: "ipotesi_da_verificare",
      priority: "bassa",
      confidence: 0.7,
      proposedAction: `Apri la scheda Missioni e valuta se svolgere "${readyMission.title}".`,
      estimatedMinutes: readyMission.estimatedMinutes,
      generatedAt: nowIso,
      status: "proposed",
    });
  }

  // Deduplicazione rigorosa (sia contro suggerimenti già esistenti sia interni)
  const seenNow = new Set<string>();
  const uniqueSuggestions: ProactiveSuggestion[] = [];
  let skippedDuplicates = 0;

  for (const s of candidates) {
    if (existingKeys.has(s.dedupeKey) || seenNow.has(s.dedupeKey)) {
      skippedDuplicates += 1;
      continue;
    }
    seenNow.add(s.dedupeKey);
    uniqueSuggestions.push(s);
  }

  return {
    safetyBlocked: false,
    generatedAt: nowIso,
    suggestions: uniqueSuggestions,
    skippedDuplicates,
  };
}

export function transitionSuggestionStatus(
  suggestions: ProactiveSuggestion[],
  id: string,
  status: SuggestionStatus
): ProactiveSuggestion[] {
  return suggestions.map((s) => (s.id === id ? { ...s, status } : s));
}

export function snoozeSuggestion(
  suggestions: ProactiveSuggestion[],
  id: string,
  hours: number = 4,
  nowIso: string = new Date().toISOString()
): ProactiveSuggestion[] {
  const until = new Date(new Date(nowIso).getTime() + hours * 60 * 60 * 1000).toISOString();
  return suggestions.map((s) => (s.id === id ? { ...s, snoozedUntil: until } : s));
}
