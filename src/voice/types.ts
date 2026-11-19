export type VoiceRecognitionStatus = "idle" | "listening" | "error" | "unsupported";

export type VoiceSynthesisStatus = "idle" | "speaking" | "paused" | "unsupported";

export type TurnTakingState =
  | "IDLE"
  | "LISTENING"
  | "USER_SPEAKING"
  | "USER_PAUSED"
  | "PROCESSING"
  | "AURA_SPEAKING"
  | "INTERRUPTED"
  | "ERROR";

export type TurnEndReason =
  | "long_pause"
  | "max_timeout"
  | "manual_stop"
  | "recognition_end";

export interface TurnTakingConfig {
  shortPauseMs: number;
  longPauseMs: number;
  maxTurnTimeoutMs: number;
}

export interface TurnTakingSnapshot {
  state: TurnTakingState;
  sentenceFinalized: boolean;
  pausePhase: "none" | "short" | "long";
  lastTurnEndReason: TurnEndReason | null;
  interruptedAura: boolean;
  vadSupported: false;
  config: TurnTakingConfig;
}

export interface TurnTakingTimerAdapter {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

export type HandsFreeState =
  | "DISABLED"
  | "READY"
  | "LISTENING"
  | "USER_SPEAKING"
  | "USER_PAUSED"
  | "PROCESSING"
  | "AURA_SPEAKING"
  | "INTERRUPTED"
  | "STOPPING"
  | "ERROR";

export interface HandsFreeSnapshot {
  state: HandsFreeState;
  enabled: boolean;
  micActive: boolean;
  activeTurnId: number;
  consecutiveErrors: number;
  lastError: VoiceErrorInfo | null;
  lastNotice: string | null;
}

export interface VoiceCapabilities {
  speechRecognitionSupported: boolean;
  speechSynthesisSupported: boolean;
  pauseResumeSupported: boolean;
}

export interface VoicePreferences {
  lang: string;
  rate: number;
  pitch: number;
  voiceModeEnabled: boolean;
  autoSpeakResponses: boolean;
}

export interface RecognitionResultPayload {
  finalTranscript: string;
  interimTranscript: string;
  combinedTranscript: string;
}

export interface VoiceErrorInfo {
  code:
    | "UNSUPPORTED"
    | "PERMISSION_DENIED"
    | "NO_SPEECH"
    | "AUDIO_CAPTURE"
    | "NETWORK"
    | "ABORTED"
    | "SYNTHESIS_ERROR"
    | "UNKNOWN";
  message: string;
}

export interface SpeechRecognitionLikeEvent {
  resultIndex?: number;
  results: ArrayLike<{
    isFinal?: boolean;
    0?: { transcript?: string };
  }>;
}

export interface SpeechRecognitionLikeErrorEvent {
  error?: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionLikeErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionLikeEvent) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export interface SpeechSynthesisVoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
}

export interface SpeechSynthesisUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  voice: SpeechSynthesisVoiceLike | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

export type SpeechSynthesisUtteranceConstructor = new (
  text?: string
) => SpeechSynthesisUtteranceLike;

export interface SpeechSynthesisLike {
  speaking?: boolean;
  paused?: boolean;
  getVoices: () => SpeechSynthesisVoiceLike[];
  speak: (utterance: SpeechSynthesisUtteranceLike) => void;
  cancel: () => void;
  pause?: () => void;
  resume?: () => void;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  onvoiceschanged?: (() => void) | null;
}
