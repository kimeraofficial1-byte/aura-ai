import { runStructuredReasoning } from "../reasoning/reasoningEngine";
import type {
  HorizonBucket,
  PersonalPlan,
  PlanCreateInput,
  PlanExportBundle,
  PlanHorizon,
  PlanProgressMetrics,
  PlanRecalculateInput,
  PlanRevision,
  PlanTask,
  TaskPriority,
  TaskStatus,
} from "./types";

export const PLANS_STORAGE_KEY = "aura_planning_v1_plans";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(baseIso: string, days: number): string {
  const d = new Date(`${toDateOnly(baseIso)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function defaultDaysForHorizon(horizon: PlanHorizon): number {
  switch (horizon) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
  }
}

function bucketForDayOffset(offset: number, horizon: PlanHorizon): HorizonBucket {
  if (horizon === "daily" || offset <= 0) return "oggi";
  if (offset <= 7) return "settimana";
  return "mese";
}

function computeProgressPercent(tasks: PlanTask[]): number {
  const countable = tasks.filter((t) => t.status !== "cancelled");
  if (countable.length === 0) return 0;
  const completed = countable.filter((t) => t.status === "completed").length;
  return Math.round((completed / countable.length) * 100);
}

function buildAlternativesForTask(title: string, dailyLimit: number): string[] {
  const compactMinutes = Math.max(10, Math.min(20, Math.floor(dailyLimit / 2)));
  return [
    `Versione ridotta (${compactMinutes} min): completa solo il primo passo essenziale di "${title}".`,
    `Riprogramma "${title}" nella prossima fascia libera riducendo il carico giornaliero.`,
  ];
}

function inferResourcesFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const resources: string[] = ["Tempo dedicato senza interruzioni"];
  if (/studi|impar|corso|legg|esam/.test(lower)) {
    resources.push("Materiale di studio o appunti");
  }
  if (/lavor|cv|colloqui|progett/.test(lower)) {
    resources.push("Documento o lista di controllo personale");
  }
  if (/allen|cors|cammin|palestr|salut/.test(lower)) {
    resources.push("Spazio adeguato e abbigliamento comodo");
  }
  if (/budget|risparm|spes/.test(lower)) {
    resources.push("Riepilogo delle spese dichiarate");
  }
  return resources;
}

/**
 * Crea un piano strutturato a partire da un obiettivo dichiarato dall'utente.
 * Collabora con il Reasoning Engine V1 per valutare complessità, incertezze e decomposizione.
 * Evita duplicazioni rispetto alle missioni esistenti e rispetta il consenso memoria e il Safety Engine.
 */
export function createPlan(
  input: PlanCreateInput,
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  const cleanGoal = input.declaredGoal.trim();
  if (!cleanGoal) {
    throw new Error("È necessario dichiarare un obiettivo prima di creare un piano.");
  }

  if (input.crisisBlocked) {
    throw new Error(
      "Elaborazione del piano sospesa: il Safety Engine ha la priorità in questo momento."
    );
  }

  const horizon: PlanHorizon = input.horizon || "weekly";
  const dailyMinutesLimit = Math.max(10, Math.min(240, Math.round(input.dailyMinutesLimit ?? 30)));
  const defaultSpan = defaultDaysForHorizon(horizon);
  const targetDate = input.targetDate?.trim() || addDays(nowIso, defaultSpan);
  const constraints = (input.constraints ?? [])
    .map((c) => c.trim())
    .filter(Boolean);

  if (input.emotionalTone && /stanc|stress|ansi|sovraccaric/i.test(input.emotionalTone)) {
    constraints.push("Ritmo sostenibile: evita sovraccarichi (adattato al carico emotivo attuale, senza diagnosi).");
  }

  // Utilizzo del Reasoning Engine V1 per analizzare complessità, sotto-problemi e incertezze
  const reasoning = runStructuredReasoning({
    message: cleanGoal,
    consentEnabled: input.consentEnabled,
    crisisBlocked: false,
  });

  const existingMissionsSet = new Set(
    (input.existingMissionTitles ?? []).map(normalizeTitle)
  );

  const rawSteps: Array<{
    title: string;
    description: string;
    priority: TaskPriority;
    dayOffset: number;
    estimatedMinutes: number;
  }> = [];

  if (reasoning.subProblems.length >= 2) {
    reasoning.subProblems.slice(0, 5).forEach((sub, idx) => {
      const ratio = reasoning.subProblems.length > 1 ? idx / (reasoning.subProblems.length - 1) : 0;
      const dayOffset = horizon === "daily" ? 0 : Math.round(ratio * Math.max(1, defaultSpan - 1));
      const priority: TaskPriority = idx === 0 ? "alta" : idx === 1 ? "media" : "bassa";
      rawSteps.push({
        title: sub.slice(0, 80),
        description: `Passo ${idx + 1} derivato dall'analisi strutturata: ${sub}`,
        priority,
        dayOffset,
        estimatedMinutes: Math.min(dailyMinutesLimit, Math.max(15, Math.round(dailyMinutesLimit * 0.7))),
      });
    });
  } else {
    // Piano semplice ma strutturato in 3 passi chiari
    rawSteps.push(
      {
        title: `Definire il risultato concreto per: ${cleanGoal.slice(0, 60)}`,
        description: "Chiarire il criterio di completamento e preparare l'occorrente essenziale.",
        priority: "alta",
        dayOffset: 0,
        estimatedMinutes: Math.min(dailyMinutesLimit, 15),
      },
      {
        title: `Eseguire la prima azione operativa`,
        description: `Avviare concretamente l'obiettivo "${cleanGoal.slice(0, 60)}" nel tempo disponibile.`,
        priority: "alta",
        dayOffset: horizon === "daily" ? 0 : Math.min(2, defaultSpan),
        estimatedMinutes: Math.min(dailyMinutesLimit, Math.max(15, Math.round(dailyMinutesLimit * 0.8))),
      },
      {
        title: "Verifica intermedia e aggiustamento",
        description: "Controllare i progressi reali e adattare i passi successivi se necessario.",
        priority: "media",
        dayOffset: horizon === "daily" ? 0 : defaultSpan,
        estimatedMinutes: Math.min(dailyMinutesLimit, 15),
      }
    );
  }

  // Deduplicazione rispetto alle missioni adattive già attive
  const filteredSteps = rawSteps.filter(
    (step) => !existingMissionsSet.has(normalizeTitle(step.title))
  );
  const finalSteps = filteredSteps.length > 0 ? filteredSteps : rawSteps;

  const resources = inferResourcesFromText(cleanGoal);
  const tasks: PlanTask[] = [];

  finalSteps.forEach((step, idx) => {
    const id = makeId(`task${idx + 1}`);
    const previousTaskId = idx > 0 ? tasks[idx - 1].id : null;
    const dueDate = addDays(nowIso, step.dayOffset);
    tasks.push({
      id,
      title: step.title,
      description: step.description,
      priority: step.priority,
      status: "pending",
      dueDate,
      estimatedMinutes: step.estimatedMinutes,
      uncertaintyNote:
        "Stima indicativa basata sui vincoli dichiarati; la durata reale può variare.",
      dependencies: previousTaskId ? [previousTaskId] : [],
      resources,
      subtasks: [
        {
          id: makeId("sub"),
          title: `Preparazione iniziale (${Math.max(5, Math.round(step.estimatedMinutes * 0.3))} min)`,
          completed: false,
        },
        {
          id: makeId("sub"),
          title: `Completamento attività (${Math.max(5, Math.round(step.estimatedMinutes * 0.7))} min)`,
          completed: false,
        },
      ],
      alternatives: buildAlternativesForTask(step.title, dailyMinutesLimit),
      horizonBucket: bucketForDayOffset(step.dayOffset, horizon),
    });
  });

  const uncertainties: string[] = [
    ...reasoning.uncertainties,
    `Le stime temporali (${dailyMinutesLimit} min/giorno) sono indicative e dipendono dagli imprevisti quotidiani.`,
  ];

  if (reasoning.missingInformation.length > 0) {
    uncertainties.push(
      `Informazioni non ancora specificate: ${reasoning.missingInformation.slice(0, 2).join("; ")}.`
    );
  }

  const desiredOutcome =
    input.desiredOutcome?.trim() ||
    `Raggiungere in modo sostenibile l'obiettivo dichiarato: "${cleanGoal}".`;

  const initialRevision: PlanRevision = {
    id: makeId("rev"),
    timestamp: nowIso,
    reason: "Creazione piano iniziale",
    explanation: `Piano ${horizon === "daily" ? "giornaliero" : horizon === "weekly" ? "settimanale" : "mensile"} creato con ${tasks.length} attività ordinate per priorità e dipendenze (limite ${dailyMinutesLimit} min/giorno).`,
    changesSummary: [
      `Creato piano con ${tasks.length} attività.`,
      `Scadenza target impostata al ${targetDate}.`,
    ],
  };

  const growthLinkNote =
    input.growthGoalTitles && input.growthGoalTitles.length > 0
      ? ` Allineato agli obiettivi di crescita dichiarati (${input.growthGoalTitles.slice(0, 2).join(", ")}).`
      : "";

  return {
    id: makeId("plan"),
    title: cleanGoal.length > 68 ? `${cleanGoal.slice(0, 65)}...` : cleanGoal,
    declaredGoal: cleanGoal,
    desiredOutcome,
    horizon,
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
    targetDate,
    constraints,
    dailyMinutesLimit,
    uncertainties,
    tasks,
    revisions: [initialRevision],
    reasoningSummary: `${reasoning.selectedStrategy?.label ?? "Piano graduale"}: ${reasoning.selectedStrategy?.rationale ?? "Suddivisione in passi sostenibili."}${growthLinkNote}`,
    progressPercent: 0,
    source: "local",
    sessionOnly: !input.consentEnabled,
  };
}

/**
 * Aggiorna i dettagli principali del piano (richiede azione esplicita dell'utente).
 */
export function updatePlanDetails(
  plan: PersonalPlan,
  patch: {
    title?: string;
    desiredOutcome?: string;
    targetDate?: string;
    dailyMinutesLimit?: number;
    constraints?: string[];
  },
  explanation: string = "Aggiornamento manuale richiesto dall'utente.",
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  const changes: string[] = [];
  const nextTitle = patch.title?.trim() || plan.title;
  if (nextTitle !== plan.title) changes.push(`Titolo aggiornato in "${nextTitle}".`);

  const nextOutcome = patch.desiredOutcome?.trim() || plan.desiredOutcome;
  if (nextOutcome !== plan.desiredOutcome) changes.push("Risultato desiderato aggiornato.");

  const nextTarget = patch.targetDate?.trim() || plan.targetDate;
  if (nextTarget !== plan.targetDate) changes.push(`Scadenza aggiornata al ${nextTarget}.`);

  const nextLimit =
    patch.dailyMinutesLimit !== undefined
      ? Math.max(10, Math.min(240, Math.round(patch.dailyMinutesLimit)))
      : plan.dailyMinutesLimit;
  if (nextLimit !== plan.dailyMinutesLimit) {
    changes.push(`Limite giornaliero aggiornato a ${nextLimit} min/giorno.`);
  }

  const nextConstraints = patch.constraints ?? plan.constraints;

  const revision: PlanRevision = {
    id: makeId("rev"),
    timestamp: nowIso,
    reason: "Modifica manuale del piano",
    explanation,
    changesSummary: changes.length > 0 ? changes : ["Dettagli del piano confermati."],
  };

  return {
    ...plan,
    title: nextTitle,
    desiredOutcome: nextOutcome,
    targetDate: nextTarget,
    dailyMinutesLimit: nextLimit,
    constraints: nextConstraints,
    updatedAt: nowIso,
    revisions: [revision, ...plan.revisions].slice(0, 20),
  };
}

/**
 * Mette in pausa o riprende un piano registrando una spiegazione chiara nella cronologia.
 */
export function togglePlanPause(
  plan: PersonalPlan,
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  const nextStatus = plan.status === "paused" ? "active" : "paused";
  const revision: PlanRevision = {
    id: makeId("rev"),
    timestamp: nowIso,
    reason: nextStatus === "paused" ? "Piano messo in pausa" : "Piano ripreso",
    explanation:
      nextStatus === "paused"
        ? "Il piano è stato sospeso su tua richiesta. Nessuna attività verrà considerata fallita."
        : "Il piano è nuovamente attivo. Puoi riprendere dal prossimo passo disponibile.",
    changesSummary: [`Stato piano: ${plan.status} -> ${nextStatus}.`],
  };

  return {
    ...plan,
    status: nextStatus,
    updatedAt: nowIso,
    revisions: [revision, ...plan.revisions].slice(0, 20),
  };
}

/**
 * Verifica se un'attività ha dipendenze non ancora completate.
 */
export function hasUnmetDependencies(plan: PersonalPlan, taskId: string): boolean {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task || task.dependencies.length === 0) return false;
  return task.dependencies.some((depId) => {
    const dep = plan.tasks.find((t) => t.id === depId);
    return dep && dep.status !== "completed" && dep.status !== "cancelled";
  });
}

/**
 * Cambia lo stato di una singola attività (completata, sospesa, annullata, in corso, in ritardo).
 */
export function transitionTaskStatus(
  plan: PersonalPlan,
  taskId: string,
  newStatus: TaskStatus,
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  let changedTitle = "";
  const updatedTasks = plan.tasks.map((task) => {
    if (task.id !== taskId) return task;
    changedTitle = task.title;
    return {
      ...task,
      status: newStatus,
      completedAt: newStatus === "completed" ? nowIso : undefined,
      subtasks:
        newStatus === "completed"
          ? task.subtasks.map((s) => ({ ...s, completed: true }))
          : task.subtasks,
    };
  });

  if (!changedTitle) return plan;

  const progressPercent = computeProgressPercent(updatedTasks);
  const allDone =
    updatedTasks.length > 0 &&
    updatedTasks.every((t) => t.status === "completed" || t.status === "cancelled");

  const revision: PlanRevision = {
    id: makeId("rev"),
    timestamp: nowIso,
    reason: `Aggiornamento attività (${newStatus})`,
    explanation: `L'attività "${changedTitle}" è passata allo stato "${newStatus}". Avanzamento attuale: ${progressPercent}%.`,
    changesSummary: [`"${changedTitle}" -> ${newStatus}`],
  };

  return {
    ...plan,
    status: allDone ? "completed" : plan.status === "completed" ? "active" : plan.status,
    tasks: updatedTasks,
    progressPercent,
    updatedAt: nowIso,
    revisions: [revision, ...plan.revisions].slice(0, 20),
  };
}

/**
 * Aggiorna lo stato di una sotto-attività.
 */
export function toggleSubtask(
  plan: PersonalPlan,
  taskId: string,
  subtaskId: string,
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  const updatedTasks = plan.tasks.map((task) => {
    if (task.id !== taskId) return task;
    const subtasks = task.subtasks.map((sub) =>
      sub.id === subtaskId ? { ...sub, completed: !sub.completed } : sub
    );
    return { ...task, subtasks };
  });

  return {
    ...plan,
    tasks: updatedTasks,
    updatedAt: nowIso,
  };
}

/**
 * Individua e marca automaticamente come "overdue" le attività scadute non completate/sospese/annullate.
 */
export function detectOverdueTasks(
  plan: PersonalPlan,
  nowIso: string = new Date().toISOString()
): PersonalPlan {
  if (plan.status === "paused" || plan.status === "completed") return plan;
  const today = toDateOnly(nowIso);
  let overdueCount = 0;

  const updatedTasks = plan.tasks.map((task) => {
    if (
      (task.status === "pending" || task.status === "in_progress") &&
      task.dueDate < today
    ) {
      overdueCount += 1;
      return { ...task, status: "overdue" as TaskStatus };
    }
    return task;
  });

  if (overdueCount === 0) return plan;

  return {
    ...plan,
    tasks: updatedTasks,
    updatedAt: nowIso,
  };
}

/**
 * Ricalcola il piano quando cambiano le circostanze (imprevisti, ritardi, meno tempo disponibile).
 * Ripianifica le attività in ritardo, propone alternative per quelle non realizzabili
 * e spiega chiaramente all'utente ogni modifica effettuata.
 */
export function recalculatePlan(
  plan: PersonalPlan,
  input: PlanRecalculateInput
): PersonalPlan {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const today = toDateOnly(nowIso);
  const nextDailyLimit =
    input.newDailyMinutesLimit !== undefined
      ? Math.max(10, Math.min(240, Math.round(input.newDailyMinutesLimit)))
      : plan.dailyMinutesLimit;

  const unavailableSet = new Set(input.unavailableTaskIds ?? []);
  const changes: string[] = [];
  let rescheduleDayOffset = 1;

  const updatedTasks = plan.tasks.map((task) => {
    if (task.status === "completed" || task.status === "cancelled") {
      return task;
    }

    // Attività segnalata come non più realizzabile -> sospesa con alternative esplicite
    if (unavailableSet.has(task.id)) {
      const alternatives = buildAlternativesForTask(task.title, nextDailyLimit);
      changes.push(
        `Attività "${task.title}" sospesa come non realizzabile; proposte ${alternatives.length} alternative.`
      );
      return {
        ...task,
        status: "paused" as TaskStatus,
        estimatedMinutes: Math.min(task.estimatedMinutes, nextDailyLimit),
        alternatives,
      };
    }

    let nextDueDate = task.dueDate;
    let nextStatus = task.status;
    let nextMinutes = task.estimatedMinutes;

    // Riprogramma attività scadute o in ritardo
    if (task.status === "overdue" || task.dueDate < today) {
      nextDueDate = addDays(nowIso, rescheduleDayOffset);
      rescheduleDayOffset += 1;
      nextStatus = "pending";
      changes.push(
        `Attività in ritardo "${task.title}" riprogrammata al ${nextDueDate}.`
      );
    }

    // Adatta la durata al nuovo vincolo temporale
    if (nextMinutes > nextDailyLimit) {
      nextMinutes = nextDailyLimit;
      changes.push(
        `Durata stimata di "${task.title}" ridotta a ${nextDailyLimit} min per rispettare il nuovo limite giornaliero.`
      );
    }

    return {
      ...task,
      status: nextStatus,
      dueDate: nextDueDate,
      estimatedMinutes: nextMinutes,
      alternatives: buildAlternativesForTask(task.title, nextDailyLimit),
    };
  });

  const nextConstraints = [
    ...plan.constraints,
    ...(input.extraConstraints ?? []).map((c) => c.trim()).filter(Boolean),
  ];

  const maxTaskDue = updatedTasks.reduce(
    (max, t) => (t.dueDate > max ? t.dueDate : max),
    plan.targetDate
  );
  const nextTargetDate = input.newTargetDate?.trim() || maxTaskDue;

  if (nextTargetDate !== plan.targetDate) {
    changes.push(`Scadenza finale del piano aggiornata al ${nextTargetDate}.`);
  }

  const explanation =
    changes.length > 0
      ? `Piano ricalcolato per: ${input.reason}. ${changes.join(" ")}`
      : `Piano verificato per: ${input.reason}. Le attività correnti restano sostenibili senza variazioni.`;

  const revision: PlanRevision = {
    id: makeId("rev"),
    timestamp: nowIso,
    reason: input.reason,
    explanation,
    changesSummary: changes.length > 0 ? changes : ["Nessuna modifica necessaria."],
  };

  return {
    ...plan,
    dailyMinutesLimit: nextDailyLimit,
    targetDate: nextTargetDate,
    constraints: Array.from(new Set(nextConstraints)),
    tasks: updatedTasks,
    progressPercent: computeProgressPercent(updatedTasks),
    updatedAt: nowIso,
    revisions: [revision, ...plan.revisions].slice(0, 20),
  };
}

/**
 * Calcola le metriche di avanzamento del piano per la dashboard.
 */
export function getPlanProgressMetrics(
  plan: PersonalPlan,
  nowIso: string = new Date().toISOString()
): PlanProgressMetrics {
  const today = toDateOnly(nowIso);
  const totalTasks = plan.tasks.length;
  const completedTasks = plan.tasks.filter((t) => t.status === "completed").length;
  const pausedTasks = plan.tasks.filter((t) => t.status === "paused").length;
  const cancelledTasks = plan.tasks.filter((t) => t.status === "cancelled").length;
  const overdueTasks = plan.tasks.filter(
    (t) =>
      t.status === "overdue" ||
      ((t.status === "pending" || t.status === "in_progress") && t.dueDate < today)
  ).length;
  const activeTasks = plan.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress" || t.status === "overdue"
  ).length;
  const todayTasks = plan.tasks.filter(
    (t) =>
      (t.dueDate === today || t.horizonBucket === "oggi") &&
      t.status !== "completed" &&
      t.status !== "cancelled"
  ).length;
  const blockedByDependencies = plan.tasks.filter(
    (t) =>
      (t.status === "pending" || t.status === "in_progress") &&
      hasUnmetDependencies(plan, t.id)
  ).length;

  return {
    totalTasks,
    activeTasks,
    completedTasks,
    overdueTasks,
    pausedTasks,
    cancelledTasks,
    todayTasks,
    blockedByDependencies,
    progressPercent: computeProgressPercent(plan.tasks),
  };
}

/**
 * Esporta i dati dei piani in formato JSON leggibile dall'utente.
 */
export function exportPlansData(
  plans: PersonalPlan[],
  consentEnabled: boolean
): string {
  const bundle: PlanExportBundle = {
    exportedAt: new Date().toISOString(),
    consentEnabled,
    sessionOnly: !consentEnabled,
    plans,
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * Carica i piani salvati localmente SOLO se il consenso alla memoria è attivo.
 */
export function loadPlansFromStorage(
  consentEnabled: boolean,
  storage?: Pick<Storage, "getItem">
): PersonalPlan[] {
  if (!consentEnabled) return [];
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return [];
  try {
    const raw = target.getItem(PLANS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PersonalPlan[]) : [];
  } catch {
    return [];
  }
}

/**
 * Salva i piani localmente SOLO se il consenso alla memoria è attivo; altrimenti rimuove i dati salvati.
 */
export function savePlansToStorage(
  plans: PersonalPlan[],
  consentEnabled: boolean,
  storage?: Pick<Storage, "setItem" | "removeItem">
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return;
  try {
    if (!consentEnabled) {
      target.removeItem(PLANS_STORAGE_KEY);
      return;
    }
    target.setItem(PLANS_STORAGE_KEY, JSON.stringify(plans));
  } catch {
    // Ignora errori quota storage
  }
}

/**
 * Cancella completamente i piani salvati localmente.
 */
export function clearPlansFromStorage(
  storage?: Pick<Storage, "removeItem">
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return;
  try {
    target.removeItem(PLANS_STORAGE_KEY);
  } catch {
    // Ignora errori storage
  }
}
