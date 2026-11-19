import { ANDROID_KEYBOARD_MIC_HINT } from "./speechRecognition";
import type {
  HandsFreeSnapshot,
  HandsFreeState,
  TurnTakingSnapshot,
  VoiceErrorInfo,
  VoiceRecognitionStatus,
  VoiceSynthesisStatus,
} from "./types";
import type { AuraVoiceEngine } from "./voiceEngine";

export interface HandsFreeCallbacks {
  onSnapshotChange?: (snapshot: HandsFreeSnapshot) => void;
  onRecognitionStatus?: (status: VoiceRecognitionStatus) => void;
  onSynthesisStatus?: (status: VoiceSynthesisStatus) => void;
  onTranscriptUpdate?: (combined: string, interim: string) => void;
  onSubmitTurn?: (transcript: string, turnId: number) => void;
}

const MAX_CONSECUTIVE_ERRORS = 2;

export class HandsFreeSessionManager {
  private readonly voiceEngine: AuraVoiceEngine;
  private callbacks: HandsFreeCallbacks;

  private state: HandsFreeState = "DISABLED";
  private enabled = false;
  private micActive = false;
  private activeTurnId = 0;
  private lastSubmittedTurnId = -1;
  private currentTurnTranscript = "";
  private consecutiveErrors = 0;
  private lastError: VoiceErrorInfo | null = null;
  private lastNotice: string | null = null;

  constructor(voiceEngine: AuraVoiceEngine, callbacks: HandsFreeCallbacks = {}) {
    this.voiceEngine = voiceEngine;
    this.callbacks = callbacks;
  }

  setCallbacks(callbacks: HandsFreeCallbacks): void {
    this.callbacks = callbacks;
  }

  getHandsFreeSnapshot(): HandsFreeSnapshot {
    return {
      state: this.state,
      enabled: this.enabled,
      micActive: this.micActive,
      activeTurnId: this.activeTurnId,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError ? { ...this.lastError } : null,
      lastNotice: this.lastNotice,
    };
  }

  private emit(): HandsFreeSnapshot {
    const snap = this.getHandsFreeSnapshot();
    this.callbacks.onSnapshotChange?.(snap);
    return snap;
  }

  /**
   * Abilita esplicitamente la modalità vivavoce su comando dell'utente.
   * Non attiva mai il microfono automaticamente senza verifica capacità.
   */
  enableHandsFree(): HandsFreeSnapshot {
    const caps = this.voiceEngine.getCapabilities();
    if (!caps.speechRecognitionSupported) {
      return this.handleHandsFreeError({
        code: "UNSUPPORTED",
        message: ANDROID_KEYBOARD_MIC_HINT,
      });
    }

    this.enabled = true;
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.lastNotice = "Modalità vivavoce pronta. Avvio ascolto su tua richiesta.";
    this.state = "READY";
    this.voiceEngine.setVoiceModeEnabled(true);
    this.voiceEngine.setAutoSpeakResponses(true);
    return this.emit();
  }

  /**
   * Disattiva immediatamente la modalità vivavoce e ferma microfono + TTS.
   */
  disableHandsFree(): HandsFreeSnapshot {
    this.state = "STOPPING";
    this.enabled = false;
    this.micActive = false;
    this.activeTurnId += 1;
    this.currentTurnTranscript = "";
    this.consecutiveErrors = 0;
    this.lastNotice = "Modalità vivavoce disattivata.";
    this.voiceEngine.cancelProgressiveResponse(this.callbacks.onSynthesisStatus);
    this.voiceEngine.stopListening(this.callbacks.onRecognitionStatus);
    this.state = "DISABLED";
    return this.emit();
  }

  /**
   * Avvia una sessione di ascolto vivavoce dopo attivazione esplicita.
   */
  startHandsFreeSession(initialDraft = ""): boolean {
    if (!this.enabled) {
      this.enableHandsFree();
      if (!this.enabled) return false;
    }

    const caps = this.voiceEngine.getCapabilities();
    if (!caps.speechRecognitionSupported) {
      this.handleHandsFreeError({
        code: "UNSUPPORTED",
        message: ANDROID_KEYBOARD_MIC_HINT,
      });
      return false;
    }

    this.activeTurnId += 1;
    const turnId = this.activeTurnId;
    this.currentTurnTranscript = initialDraft.trim();
    this.lastError = null;
    this.lastNotice = "Microfono attivo in modalità vivavoce.";

    const started = this.voiceEngine.startListening(
      {
        onSynthesisStatus: this.callbacks.onSynthesisStatus,
        onStatusChange: (status) => {
          this.callbacks.onRecognitionStatus?.(status);
          if (status === "listening") {
            this.micActive = true;
            this.consecutiveErrors = 0;
            this.state = "LISTENING";
            this.emit();
          } else if (status === "idle") {
            this.micActive = false;
            if (
              this.enabled &&
              this.activeTurnId === turnId &&
              (this.state === "LISTENING" ||
                this.state === "USER_SPEAKING" ||
                this.state === "USER_PAUSED")
            ) {
              if (this.currentTurnTranscript.trim()) {
                this.handleUserTurn(this.currentTurnTranscript, turnId);
              } else {
                // Il browser Android ha chiuso l'ascolto senza testo: non riavviare in loop infinito
                this.state = "READY";
                this.lastNotice =
                  "Ascolto terminato dal browser. Tocca Avvia microfono o riattiva vivavoce per continuare.";
                this.emit();
              }
            }
          }
        },
        onTranscript: (payload) => {
          if (this.activeTurnId !== turnId) return;
          this.currentTurnTranscript = payload.combinedTranscript;
          this.callbacks.onTranscriptUpdate?.(
            payload.combinedTranscript,
            payload.interimTranscript
          );
        },
        onError: (err) => {
          this.micActive = false;
          this.handleHandsFreeError(err);
        },
      },
      initialDraft
    );

    if (!started) {
      this.micActive = false;
      return false;
    }

    return true;
  }

  /**
   * Arresto immediato (pulsante STOP): ferma microfono, sintesi e coda vocale
   * senza perdere il testo già presente in chat.
   */
  stopHandsFreeSession(reason?: string): HandsFreeSnapshot {
    this.state = "STOPPING";
    this.micActive = false;
    this.activeTurnId += 1;
    this.voiceEngine.interruptAura({
      onSynthesisStatus: this.callbacks.onSynthesisStatus,
      onRecognitionStatus: this.callbacks.onRecognitionStatus,
    });
    this.enabled = false;
    this.currentTurnTranscript = "";
    this.lastNotice = reason ?? "Sessione vivavoce interrotta.";
    this.state = "INTERRUPTED";
    return this.emit();
  }

  /**
   * Barge-in durante la risposta di AURA: ferma subito TTS/coda,
   * evita sovrapposizioni e riparte in ascolto se vivavoce attivo.
   */
  interruptAndListen(initialDraft = ""): boolean {
    this.activeTurnId += 1;
    this.voiceEngine.interruptAura({
      onSynthesisStatus: this.callbacks.onSynthesisStatus,
      onRecognitionStatus: this.callbacks.onRecognitionStatus,
    });
    this.state = "INTERRUPTED";
    this.lastNotice = "AURA interrotta: ti ascolto.";
    this.emit();
    if (!this.enabled) {
      return false;
    }
    return this.startHandsFreeSession(initialDraft);
  }

  /**
   * Sincronizza gli stati intermedi da AuraTurnTakingEngine (USER_SPEAKING, USER_PAUSED, AURA_SPEAKING).
   */
  syncFromTurnTaking(turnSnapshot: TurnTakingSnapshot): HandsFreeSnapshot {
    if (!this.enabled && this.state === "DISABLED") {
      return this.getHandsFreeSnapshot();
    }

    if (turnSnapshot.state === "USER_SPEAKING" && this.micActive) {
      this.state = "USER_SPEAKING";
      return this.emit();
    }
    if (turnSnapshot.state === "USER_PAUSED" && this.micActive) {
      this.state = "USER_PAUSED";
      return this.emit();
    }
    if (turnSnapshot.state === "AURA_SPEAKING" && this.enabled) {
      this.micActive = false;
      this.state = "AURA_SPEAKING";
      return this.emit();
    }
    if (turnSnapshot.state === "PROCESSING" && this.enabled) {
      this.micActive = false;
      this.state = "PROCESSING";
      return this.emit();
    }
    return this.getHandsFreeSnapshot();
  }

  /**
   * Gestisce la fine del turno utente garantendo l'invio di UNA SOLA richiesta per turno.
   */
  handleUserTurn(transcript: string, turnId: number = this.activeTurnId): boolean {
    const clean = transcript.trim();
    if (!clean) {
      return false;
    }
    if (this.lastSubmittedTurnId === turnId) {
      // Previene richieste duplicate su eventi ripetuti di SpeechRecognition
      return false;
    }

    this.lastSubmittedTurnId = turnId;
    this.micActive = false;
    this.voiceEngine.stopListening(this.callbacks.onRecognitionStatus);
    this.state = "PROCESSING";
    this.lastNotice = "Elaborazione risposta in corso...";
    this.emit();
    this.callbacks.onSubmitTurn?.(clean, turnId);
    return true;
  }

  /**
   * Riprende l'ascolto al termine della risposta vocale di AURA,
   * esclusivamente se la modalità vivavoce è ancora attiva e non ci sono errori bloccanti.
   */
  resumeListeningAfterResponse(): boolean {
    if (!this.enabled) {
      return false;
    }
    if (this.state === "STOPPING" || this.state === "DISABLED" || this.state === "ERROR") {
      return false;
    }
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      this.enabled = false;
      this.state = "ERROR";
      this.lastNotice =
        "Troppi errori consecutivi del microfono. Riattiva manualmente il vivavoce quando sei pronto.";
      this.emit();
      return false;
    }
    return this.startHandsFreeSession("");
  }

  /**
   * Gestisce la sospensione della scheda o il blocco schermo su Android.
   */
  handleVisibilityHidden(): HandsFreeSnapshot {
    if (!this.enabled && !this.micActive) {
      return this.getHandsFreeSnapshot();
    }
    return this.stopHandsFreeSession(
      "La pagina è passata in background o lo schermo è stato bloccato: riattiva il vivavoce quando vuoi."
    );
  }

  /**
   * Gestisce errori di permesso, browser non supportato, TTS o SSE senza loop infiniti.
   */
  handleHandsFreeError(error: VoiceErrorInfo): HandsFreeSnapshot {
    this.micActive = false;
    this.lastError = error;
    this.lastNotice = error.message;
    this.consecutiveErrors += 1;

    const isFatal =
      error.code === "PERMISSION_DENIED" ||
      error.code === "UNSUPPORTED" ||
      this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;

    if (isFatal) {
      this.enabled = false;
      this.activeTurnId += 1;
      this.voiceEngine.cancelProgressiveResponse(this.callbacks.onSynthesisStatus);
      this.voiceEngine.stopListening(this.callbacks.onRecognitionStatus);
    }

    this.state = "ERROR";
    return this.emit();
  }
}
