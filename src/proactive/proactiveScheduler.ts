import { analyzeProactiveOpportunities } from "./proactiveEngine";
import type {
  ProactiveAnalysisInput,
  ProactiveAnalysisResult,
  ProactiveMode,
  ProactiveSchedulerConfig,
} from "./types";

const DEFAULT_MIN_INTERVAL_MS = 60_000;
export const PROACTIVE_MODE_STORAGE_KEY = "aura_proactive_mode_v1";

export function isValidProactiveMode(value: unknown): value is ProactiveMode {
  return value === "PASSIVE" || value === "ASSISTED" || value === "USER-AUTHORIZED";
}

export interface MinimalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPersistedProactiveMode(
  storage?: MinimalStorageLike | null
): ProactiveMode {
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== "undefined"
          ? window.localStorage
          : null;
    if (!target) return "PASSIVE";
    const raw = target.getItem(PROACTIVE_MODE_STORAGE_KEY);
    return isValidProactiveMode(raw) ? raw : "PASSIVE";
  } catch {
    return "PASSIVE";
  }
}

export function savePersistedProactiveMode(
  mode: ProactiveMode,
  storage?: MinimalStorageLike | null
): boolean {
  if (!isValidProactiveMode(mode)) return false;
  try {
    const target =
      storage !== undefined
        ? storage
        : typeof window !== "undefined"
          ? window.localStorage
          : null;
    if (!target) return false;
    target.setItem(PROACTIVE_MODE_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scheduler controllato per Proactive Intelligence Engine V1.
 * - Modalità predefinita: PASSIVE (nessuna esecuzione automatica in background).
 * - Nessun timer permanente obbligatorio.
 * - Nessuna notifica nativa simulata o non autorizzata.
 */
export class ProactiveScheduler {
  private config: ProactiveSchedulerConfig;
  private lastRunAtMs: number | null = null;

  constructor(initial?: Partial<ProactiveSchedulerConfig>) {
    this.config = {
      mode: initial?.mode ?? "PASSIVE",
      suspended: initial?.suspended ?? false,
      minIntervalMs: initial?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      notificationsAuthorized: initial?.notificationsAuthorized ?? false,
    };
  }

  getConfig(): ProactiveSchedulerConfig {
    return { ...this.config };
  }

  setMode(mode: ProactiveMode): void {
    this.config.mode = mode;
    if (mode !== "USER-AUTHORIZED") {
      this.config.notificationsAuthorized = false;
    }
  }

  setMinIntervalMs(ms: number): void {
    this.config.minIntervalMs = Math.max(1000, Math.round(ms));
  }

  setNotificationsAuthorized(authorized: boolean): void {
    this.config.notificationsAuthorized = authorized && this.config.mode === "USER-AUTHORIZED";
  }

  suspend(): void {
    this.config.suspended = true;
  }

  resume(): void {
    this.config.suspended = false;
  }

  /**
   * Verifica se è consentito inviare una notifica browser reale.
   * Non simula mai notifiche se il dispositivo/browser non le supporta o l'utente non ha autorizzato.
   */
  canSendNotification(): boolean {
    if (this.config.suspended) return false;
    if (this.config.mode !== "USER-AUTHORIZED") return false;
    if (!this.config.notificationsAuthorized) return false;
    if (typeof Notification === "undefined") return false;
    return Notification.permission === "granted";
  }

  /**
   * Analisi esplicita richiesta dall'utente (funziona in PASSIVE, ASSISTED, USER-AUTHORIZED
   * purché non sospeso e non bloccato dal Safety Engine).
   */
  runManualAnalysis(
    input: ProactiveAnalysisInput,
    nowMs: number = Date.now()
  ): ProactiveAnalysisResult & { skippedReason?: string } {
    if (this.config.suspended) {
      return {
        safetyBlocked: false,
        generatedAt: input.nowIso ?? new Date(nowMs).toISOString(),
        suggestions: [],
        skippedDuplicates: 0,
        skippedReason: "suspended",
      };
    }

    const result = analyzeProactiveOpportunities(input);
    this.lastRunAtMs = nowMs;
    return result;
  }

  /**
   * Analisi su evento controllato dell'app (es. apertura app).
   * In modalità PASSIVE non si esegue automaticamente senza richiesta esplicita.
   */
  runControlledAppEvent(
    input: ProactiveAnalysisInput,
    nowMs: number = Date.now()
  ): ProactiveAnalysisResult & { skippedReason?: string } {
    if (this.config.suspended) {
      return {
        safetyBlocked: false,
        generatedAt: input.nowIso ?? new Date(nowMs).toISOString(),
        suggestions: [],
        skippedDuplicates: 0,
        skippedReason: "suspended",
      };
    }

    if (this.config.mode === "PASSIVE") {
      return {
        safetyBlocked: false,
        generatedAt: input.nowIso ?? new Date(nowMs).toISOString(),
        suggestions: [],
        skippedDuplicates: 0,
        skippedReason: "passive_mode",
      };
    }

    if (
      this.lastRunAtMs !== null &&
      nowMs - this.lastRunAtMs < this.config.minIntervalMs
    ) {
      return {
        safetyBlocked: false,
        generatedAt: input.nowIso ?? new Date(nowMs).toISOString(),
        suggestions: [],
        skippedDuplicates: 0,
        skippedReason: "min_interval_not_elapsed",
      };
    }

    const result = analyzeProactiveOpportunities(input);
    this.lastRunAtMs = nowMs;
    return result;
  }
}
