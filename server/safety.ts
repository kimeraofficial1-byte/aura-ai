import type { AuraChatRequest, ChatHistoryItem, WellnessContext } from "../src/types/aura";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_ITEMS = 16;

export interface SafetyEvaluation {
  crisisDetected: boolean;
  reason?: "self_harm_or_suicide_risk";
  reply?: string;
}

export const CRISIS_EMERGENCY_REPLY =
  "Mi dispiace molto che tu stia attraversando un momento così pesante. La tua sicurezza viene prima di tutto. " +
  "Se pensi di poterti fare del male o sei in pericolo immediato, chiama subito il 112 (Numero Unico di Emergenza) o recati al pronto soccorso più vicino. " +
  "Puoi anche contattare servizi di ascolto dedicati come Telefono Amico Italia (02 2327 2327, tutti i giorni dalle 9:00 alle 24:00) o Samaritans Onlus (06 77208977). " +
  "Se puoi, avvicinati subito a una persona fidata e dille chiaramente che hai bisogno di supporto adesso. " +
  "Non sei solo, ma AURA è uno strumento di supporto al benessere e non sostituisce un servizio di emergenza o un professionista sanitario.";

const CRISIS_PATTERNS: RegExp[] = [
  /(suicid|ammazz|uccidermi|farla finita|autolesion|non voglio (?:piu )?vivere)/i,
  /(voglio morire|preferirei morire|togliermi la vita|togliere la vita|tagliarmi|faccio del male|farmi del male)/i,
  /(non ce la faccio piu a vivere|meglio se sparissi|non ha senso vivere)/i,
];

export function normalizeForSafetyCheck(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function evaluatePreModelSafety(message: string): SafetyEvaluation {
  const normalized = normalizeForSafetyCheck(message);
  const matched = CRISIS_PATTERNS.some((pattern) => pattern.test(normalized));

  if (matched) {
    return {
      crisisDetected: true,
      reason: "self_harm_or_suicide_risk",
      reply: CRISIS_EMERGENCY_REPLY,
    };
  }

  return { crisisDetected: false };
}

export function validateChatRequest(
  rawBody: unknown
): { ok: true; data: AuraChatRequest } | { ok: false; error: string } {
  if (!rawBody || typeof rawBody !== "object") {
    return { ok: false, error: "Formato della richiesta non valido." };
  }

  const body = rawBody as Record<string, unknown>;
  const message =
    typeof body.message === "string"
      ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH)
      : "";

  if (!message) {
    return { ok: false, error: "Il messaggio non può essere vuoto." };
  }

  let history: ChatHistoryItem[] = [];
  if (Array.isArray(body.history)) {
    history = body.history
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) &&
          typeof item === "object" &&
          ((item as Record<string, unknown>).role === "user" ||
            (item as Record<string, unknown>).role === "assistant") &&
          typeof (item as Record<string, unknown>).text === "string"
      )
      .map((item) => ({
        role: item.role as "user" | "assistant",
        text: String(item.text).trim().slice(0, MAX_MESSAGE_LENGTH),
        time: typeof item.time === "string" ? item.time.slice(0, 32) : undefined,
      }))
      .filter((item) => item.text.length > 0)
      .slice(-MAX_HISTORY_ITEMS);
  }

  const context: WellnessContext = {};
  if (body.context && typeof body.context === "object") {
    const rawContext = body.context as Record<string, unknown>;
    if (typeof rawContext.mood === "string" && rawContext.mood.trim()) {
      context.mood = rawContext.mood.trim().slice(0, 64);
    }
    if (typeof rawContext.stress === "number" && Number.isFinite(rawContext.stress)) {
      context.stress = Math.max(0, Math.min(10, Math.round(rawContext.stress)));
    }
    if (
      typeof rawContext.completedMissions === "number" &&
      Number.isFinite(rawContext.completedMissions)
    ) {
      context.completedMissions = Math.max(0, Math.round(rawContext.completedMissions));
    }
    if (
      typeof rawContext.totalMissions === "number" &&
      Number.isFinite(rawContext.totalMissions)
    ) {
      context.totalMissions = Math.max(0, Math.round(rawContext.totalMissions));
    }
    if (typeof rawContext.memorySummary === "string" && rawContext.memorySummary.trim()) {
      context.memorySummary = rawContext.memorySummary.trim().slice(0, 2000);
    }
    if (
      typeof rawContext.emotionalTrendSummary === "string" &&
      rawContext.emotionalTrendSummary.trim()
    ) {
      context.emotionalTrendSummary = rawContext.emotionalTrendSummary.trim().slice(0, 600);
    }
    if (
      typeof rawContext.orchestratedContextSummary === "string" &&
      rawContext.orchestratedContextSummary.trim()
    ) {
      context.orchestratedContextSummary = rawContext.orchestratedContextSummary
        .trim()
        .slice(0, 2400);
    }
    if (rawContext.emotionalProfile && typeof rawContext.emotionalProfile === "object") {
      const ep = rawContext.emotionalProfile as Record<string, unknown>;
      context.emotionalProfile = {
        primaryEmotion:
          typeof ep.primaryEmotion === "string"
            ? ep.primaryEmotion.trim().slice(0, 64)
            : undefined,
        intensity:
          ep.intensity === "low" || ep.intensity === "moderate" || ep.intensity === "high"
            ? ep.intensity
            : undefined,
        notes: typeof ep.notes === "string" ? ep.notes.trim().slice(0, 500) : undefined,
      };
    }
  }

  return {
    ok: true,
    data: {
      message,
      history,
      context,
    },
  };
}
