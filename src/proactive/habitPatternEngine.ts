import type { HabitPattern, ProactiveAnalysisInput } from "./types";

const MIN_OBSERVATIONS = 3;

/**
 * Habit Pattern Analysis Engine V1.1.
 * Riconosce schemi ricorrenti esclusivamente nei dati operativi osservati.
 * Non inventa abitudini, non deduce caratteristiche psicologiche.
 * Se le osservazioni sono insufficienti, dichiara esplicitamente "Dati insufficienti".
 */
export function analyzeHabitPatterns(input: ProactiveAnalysisInput): HabitPattern[] {
  if (input.crisisBlocked) return [];

  const patterns: HabitPattern[] = [];
  const periodAnalyzed = "Dati operativi disponibili nella sessione/storage";

  // 1. Completamento e rifiuto missioni
  const totalMissions = input.missions.length;
  if (totalMissions >= MIN_OBSERVATIONS) {
    const completed = input.missions.filter((m) => m.status === "completata").length;
    const rejected = input.missions.filter(
      (m) => m.status === "rifiutata" || m.status === "annullata"
    ).length;
    const rate = Math.round((completed / totalMissions) * 100);
    patterns.push({
      id: "habit-missions-completion",
      label: "Completamento missioni",
      description: `Hai completato ${completed} missioni su ${totalMissions} (${rate}%)${
        rejected > 0 ? `, con ${rejected} rifiutate o annullate` : ""
      }.`,
      dataSource: "Adaptive Mission Engine",
      observationCount: totalMissions,
      periodAnalyzed,
      confidence: Math.min(0.9, 0.55 + totalMissions * 0.05),
      insufficientData: false,
    });
  }

  // 2. Attività frequentemente posticipate / sospese / in ritardo
  const allTasks = input.plans.flatMap((p) => p.tasks);
  if (allTasks.length >= MIN_OBSERVATIONS) {
    const delayedOrPaused = allTasks.filter(
      (t) => t.status === "paused" || t.status === "overdue"
    ).length;
    const completedTasks = allTasks.filter((t) => t.status === "completed");

    if (delayedOrPaused >= 2) {
      patterns.push({
        id: "habit-tasks-postponed",
        label: "Attività spesso rimandate o in ritardo",
        description: `${delayedOrPaused} attività su ${allTasks.length} risultano sospese o oltre la scadenza; potresti valutare passi più brevi.`,
        dataSource: "Planning Engine",
        observationCount: allTasks.length,
        periodAnalyzed,
        confidence: 0.75,
        insufficientData: false,
      });
    }

    // 3. Fasce temporali di completamento (solo se esistono >= 3 timestamp reali)
    const hours = completedTasks
      .map((t) => (t.completedAt ? new Date(t.completedAt).getUTCHours() : null))
      .filter((h): h is number => h !== null && !Number.isNaN(h));

    if (hours.length >= MIN_OBSERVATIONS) {
      const buckets = { mattina: 0, pomeriggio: 0, sera: 0 };
      for (const h of hours) {
        if (h >= 6 && h < 13) buckets.mattina += 1;
        else if (h >= 13 && h < 19) buckets.pomeriggio += 1;
        else buckets.sera += 1;
      }
      const topSlot = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0];
      patterns.push({
        id: "habit-time-slot",
        label: "Fascia oraria più frequente",
        description: `La maggior parte delle attività completate (${topSlot[1]}/${hours.length}) ricade nella fascia: ${topSlot[0]}.`,
        dataSource: "Planning Engine (timestamp completamenti)",
        observationCount: hours.length,
        periodAnalyzed,
        confidence: Math.min(0.85, 0.55 + hours.length * 0.05),
        insufficientData: false,
      });
    }
  }

  // 4. Obiettivi con progressi regolari o irregolari
  if (input.growthGoals.length >= 2) {
    const withProgress = input.growthGoals.filter((g) =>
      g.steps.some((s) => s.done)
    ).length;
    patterns.push({
      id: "habit-goals-progress",
      label: "Andamento obiettivi personali",
      description: `${withProgress} obiettivi su ${input.growthGoals.length} mostrano almeno un passo completato.`,
      dataSource: "Personal Growth Engine",
      observationCount: input.growthGoals.length,
      periodAnalyzed,
      confidence: 0.75,
      insufficientData: false,
    });
  }

  if (patterns.length === 0) {
    return [
      {
        id: "habit-insufficient",
        label: "Dati insufficienti",
        description:
          "Dati insufficienti: servono più attività, missioni o obiettivi registrati per individuare schemi ricorrenti affidabili.",
        dataSource: "Dati operativi locali",
        observationCount: totalMissions + allTasks.length + input.growthGoals.length,
        periodAnalyzed,
        confidence: 0,
        insufficientData: true,
      },
    ];
  }

  return patterns;
}
