import { hasUnmetDependencies } from "../planning/planningEngine";
import type {
  PriorityProposal,
  PriorityProposalStatus,
  ProactiveAnalysisInput,
  SuggestionPriority,
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
 * Dynamic Priority Engine V1.1.
 * Calcola proposte di ri-prioritizzazione confrontando priorità precedente e suggerita.
 * NON modifica mai automaticamente alcun piano: ogni proposta richiede azione dell'utente.
 */
export function generatePriorityProposals(
  input: ProactiveAnalysisInput
): PriorityProposal[] {
  if (input.crisisBlocked) return [];

  const nowIso = input.nowIso ?? new Date().toISOString();
  const today = toDateOnly(nowIso);
  const proposals: PriorityProposal[] = [];

  for (const plan of input.plans) {
    if (plan.status !== "active") continue;

    for (const task of plan.tasks) {
      if (task.status === "completed" || task.status === "cancelled") continue;

      const isOverdue = task.status === "overdue" || task.dueDate < today;
      const daysLeft = daysBetween(today, task.dueDate);
      const blocked = hasUnmetDependencies(plan, task.id);

      let suggested: SuggestionPriority = task.priority;
      let reason = "";
      let confidence = 0.8;

      if (isOverdue && task.priority !== "alta") {
        suggested = "alta";
        reason = `Attività oltre la scadenza (${task.dueDate}): conviene portarla in priorità alta o riprogrammarla.`;
        confidence = 0.92;
      } else if (!blocked && daysLeft >= 0 && daysLeft <= 1 && task.priority === "bassa") {
        suggested = "media";
        reason = `Scadenza entro 24 ore (${task.dueDate}) senza dipendenze bloccanti.`;
        confidence = 0.85;
      } else if (blocked && task.priority === "alta") {
        suggested = "media";
        reason = "Attività attualmente bloccata da un prerequisito: conviene dare priorità al passo precedente.";
        confidence = 0.88;
      } else if (
        task.estimatedMinutes > plan.dailyMinutesLimit &&
        task.priority === "alta"
      ) {
        suggested = "media";
        reason = `Durata stimata (${task.estimatedMinutes} min) superiore al limite giornaliero (${plan.dailyMinutesLimit} min): utile suddividerla.`;
        confidence = 0.8;
      }

      if (suggested !== task.priority) {
        proposals.push({
          id: `prio-${plan.id}-${task.id}`,
          planId: plan.id,
          planTitle: plan.title,
          taskId: task.id,
          taskTitle: task.title,
          previousPriority: task.priority,
          suggestedPriority: suggested,
          reason,
          dataSource: `Planning Engine · Piano "${plan.title}"`,
          confidence,
          status: "proposed",
        });
      }
    }
  }

  return proposals;
}

export function transitionPriorityProposalStatus(
  proposals: PriorityProposal[],
  id: string,
  status: PriorityProposalStatus
): PriorityProposal[] {
  return proposals.map((p) => (p.id === id ? { ...p, status } : p));
}
