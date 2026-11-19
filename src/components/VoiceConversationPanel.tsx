import {
  AlertCircle,
  Hand,
  Mic,
  MicOff,
  Pause,
  Play,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useState } from "react";
import {
  ANDROID_KEYBOARD_MIC_HINT,
  VOICE_BROWSER_PRIVACY_NOTE,
} from "../voice/speechRecognition";
import type {
  HandsFreeSnapshot,
  TurnTakingConfig,
  TurnTakingSnapshot,
  VoiceCapabilities,
  VoiceRecognitionStatus,
  VoiceSynthesisStatus,
} from "../voice/types";

interface VoiceConversationPanelProps {
  capabilities: VoiceCapabilities;
  voiceModeEnabled: boolean;
  autoSpeakResponses: boolean;
  recognitionStatus: VoiceRecognitionStatus;
  synthesisStatus: VoiceSynthesisStatus;
  turnTaking: TurnTakingSnapshot;
  handsFree: HandsFreeSnapshot;
  busy: boolean;
  transcriptDraft: string;
  interimTranscript: string;
  voiceNotice: string | null;
  latestAssistantReply: string | null;
  onToggleVoiceMode: (enabled: boolean) => void;
  onToggleHandsFree: (enabled: boolean) => void;
  onStopHandsFree: () => void;
  onToggleAutoSpeak: (enabled: boolean) => void;
  onStartListening: () => void;
  onStopListening: () => void;
  onInterrupt: () => void;
  onUpdateTurnConfig: (partial: Partial<TurnTakingConfig>) => void;
  onChangeTranscriptDraft: (text: string) => void;
  onSendTranscript: () => void;
  onClearTranscript: () => void;
  onSpeakLatestReply: () => void;
  onPauseSpeaking: () => void;
  onResumeSpeaking: () => void;
  onStopSpeaking: () => void;
}

export function VoiceConversationPanel({
  capabilities,
  voiceModeEnabled,
  autoSpeakResponses,
  recognitionStatus,
  synthesisStatus,
  turnTaking,
  handsFree,
  busy,
  transcriptDraft,
  interimTranscript,
  voiceNotice,
  latestAssistantReply,
  onToggleVoiceMode,
  onToggleHandsFree,
  onStopHandsFree,
  onToggleAutoSpeak,
  onStartListening,
  onStopListening,
  onInterrupt,
  onUpdateTurnConfig,
  onChangeTranscriptDraft,
  onSendTranscript,
  onClearTranscript,
  onSpeakLatestReply,
  onPauseSpeaking,
  onResumeSpeaking,
  onStopSpeaking,
}: VoiceConversationPanelProps) {
  const [showPauseSettings, setShowPauseSettings] = useState(false);

  const isListening =
    recognitionStatus === "listening" ||
    handsFree.micActive ||
    turnTaking.state === "LISTENING" ||
    turnTaking.state === "USER_SPEAKING" ||
    turnTaking.state === "USER_PAUSED";
  const isSpeaking =
    synthesisStatus === "speaking" ||
    turnTaking.state === "AURA_SPEAKING" ||
    handsFree.state === "AURA_SPEAKING";
  const isPaused = synthesisStatus === "paused";
  const isUserPaused = turnTaking.state === "USER_PAUSED" || handsFree.state === "USER_PAUSED";
  const isProcessing =
    busy || turnTaking.state === "PROCESSING" || handsFree.state === "PROCESSING";
  const isInterrupted =
    handsFree.state === "INTERRUPTED" || turnTaking.state === "INTERRUPTED";
  const canInterrupt = isSpeaking || isPaused || isListening || handsFree.enabled;

  const statusLabel = !voiceModeEnabled && !handsFree.enabled
    ? "Modalità vocale disattivata"
    : isProcessing
      ? "ELABORAZIONE"
      : isUserPaused
        ? "In pausa (puoi continuare)"
        : turnTaking.state === "USER_SPEAKING" || handsFree.state === "USER_SPEAKING"
          ? "ASCOLTO · Stai parlando"
          : isListening
            ? "ASCOLTO"
            : isSpeaking
              ? "AURA STA PARLANDO"
              : isPaused
                ? "Lettura in pausa"
                : isInterrupted
                  ? "SESSIONE INTERROTTA"
                  : turnTaking.state === "ERROR" || handsFree.state === "ERROR"
                    ? "Errore vocale"
                    : !capabilities.speechRecognitionSupported &&
                        !capabilities.speechSynthesisSupported
                      ? "Funzioni vocali non supportate"
                      : handsFree.enabled
                        ? "Vivavoce pronto"
                        : "Modalità vocale pronta";

  const statusTone = !voiceModeEnabled && !handsFree.enabled
    ? "idle"
    : isProcessing
      ? "processing"
      : isUserPaused
        ? "paused"
        : isListening
          ? "listening"
          : isSpeaking || isPaused
            ? "speaking"
            : isInterrupted
              ? "interrupted"
              : turnTaking.state === "ERROR" || handsFree.state === "ERROR"
                ? "error"
                : "idle";

  return (
    <div className="voice-panel" data-testid="voice-conversation-panel">
      <div className="voice-panel-top">
        <div className="voice-status-group">
          <span
            className={`voice-status-badge ${statusTone}`}
            data-testid="voice-status-badge"
          >
            {statusLabel}
          </span>
          {isListening && (
            <span
              className="voice-mic-live-badge"
              data-testid="voice-mic-active-badge"
              role="status"
            >
              MICROFONO ATTIVO
            </span>
          )}
          {(voiceModeEnabled || handsFree.enabled) && (
            <span
              className="voice-state-code"
              data-testid="voice-turn-state"
              title="Stato macchina dei turni di parola"
            >
              {handsFree.enabled ? `HF:${handsFree.state}` : turnTaking.state}
            </span>
          )}
        </div>

        <div className="voice-mode-switches">
          <button
            type="button"
            className={`voice-toggle-btn ${handsFree.enabled ? "active" : ""}`}
            onClick={() => onToggleHandsFree(!handsFree.enabled)}
            aria-pressed={handsFree.enabled}
            data-testid="voice-handsfree-toggle"
          >
            <Mic size={14} />
            {handsFree.enabled ? "Disattiva vivavoce" : "Attiva vivavoce"}
          </button>

          <button
            type="button"
            className={`voice-toggle-btn ${voiceModeEnabled ? "active" : ""}`}
            onClick={() => onToggleVoiceMode(!voiceModeEnabled)}
            aria-pressed={voiceModeEnabled}
          >
            {voiceModeEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {voiceModeEnabled ? "Disattiva modalità vocale" : "Attiva modalità vocale"}
          </button>

          {voiceModeEnabled && capabilities.speechSynthesisSupported && (
            <label className="voice-auto-check">
              <input
                type="checkbox"
                checked={autoSpeakResponses}
                onChange={(e) => onToggleAutoSpeak(e.target.checked)}
              />
              <span>Lettura automatica</span>
            </label>
          )}
        </div>
      </div>

      {voiceModeEnabled && (
        <div className="voice-panel-body">
          {/* Controllo principale microfono + Interrompi + controlli lettura */}
          <div className="voice-primary-controls">
            {capabilities.speechRecognitionSupported ? (
              <button
                type="button"
                className={`voice-mic-cta ${isListening ? "recording" : ""}`}
                onClick={isListening ? onStopListening : onStartListening}
                disabled={isProcessing}
                aria-label={isListening ? "Interrompi ascolto" : "Avvia microfono"}
              >
                {isListening ? <MicOff size={20} /> : <Mic size={20} />}
                <span>
                  {isListening
                    ? "Interrompi ascolto"
                    : isSpeaking
                      ? "Parla ora (interrompi AURA)"
                      : "Avvia microfono"}
                </span>
              </button>
            ) : (
              <div className="voice-unsupported-box" data-testid="voice-stt-unsupported">
                <AlertCircle size={15} />
                <span>{ANDROID_KEYBOARD_MIC_HINT}</span>
              </div>
            )}

            <div className="voice-playback-controls">
              {canInterrupt && (
                <button
                  type="button"
                  className="danger-btn voice-touch-btn"
                  onClick={handsFree.enabled ? onStopHandsFree : onInterrupt}
                  data-testid="voice-interrupt-btn"
                >
                  <Hand size={14} /> {handsFree.enabled ? "STOP immediato" : "Interrompi"}
                </button>
              )}

              {capabilities.speechSynthesisSupported ? (
                <>
                  {!isSpeaking && !isPaused && (
                    <button
                      type="button"
                      className="secondary-btn voice-touch-btn"
                      onClick={onSpeakLatestReply}
                      disabled={!latestAssistantReply || isProcessing}
                    >
                      <Volume2 size={14} /> Leggi risposta
                    </button>
                  )}

                  {isSpeaking && capabilities.pauseResumeSupported && (
                    <button
                      type="button"
                      className="secondary-btn voice-touch-btn"
                      onClick={onPauseSpeaking}
                    >
                      <Pause size={14} /> Pausa
                    </button>
                  )}

                  {isPaused && capabilities.pauseResumeSupported && (
                    <button
                      type="button"
                      className="secondary-btn voice-touch-btn"
                      onClick={onResumeSpeaking}
                    >
                      <Play size={14} /> Riprendi
                    </button>
                  )}

                  {(isSpeaking || isPaused) && (
                    <button
                      type="button"
                      className="danger-btn voice-touch-btn"
                      onClick={onStopSpeaking}
                    >
                      <Square size={13} /> Interrompi lettura
                    </button>
                  )}
                </>
              ) : (
                <span className="voice-unsupported-inline" data-testid="voice-tts-unsupported">
                  Sintesi vocale non supportata su questo browser.
                </span>
              )}

              <button
                type="button"
                className="secondary-btn voice-touch-btn"
                onClick={() => setShowPauseSettings((prev) => !prev)}
                aria-expanded={showPauseSettings}
                data-testid="voice-pause-settings-toggle"
              >
                <SlidersHorizontal size={14} /> Tempi pausa
              </button>
            </div>
          </div>

          {showPauseSettings && (
            <div className="voice-pause-settings" data-testid="voice-pause-settings">
              <label className="voice-pause-field">
                <span>Pausa breve ({turnTaking.config.shortPauseMs} ms)</span>
                <input
                  type="range"
                  min={300}
                  max={2000}
                  step={100}
                  value={turnTaking.config.shortPauseMs}
                  onChange={(e) =>
                    onUpdateTurnConfig({ shortPauseMs: Number(e.target.value) })
                  }
                />
              </label>
              <label className="voice-pause-field">
                <span>Pausa lunga ({turnTaking.config.longPauseMs} ms)</span>
                <input
                  type="range"
                  min={800}
                  max={4000}
                  step={100}
                  value={turnTaking.config.longPauseMs}
                  onChange={(e) =>
                    onUpdateTurnConfig({ longPauseMs: Number(e.target.value) })
                  }
                />
              </label>
              <label className="voice-pause-field">
                <span>Timeout max ({turnTaking.config.maxTurnTimeoutMs} ms)</span>
                <input
                  type="range"
                  min={2500}
                  max={12000}
                  step={500}
                  value={turnTaking.config.maxTurnTimeoutMs}
                  onChange={(e) =>
                    onUpdateTurnConfig({ maxTurnTimeoutMs: Number(e.target.value) })
                  }
                />
              </label>
            </div>
          )}

          {interimTranscript && (
            <div className="voice-interim-line" data-testid="voice-interim-transcript">
              Trascrizione in corso: <em>{interimTranscript}</em>
            </div>
          )}

          {/* Area testo riconosciuto modificabile prima dell'invio */}
          <div className="voice-draft-box">
            <label className="voice-draft-label" htmlFor="aura-voice-transcript">
              Testo riconosciuto (puoi correggerlo prima di inviare)
            </label>
            <textarea
              id="aura-voice-transcript"
              className="voice-draft-input"
              rows={2}
              value={transcriptDraft}
              onChange={(e) => onChangeTranscriptDraft(e.target.value)}
              placeholder="Il testo dettato apparirà qui. Puoi modificarlo liberamente prima di confermare l'invio..."
              disabled={isProcessing}
            />
            <div className="voice-draft-actions">
              <button
                type="button"
                className="primary-btn voice-touch-btn"
                onClick={onSendTranscript}
                disabled={!transcriptDraft.trim() || isProcessing}
              >
                <Send size={14} /> Invia a AURA
              </button>
              {transcriptDraft.trim() && (
                <button
                  type="button"
                  className="secondary-btn voice-touch-btn"
                  onClick={onClearTranscript}
                  disabled={isProcessing}
                >
                  Pulisci
                </button>
              )}
            </div>
          </div>

          {voiceNotice && (
            <div className="voice-notice" role="status" data-testid="voice-notice">
              <AlertCircle size={14} />
              <span>{voiceNotice}</span>
            </div>
          )}

          <div className="voice-privacy-foot">
            <ShieldCheck size={13} />
            <span>{VOICE_BROWSER_PRIVACY_NOTE}</span>
          </div>
        </div>
      )}
    </div>
  );
}
