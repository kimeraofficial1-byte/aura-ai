import { buildEmotionalTrendSummaryForGemini } from "../emotion/empathy";
import type { EmotionalAnalysis, EmotionalTrendEntry } from "../emotion/types";
import { buildWeeklyReflection } from "../growth/engine";
import type { GrowthGoal } from "../growth/types";
import { buildMemorySummaryForGemini, dedupeAndCap } from "../memory/extractor";
import { isSafeForLongTermMemory } from "../memory/privacyFilter";
import type { CheckInRecord, LongTermMemory } from "../memory/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { ChatHistoryItem } from "../types/aura";

export type ContextProvenance =
  | "user_declared"
  | "observed_record"
  | "prudent_interpretation";

export type ContextScope = "session_ephemeral" | "persistent_authorized";

export interface ContextItem {
  category: "memory" | "emotion" | "growth" | "mission" | "checkin";
  label: string;
  value: string;
  provenance: ContextProvenance;
  scope: ContextScope;
  uncertain?: boolean;
}

export interface OrchestratedContext {
  safetyBlocked: boolean;
  consentEnabled: boolean;
  items: ContextItem[];
  excludedDuplicateMissions: string[];
  totalChars: number;
  truncated: boolean;
}

export interface ContextOrchestrationInput {
  userMessage: string;
  history?: ChatHistoryItem[];
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  /** Session-only check-in state */
  currentMood?: string;
  currentStress?: number;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  /** Existing engines data */
  longTermMemory?: LongTermMemory;
  checkIns?: CheckInRecord[];
  latestEmotionalAnalysis?: EmotionalAnalysis | null;
  emotionalTrends?: EmotionalTrendEntry[];
  missions?: AdaptiveMission[];
  growthGoals?: GrowthGoal[];
  maxTotalChars?: number;
}

const DEFAULT_MAX_CONTEXT_CHARS = 1800;

const CRISIS_GUARD_PATTERNS: RegExp[] = [
  /\b(suicid|ammazzarmi|uccidermi|togliermi la vita|farla finita)\b/i,
  /\b(autolesion|tagliarmi|farmi del male|voglio morire)\b/i,
];

function hasPreModelCrisisSignal(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CRISIS_GUARD_PATTERNS.some((re) => re.test(clean));
}

function sanitizeContextValue(raw: string, maxLen = 220): string {
  // Neutralizza eventuali tentativi di prompt injection presenti in testi salvati
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\b(ignora le istruzioni|ignore previous instructions|system prompt)\b/gi, "[rimosso]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isRelevantToMessage(
  userMessage: string,
  candidate: string,
  alwaysInclude = false
): boolean {
  if (alwaysInclude) return true;
  const msgLower = userMessage.toLowerCase();
  const candLower = candidate.toLowerCase();
  const words = msgLower
    .replace(/[^a-zàèéìòù0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return true;
  return words.some((w) => candLower.includes(w));
}

/**
 * Context Orchestration Engine (FASE D):
 * Raccoglie esclusivamente dati dai 5 motori esistenti, preserva la provenienza,
 * applica priorità assoluta a Safety e consenso Memory, deduplica e limita la dimensione.
 */
export function orchestratePersonalContext(
  input: ContextOrchestrationInput
): OrchestratedContext {
  const maxChars = Math.max(400, Math.min(2400, input.maxTotalChars ?? DEFAULT_MAX_CONTEXT_CHARS));
  const safetyBlocked =
    Boolean(input.crisisBlocked) || hasPreModelCrisisSignal(input.userMessage);

  // Priorità assoluta al Safety Engine: in caso di crisi non trasmette contesto/missioni automatiche
  if (safetyBlocked) {
    return {
      safetyBlocked: true,
      consentEnabled: input.consentEnabled,
      items: [],
      excludedDuplicateMissions: [],
      totalChars: 0,
      truncated: false,
    };
  }

  const items: ContextItem[] = [];
  const seenKeys = new Set<string>();
  let totalChars = 0;
  let truncated = false;

  const pushItem = (item: ContextItem) => {
    const cleanVal = sanitizeContextValue(item.value);
    if (!cleanVal) return;
    const dedupeKey = `${item.category}:${item.label}:${cleanVal.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return;

    const estimatedLen = item.label.length + cleanVal.length + 24;
    if (totalChars + estimatedLen > maxChars) {
      truncated = true;
      return;
    }

    seenKeys.add(dedupeKey);
    totalChars += estimatedLen;
    items.push({ ...item, value: cleanVal });
  };

  // 1. Check-in della sessione corrente (dichiarato dall'utente, effimero)
  if (input.currentMood) {
    pushItem({
      category: "checkin",
      label: "Umore check-in sessione",
      value: input.currentMood,
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }
  if (typeof input.currentStress === "number" && Number.isFinite(input.currentStress)) {
    pushItem({
      category: "checkin",
      label: "Stress percepito sessione",
      value: `${Math.max(0, Math.min(10, Math.round(input.currentStress)))}/10`,
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }
  if (input.energyLevel || typeof input.availableMinutes === "number") {
    const parts: string[] = [];
    if (input.energyLevel) parts.push(`energia ${input.energyLevel}`);
    if (typeof input.availableMinutes === "number") {
      parts.push(`tempo disponibile ${input.availableMinutes} min`);
    }
    pushItem({
      category: "mission",
      label: "Contesto energetico/temporale",
      value: parts.join(", "),
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }

  // 2. Emotional Intelligence Engine (sessione corrente = interpretazione prudente)
  if (input.latestEmotionalAnalysis) {
    const ea = input.latestEmotionalAnalysis;
    const isLowConfidence = ea.uncertain || ea.confidence < 0.55;
    pushItem({
      category: "emotion",
      label: "Segnale emotivo recente (non diagnostico)",
      value: isLowConfidence
        ? `possibile ${ea.primaryEmotion} (confidenza bassa ${Math.round(ea.confidence * 100)}%, mantenere incertezza)`
        : `${ea.primaryEmotion} (intensità ${ea.intensity}/10, confidenza ${Math.round(ea.confidence * 100)}%)`,
      provenance: "prudent_interpretation",
      scope: "session_ephemeral",
      uncertain: isLowConfidence,
    });
  }

  // Se il consenso Memory è OFF, NON recuperare né trasmettere alcun dato persistente
  if (!input.consentEnabled) {
    return {
      safetyBlocked: false,
      consentEnabled: false,
      items,
      excludedDuplicateMissions: [],
      totalChars,
      truncated,
    };
  }

  // 3. Memory Engine V1 (solo con consenso attivo e filtri privacy)
  if (input.longTermMemory) {
    const memoryText = buildMemorySummaryForGemini({
      consentEnabled: true,
      memory: input.longTermMemory,
      checkIns: input.checkIns ?? [],
    });
    if (memoryText && isSafeForLongTermMemory(memoryText)) {
      pushItem({
        category: "memory",
        label: "Memoria esplicita autorizzata",
        value: memoryText,
        provenance: "user_declared",
        scope: "persistent_authorized",
      });
    }
  }

  // 4. Emotional Trend persistente (solo con consenso attivo)
  if (input.emotionalTrends && input.emotionalTrends.length > 0) {
    const trendSummary = buildEmotionalTrendSummaryForGemini({
      consentEnabled: true,
      trends: input.emotionalTrends,
    });
    if (trendSummary) {
      pushItem({
        category: "emotion",
        label: "Andamento emotivo registrato",
        value: trendSummary,
        provenance: "observed_record",
        scope: "persistent_authorized",
      });
    }
  }

  // 5. Personal Growth Engine V1 (obiettivi dichiarati, completati, sospesi, riflessione settimanale)
  const goals = input.growthGoals ?? [];
  const activeGoals = dedupeAndCap(
    goals.filter((g) => g.status === "attivo").map((g) => g.title),
    4
  );
  const completedGoals = dedupeAndCap(
    goals.filter((g) => g.status === "completato").map((g) => g.title),
    3
  );
  const pausedGoals = dedupeAndCap(
    goals.filter((g) => g.status === "in_pausa").map((g) => g.title),
    2
  );

  if (activeGoals.length > 0) {
    pushItem({
      category: "growth",
      label: "Obiettivi attivi dichiarati",
      value: activeGoals.join("; "),
      provenance: "user_declared",
      scope: "persistent_authorized",
    });
  }
  if (completedGoals.length > 0) {
    pushItem({
      category: "growth",
      label: "Obiettivi completati registrati",
      value: completedGoals.join("; "),
      provenance: "observed_record",
      scope: "persistent_authorized",
    });
  }
  if (pausedGoals.length > 0) {
    pushItem({
      category: "growth",
      label: "Obiettivi sospesi",
      value: pausedGoals.join("; "),
      provenance: "observed_record",
      scope: "persistent_authorized",
    });
  }

  // Riflessione settimanale solo se pertinente o se ci sono dati reali
  if (goals.length > 0 || (input.missions && input.missions.length > 0)) {
    const reflection = buildWeeklyReflection({
      missions: input.missions ?? [],
      checkIns: input.checkIns ?? [],
      goals,
      emotionalTrends: input.emotionalTrends ?? [],
    });
    if (
      reflection.hasSufficientData &&
      reflection.observableSmallProgress.length > 0 &&
      isRelevantToMessage(
        input.userMessage,
        reflection.observableSmallProgress.join(" "),
        /(progress|settiman|obiettiv|mission|traguard|come sto andando)/i.test(input.userMessage)
      )
    ) {
      pushItem({
        category: "growth",
        label: "Progressi settimanali registrati",
        value: reflection.observableSmallProgress.slice(0, 2).join("; "),
        provenance: "observed_record",
        scope: "persistent_authorized",
      });
    }
  }

  // 6. Adaptive Mission Engine V1 (attive, completate, rifiutate/annullate senza duplicati)
  const missions = input.missions ?? [];
  const activeMissions = dedupeAndCap(
    missions
      .filter((m) => m.status === "accettata" || m.status === "proposta")
      .map((m) => `${m.title} (${m.status})`),
    3
  );
  const completedMissions = dedupeAndCap(
    missions.filter((m) => m.status === "completata").map((m) => m.title),
    3
  );
  const excludedDuplicateMissions = dedupeAndCap(
    missions
      .filter(
        (m) =>
          m.status === "completata" ||
          m.status === "rifiutata" ||
          m.status === "annullata"
      )
      .map((m) => m.title),
    6
  );

  if (activeMissions.length > 0) {
    pushItem({
      category: "mission",
      label: "Missioni attive/proposte",
      value: activeMissions.join("; "),
      provenance: "observed_record",
      scope: "persistent_authorized",
    });
  }
  if (completedMissions.length > 0) {
    pushItem({
      category: "mission",
      label: "Missioni completate",
      value: completedMissions.join("; "),
      provenance: "observed_record",
      scope: "persistent_authorized",
    });
  }
  if (excludedDuplicateMissions.length > 0) {
    pushItem({
      category: "mission",
      label: "Missioni già svolte/rifiutate (non riproporre)",
      value: excludedDuplicateMissions.join("; "),
      provenance: "observed_record",
      scope: "persistent_authorized",
    });
  }

  return {
    safetyBlocked: false,
    consentEnabled: true,
    items,
    excludedDuplicateMissions,
    totalChars,
    truncated,
  };
}
