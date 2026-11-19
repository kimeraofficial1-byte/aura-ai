import {
  ProgressiveSpeechBuffer,
  type ProgressiveBufferConfig,
} from "./progressiveSpeechBuffer";
import {
  AuraSpeechRecognitionService,
  type SpeechRecognitionCallbacks,
} from "./speechRecognition";
import {
  AuraSpeechSynthesisService,
  type SpeechSynthesisCallbacks,
} from "./speechSynthesis";
import {
  AuraTurnTakingEngine,
  type TurnTakingCallbacks,
} from "./turnTaking";
import type {
  SpeechRecognitionConstructor,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceConstructor,
  TurnTakingConfig,
  TurnTakingSnapshot,
  TurnTakingTimerAdapter,
  VoiceCapabilities,
  VoicePreferences,
  VoiceRecognitionStatus,
  VoiceSynthesisStatus,
} from "./types";

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  lang: "it-IT",
  rate: 1.0,
  pitch: 1.0,
  voiceModeEnabled: false,
  autoSpeakResponses: true,
};

export class AuraVoiceEngine {
  private readonly recognition: AuraSpeechRecognitionService;
  private readonly synthesis: AuraSpeechSynthesisService;
  private readonly turnTaking: AuraTurnTakingEngine;
  private readonly progressiveBuffer: ProgressiveSpeechBuffer;
  private preferences: VoicePreferences;
  private externalTurnCallbacks: TurnTakingCallbacks = {};
  private progressiveActive = false;
  private progressiveHadError = false;
  private progressiveCallbacks?: SpeechSynthesisCallbacks;

  constructor(options?: {
    globalObj?: unknown;
    recognitionCtor?: SpeechRecognitionConstructor | null;
    synthesis?: SpeechSynthesisLike | null;
    UtteranceCtor?: SpeechSynthesisUtteranceConstructor | null;
    initialPreferences?: Partial<VoicePreferences>;
    turnTakingConfig?: Partial<TurnTakingConfig>;
    progressiveBufferConfig?: Partial<ProgressiveBufferConfig>;
    timers?: TurnTakingTimerAdapter;
  }) {
    this.recognition = new AuraSpeechRecognitionService({
      globalObj: options?.globalObj,
      recognitionCtor: options?.recognitionCtor,
    });
    this.synthesis = new AuraSpeechSynthesisService({
      globalObj: options?.globalObj,
      synthesis: options?.synthesis,
      UtteranceCtor: options?.UtteranceCtor,
    });
    this.progressiveBuffer = new ProgressiveSpeechBuffer(options?.progressiveBufferConfig);
    this.turnTaking = new AuraTurnTakingEngine({
      config: options?.turnTakingConfig,
      timers: options?.timers,
      callbacks: {
        onStateChange: (snapshot) => {
          this.externalTurnCallbacks.onStateChange?.(snapshot);
        },
        onTurnEnd: (reason, snapshot) => {
          // Quando termina il turno per pausa lunga o timeout, ferma l'ascolto
          // preservando interamente il testo già trascritto.
          if (reason === "long_pause" || reason === "max_timeout") {
            this.recognition.stop();
          }
          this.externalTurnCallbacks.onTurnEnd?.(reason, snapshot);
        },
      },
    });
    this.preferences = {
      ...DEFAULT_VOICE_PREFERENCES,
      ...options?.initialPreferences,
    };
  }

  getCapabilities(): VoiceCapabilities {
    return {
      speechRecognitionSupported: this.recognition.isSupported(),
      speechSynthesisSupported: this.synthesis.isSupported(),
      pauseResumeSupported: this.synthesis.isPauseResumeSupported(),
    };
  }

  getPreferences(): VoicePreferences {
    return { ...this.preferences };
  }

  getTurnTakingSnapshot(): TurnTakingSnapshot {
    return this.turnTaking.getSnapshot();
  }

  getTurnTakingConfig(): TurnTakingConfig {
    return this.turnTaking.getConfig();
  }

  setTurnTakingConfig(partial: Partial<TurnTakingConfig>): TurnTakingConfig {
    return this.turnTaking.updateConfig(partial);
  }

  setTurnTakingCallbacks(callbacks: TurnTakingCallbacks): void {
    this.externalTurnCallbacks = callbacks;
  }

  notifyProcessingStart(): TurnTakingSnapshot {
    return this.turnTaking.onProcessingStart();
  }

  notifyProcessingEnd(): TurnTakingSnapshot {
    return this.turnTaking.onProcessingEnd();
  }

  interruptAura(callbacks?: {
    onSynthesisStatus?: (s: VoiceSynthesisStatus) => void;
    onRecognitionStatus?: (s: VoiceRecognitionStatus) => void;
  }): TurnTakingSnapshot {
    this.progressiveActive = false;
    this.progressiveBuffer.clear();
    this.synthesis.stop(callbacks?.onSynthesisStatus);
    this.recognition.stop();
    if (this.recognition.isSupported()) {
      callbacks?.onRecognitionStatus?.("idle");
    }
    return this.turnTaking.onInterruptAura();
  }

  /**
   * Avvia una sessione di lettura vocale progressiva collegata allo stream SSE esistente.
   */
  startProgressiveResponse(callbacks?: SpeechSynthesisCallbacks): boolean {
    this.progressiveBuffer.reset();
    this.progressiveHadError = false;
    this.progressiveCallbacks = callbacks;

    if (
      !this.preferences.voiceModeEnabled ||
      !this.preferences.autoSpeakResponses ||
      !this.synthesis.isSupported()
    ) {
      this.progressiveActive = false;
      return false;
    }

    this.synthesis.stop(callbacks?.onStatusChange);
    this.progressiveActive = true;
    return true;
  }

  /**
   * Alimenta il buffer progressivo con il testo cumulativo ricevuto da SSE `chunk`
   * e accoda subito le frasi pronte in SpeechSynthesis.
   */
  pushProgressiveAccumulatedText(accumulatedText: string): string[] {
    if (!this.progressiveActive) return [];
    const readySegments = this.progressiveBuffer.pushAccumulated(accumulatedText);
    for (const segment of readySegments) {
      this.enqueueProgressiveSegment(segment);
    }
    return readySegments;
  }

  /**
   * Chiude lo stream progressivo, legge l'ultimo frammento o effettua fallback
   * alla lettura completa se nessun segmento era stato accodato o in caso di errore.
   */
  finishProgressiveResponse(finalText: string): boolean {
    if (!this.progressiveActive) return false;

    const remainingSegments = this.progressiveBuffer.flushFinal(finalText);
    const totalEmitted = this.progressiveBuffer.getEmittedSegments().length;

    if (this.progressiveHadError) {
      this.progressiveActive = false;
      return this.speakReply(finalText, {
        force: false,
        callbacks: this.progressiveCallbacks,
      });
    }

    if (remainingSegments.length > 0) {
      for (const segment of remainingSegments) {
        this.enqueueProgressiveSegment(segment);
      }
      this.progressiveActive = false;
      return true;
    }

    this.progressiveActive = false;
    if (totalEmitted === 0 && finalText.trim()) {
      return this.speakReply(finalText, {
        force: false,
        callbacks: this.progressiveCallbacks,
      });
    }
    return totalEmitted > 0;
  }

  cancelProgressiveResponse(onStatusChange?: (status: VoiceSynthesisStatus) => void): void {
    this.progressiveActive = false;
    this.progressiveBuffer.clear();
    this.synthesis.stop(onStatusChange);
  }

  getPendingSpeechQueueLength(): number {
    return this.synthesis.getQueueLength();
  }

  private enqueueProgressiveSegment(segment: string): void {
    this.synthesis.enqueue(segment, {
      lang: this.preferences.lang,
      rate: this.preferences.rate,
      pitch: this.preferences.pitch,
      callbacks: {
        onStatusChange: (status) => {
          if (status === "speaking") {
            this.turnTaking.onAuraSpeakingStart();
          } else if (status === "idle") {
            this.turnTaking.onAuraSpeakingEnd();
          }
          this.progressiveCallbacks?.onStatusChange?.(status);
        },
        onError: (err) => {
          this.progressiveHadError = true;
          this.turnTaking.onError();
          this.progressiveCallbacks?.onError?.(err);
        },
      },
    });
  }

  setVoiceModeEnabled(
    enabled: boolean,
    callbacks?: {
      onRecognitionStatus?: (s: VoiceRecognitionStatus) => void;
      onSynthesisStatus?: (s: VoiceSynthesisStatus) => void;
    }
  ): VoicePreferences {
    this.preferences = {
      ...this.preferences,
      voiceModeEnabled: enabled,
    };

    if (!enabled) {
      this.progressiveActive = false;
      this.progressiveBuffer.clear();
      this.recognition.stop();
      if (this.recognition.isSupported()) {
        callbacks?.onRecognitionStatus?.("idle");
      }
      this.synthesis.stop(callbacks?.onSynthesisStatus);
      this.turnTaking.reset();
    }

    return this.getPreferences();
  }

  setAutoSpeakResponses(enabled: boolean): VoicePreferences {
    this.preferences = {
      ...this.preferences,
      autoSpeakResponses: enabled,
    };
    return this.getPreferences();
  }

  startListening(
    callbacks: SpeechRecognitionCallbacks & {
      onSynthesisStatus?: (s: VoiceSynthesisStatus) => void;
    },
    initialText = ""
  ): boolean {
    const wasAuraSpeaking = this.turnTaking.getSnapshot().state === "AURA_SPEAKING";

    // Barge-in: se l'utente inizia a parlare mentre AURA legge, interrompi subito TTS e coda vocale
    this.progressiveActive = false;
    this.progressiveBuffer.clear();
    this.synthesis.stop(callbacks.onSynthesisStatus);
    if (wasAuraSpeaking) {
      this.turnTaking.onInterruptAura();
    }

    const started = this.recognition.start(
      {
        onTranscript: (payload) => {
          this.turnTaking.onSpeechActivity({
            hasInterim: payload.interimTranscript.trim().length > 0,
            hasFinal: payload.finalTranscript.trim().length > 0,
          });
          callbacks.onTranscript?.(payload);
        },
        onStatusChange: (status) => {
          if (status === "listening") {
            this.turnTaking.onListeningStart();
          } else if (status === "idle") {
            this.turnTaking.onRecognitionEnd();
          } else if (status === "error" || status === "unsupported") {
            this.turnTaking.onError();
          }
          callbacks.onStatusChange?.(status);
        },
        onError: (err) => {
          this.turnTaking.onError();
          callbacks.onError?.(err);
        },
      },
      {
        lang: this.preferences.lang,
        initialText,
      }
    );

    if (!started) {
      this.turnTaking.onError();
    }

    return started;
  }

  stopListening(onRecognitionStatus?: (s: VoiceRecognitionStatus) => void): void {
    this.recognition.stop();
    this.turnTaking.onManualStopListening();
    if (this.recognition.isSupported()) {
      onRecognitionStatus?.("idle");
    }
  }

  speakReply(
    text: string,
    options?: { force?: boolean; callbacks?: SpeechSynthesisCallbacks }
  ): boolean {
    if (!options?.force && !this.preferences.voiceModeEnabled) {
      return false;
    }
    return this.synthesis.speak(text, {
      lang: this.preferences.lang,
      rate: this.preferences.rate,
      pitch: this.preferences.pitch,
      callbacks: {
        onStatusChange: (status) => {
          if (status === "speaking") {
            this.turnTaking.onAuraSpeakingStart();
          } else if (status === "idle") {
            this.turnTaking.onAuraSpeakingEnd();
          }
          options?.callbacks?.onStatusChange?.(status);
        },
        onError: (err) => {
          this.turnTaking.onError();
          options?.callbacks?.onError?.(err);
        },
      },
    });
  }

  pauseSpeaking(onStatusChange?: (status: VoiceSynthesisStatus) => void): boolean {
    return this.synthesis.pause(onStatusChange);
  }

  resumeSpeaking(onStatusChange?: (status: VoiceSynthesisStatus) => void): boolean {
    return this.synthesis.resume(onStatusChange);
  }

  stopSpeaking(onStatusChange?: (status: VoiceSynthesisStatus) => void): void {
    this.progressiveActive = false;
    this.progressiveBuffer.clear();
    this.synthesis.stop(onStatusChange);
    this.turnTaking.onAuraSpeakingEnd();
  }

  dispose(): void {
    this.progressiveActive = false;
    this.progressiveBuffer.clear();
    this.recognition.stop();
    this.synthesis.dispose();
    this.turnTaking.reset();
  }
}
