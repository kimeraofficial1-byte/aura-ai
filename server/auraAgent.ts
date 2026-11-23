import { GoogleGenAI, ThinkingLevel, type Content } from "@google/genai";
import { buildEmpathyGuidanceForGemini } from "../src/emotion/empathy";
import { buildNaturalPersonalityInstruction } from "../src/personality/conversationEngine";
import {
  buildReasoningGuidanceForGemini,
  runStructuredReasoning,
} from "../src/reasoning/reasoningEngine";
import type {
  AuraErrorCode,
  ChatHistoryItem,
  WellnessContext,
} from "../src/types/aura";

export const DEFAULT_AURA_MODEL = "gemini-4-hydrogen";
export const FALLBACK_AURA_MODEL = "gemini-3.1-flash-lite";
const IDLE_TIMEOUT_MS = 90_000;
const PRIMARY_FIRST_CHUNK_TIMEOUT_MS = 35_000;

export function getAuraModelName(): string {
  return process.env.AURA_GEMINI_MODEL?.trim() || DEFAULT_AURA_MODEL;
}

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

export function buildAuraSystemInstruction(
  context?: WellnessContext,
  message?: string,
  history?: ChatHistoryItem[]
): string {
  const sections: string[] = [
    "Sei AURA, un assistente AI per il benessere psicologico ed emotivo quotidiano.",
    buildNaturalPersonalityInstruction({ message, history, context }),
    "ASCOLTO ATTIVO E CONTESTO: Ascolta con attenzione ciò che l'utente esprime, tieni conto della cronologia della conversazione e rifletti con naturalezza ciò che emerge.",
    "RICONOSCIMENTO DELLE EMOZIONI: Aiuta a riconoscere e nominare le emozioni con prudenza e tatto, presentandole sempre come possibili percezioni (es. 'mi sembra di cogliere...', 'potrebbe esserci un senso di...'), mai come etichette cliniche o valutazioni definitive.",
    "ESERCIZI E MICRO-PASSI: Quando utile e richiesto dal contesto, proponi esercizi semplici, concreti e a basso rischio: respirazione lenta (es. 4 secondi inspiro, 6 espiro), grounding sensoriale (es. notare 3-5 dettagli intorno a sé), brevi pause di consapevolezza o un piccolo passo realistico.",
    "CONFINI CLINICI RIGOROSI: Non formulare mai diagnosi mediche, psichiatriche o psicologiche. Non prescrivere farmaci, integratori o terapie cliniche. Non presentarti come psicologo, psicoterapeuta o medico e non sostituire mai professionisti sanitari.",
    "GESTIONE CRISI: Se l'utente esprime disperazione intensa, pericolo per sé o per altri, o disagio grave che supera un normale confronto quotidiano, rispondi con estrema cura, invita a contattare subito i servizi di emergenza (112), il pronto soccorso o una persona fidata, e ricorda i limiti di AURA.",
  ];

  const contextLines: string[] = [];
  if (context?.mood) {
    contextLines.push(`Umore dichiarato dall'utente al check-in: "${context.mood}".`);
  }
  if (typeof context?.stress === "number") {
    contextLines.push(`Livello di stress percepito al check-in: ${context.stress}/10.`);
  }
  if (
    typeof context?.completedMissions === "number" &&
    typeof context?.totalMissions === "number" &&
    context.totalMissions > 0
  ) {
    contextLines.push(
      `Missioni di benessere completate oggi: ${context.completedMissions} su ${context.totalMissions}.`
    );
  }
  if (context?.memorySummary) {
    contextLines.push(
      `MEMORIA VERIFICATA (usa esclusivamente questi elementi espliciti; NON inventare, dedurre o presumere ricordi non presenti qui e accetta sempre eventuali correzioni dell'utente):\n${context.memorySummary}`
    );
  }
  if (context?.emotionalTrendSummary) {
    contextLines.push(context.emotionalTrendSummary);
  }
  if (context?.emotionalProfile?.primaryEmotion) {
    const intensity = context.emotionalProfile.intensity
      ? ` (intensità ${context.emotionalProfile.intensity})`
      : "";
    contextLines.push(
      `Segnale emotivo prevalente: ${context.emotionalProfile.primaryEmotion}${intensity}.`
    );
  }

  if (context?.orchestratedContextSummary) {
    sections.push(context.orchestratedContextSummary);
  } else if (contextLines.length > 0) {
    sections.push(
      "CONTESTO ATTUALE DELL'UTENTE (usalo con discrezione senza elencarlo meccanicamente):\n" +
        contextLines.join("\n")
    );
  }

  if (context?.emotionalAnalysis) {
    sections.push(buildEmpathyGuidanceForGemini(context.emotionalAnalysis));
  }

  if (message && message.trim()) {
    const reasoning = runStructuredReasoning({
      message,
      history,
      context,
      consentEnabled: false,
    });
    const reasoningGuidance = buildReasoningGuidanceForGemini(reasoning);
    if (reasoningGuidance) {
      sections.push(reasoningGuidance);
    }
  }

  return sections.join("\n\n");
}

export function buildGeminiContents(
  message: string,
  history: ChatHistoryItem[] = []
): Content[] {
  const cleanHistory = history.filter((item) => item.text.trim().length > 0);

  // Evita di duplicare l'ultimo messaggio se il client lo avesse già incluso in history
  const withoutDuplicateLast =
    cleanHistory.length > 0 &&
    cleanHistory[cleanHistory.length - 1].role === "user" &&
    cleanHistory[cleanHistory.length - 1].text.trim() === message.trim()
      ? cleanHistory.slice(0, -1)
      : cleanHistory;

  // Gemini richiede che la sequenza conversazionale inizi con un turno "user"
  const firstUserIndex = withoutDuplicateLast.findIndex((item) => item.role === "user");
  const normalizedHistory =
    firstUserIndex >= 0 ? withoutDuplicateLast.slice(firstUserIndex) : [];

  const contents: Content[] = [];
  for (const item of normalizedHistory) {
    const geminiRole = item.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === geminiRole && last.parts?.[0]?.text) {
      last.parts[0].text = `${last.parts[0].text}\n\n${item.text}`;
    } else {
      contents.push({
        role: geminiRole,
        parts: [{ text: item.text }],
      });
    }
  }

  const last = contents[contents.length - 1];
  if (last && last.role === "user" && last.parts?.[0]?.text) {
    last.parts[0].text = `${last.parts[0].text}\n\n${message}`;
  } else {
    contents.push({
      role: "user",
      parts: [{ text: message }],
    });
  }

  return contents;
}

export interface MappedGeminiError {
  status: number;
  code: AuraErrorCode;
  message: string;
  retryable: boolean;
}

export function mapGeminiError(error: unknown): MappedGeminiError {
  if (error instanceof Error && error.name === "AuraTimeoutError") {
    return {
      status: 504,
      code: "TIMEOUT",
      message:
        "AURA sta impiegando più tempo del previsto a rispondere. Riprova tra qualche istante.",
      retryable: false,
    };
  }

  const errObj = (error && typeof error === "object" ? error : {}) as Record<
    string,
    unknown
  >;
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const lower = rawMessage.toLowerCase();
  const statusCode =
    typeof errObj.status === "number"
      ? errObj.status
      : typeof errObj.code === "number"
        ? errObj.code
        : undefined;

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes("permission_denied") ||
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid")
  ) {
    return {
      status: 502,
      code: "INVALID_API_KEY",
      message:
        "La chiave API di Gemini configurata sul server non è valida o non ha i permessi necessari. Verifica GEMINI_API_KEY in Settings > Secrets.",
      retryable: false,
    };
  }

  if (statusCode === 429 || lower.includes("resource_exhausted") || lower.includes("quota")) {
    return {
      status: 429,
      code: "RATE_LIMIT",
      message:
        "Il servizio AI ha raggiunto temporaneamente il limite di richieste. Attendi qualche secondo e riprova.",
      retryable: false,
    };
  }

  if (statusCode === 404 || lower.includes("not_found")) {
    return {
      status: 502,
      code: "MODEL_NOT_FOUND",
      message:
        "Il modello Gemini configurato sul server non è disponibile al momento.",
      retryable: false,
    };
  }

  if (statusCode === 400) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "La richiesta inviata al modello AI non è valida.",
      retryable: false,
    };
  }

  const isTransient =
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    lower.includes("unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("internal") ||
    lower.includes("fetch failed") ||
    lower.includes("econnreset");

  return {
    status: 502,
    code: "UPSTREAM_ERROR",
    message:
      "Si è verificato un problema temporaneo nel contattare AURA AI. Riprova tra poco.",
    retryable: isTransient,
  };
}

export class AuraTimeoutError extends Error {
  constructor(ms: number) {
    super(`Gemini request timed out after ${ms}ms`);
    this.name = "AuraTimeoutError";
  }
}

export interface GenerateAuraStreamParams {
  apiKey: string;
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (chunkText: string, accumulatedText: string) => void;
}

export async function generateAuraReplyStream(
  params: GenerateAuraStreamParams
): Promise<{ reply: string; model: string }> {
  const primaryModel = getAuraModelName();
  const ai = createGeminiClient(params.apiKey);
  const systemInstruction = buildAuraSystemInstruction(
    params.context,
    params.message,
    params.history
  );
  const contents = buildGeminiContents(params.message, params.history);
  const idleTimeoutMs = params.timeoutMs ?? IDLE_TIMEOUT_MS;
  const canFallback = primaryModel !== FALLBACK_AURA_MODEL;

  const attemptCall = async (
    targetModel: string,
    firstChunkTimeoutMs: number,
    onChunkCb?: (chunkText: string, accumulatedText: string) => void
  ): Promise<{ reply: string; model: string }> => {
    const controller = new AbortController();
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let accumulated = "";

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const armTimer = (ms: number) => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new AuraTimeoutError(ms));
      }, ms);
    };

    const onExternalAbort = () => {
      clearIdleTimer();
      controller.abort(params.signal?.reason);
    };

    if (params.signal) {
      if (params.signal.aborted) {
        controller.abort(params.signal.reason);
      } else {
        params.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    armTimer(firstChunkTimeoutMs);

    try {
      const stream = await ai.models.generateContentStream({
        model: targetModel,
        contents,
        config: {
          systemInstruction,
          ...(targetModel === FALLBACK_AURA_MODEL
            ? {}
            : {
                thinkingConfig: {
                  thinkingLevel: ThinkingLevel.LOW,
                },
              }),
          abortSignal: controller.signal,
        },
      });

      for await (const chunk of stream) {
        armTimer(idleTimeoutMs);
        const chunkText = chunk.text ?? "";
        if (chunkText) {
          accumulated += chunkText;
          onChunkCb?.(chunkText, accumulated);
        }
      }

      const reply = accumulated.trim();
      if (!reply) {
        throw new Error("Empty response from Gemini model");
      }
      return { reply, model: targetModel };
    } catch (err) {
      if (timedOut) {
        throw new AuraTimeoutError(firstChunkTimeoutMs);
      }
      throw err;
    } finally {
      clearIdleTimer();
      params.signal?.removeEventListener("abort", onExternalAbort);
    }
  };

  const originalOnChunk = params.onChunk;
  let emittedAnyChunk = false;
  const trackedOnChunk = originalOnChunk
    ? (chunkText: string, accumulatedText: string) => {
        emittedAnyChunk = true;
        originalOnChunk(chunkText, accumulatedText);
      }
    : undefined;

  const primaryFirstChunkTimeout = canFallback
    ? Math.min(idleTimeoutMs, PRIMARY_FIRST_CHUNK_TIMEOUT_MS)
    : idleTimeoutMs;

  try {
    return await attemptCall(primaryModel, primaryFirstChunkTimeout, trackedOnChunk);
  } catch (firstError) {
    if (params.signal?.aborted || emittedAnyChunk) {
      throw firstError;
    }

    const mapped = mapGeminiError(firstError);
    const isRateLimit = mapped.code === "RATE_LIMIT";
    const shouldFallback =
      canFallback &&
      (mapped.retryable ||
        isRateLimit ||
        mapped.code === "TIMEOUT" ||
        mapped.code === "MODEL_NOT_FOUND" ||
        mapped.code === "UPSTREAM_ERROR");

    if (shouldFallback) {
      if (isRateLimit) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        if (params.signal?.aborted) {
          throw firstError;
        }
      }
      try {
        return await attemptCall(FALLBACK_AURA_MODEL, idleTimeoutMs, trackedOnChunk);
      } catch (fallbackError) {
        if (params.signal?.aborted || emittedAnyChunk) {
          throw fallbackError;
        }
        const secondMapped = mapGeminiError(fallbackError);
        const delayMs = secondMapped.code === "RATE_LIMIT" ? 2_500 : 700;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (params.signal?.aborted) {
          throw fallbackError;
        }
        return await attemptCall("gemini-4-carbon", idleTimeoutMs, trackedOnChunk);
      }
    }

    if (mapped.retryable || isRateLimit || mapped.code === "UPSTREAM_ERROR") {
      await new Promise((resolve) => setTimeout(resolve, isRateLimit ? 1_500 : 600));
      if (params.signal?.aborted) {
        throw firstError;
      }
      return await attemptCall(primaryModel, idleTimeoutMs, trackedOnChunk);
    }

    throw firstError;
  }
}

export async function generateAuraReply(params: {
  apiKey: string;
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ reply: string; model: string }> {
  return generateAuraReplyStream(params);
}
