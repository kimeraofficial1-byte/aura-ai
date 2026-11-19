import { isSafeForLongTermMemory, normalizeText, redactSensitiveTokens } from "./privacyFilter";
import type { CheckInRecord, LongTermMemory } from "./types";

const MAX_ITEMS_PER_BUCKET = 8;
const MAX_ITEM_LENGTH = 140;
const MAX_SUMMARY_CHARS = 900;

export function createEmptyLongTermMemory(): LongTermMemory {
  return {
    preferences: [],
    goalsAndStrategies: [],
    completedMissions: [],
    conversationTopics: [],
    userNotes: "",
    updatedAt: null,
  };
}

function canonicalKey(text: string): string {
  return normalizeText(text).replace(/[.,;:!?'"()[\]]/g, "");
}

export function dedupeAndCap(items: string[], maxItems = MAX_ITEMS_PER_BUCKET): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of items) {
    const cleaned = redactSensitiveTokens(raw).slice(0, MAX_ITEM_LENGTH).trim();
    if (!cleaned || !isSafeForLongTermMemory(cleaned)) continue;
    const key = canonicalKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }

  return result.slice(-maxItems);
}

const PREFERENCE_PATTERNS: RegExp[] = [
  /\b(preferisco|preferirei|mi piace|non mi piace|mi trovo bene con|mi aiuta molto|vorrei risposte)\b/i,
];

const GOAL_STRATEGY_PATTERNS: RegExp[] = [
  /\b(il mio obiettivo|vorrei riuscire|voglio migliorare|sto cercando di|mi aiuta a calmarmi|mi fa stare meglio|quando respiro|per rilassarmi)\b/i,
];

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

export function extractLongTermMemoryUpdate(params: {
  current: LongTermMemory;
  userMessage: string;
  crisisDetected: boolean;
  nowIso?: string;
}): LongTermMemory {
  const { current, userMessage, crisisDetected } = params;
  if (crisisDetected || !isSafeForLongTermMemory(userMessage)) {
    return current;
  }

  const sentences = splitSentences(userMessage);
  const newPreferences: string[] = [];
  const newGoals: string[] = [];

  for (const sentence of sentences) {
    if (!isSafeForLongTermMemory(sentence)) continue;
    const clean = redactSensitiveTokens(sentence).slice(0, MAX_ITEM_LENGTH).trim();
    if (!clean) continue;

    if (PREFERENCE_PATTERNS.some((re) => re.test(clean))) {
      newPreferences.push(clean);
    }
    if (GOAL_STRATEGY_PATTERNS.some((re) => re.test(clean))) {
      newGoals.push(clean);
    }
  }

  // Crea un breve punto di riepilogo solo se il messaggio contiene contesto significativo (> 24 caratteri)
  const sanitizedTopic = redactSensitiveTokens(userMessage).trim();
  const topicCandidate =
    sanitizedTopic.length >= 24
      ? sanitizedTopic.length > 110
        ? `${sanitizedTopic.slice(0, 107).trim()}...`
        : sanitizedTopic
      : "";

  const nextPreferences = dedupeAndCap([...current.preferences, ...newPreferences]);
  const nextGoals = dedupeAndCap([...current.goalsAndStrategies, ...newGoals]);
  const nextTopics = topicCandidate
    ? dedupeAndCap([...current.conversationTopics, topicCandidate], 6)
    : current.conversationTopics;

  const changed =
    nextPreferences.length !== current.preferences.length ||
    nextGoals.length !== current.goalsAndStrategies.length ||
    nextTopics.length !== current.conversationTopics.length ||
    nextTopics.some((v, idx) => v !== current.conversationTopics[idx]);

  if (!changed) {
    return current;
  }

  return {
    ...current,
    preferences: nextPreferences,
    goalsAndStrategies: nextGoals,
    conversationTopics: nextTopics,
    updatedAt: params.nowIso ?? new Date().toISOString(),
  };
}

export function syncCompletedMissionsToMemory(
  current: LongTermMemory,
  completedMissionTitles: string[],
  nowIso?: string
): LongTermMemory {
  const nextMissions = dedupeAndCap(completedMissionTitles, 12);
  const same =
    nextMissions.length === current.completedMissions.length &&
    nextMissions.every((t, i) => t === current.completedMissions[i]);

  if (same) return current;

  return {
    ...current,
    completedMissions: nextMissions,
    updatedAt: nowIso ?? new Date().toISOString(),
  };
}

export function buildMemorySummaryForGemini(params: {
  consentEnabled: boolean;
  memory: LongTermMemory;
  checkIns?: CheckInRecord[];
}): string | undefined {
  if (!params.consentEnabled) return undefined;

  const { memory, checkIns = [] } = params;
  const parts: string[] = [];

  if (memory.preferences.length > 0) {
    parts.push(`Preferenze esplicite: ${memory.preferences.join(" | ")}`);
  }
  if (memory.goalsAndStrategies.length > 0) {
    parts.push(`Obiettivi e strategie utili: ${memory.goalsAndStrategies.join(" | ")}`);
  }
  if (memory.completedMissions.length > 0) {
    parts.push(`Missioni completate: ${memory.completedMissions.join(", ")}`);
  }
  if (memory.conversationTopics.length > 0) {
    parts.push(`Riepilogo temi recenti: ${memory.conversationTopics.slice(-4).join(" | ")}`);
  }
  if (memory.userNotes.trim() && isSafeForLongTermMemory(memory.userNotes)) {
    parts.push(`Note personali dell'utente: ${redactSensitiveTokens(memory.userNotes).slice(0, 260)}`);
  }
  if (checkIns.length > 0) {
    const recent = checkIns.slice(-3);
    const avgStress = Math.round(
      (recent.reduce((acc, c) => acc + c.stress, 0) / recent.length) * 10
    ) / 10;
    const lastMood = recent[recent.length - 1]?.mood;
    parts.push(
      `Andamento recenti check-in (${checkIns.length} registrati): stress medio recente ${avgStress}/10${lastMood ? `, ultimo umore "${lastMood}"` : ""}.`
    );
  }

  if (parts.length === 0) return undefined;

  const summary = parts.join("\n");
  return summary.length > MAX_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_SUMMARY_CHARS - 3)}...`
    : summary;
}
