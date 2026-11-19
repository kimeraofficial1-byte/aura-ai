import { normalizeEmotionCategory } from "../emotion/analyzer";
import type { EmotionalTrendEntry } from "../emotion/types";
import { sanitizeGrowthGoalList } from "../growth/engine";
import type { GrowthGoal } from "../growth/types";
import { normalizeMissionCategory } from "../missions/engine";
import type { AdaptiveMission } from "../missions/types";
import { createEmptyLongTermMemory, dedupeAndCap } from "./extractor";
import { isSafeForLongTermMemory, redactSensitiveTokens } from "./privacyFilter";
import type {
  AuraExportBundle,
  CheckInRecord,
  LongTermMemory,
  MemoryConsentState,
  ShortTermMemory,
  StorageDriver,
} from "./types";

export const MEMORY_STORAGE_KEYS = {
  consent: "aura.memory.consent.v1",
  shortTerm: "aura.memory.short_term.v1",
  longTerm: "aura.memory.long_term.v1",
  checkIns: "aura.memory.checkins.v1",
  emotionalTrends: "aura.memory.emotional_trends.v1",
  missions: "aura.memory.missions.v1",
  growthGoals: "aura.memory.growth_goals.v1",
  legacyCheckIns: "aura-checkins",
} as const;

const MAX_SHORT_TERM_MESSAGES = 30;
const MAX_CHECKINS = 60;
const MAX_EMOTIONAL_TRENDS = 60;
const MAX_MISSIONS = 40;

export function createBrowserStorageDriver(): StorageDriver {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class AuraMemoryStore {
  private readonly driver: StorageDriver;

  constructor(driver: StorageDriver = createBrowserStorageDriver()) {
    this.driver = driver;
  }

  getConsent(): MemoryConsentState {
    const parsed = safeParseJson<Partial<MemoryConsentState>>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.consent),
      {}
    );
    return {
      enabled: parsed.enabled === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  }

  setConsent(enabled: boolean, nowIso = new Date().toISOString()): MemoryConsentState {
    const next: MemoryConsentState = { enabled, updatedAt: nowIso };
    if (enabled) {
      this.driver.setItem(MEMORY_STORAGE_KEYS.consent, JSON.stringify(next));
    } else {
      // Revoca del consenso: rimuove immediatamente tutta la memoria personale salvata
      this.clearAllPersonalMemory();
      this.driver.setItem(MEMORY_STORAGE_KEYS.consent, JSON.stringify(next));
    }
    return next;
  }

  getShortTermMemory(): ShortTermMemory {
    if (!this.getConsent().enabled) {
      return { messages: [], updatedAt: null };
    }
    const parsed = safeParseJson<Partial<ShortTermMemory>>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.shortTerm),
      {}
    );
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter(
            (m) =>
              m &&
              (m.role === "assistant" || m.role === "user") &&
              typeof m.text === "string" &&
              typeof m.time === "string"
          )
          .slice(-MAX_SHORT_TERM_MESSAGES)
      : [];
    return {
      messages,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  }

  saveShortTermMemory(
    messages: ShortTermMemory["messages"],
    nowIso = new Date().toISOString()
  ): boolean {
    if (!this.getConsent().enabled) return false;
    const payload: ShortTermMemory = {
      messages: messages.slice(-MAX_SHORT_TERM_MESSAGES),
      updatedAt: nowIso,
    };
    this.driver.setItem(MEMORY_STORAGE_KEYS.shortTerm, JSON.stringify(payload));
    return true;
  }

  getLongTermMemory(): LongTermMemory {
    if (!this.getConsent().enabled) {
      return createEmptyLongTermMemory();
    }
    const parsed = safeParseJson<Partial<LongTermMemory>>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.longTerm),
      {}
    );
    return {
      preferences: Array.isArray(parsed.preferences)
        ? dedupeAndCap(parsed.preferences.filter((x): x is string => typeof x === "string"))
        : [],
      goalsAndStrategies: Array.isArray(parsed.goalsAndStrategies)
        ? dedupeAndCap(
            parsed.goalsAndStrategies.filter((x): x is string => typeof x === "string")
          )
        : [],
      completedMissions: Array.isArray(parsed.completedMissions)
        ? dedupeAndCap(
            parsed.completedMissions.filter((x): x is string => typeof x === "string"),
            12
          )
        : [],
      conversationTopics: Array.isArray(parsed.conversationTopics)
        ? dedupeAndCap(
            parsed.conversationTopics.filter((x): x is string => typeof x === "string"),
            6
          )
        : [],
      userNotes:
        typeof parsed.userNotes === "string" && isSafeForLongTermMemory(parsed.userNotes)
          ? redactSensitiveTokens(parsed.userNotes).slice(0, 500)
          : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  }

  saveLongTermMemory(memory: LongTermMemory): boolean {
    if (!this.getConsent().enabled) return false;
    const sanitized: LongTermMemory = {
      preferences: dedupeAndCap(memory.preferences),
      goalsAndStrategies: dedupeAndCap(memory.goalsAndStrategies),
      completedMissions: dedupeAndCap(memory.completedMissions, 12),
      conversationTopics: dedupeAndCap(memory.conversationTopics, 6),
      userNotes:
        memory.userNotes.trim() && isSafeForLongTermMemory(memory.userNotes)
          ? redactSensitiveTokens(memory.userNotes).slice(0, 500)
          : "",
      updatedAt: memory.updatedAt ?? new Date().toISOString(),
    };
    this.driver.setItem(MEMORY_STORAGE_KEYS.longTerm, JSON.stringify(sanitized));
    return true;
  }

  getCheckIns(): CheckInRecord[] {
    if (!this.getConsent().enabled) return [];
    const parsed = safeParseJson<unknown[]>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.checkIns),
      []
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is CheckInRecord =>
          Boolean(r) &&
          typeof r === "object" &&
          typeof (r as CheckInRecord).date === "string" &&
          typeof (r as CheckInRecord).stress === "number" &&
          typeof (r as CheckInRecord).mood === "string"
      )
      .slice(-MAX_CHECKINS);
  }

  saveCheckIn(record: CheckInRecord): CheckInRecord[] {
    if (!this.getConsent().enabled) {
      return [];
    }
    const existing = this.getCheckIns();
    const next = [...existing, record].slice(-MAX_CHECKINS);
    this.driver.setItem(MEMORY_STORAGE_KEYS.checkIns, JSON.stringify(next));
    return next;
  }

  getEmotionalTrends(): EmotionalTrendEntry[] {
    if (!this.getConsent().enabled) return [];
    const parsed = safeParseJson<unknown[]>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.emotionalTrends),
      []
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is EmotionalTrendEntry => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return (
          typeof r.id === "string" &&
          typeof r.date === "string" &&
          normalizeEmotionCategory(r.primaryEmotion) !== null &&
          typeof r.intensity === "number" &&
          typeof r.confidence === "number"
        );
      })
      .slice(-MAX_EMOTIONAL_TRENDS);
  }

  saveEmotionalTrend(
    entry: EmotionalTrendEntry,
    options?: { rawText?: string; crisisDetected?: boolean }
  ): EmotionalTrendEntry[] {
    if (!this.getConsent().enabled) {
      return [];
    }
    const existing = this.getEmotionalTrends();
    if (options?.crisisDetected) {
      return existing;
    }
    if (options?.rawText && !isSafeForLongTermMemory(options.rawText)) {
      return existing;
    }

    const sanitizedSignals = entry.stressSignals
      .filter((s) => isSafeForLongTermMemory(s))
      .map((s) => redactSensitiveTokens(s).slice(0, 80))
      .slice(0, 4);

    const safeEntry: EmotionalTrendEntry = {
      ...entry,
      intensity: Math.max(0, Math.min(10, Math.round(entry.intensity))),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence.toFixed(2)))),
      stressSignals: sanitizedSignals,
    };

    const next = [...existing, safeEntry].slice(-MAX_EMOTIONAL_TRENDS);
    this.driver.setItem(MEMORY_STORAGE_KEYS.emotionalTrends, JSON.stringify(next));
    return next;
  }

  getMissions(): AdaptiveMission[] {
    if (!this.getConsent().enabled) return [];
    const parsed = safeParseJson<unknown[]>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.missions),
      []
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is AdaptiveMission => {
        if (!item || typeof item !== "object") return false;
        const r = item as Record<string, unknown>;
        return (
          typeof r.id === "string" &&
          typeof r.title === "string" &&
          typeof r.description === "string" &&
          normalizeMissionCategory(r.category) !== null &&
          typeof r.estimatedMinutes === "number" &&
          typeof r.status === "string" &&
          Array.isArray(r.instructions)
        );
      })
      .slice(-MAX_MISSIONS);
  }

  saveMissions(missions: AdaptiveMission[]): boolean {
    if (!this.getConsent().enabled) return false;
    const sanitized: AdaptiveMission[] = [];
    for (const m of missions) {
      if (
        !isSafeForLongTermMemory(m.title) ||
        !isSafeForLongTermMemory(m.description) ||
        !isSafeForLongTermMemory(m.goal)
      ) {
        continue;
      }
      sanitized.push({
        ...m,
        title: redactSensitiveTokens(m.title).slice(0, 90),
        description: redactSensitiveTokens(m.description).slice(0, 260),
        goal: redactSensitiveTokens(m.goal).slice(0, 140),
        instructions: m.instructions
          .filter((step) => isSafeForLongTermMemory(step))
          .map((step) => redactSensitiveTokens(step).slice(0, 140)),
      });
    }
    this.driver.setItem(
      MEMORY_STORAGE_KEYS.missions,
      JSON.stringify(sanitized.slice(-MAX_MISSIONS))
    );
    return true;
  }

  getGrowthGoals(): GrowthGoal[] {
    if (!this.getConsent().enabled) return [];
    const parsed = safeParseJson<unknown[]>(
      this.driver.getItem(MEMORY_STORAGE_KEYS.growthGoals),
      []
    );
    return sanitizeGrowthGoalList(parsed);
  }

  saveGrowthGoals(goals: GrowthGoal[]): boolean {
    if (!this.getConsent().enabled) return false;
    const sanitized = sanitizeGrowthGoalList(goals);
    this.driver.setItem(
      MEMORY_STORAGE_KEYS.growthGoals,
      JSON.stringify(sanitized.slice(-25))
    );
    return true;
  }

  clearAllPersonalMemory(): void {
    this.driver.removeItem(MEMORY_STORAGE_KEYS.shortTerm);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.longTerm);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.checkIns);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.emotionalTrends);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.missions);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.growthGoals);
    this.driver.removeItem(MEMORY_STORAGE_KEYS.legacyCheckIns);
  }

  exportBundle(inMemoryFallback?: {
    shortTermMessages?: ShortTermMemory["messages"];
    longTermMemory?: LongTermMemory;
    checkIns?: CheckInRecord[];
    emotionalTrends?: EmotionalTrendEntry[];
    missions?: AdaptiveMission[];
    growthGoals?: GrowthGoal[];
  }): AuraExportBundle {
    const consent = this.getConsent();
    const shortTerm = consent.enabled
      ? this.getShortTermMemory()
      : {
          messages: inMemoryFallback?.shortTermMessages ?? [],
          updatedAt: null,
        };
    const longTerm = consent.enabled
      ? this.getLongTermMemory()
      : inMemoryFallback?.longTermMemory ?? createEmptyLongTermMemory();
    const checkIns = consent.enabled
      ? this.getCheckIns()
      : inMemoryFallback?.checkIns ?? [];
    const emotionalTrends = consent.enabled
      ? this.getEmotionalTrends()
      : inMemoryFallback?.emotionalTrends ?? [];
    const missions = consent.enabled
      ? this.getMissions()
      : inMemoryFallback?.missions ?? [];
    const growthGoals = consent.enabled
      ? this.getGrowthGoals()
      : inMemoryFallback?.growthGoals ?? [];

    return {
      version: "aura-memory-v1",
      exportedAt: new Date().toISOString(),
      consent,
      longTermMemory: longTerm,
      shortTermMemory: shortTerm,
      checkIns,
      emotionalTrends,
      missions,
      growthGoals,
    };
  }
}
