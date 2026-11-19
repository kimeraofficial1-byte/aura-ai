import type {
  TurnEndReason,
  TurnTakingConfig,
  TurnTakingSnapshot,
  TurnTakingState,
  TurnTakingTimerAdapter,
} from "./types";

export const DEFAULT_TURN_TAKING_CONFIG: TurnTakingConfig = {
  shortPauseMs: 700,
  longPauseMs: 1500,
  maxTurnTimeoutMs: 5000,
};

export interface TurnTakingCallbacks {
  onStateChange?: (snapshot: TurnTakingSnapshot) => void;
  onTurnEnd?: (reason: TurnEndReason, snapshot: TurnTakingSnapshot) => void;
}

const DEFAULT_TIMERS: TurnTakingTimerAdapter = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export function sanitizeTurnTakingConfig(
  partial?: Partial<TurnTakingConfig>,
  base: TurnTakingConfig = DEFAULT_TURN_TAKING_CONFIG
): TurnTakingConfig {
  const shortPauseMs = Math.max(
    200,
    Math.min(5000, Math.round(partial?.shortPauseMs ?? base.shortPauseMs))
  );
  const longPauseMs = Math.max(
    shortPauseMs + 200,
    Math.min(10_000, Math.round(partial?.longPauseMs ?? base.longPauseMs))
  );
  const maxTurnTimeoutMs = Math.max(
    longPauseMs + 500,
    Math.min(30_000, Math.round(partial?.maxTurnTimeoutMs ?? base.maxTurnTimeoutMs))
  );

  return {
    shortPauseMs,
    longPauseMs,
    maxTurnTimeoutMs,
  };
}

export class AuraTurnTakingEngine {
  private state: TurnTakingState = "IDLE";
  private sentenceFinalized = false;
  private pausePhase: "none" | "short" | "long" = "none";
  private lastTurnEndReason: TurnEndReason | null = null;
  private interruptedAura = false;
  private config: TurnTakingConfig;
  private readonly timers: TurnTakingTimerAdapter;
  private callbacks: TurnTakingCallbacks;

  private shortPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private longPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private hasSpeechInCurrentTurn = false;

  constructor(options?: {
    config?: Partial<TurnTakingConfig>;
    timers?: TurnTakingTimerAdapter;
    callbacks?: TurnTakingCallbacks;
  }) {
    this.config = sanitizeTurnTakingConfig(options?.config);
    this.timers = options?.timers ?? DEFAULT_TIMERS;
    this.callbacks = options?.callbacks ?? {};
  }

  setCallbacks(callbacks: TurnTakingCallbacks): void {
    this.callbacks = callbacks;
  }

  getConfig(): TurnTakingConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<TurnTakingConfig>): TurnTakingConfig {
    this.config = sanitizeTurnTakingConfig(partial, this.config);
    this.emitState();
    return this.getConfig();
  }

  getSnapshot(): TurnTakingSnapshot {
    return {
      state: this.state,
      sentenceFinalized: this.sentenceFinalized,
      pausePhase: this.pausePhase,
      lastTurnEndReason: this.lastTurnEndReason,
      interruptedAura: this.interruptedAura,
      vadSupported: false,
      config: { ...this.config },
    };
  }

  private emitState(): void {
    this.callbacks.onStateChange?.(this.getSnapshot());
  }

  private clearPauseTimers(): void {
    if (this.shortPauseTimer !== null) {
      this.timers.clearTimeout(this.shortPauseTimer);
      this.shortPauseTimer = null;
    }
    if (this.longPauseTimer !== null) {
      this.timers.clearTimeout(this.longPauseTimer);
      this.longPauseTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearPauseTimers();
    if (this.maxTimeoutTimer !== null) {
      this.timers.clearTimeout(this.maxTimeoutTimer);
      this.maxTimeoutTimer = null;
    }
  }

  private armMaxTurnTimer(): void {
    if (this.maxTimeoutTimer !== null) {
      this.timers.clearTimeout(this.maxTimeoutTimer);
    }
    this.maxTimeoutTimer = this.timers.setTimeout(() => {
      if (
        this.state === "LISTENING" ||
        this.state === "USER_SPEAKING" ||
        this.state === "USER_PAUSED"
      ) {
        this.finishTurn("max_timeout");
      }
    }, this.config.maxTurnTimeoutMs);
  }

  private armPauseTimers(): void {
    this.clearPauseTimers();

    this.shortPauseTimer = this.timers.setTimeout(() => {
      if (this.state === "USER_SPEAKING") {
        this.state = "USER_PAUSED";
        this.pausePhase = "short";
        this.emitState();
      }
    }, this.config.shortPauseMs);

    this.longPauseTimer = this.timers.setTimeout(() => {
      if (this.state === "USER_SPEAKING" || this.state === "USER_PAUSED") {
        this.pausePhase = "long";
        this.finishTurn("long_pause");
      }
    }, this.config.longPauseMs);
  }

  private finishTurn(reason: TurnEndReason): void {
    this.clearAllTimers();
    this.lastTurnEndReason = reason;
    this.state = "IDLE";
    const snapshot = this.getSnapshot();
    this.callbacks.onStateChange?.(snapshot);
    this.callbacks.onTurnEnd?.(reason, snapshot);
  }

  /**
   * Chiamato quando l'utente avvia il microfono mentre AURA sta parlando (barge-in)
   * oppure preme il pulsante Interrompi.
   */
  onInterruptAura(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.interruptedAura = true;
    this.pausePhase = "none";
    this.state = "INTERRUPTED";
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Chiamato quando SpeechRecognition entra in ascolto attivo.
   */
  onListeningStart(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.hasSpeechInCurrentTurn = false;
    this.sentenceFinalized = false;
    this.pausePhase = "none";
    this.lastTurnEndReason = null;
    this.state = "LISTENING";
    this.armMaxTurnTimer();
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Chiamato ad ogni evento SpeechRecognition onresult (interim o final).
   * Non utilizza VAD fittizio: si basa esclusivamente sugli eventi reali di SpeechRecognition.
   */
  onSpeechActivity(options: { hasInterim: boolean; hasFinal: boolean }): TurnTakingSnapshot {
    if (
      this.state !== "LISTENING" &&
      this.state !== "USER_SPEAKING" &&
      this.state !== "USER_PAUSED" &&
      this.state !== "INTERRUPTED"
    ) {
      return this.getSnapshot();
    }

    this.hasSpeechInCurrentTurn = true;
    this.interruptedAura = false;
    this.pausePhase = "none";
    if (options.hasFinal) {
      this.sentenceFinalized = true;
    } else if (options.hasInterim) {
      this.sentenceFinalized = false;
    }

    this.state = "USER_SPEAKING";
    this.armPauseTimers();
    this.armMaxTurnTimer();
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Chiamato quando l'utente ferma manualmente il microfono.
   */
  onManualStopListening(): TurnTakingSnapshot {
    if (
      this.state === "LISTENING" ||
      this.state === "USER_SPEAKING" ||
      this.state === "USER_PAUSED" ||
      this.state === "INTERRUPTED"
    ) {
      this.clearAllTimers();
      this.lastTurnEndReason = "manual_stop";
      this.pausePhase = "none";
      this.state = "IDLE";
      this.emitState();
    }
    return this.getSnapshot();
  }

  /**
   * Chiamato quando SpeechRecognition termina naturalmente (onend).
   */
  onRecognitionEnd(): TurnTakingSnapshot {
    if (
      this.state === "LISTENING" ||
      this.state === "USER_SPEAKING" ||
      this.state === "USER_PAUSED"
    ) {
      this.clearAllTimers();
      if (this.hasSpeechInCurrentTurn) {
        this.lastTurnEndReason = "recognition_end";
      }
      this.pausePhase = "none";
      this.state = "IDLE";
      this.emitState();
    }
    return this.getSnapshot();
  }

  /**
   * Chiamato quando parte la richiesta verso POST /api/chat.
   */
  onProcessingStart(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.pausePhase = "none";
    this.interruptedAura = false;
    this.state = "PROCESSING";
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Chiamato quando termina l'elaborazione della risposta (prima o senza TTS).
   */
  onProcessingEnd(): TurnTakingSnapshot {
    if (this.state === "PROCESSING") {
      this.state = "IDLE";
      this.emitState();
    }
    return this.getSnapshot();
  }

  /**
   * Chiamato quando inizia la sintesi vocale (TTS) di AURA.
   */
  onAuraSpeakingStart(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.pausePhase = "none";
    this.interruptedAura = false;
    this.state = "AURA_SPEAKING";
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Chiamato quando termina la sintesi vocale (TTS) di AURA.
   */
  onAuraSpeakingEnd(): TurnTakingSnapshot {
    if (this.state === "AURA_SPEAKING") {
      this.state = "IDLE";
      this.emitState();
    }
    return this.getSnapshot();
  }

  /**
   * Chiamato in caso di errore di riconoscimento o sintesi.
   */
  onError(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.pausePhase = "none";
    this.state = "ERROR";
    this.emitState();
    return this.getSnapshot();
  }

  /**
   * Ripristina completamente la macchina a stati (es. disattivazione modalità vocale).
   */
  reset(): TurnTakingSnapshot {
    this.clearAllTimers();
    this.hasSpeechInCurrentTurn = false;
    this.sentenceFinalized = false;
    this.pausePhase = "none";
    this.lastTurnEndReason = null;
    this.interruptedAura = false;
    this.state = "IDLE";
    this.emitState();
    return this.getSnapshot();
  }
}
