import {
  LocalStorageAdapter,
  MemoryStorageAdapter,
  type MinimalWebStorage,
} from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import { evaluateLearningSafety } from "./learningSafetyGuard";
import type {
  Confidence,
  EpistemicTag,
  LearningConsentState,
  LearningGuardDecision,
  LearningPayload,
} from "./selfLearningTypes";

export const ADAPTIVE_LEARNING_STORAGE_KEY = "aura_adaptive_learning_v1";
export const MIN_ADAPTIVE_WEIGHT = 0.5;
export const MAX_ADAPTIVE_WEIGHT = 1.5;
export const DEFAULT_ADAPTIVE_WEIGHT = 1.0;
export const DEFAULT_DECAY_RATE_PER_DAY = 0.02;

export type AdaptiveStrategy = "STANDARD" | "LIGHT" | "DEFERRED";
export type AdaptiveDuration = "short" | "medium" | "long";
export type AdaptiveDetail = "concise" | "balanced" | "detailed";

export interface AdaptiveProfile {
  version: 1;
  updatedAt: string;
  signalCount: number;
  strategyWeights: Record<AdaptiveStrategy, number>;
  durationWeights: Record<AdaptiveDuration, number>;
  detailWeights: Record<AdaptiveDetail, number>;
}

export interface AdaptiveSignalInput {
  evidenceType: "explicit_feedback" | "observed_behavior" | "hypothesis";
  /** Il silenzio (undefined/false) non viene mai interpretato come preferenza. */
  isSilence?: boolean;
  strategy?: AdaptiveStrategy;
  duration?: AdaptiveDuration;
  detail?: AdaptiveDetail;
  direction: "positive" | "negative";
  dataSource: string;
  summary: string;
  uncertaintyNote: string;
  targetSubsystem?: string;
  nowIso?: string;
}

export interface AdaptationHints {
  allowed: boolean;
  insufficientData: boolean;
  preferredDuration: AdaptiveDuration;
  preferredDetail: AdaptiveDetail;
  recommendedStrategy: AdaptiveStrategy;
  strategyWeights: Record<AdaptiveStrategy, number>;
  durationWeights: Record<AdaptiveDuration, number>;
  detailWeights: Record<AdaptiveDetail, number>;
  confidence: Confidence;
  epistemicTag: EpistemicTag;
  uncertaintyNote: string;
  guardDecision: LearningGuardDecision;
}

export interface AdaptiveLearningOperationResult {
  allowed: boolean;
  reason: string;
  profile?: AdaptiveProfile;
  guardDecision: LearningGuardDecision;
}

export interface AdaptiveProfileExport {
  exportType: "aura_adaptive_learning";
  version: 1;
  exportedAt: string;
  profile: AdaptiveProfile;
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ADAPTIVE_WEIGHT;
  return Math.max(
    MIN_ADAPTIVE_WEIGHT,
    Math.min(MAX_ADAPTIVE_WEIGHT, Math.round(value * 100) / 100)
  );
}

function createDefaultProfile(nowIso: string = new Date().toISOString()): AdaptiveProfile {
  return {
    version: 1,
    updatedAt: nowIso,
    signalCount: 0,
    strategyWeights: {
      STANDARD: DEFAULT_ADAPTIVE_WEIGHT,
      LIGHT: DEFAULT_ADAPTIVE_WEIGHT,
      DEFERRED: DEFAULT_ADAPTIVE_WEIGHT,
    },
    durationWeights: {
      short: DEFAULT_ADAPTIVE_WEIGHT,
      medium: DEFAULT_ADAPTIVE_WEIGHT,
      long: DEFAULT_ADAPTIVE_WEIGHT,
    },
    detailWeights: {
      concise: DEFAULT_ADAPTIVE_WEIGHT,
      balanced: DEFAULT_ADAPTIVE_WEIGHT,
      detailed: DEFAULT_ADAPTIVE_WEIGHT,
    },
  };
}

function isValidWeightMap(obj: unknown, keys: string[]): boolean {
  if (!obj || typeof obj !== "object") return false;
  const rec = obj as Record<string, unknown>;
  return keys.every(
    (k) =>
      typeof rec[k] === "number" &&
      Number.isFinite(rec[k]) &&
      (rec[k] as number) >= MIN_ADAPTIVE_WEIGHT &&
      (rec[k] as number) <= MAX_ADAPTIVE_WEIGHT
  );
}

function isValidAdaptiveProfile(raw: unknown): raw is AdaptiveProfile {
  if (!raw || typeof raw !== "object") return false;
  const p = raw as Record<string, unknown>;
  return (
    p.version === 1 &&
    typeof p.updatedAt === "string" &&
    !Number.isNaN(Date.parse(p.updatedAt)) &&
    typeof p.signalCount === "number" &&
    Number.isFinite(p.signalCount) &&
    p.signalCount >= 0 &&
    isValidWeightMap(p.strategyWeights, ["STANDARD", "LIGHT", "DEFERRED"]) &&
    isValidWeightMap(p.durationWeights, ["short", "medium", "long"]) &&
    isValidWeightMap(p.detailWeights, ["concise", "balanced", "detailed"])
  );
}

function decayWeightTowardBaseline(
  weight: number,
  elapsedDays: number,
  decayRatePerDay: number
): number {
  if (elapsedDays <= 0) return clampWeight(weight);
  const factor = Math.max(0, 1 - elapsedDays * decayRatePerDay);
  const decayed = DEFAULT_ADAPTIVE_WEIGHT + (weight - DEFAULT_ADAPTIVE_WEIGHT) * factor;
  return clampWeight(decayed);
}

function pickTopKey<T extends string>(weights: Record<T, number>, fallback: T): T {
  let bestKey = fallback;
  let bestVal = weights[fallback];
  for (const [k, v] of Object.entries(weights) as [T, number][]) {
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestKey;
}

/**
 * Adaptive Learning Engine V1.
 * Gestisce un profilo di adattamento operativo locale separato (aura_adaptive_learning_v1),
 * indipendente da AuraMemoryStore, protetto dal Learning Safety Guard V1.
 */
export class AdaptiveLearningEngine {
  private readonly adapter: StorageAdapter;
  private readonly decayRatePerDay: number;

  constructor(
    storage?: MinimalWebStorage | StorageAdapter | null,
    decayRatePerDay: number = DEFAULT_DECAY_RATE_PER_DAY
  ) {
    if (storage && "isAvailable" in storage) {
      this.adapter = storage;
    } else if (storage === null) {
      this.adapter = new MemoryStorageAdapter();
    } else {
      const local = new LocalStorageAdapter(storage);
      this.adapter = local.isAvailable() ? local : new MemoryStorageAdapter();
    }
    this.decayRatePerDay = Math.max(0, Math.min(0.5, decayRatePerDay));
  }

  private readRawProfile(nowIso: string): {
    ok: boolean;
    corrupted: boolean;
    profile: AdaptiveProfile;
  } {
    if (!this.adapter.isAvailable()) {
      return { ok: false, corrupted: false, profile: createDefaultProfile(nowIso) };
    }
    try {
      const raw = this.adapter.getItem(ADAPTIVE_LEARNING_STORAGE_KEY);
      if (!raw) {
        return { ok: true, corrupted: false, profile: createDefaultProfile(nowIso) };
      }
      const parsed = JSON.parse(raw);
      if (!isValidAdaptiveProfile(parsed)) {
        return { ok: false, corrupted: true, profile: createDefaultProfile(nowIso) };
      }
      return { ok: true, corrupted: false, profile: parsed };
    } catch {
      return { ok: false, corrupted: true, profile: createDefaultProfile(nowIso) };
    }
  }

  private applyDecayToProfile(profile: AdaptiveProfile, nowIso: string): AdaptiveProfile {
    const prevMs = Date.parse(profile.updatedAt);
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(prevMs) || Number.isNaN(nowMs) || nowMs <= prevMs) {
      return profile;
    }
    const elapsedDays = (nowMs - prevMs) / (1000 * 60 * 60 * 24);
    if (elapsedDays < 0.01) return profile;

    return {
      ...profile,
      updatedAt: nowIso,
      strategyWeights: {
        STANDARD: decayWeightTowardBaseline(
          profile.strategyWeights.STANDARD,
          elapsedDays,
          this.decayRatePerDay
        ),
        LIGHT: decayWeightTowardBaseline(
          profile.strategyWeights.LIGHT,
          elapsedDays,
          this.decayRatePerDay
        ),
        DEFERRED: decayWeightTowardBaseline(
          profile.strategyWeights.DEFERRED,
          elapsedDays,
          this.decayRatePerDay
        ),
      },
      durationWeights: {
        short: decayWeightTowardBaseline(
          profile.durationWeights.short,
          elapsedDays,
          this.decayRatePerDay
        ),
        medium: decayWeightTowardBaseline(
          profile.durationWeights.medium,
          elapsedDays,
          this.decayRatePerDay
        ),
        long: decayWeightTowardBaseline(
          profile.durationWeights.long,
          elapsedDays,
          this.decayRatePerDay
        ),
      },
      detailWeights: {
        concise: decayWeightTowardBaseline(
          profile.detailWeights.concise,
          elapsedDays,
          this.decayRatePerDay
        ),
        balanced: decayWeightTowardBaseline(
          profile.detailWeights.balanced,
          elapsedDays,
          this.decayRatePerDay
        ),
        detailed: decayWeightTowardBaseline(
          profile.detailWeights.detailed,
          elapsedDays,
          this.decayRatePerDay
        ),
      },
    };
  }

  recordSignal(
    consentState: LearningConsentState,
    signal: AdaptiveSignalInput,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string }
  ): AdaptiveLearningOperationResult {
    const nowIso = signal.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();

    // Il silenzio non è mai una preferenza
    if (signal.isSilence === true) {
      const decision = evaluateLearningSafety({
        operation: "approve",
        consentState,
        crisisBlocked: options?.crisisBlocked,
        userTextForSafetyCheck: options?.userTextForSafetyCheck,
        storageAvailable,
        nowIso,
        payload: {
          stage: "observation",
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          confidence: 0.1,
          dataSource: signal.dataSource || "silence",
          timestamp: nowIso,
          uncertaintyNote: "Il silenzio non viene interpretato come preferenza.",
          summary: "Silenzio ignorato",
          userExplicitApproval: false,
        },
      });
      return {
        allowed: false,
        reason: "Il silenzio dell'utente non viene mai interpretato come preferenza.",
        guardDecision: decision,
      };
    }

    // Registra esclusivamente explicit_feedback e observed_behavior (mai hypothesis)
    if (
      signal.evidenceType !== "explicit_feedback" &&
      signal.evidenceType !== "observed_behavior"
    ) {
      const decision = evaluateLearningSafety({
        operation: "write",
        consentState,
        crisisBlocked: options?.crisisBlocked,
        userTextForSafetyCheck: options?.userTextForSafetyCheck,
        storageAvailable,
        nowIso,
      });
      return {
        allowed: false,
        reason:
          "Solo feedback espliciti e comportamenti operativi consentiti possono aggiornare il profilo adattivo.",
        guardDecision: {
          ...decision,
          allowed: false,
          failClosed: true,
          blockedBy: decision.blockedBy ?? "invalid_payload",
        },
      };
    }

    const loaded = this.readRawProfile(nowIso);
    const payload: LearningPayload = {
      stage: "observation",
      evidenceType: signal.evidenceType,
      epistemicTag:
        signal.evidenceType === "explicit_feedback"
          ? "fatto_osservato"
          : "interpretazione_prudente",
      confidence: signal.evidenceType === "explicit_feedback" ? 0.75 : 0.55,
      dataSource: signal.dataSource,
      timestamp: nowIso,
      uncertaintyNote: signal.uncertaintyNote,
      summary: signal.summary,
      targetSubsystem: signal.targetSubsystem,
    };

    const guardDecision = evaluateLearningSafety({
      operation: "write",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    const baseProfile = this.applyDecayToProfile(loaded.profile, nowIso);
    const magnitude = signal.evidenceType === "explicit_feedback" ? 0.12 : 0.06;
    const delta = signal.direction === "positive" ? magnitude : -magnitude;

    const updated: AdaptiveProfile = {
      ...baseProfile,
      updatedAt: nowIso,
      signalCount: baseProfile.signalCount + 1,
      strategyWeights: { ...baseProfile.strategyWeights },
      durationWeights: { ...baseProfile.durationWeights },
      detailWeights: { ...baseProfile.detailWeights },
    };

    if (signal.strategy) {
      updated.strategyWeights[signal.strategy] = clampWeight(
        updated.strategyWeights[signal.strategy] + delta
      );
    }
    if (signal.duration) {
      updated.durationWeights[signal.duration] = clampWeight(
        updated.durationWeights[signal.duration] + delta
      );
    }
    if (signal.detail) {
      updated.detailWeights[signal.detail] = clampWeight(
        updated.detailWeights[signal.detail] + delta
      );
    }

    try {
      this.adapter.setItem(ADAPTIVE_LEARNING_STORAGE_KEY, JSON.stringify(updated));
      return {
        allowed: true,
        reason: "Profilo di adattamento operativo aggiornato in modo controllato.",
        profile: updated,
        guardDecision,
      };
    } catch {
      return {
        allowed: false,
        reason:
          "Impossibile salvare il profilo nello storage locale (fail-closed senza impatto su chat o voce).",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "storage_unavailable",
        },
      };
    }
  }

  getAdaptationHints(
    consentState: LearningConsentState,
    options?: {
      crisisBlocked?: boolean;
      userTextForSafetyCheck?: string;
      nowIso?: string;
    }
  ): AdaptationHints {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readRawProfile(nowIso);

    const guardDecision = evaluateLearningSafety({
      operation: "read",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      nowIso,
    });

    const neutral = createDefaultProfile(nowIso);
    if (!guardDecision.allowed) {
      return {
        allowed: false,
        insufficientData: true,
        preferredDuration: "medium",
        preferredDetail: "balanced",
        recommendedStrategy: "STANDARD",
        strategyWeights: neutral.strategyWeights,
        durationWeights: neutral.durationWeights,
        detailWeights: neutral.detailWeights,
        confidence: 0,
        epistemicTag: "ipotesi_da_verificare",
        uncertaintyNote: guardDecision.reason,
        guardDecision,
      };
    }

    const decayed = this.applyDecayToProfile(loaded.profile, nowIso);
    const insufficientData = decayed.signalCount < 3;
    const confidence = insufficientData
      ? Math.round((decayed.signalCount / 6) * 100) / 100
      : Math.min(0.9, Math.round((0.5 + decayed.signalCount * 0.04) * 100) / 100);

    return {
      allowed: true,
      insufficientData,
      preferredDuration: pickTopKey(decayed.durationWeights, "medium"),
      preferredDetail: pickTopKey(decayed.detailWeights, "balanced"),
      recommendedStrategy: pickTopKey(decayed.strategyWeights, "STANDARD"),
      strategyWeights: { ...decayed.strategyWeights },
      durationWeights: { ...decayed.durationWeights },
      detailWeights: { ...decayed.detailWeights },
      confidence,
      epistemicTag: insufficientData ? "ipotesi_da_verificare" : "interpretazione_prudente",
      uncertaintyNote: insufficientData
        ? `Segnali insufficienti (${decayed.signalCount}/3): applicati valori neutri di default.`
        : "Suggerimenti operativi adattivi con decadimento temporale controllato e limiti [0.5, 1.5].",
      guardDecision,
    };
  }

  exportProfileJson(
    consentState: LearningConsentState,
    options?: {
      crisisBlocked?: boolean;
      userTextForSafetyCheck?: string;
      nowIso?: string;
    }
  ): { allowed: boolean; json?: string; reason: string; guardDecision: LearningGuardDecision } {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readRawProfile(nowIso);

    const guardDecision = evaluateLearningSafety({
      operation: "read",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    const decayed = this.applyDecayToProfile(loaded.profile, nowIso);
    const payload: AdaptiveProfileExport = {
      exportType: "aura_adaptive_learning",
      version: 1,
      exportedAt: nowIso,
      profile: decayed,
    };

    return {
      allowed: true,
      json: JSON.stringify(payload, null, 2),
      reason: "Esportazione JSON del profilo di adattamento completata.",
      guardDecision,
    };
  }

  resetProfile(
    consentState: LearningConsentState,
    options?: {
      crisisBlocked?: boolean;
      userTextForSafetyCheck?: string;
      nowIso?: string;
    }
  ): AdaptiveLearningOperationResult {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();

    const guardDecision = evaluateLearningSafety({
      operation: "clear",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    try {
      this.adapter.removeItem(ADAPTIVE_LEARNING_STORAGE_KEY);
      return {
        allowed: true,
        reason:
          "Profilo di adattamento locale cancellato con conferma esplicita (AI Memory e dati operativi intatti).",
        profile: createDefaultProfile(nowIso),
        guardDecision,
      };
    } catch {
      return {
        allowed: false,
        reason: "Errore durante la cancellazione del profilo nello storage locale.",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "storage_unavailable",
        },
      };
    }
  }
}
