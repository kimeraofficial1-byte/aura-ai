import type {
  RecognitionResultPayload,
  SpeechRecognitionConstructor,
  SpeechRecognitionLike,
  VoiceErrorInfo,
  VoiceRecognitionStatus,
} from "./types";

export const ANDROID_KEYBOARD_MIC_HINT =
  "Il riconoscimento vocale integrato non è disponibile su questo browser. Puoi comunque toccare il campo di testo e usare il microfono della tastiera Android (es. Gboard), oppure scrivere normalmente.";

export const VOICE_BROWSER_PRIVACY_NOTE =
  "AURA non registra né salva file audio. Il riconoscimento vocale utilizza il servizio vocale integrato nel browser, che potrebbe elaborare l'audio tramite il provider del browser.";

export function getSpeechRecognitionConstructor(
  globalObj: unknown = typeof window !== "undefined" ? window : undefined
): SpeechRecognitionConstructor | null {
  if (!globalObj || typeof globalObj !== "object") return null;
  const w = globalObj as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionConstructor) : null;
}

export function isSpeechRecognitionSupported(
  globalObj: unknown = typeof window !== "undefined" ? window : undefined
): boolean {
  return getSpeechRecognitionConstructor(globalObj) !== null;
}

export function mapSpeechRecognitionError(rawCode?: string): VoiceErrorInfo {
  switch (rawCode) {
    case "not-allowed":
    case "service-not-allowed":
      return {
        code: "PERMISSION_DENIED",
        message:
          "Permesso microfono negato. Consenti l'accesso al microfono nelle impostazioni del browser oppure usa la tastiera.",
      };
    case "no-speech":
      return {
        code: "NO_SPEECH",
        message:
          "Nessuna voce rilevata. Puoi riprovare a parlare più vicino al microfono o scrivere il messaggio.",
      };
    case "audio-capture":
      return {
        code: "AUDIO_CAPTURE",
        message:
          "Microfono non rilevato o occupato da un'altra app. Verifica il dispositivo o usa la tastiera.",
      };
    case "network":
      return {
        code: "NETWORK",
        message:
          "Servizio di riconoscimento vocale temporaneamente non raggiungibile. Puoi scrivere il messaggio manualmente.",
      };
    case "aborted":
      return {
        code: "ABORTED",
        message: "Ascolto interrotto.",
      };
    default:
      return {
        code: "UNKNOWN",
        message:
          "Si è verificato un problema durante il riconoscimento vocale. Puoi riprovare o scrivere manualmente.",
      };
  }
}

export interface SpeechRecognitionCallbacks {
  onStatusChange?: (status: VoiceRecognitionStatus) => void;
  onTranscript?: (payload: RecognitionResultPayload) => void;
  onError?: (error: VoiceErrorInfo) => void;
}

export class AuraSpeechRecognitionService {
  private readonly ctor: SpeechRecognitionConstructor | null;
  private instance: SpeechRecognitionLike | null = null;
  private status: VoiceRecognitionStatus;
  private finalText = "";

  constructor(options?: {
    globalObj?: unknown;
    recognitionCtor?: SpeechRecognitionConstructor | null;
  }) {
    this.ctor =
      options?.recognitionCtor !== undefined
        ? options.recognitionCtor
        : getSpeechRecognitionConstructor(options?.globalObj);
    this.status = this.ctor ? "idle" : "unsupported";
  }

  isSupported(): boolean {
    return this.ctor !== null;
  }

  getStatus(): VoiceRecognitionStatus {
    return this.status;
  }

  start(
    callbacks: SpeechRecognitionCallbacks,
    options?: { lang?: string; initialText?: string }
  ): boolean {
    if (!this.ctor) {
      this.status = "unsupported";
      callbacks.onStatusChange?.("unsupported");
      callbacks.onError?.({
        code: "UNSUPPORTED",
        message: ANDROID_KEYBOARD_MIC_HINT,
      });
      return false;
    }

    this.stop();

    const recognition = new this.ctor();
    recognition.lang = options?.lang ?? "it-IT";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    this.finalText = (options?.initialText ?? "").trim();
    this.instance = recognition;

    recognition.onstart = () => {
      this.status = "listening";
      callbacks.onStatusChange?.("listening");
    };

    recognition.onresult = (event) => {
      let interim = "";
      let newlyFinalized = "";
      const startIndex = typeof event.resultIndex === "number" ? event.resultIndex : 0;

      for (let i = startIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (result.isFinal) {
          newlyFinalized = newlyFinalized ? `${newlyFinalized} ${transcript}` : transcript;
        } else {
          interim = interim ? `${interim} ${transcript}` : transcript;
        }
      }

      if (newlyFinalized) {
        this.finalText = this.finalText
          ? `${this.finalText} ${newlyFinalized}`
          : newlyFinalized;
      }

      const combinedTranscript = [this.finalText, interim].filter(Boolean).join(" ").trim();
      callbacks.onTranscript?.({
        finalTranscript: this.finalText,
        interimTranscript: interim,
        combinedTranscript,
      });
    };

    recognition.onerror = (event) => {
      const mapped = mapSpeechRecognitionError(event?.error);
      this.status = mapped.code === "ABORTED" ? "idle" : "error";
      callbacks.onStatusChange?.(this.status);
      if (mapped.code !== "ABORTED") {
        callbacks.onError?.(mapped);
      }
    };

    recognition.onend = () => {
      if (this.instance === recognition) {
        this.instance = null;
      }
      if (this.status === "listening") {
        this.status = "idle";
        callbacks.onStatusChange?.("idle");
      }
    };

    try {
      recognition.start();
      return true;
    } catch {
      this.instance = null;
      this.status = "error";
      callbacks.onStatusChange?.("error");
      callbacks.onError?.({
        code: "UNKNOWN",
        message: "Impossibile avviare il microfono in questo momento. Riprova o usa la tastiera.",
      });
      return false;
    }
  }

  stop(): void {
    if (this.instance) {
      const current = this.instance;
      this.instance = null;
      try {
        current.stop();
      } catch {
        try {
          current.abort();
        } catch {
          // Ignora errori di chiusura del browser
        }
      }
    }
    if (this.status === "listening") {
      this.status = "idle";
    }
  }
}
