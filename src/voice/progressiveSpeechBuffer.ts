import { splitTextIntoSpeechChunks } from "./speechSynthesis";

export interface ProgressiveBufferConfig {
  /** Soglia minima di caratteri prima di emettere una frase su . ? ! */
  minSentenceChars: number;
  /** Soglia oltre la quale spezzare una frase lunga anche su , ; : */
  commaSplitThresholdChars: number;
  /** Lunghezza massima sicura di un singolo chunk vocale per Android Chrome */
  maxChunkChars: number;
}

export const DEFAULT_PROGRESSIVE_BUFFER_CONFIG: ProgressiveBufferConfig = {
  minSentenceChars: 24,
  commaSplitThresholdChars: 110,
  maxChunkChars: 170,
};

/**
 * Buffer progressivo per la lettura vocale in streaming SSE.
 * Riceve testo incrementale o cumulativo, rileva confini di frase (. ? ! e , su testi lunghi),
 * mantiene una coda ordinata senza duplicazioni né perdite e gestisce l'ultimo frammento.
 */
export class ProgressiveSpeechBuffer {
  private readonly config: ProgressiveBufferConfig;
  private pendingText = "";
  private consumedAccumulatedLength = 0;
  private queue: string[] = [];
  private emittedSegments: string[] = [];
  private finalized = false;

  constructor(config?: Partial<ProgressiveBufferConfig>) {
    this.config = {
      ...DEFAULT_PROGRESSIVE_BUFFER_CONFIG,
      ...config,
    };
  }

  getConfig(): ProgressiveBufferConfig {
    return { ...this.config };
  }

  getPendingQueue(): string[] {
    return [...this.queue];
  }

  getEmittedSegments(): string[] {
    return [...this.emittedSegments];
  }

  getUnflushedText(): string {
    return this.pendingText;
  }

  /**
   * Riceve il testo cumulativo dall'evento SSE `chunk` (es. `accumulated`)
   * calcolando automaticamente il solo delta non ancora elaborato.
   */
  pushAccumulated(accumulatedText: string): string[] {
    if (this.finalized) return [];
    if (!accumulatedText || accumulatedText.length <= this.consumedAccumulatedLength) {
      return [];
    }
    const delta = accumulatedText.slice(this.consumedAccumulatedLength);
    this.consumedAccumulatedLength = accumulatedText.length;
    return this.pushChunk(delta);
  }

  /**
   * Riceve un singolo frammento incrementale e restituisce gli eventuali segmenti
   * appena divenuti pronti per SpeechSynthesis (aggiunti anche alla coda ordinata).
   */
  pushChunk(delta: string): string[] {
    if (this.finalized || !delta) return [];
    this.pendingText += delta;
    return this.extractReadySegments();
  }

  /**
   * Chiude lo stream e rilascia l'eventuale ultimo frammento rimasto nel buffer.
   */
  flushFinal(finalFullText?: string): string[] {
    if (this.finalized) return [];

    if (finalFullText && finalFullText.length > this.consumedAccumulatedLength) {
      const remainingDelta = finalFullText.slice(this.consumedAccumulatedLength);
      this.consumedAccumulatedLength = finalFullText.length;
      this.pendingText += remainingDelta;
    }

    this.finalized = true;
    const newlyReady = this.extractReadySegments();
    const leftover = this.pendingText.replace(/\s+/g, " ").trim();
    this.pendingText = "";

    if (leftover) {
      const chunks = splitTextIntoSpeechChunks(leftover, this.config.maxChunkChars);
      for (const chunk of chunks) {
        this.enqueueSegment(chunk);
        newlyReady.push(chunk);
      }
    }

    return newlyReady;
  }

  /**
   * Estrae il prossimo segmento dalla coda FIFO.
   */
  dequeue(): string | null {
    return this.queue.shift() ?? null;
  }

  /**
   * Svuota completamente buffer e coda (es. interruzione utente / barge-in).
   */
  clear(): void {
    this.pendingText = "";
    this.queue = [];
    this.finalized = true;
  }

  /**
   * Ripristina il buffer per una nuova risposta in streaming.
   */
  reset(): void {
    this.pendingText = "";
    this.consumedAccumulatedLength = 0;
    this.queue = [];
    this.emittedSegments = [];
    this.finalized = false;
  }

  private enqueueSegment(segment: string): void {
    const clean = segment.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.queue.push(clean);
    this.emittedSegments.push(clean);
  }

  private extractReadySegments(): string[] {
    const newlyReady: string[] = [];

    while (true) {
      const splitIndex = this.findSplitIndex(this.pendingText);
      if (splitIndex === -1) break;

      const rawSegment = this.pendingText.slice(0, splitIndex).trim();
      this.pendingText = this.pendingText.slice(splitIndex).replace(/^\s+/, "");

      if (!rawSegment) continue;

      const chunks = splitTextIntoSpeechChunks(rawSegment, this.config.maxChunkChars);
      for (const chunk of chunks) {
        this.enqueueSegment(chunk);
        newlyReady.push(chunk);
      }
    }

    return newlyReady;
  }

  private findSplitIndex(text: string): number {
    // 1. Confine di frase forte (. ? !) dopo la soglia minima, seguito da spazio o fine riga
    const sentenceRegex = /[.!?]+(?:\s+|\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = sentenceRegex.exec(text)) !== null) {
      const endPos = match.index + match[0].length;
      const endsWithWhitespace = /[\s\n]$/.test(match[0]);
      // Evita di tagliare su un punto a fine stringa se non c'è ancora uno spazio successivo
      // (es. "3.5" o "...") a meno che non superi maxChunkChars
      if (!endsWithWhitespace && text.length < this.config.maxChunkChars) {
        continue;
      }
      const candidate = text.slice(0, endPos).trim();
      if (candidate.length >= this.config.minSentenceChars) {
        return endPos;
      }
    }

    // 2. Su frasi lunghe, consenti taglio naturale su virgola, punto e virgola o due punti
    if (text.length >= this.config.commaSplitThresholdChars) {
      const clauseRegex = /[,;:]+(?:\s+|\n)/g;
      let lastClauseEnd = -1;
      while ((match = clauseRegex.exec(text)) !== null) {
        const endPos = match.index + match[0].length;
        if (endPos >= this.config.minSentenceChars && endPos <= this.config.maxChunkChars) {
          lastClauseEnd = endPos;
        }
      }
      if (lastClauseEnd !== -1) {
        return lastClauseEnd;
      }
    }

    // 3. Protezione Android Chrome: se il testo supera maxChunkChars senza punteggiatura, taglia su uno spazio
    if (text.length >= this.config.maxChunkChars) {
      const spaceIdx = text.lastIndexOf(" ", this.config.maxChunkChars);
      if (spaceIdx >= this.config.minSentenceChars) {
        return spaceIdx + 1;
      }
      return this.config.maxChunkChars;
    }

    return -1;
  }
}
