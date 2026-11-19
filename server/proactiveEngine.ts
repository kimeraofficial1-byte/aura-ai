import { analyzeProactiveOpportunities } from "../src/proactive/proactiveEngine";
import type {
  ProactiveAnalysisInput,
  ProactiveAnalysisResult,
} from "../src/proactive/types";
import { createGeminiClient } from "./auraAgent";
import { evaluatePreModelSafety } from "./safety";

const DEFAULT_PROACTIVE_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_PROACTIVE_TIMEOUT_MS = 4500;

export interface ServerProactiveParams extends ProactiveAnalysisInput {
  userContextText?: string;
  apiKey?: string;
  useGemini?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  geminiCaller?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

export interface ServerProactiveOutput {
  result: ProactiveAnalysisResult;
  safetyReply?: string;
  usedGemini: boolean;
  usedFallback: boolean;
  fallbackReason?: string;
}

/**
 * Orchestratore server-side per Proactive Intelligence Engine V1.
 * 1. Priorità assoluta al Safety Engine pre-modello.
 * 2. Analisi locale deterministica sui soli dati operativi autorizzati.
 * 3. Arricchimento testuale via Gemini SOLO se useGemini === true E consentEnabled === true.
 *    Con memoria AI OFF non invia mai dati personali a Gemini.
 */
export async function executeServerProactiveAnalysis(
  params: ServerProactiveParams
): Promise<ServerProactiveOutput> {
  // 1. Safety Engine pre-modello
  if (params.userContextText) {
    const safety = evaluatePreModelSafety(params.userContextText);
    if (safety.crisisDetected) {
      return {
        result: {
          safetyBlocked: true,
          generatedAt: params.nowIso ?? new Date().toISOString(),
          suggestions: [],
          skippedDuplicates: 0,
        },
        safetyReply: safety.reply,
        usedGemini: false,
        usedFallback: false,
      };
    }
  }

  // 2. Analisi deterministica locale
  const baseline = analyzeProactiveOpportunities(params);
  if (baseline.safetyBlocked || baseline.suggestions.length === 0) {
    return {
      result: baseline,
      usedGemini: false,
      usedFallback: false,
    };
  }

  // 3. Privacy: non inviare mai dati personali a Gemini senza consenso attivo
  if (!params.useGemini || !params.consentEnabled) {
    return {
      result: baseline,
      usedGemini: false,
      usedFallback: false,
    };
  }

  if (!params.apiKey && !params.geminiCaller) {
    return {
      result: baseline,
      usedGemini: false,
      usedFallback: true,
      fallbackReason: "missing_api_key",
    };
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_PROACTIVE_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prompt = [
    "Riformula in modo gentile, conciso e non invasivo (in italiano) il seguente suggerimento operativo di AURA AI.",
    "Non inventare fatti, non formulare diagnosi, non imporre azioni.",
    `Titolo: "${baseline.suggestions[0].title}"`,
    `Descrizione: "${baseline.suggestions[0].description}"`,
    'Rispondi SOLO con JSON: {"description": string}',
  ].join("\n");

  try {
    const raw = params.geminiCaller
      ? await params.geminiCaller(prompt, controller.signal)
      : await (async () => {
          const ai = createGeminiClient(params.apiKey!);
          const res = await ai.models.generateContent({
            model: DEFAULT_PROACTIVE_MODEL,
            contents: prompt,
            config: {
              temperature: 0.2,
              maxOutputTokens: 200,
              responseMimeType: "application/json",
              abortSignal: controller.signal,
            },
          });
          return res.text ?? "";
        })();

    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { description?: string };
    if (parsed && typeof parsed.description === "string" && parsed.description.trim()) {
      const updated = baseline.suggestions.map((s, idx) =>
        idx === 0 ? { ...s, description: parsed.description!.trim().slice(0, 260) } : s
      );
      return {
        result: { ...baseline, suggestions: updated },
        usedGemini: true,
        usedFallback: false,
      };
    }

    return {
      result: baseline,
      usedGemini: false,
      usedFallback: true,
      fallbackReason: "invalid_gemini_json",
    };
  } catch (error) {
    return {
      result: baseline,
      usedGemini: false,
      usedFallback: true,
      fallbackReason: timedOut
        ? "timeout"
        : error instanceof Error
        ? error.message.slice(0, 120)
        : "gemini_error",
    };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}
