import type {
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceConstructor,
  SpeechSynthesisVoiceLike,
  VoiceErrorInfo,
  VoiceSynthesisStatus,
} from "./types";

const MAX_SPEECH_CHUNK_CHARS = 190;

export function getSpeechSynthesisEnv(
  globalObj: unknown = typeof window !== "undefined" ? window : undefined
): {
  synthesis: SpeechSynthesisLike | null;
  UtteranceCtor: SpeechSynthesisUtteranceConstructor | null;
} {
  if (!globalObj || typeof globalObj !== "object") {
    return { synthesis: null, UtteranceCtor: null };
  }
  const w = globalObj as Record<string, unknown>;
  const synthesis =
    w.speechSynthesis && typeof (w.speechSynthesis as SpeechSynthesisLike).speak === "function"
      ? (w.speechSynthesis as SpeechSynthesisLike)
      : null;
  const UtteranceCtor =
    typeof w.SpeechSynthesisUtterance === "function"
      ? (w.SpeechSynthesisUtterance as SpeechSynthesisUtteranceConstructor)
      : null;

  return { synthesis, UtteranceCtor };
}

export function isSpeechSynthesisSupported(
  globalObj: unknown = typeof window !== "undefined" ? window : undefined
): boolean {
  const { synthesis, UtteranceCtor } = getSpeechSynthesisEnv(globalObj);
  return synthesis !== null && UtteranceCtor !== null;
}

export function selectPreferredItalianVoice(
  voices: SpeechSynthesisVoiceLike[],
  targetLang = "it-IT"
): SpeechSynthesisVoiceLike | null {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const normalizedTarget = targetLang.toLowerCase();
  const baseLang = normalizedTarget.split("-")[0];

  const italianVoices = voices.filter((v) => {
    const lang = (v.lang || "").toLowerCase();
    return lang === normalizedTarget || lang.startsWith(`${baseLang}-`) || lang === baseLang;
  });

  if (italianVoices.length === 0) return null;

  const scoreVoice = (voice: SpeechSynthesisVoiceLike): number => {
    let score = 0;
    const lang = (voice.lang || "").toLowerCase();
    const name = (voice.name || "").toLowerCase();
    if (lang === normalizedTarget) score += 5;
    if (voice.localService) score += 2;
    if (voice.default) score += 2;
    if (/(natural|neural|google italiano|enhanced|premium)/i.test(name)) score += 3;
    if (/(espeak|compact|robot)/i.test(name)) score -= 3;
    return score;
  };

  return italianVoices.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

export function splitTextIntoSpeechChunks(
  rawText: string,
  maxChunkLength = MAX_SPEECH_CHUNK_CHARS
): string[] {
  const clean = rawText.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChunkLength) return [clean];

  const sentences = clean.split(/(?<=[.!?;:])\s+/);
  const chunks: string[] = [];
  let current = "";

  const pushOversized = (segment: string) => {
    const words = segment.split(" ");
    let buf = "";
    for (const word of words) {
      if (!buf) {
        buf = word;
      } else if (`${buf} ${word}`.length <= maxChunkLength) {
        buf = `${buf} ${word}`;
      } else {
        chunks.push(buf);
        buf = word;
      }
    }
    if (buf) chunks.push(buf);
  };

  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > maxChunkLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      pushOversized(sentence);
      continue;
    }

    if (!current) {
      current = sentence;
    } else if (`${current} ${sentence}`.length <= maxChunkLength) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export interface SpeechSynthesisCallbacks {
  onStatusChange?: (status: VoiceSynthesisStatus) => void;
  onError?: (error: VoiceErrorInfo) => void;
}

export class AuraSpeechSynthesisService {
  private readonly synthesis: SpeechSynthesisLike | null;
  private readonly UtteranceCtor: SpeechSynthesisUtteranceConstructor | null;
  private voices: SpeechSynthesisVoiceLike[] = [];
  private status: VoiceSynthesisStatus;
  private activeSessionId = 0;
  private voicesChangedHandler: (() => void) | null = null;
  private queue: Array<{
    text: string;
    lang: string;
    rate: number;
    pitch: number;
    callbacks?: SpeechSynthesisCallbacks;
  }> = [];
  private isDraining = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: {
    globalObj?: unknown;
    synthesis?: SpeechSynthesisLike | null;
    UtteranceCtor?: SpeechSynthesisUtteranceConstructor | null;
  }) {
    const env = getSpeechSynthesisEnv(options?.globalObj);
    this.synthesis = options?.synthesis !== undefined ? options.synthesis : env.synthesis;
    this.UtteranceCtor =
      options?.UtteranceCtor !== undefined ? options.UtteranceCtor : env.UtteranceCtor;
    this.status = this.synthesis && this.UtteranceCtor ? "idle" : "unsupported";

    if (this.synthesis) {
      this.refreshVoices();
      const handler = () => this.refreshVoices();
      this.voicesChangedHandler = handler;
      if (typeof this.synthesis.addEventListener === "function") {
        this.synthesis.addEventListener("voiceschanged", handler);
      } else {
        this.synthesis.onvoiceschanged = handler;
      }
    }
  }

  isSupported(): boolean {
    return this.synthesis !== null && this.UtteranceCtor !== null;
  }

  isPauseResumeSupported(): boolean {
    return Boolean(
      this.synthesis &&
        typeof this.synthesis.pause === "function" &&
        typeof this.synthesis.resume === "function"
    );
  }

  getStatus(): VoiceSynthesisStatus {
    return this.status;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  refreshVoices(): SpeechSynthesisVoiceLike[] {
    if (!this.synthesis) return [];
    try {
      this.voices = this.synthesis.getVoices() ?? [];
    } catch {
      this.voices = [];
    }
    return this.voices;
  }

  speak(
    text: string,
    options?: {
      lang?: string;
      rate?: number;
      pitch?: number;
      callbacks?: SpeechSynthesisCallbacks;
    }
  ): boolean {
    if (!this.synthesis || !this.UtteranceCtor) {
      this.status = "unsupported";
      options?.callbacks?.onStatusChange?.("unsupported");
      return false;
    }

    const chunks = splitTextIntoSpeechChunks(text);
    if (chunks.length === 0) {
      return false;
    }

    this.stop();
    const sessionId = ++this.activeSessionId;
    const lang = options?.lang ?? "it-IT";
    const rate = options?.rate ?? 1.0;
    const pitch = options?.pitch ?? 1.0;

    if (this.voices.length === 0) {
      this.refreshVoices();
    }
    const preferredVoice = selectPreferredItalianVoice(this.voices, lang);

    const speakChunkAt = (index: number) => {
      if (sessionId !== this.activeSessionId || !this.synthesis || !this.UtteranceCtor) {
        return;
      }
      if (index >= chunks.length) {
        this.status = "idle";
        options?.callbacks?.onStatusChange?.("idle");
        return;
      }

      const utterance = new this.UtteranceCtor(chunks[index]);
      utterance.lang = preferredVoice?.lang || lang;
      utterance.rate = Math.max(0.7, Math.min(1.4, rate));
      utterance.pitch = Math.max(0.8, Math.min(1.2, pitch));
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onstart = () => {
        if (sessionId !== this.activeSessionId) return;
        this.status = "speaking";
        options?.callbacks?.onStatusChange?.("speaking");
      };

      utterance.onend = () => {
        if (sessionId !== this.activeSessionId) return;
        speakChunkAt(index + 1);
      };

      utterance.onerror = (evt) => {
        if (sessionId !== this.activeSessionId) return;
        const errCode = evt?.error;
        this.status = "idle";
        options?.callbacks?.onStatusChange?.("idle");
        if (errCode !== "interrupted" && errCode !== "canceled") {
          options?.callbacks?.onError?.({
            code: "SYNTHESIS_ERROR",
            message:
              "La lettura vocale è stata interrotta dal dispositivo. Il testo della risposta rimane comunque visibile.",
          });
        }
      };

      try {
        this.synthesis.speak(utterance);
      } catch {
        this.status = "idle";
        options?.callbacks?.onStatusChange?.("idle");
        options?.callbacks?.onError?.({
          code: "SYNTHESIS_ERROR",
          message: "Impossibile avviare la sintesi vocale su questo dispositivo.",
        });
      }
    };

    speakChunkAt(0);
    return true;
  }

  /**
   * Accoda uno o più segmenti brevi per la lettura progressiva senza interrompere
   * l'utterance già in corso. Gestisce voci caricate in ritardo e coda bloccata su Android.
   */
  enqueue(
    text: string,
    options?: {
      lang?: string;
      rate?: number;
      pitch?: number;
      callbacks?: SpeechSynthesisCallbacks;
    }
  ): boolean {
    if (!this.synthesis || !this.UtteranceCtor) {
      this.status = "unsupported";
      options?.callbacks?.onStatusChange?.("unsupported");
      return false;
    }

    const chunks = splitTextIntoSpeechChunks(text);
    if (chunks.length === 0) {
      return false;
    }

    const lang = options?.lang ?? "it-IT";
    const rate = options?.rate ?? 1.0;
    const pitch = options?.pitch ?? 1.0;

    for (const chunk of chunks) {
      this.queue.push({
        text: chunk,
        lang,
        rate,
        pitch,
        callbacks: options?.callbacks,
      });
    }

    if (!this.isDraining) {
      this.activeSessionId += 1;
      this.drainQueue(this.activeSessionId);
    }

    return true;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private drainQueue(sessionId: number): void {
    if (sessionId !== this.activeSessionId || !this.synthesis || !this.UtteranceCtor) {
      this.isDraining = false;
      this.clearWatchdog();
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      this.isDraining = false;
      this.clearWatchdog();
      this.status = "idle";
      return;
    }

    this.isDraining = true;

    if (this.voices.length === 0) {
      this.refreshVoices();
    }
    const preferredVoice = selectPreferredItalianVoice(this.voices, next.lang);

    const utterance = new this.UtteranceCtor(next.text);
    utterance.lang = preferredVoice?.lang || next.lang;
    utterance.rate = Math.max(0.7, Math.min(1.4, next.rate));
    utterance.pitch = Math.max(0.8, Math.min(1.2, next.pitch));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    const finishItem = () => {
      this.clearWatchdog();
      if (sessionId !== this.activeSessionId) return;
      if (this.queue.length > 0) {
        this.drainQueue(sessionId);
      } else {
        this.isDraining = false;
        this.status = "idle";
        next.callbacks?.onStatusChange?.("idle");
      }
    };

    utterance.onstart = () => {
      if (sessionId !== this.activeSessionId) return;
      this.status = "speaking";
      next.callbacks?.onStatusChange?.("speaking");
    };

    utterance.onend = () => {
      finishItem();
    };

    utterance.onerror = (evt) => {
      this.clearWatchdog();
      if (sessionId !== this.activeSessionId) return;
      const errCode = evt?.error;
      this.queue = [];
      this.isDraining = false;
      this.status = "idle";
      next.callbacks?.onStatusChange?.("idle");
      if (errCode !== "interrupted" && errCode !== "canceled") {
        next.callbacks?.onError?.({
          code: "SYNTHESIS_ERROR",
          message:
            "La lettura vocale è stata interrotta dal dispositivo. Il testo della risposta rimane comunque visibile.",
        });
      }
    };

    // Protezione Android Chrome: se onend non scatta entro 18s su un chunk breve, recupera la coda
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (sessionId !== this.activeSessionId) return;
      try {
        this.synthesis?.cancel();
      } catch {
        // Ignora errori di recupero
      }
      finishItem();
    }, 18_000);
    (this.watchdogTimer as { unref?: () => void }).unref?.();

    try {
      this.synthesis.speak(utterance);
    } catch {
      this.clearWatchdog();
      this.queue = [];
      this.isDraining = false;
      this.status = "idle";
      next.callbacks?.onStatusChange?.("idle");
      next.callbacks?.onError?.({
        code: "SYNTHESIS_ERROR",
        message: "Impossibile avviare la sintesi vocale su questo dispositivo.",
      });
    }
  }

  pause(onStatusChange?: (status: VoiceSynthesisStatus) => void): boolean {
    if (!this.isPauseResumeSupported() || this.status !== "speaking") return false;
    try {
      this.synthesis?.pause?.();
      this.status = "paused";
      onStatusChange?.("paused");
      return true;
    } catch {
      return false;
    }
  }

  resume(onStatusChange?: (status: VoiceSynthesisStatus) => void): boolean {
    if (!this.isPauseResumeSupported() || this.status !== "paused") return false;
    try {
      this.synthesis?.resume?.();
      this.status = "speaking";
      onStatusChange?.("speaking");
      return true;
    } catch {
      return false;
    }
  }

  stop(onStatusChange?: (status: VoiceSynthesisStatus) => void): void {
    this.activeSessionId += 1;
    this.queue = [];
    this.isDraining = false;
    this.clearWatchdog();
    if (this.synthesis) {
      try {
        this.synthesis.cancel();
      } catch {
        // Ignora errori di cancellazione
      }
    }
    if (this.status !== "unsupported") {
      this.status = "idle";
      onStatusChange?.("idle");
    }
  }

  dispose(): void {
    this.stop();
    if (this.synthesis && this.voicesChangedHandler) {
      if (typeof this.synthesis.removeEventListener === "function") {
        this.synthesis.removeEventListener("voiceschanged", this.voicesChangedHandler);
      } else if (this.synthesis.onvoiceschanged === this.voicesChangedHandler) {
        this.synthesis.onvoiceschanged = null;
      }
    }
  }
}
