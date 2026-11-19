import type {
  PersonalInsightsContext,
  PersonalInsightsResult,
} from "../growth/types";
import type {
  MissionGenerationContext,
  MissionGenerationResult,
} from "../missions/types";
import type {
  AuraChatRequest,
  AuraChatResponse,
  AuraErrorCode,
  AuraErrorResponse,
  EmotionalAnalysis,
} from "../types/aura";

const CLIENT_TIMEOUT_MS = 150_000;

export class AuraClientError extends Error {
  status: number;
  code: AuraErrorCode | "NETWORK_ERROR";

  constructor(message: string, status: number, code: AuraErrorCode | "NETWORK_ERROR") {
    super(message);
    this.name = "AuraClientError";
    this.status = status;
    this.code = code;
  }
}

export interface SendAuraChatOptions {
  onChunk?: (accumulatedText: string) => void;
  onAnalysis?: (analysis: EmotionalAnalysis) => void;
}

export async function sendAuraChatMessage(
  payload: AuraChatRequest,
  options?: SendAuraChatOptions
): Promise<AuraChatResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";

    if (response.ok && contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalPayload: AuraChatResponse | null = null;

      type ParsedSseEvent =
        | { type: "analysis"; analysis: EmotionalAnalysis }
        | { type: "chunk"; accumulated: string }
        | { type: "done"; payload: AuraChatResponse }
        | null;

      const parseSseEventBlock = (block: string): ParsedSseEvent => {
        const lines = block.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length === 0) return null;
        const rawData = dataLines.join("\n");
        const parsed = JSON.parse(rawData) as Record<string, unknown>;

        if (eventName === "analysis" && typeof parsed.primaryEmotion === "string") {
          return { type: "analysis", analysis: parsed as unknown as EmotionalAnalysis };
        }
        if (eventName === "chunk" && typeof parsed.accumulated === "string") {
          return { type: "chunk", accumulated: parsed.accumulated };
        }
        if (eventName === "done") {
          return { type: "done", payload: parsed as unknown as AuraChatResponse };
        }
        if (eventName === "error") {
          const errData = parsed as Partial<AuraErrorResponse>;
          throw new AuraClientError(
            errData.error ||
              "Non è stato possibile ottenere una risposta da AURA AI. Riprova tra poco.",
            502,
            errData.code || "UPSTREAM_ERROR"
          );
        }
        return null;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex !== -1) {
          const eventBlock = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          if (eventBlock.trim()) {
            const evt = parseSseEventBlock(eventBlock);
            if (evt?.type === "analysis") {
              options?.onAnalysis?.(evt.analysis);
            } else if (evt?.type === "chunk") {
              options?.onChunk?.(evt.accumulated);
            } else if (evt?.type === "done") {
              finalPayload = evt.payload;
            }
          }
          boundaryIndex = buffer.indexOf("\n\n");
        }
      }

      if (buffer.trim()) {
        const evt = parseSseEventBlock(buffer);
        if (evt?.type === "analysis") {
          options?.onAnalysis?.(evt.analysis);
        } else if (evt?.type === "chunk") {
          options?.onChunk?.(evt.accumulated);
        } else if (evt?.type === "done") {
          finalPayload = evt.payload;
        }
      }

      if (!finalPayload || typeof finalPayload.reply !== "string" || !finalPayload.reply.trim()) {
        throw new AuraClientError(
          "Risposta incompleta ricevuta dal server AI.",
          502,
          "UPSTREAM_ERROR"
        );
      }

      return finalPayload;
    }

    const isJson = contentType.includes("application/json");
    const data = isJson ? await response.json() : null;

    if (!response.ok) {
      const errData = (data ?? {}) as Partial<AuraErrorResponse>;
      throw new AuraClientError(
        errData.error ||
          "Non è stato possibile ottenere una risposta da AURA AI. Riprova tra poco.",
        response.status,
        errData.code || "UPSTREAM_ERROR"
      );
    }

    const chatData = data as Partial<AuraChatResponse> | null;
    if (!chatData || typeof chatData.reply !== "string" || !chatData.reply.trim()) {
      throw new AuraClientError(
        "Risposta vuota o non valida ricevuta dal server AI.",
        502,
        "UPSTREAM_ERROR"
      );
    }

    return chatData as AuraChatResponse;
  } catch (error) {
    if (error instanceof AuraClientError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AuraClientError(
        "La richiesta ha impiegato troppo tempo (timeout). Verifica la connessione e riprova.",
        504,
        "TIMEOUT"
      );
    }
    throw new AuraClientError(
      "Connessione al server AI non riuscita. Verifica che il servizio sia attivo e riprova.",
      0,
      "NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function requestAdaptiveMissions(
  payload: MissionGenerationContext & { useGemini?: boolean }
): Promise<MissionGenerationResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("/api/missions/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AuraClientError(
        "Impossibile aggiornare le missioni in questo momento.",
        response.status,
        "UPSTREAM_ERROR"
      );
    }

    return (await response.json()) as MissionGenerationResult;
  } catch (error) {
    if (error instanceof AuraClientError) throw error;
    throw new AuraClientError(
      "Connessione non riuscita durante la generazione delle missioni.",
      0,
      "NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function requestPersonalInsights(
  payload: PersonalInsightsContext & { useGemini?: boolean }
): Promise<PersonalInsightsResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("/api/growth/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AuraClientError(
        "Impossibile generare le osservazioni personali in questo momento.",
        response.status,
        "UPSTREAM_ERROR"
      );
    }

    return (await response.json()) as PersonalInsightsResult;
  } catch (error) {
    if (error instanceof AuraClientError) throw error;
    throw new AuraClientError(
      "Connessione non riuscita durante l'analisi della crescita personale.",
      0,
      "NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
