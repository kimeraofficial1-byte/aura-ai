import { Type } from "@google/genai";
import {
  buildReasoningGuidanceForGemini,
  runStructuredReasoning,
} from "../src/reasoning/reasoningEngine";
import type { ReasoningResult } from "../src/reasoning/types";
import type { ChatHistoryItem, WellnessContext } from "../src/types/aura";
import { createGeminiClient } from "./auraAgent";
import { evaluatePreModelSafety } from "./safety";

const DEFAULT_REASONING_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_REASONING_TIMEOUT_MS = 4_500;

const REASONING_JSON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    primaryGoal: { type: Type.STRING },
    subProblems: { type: Type.ARRAY, items: { type: Type.STRING } },
    missingInformation: { type: Type.ARRAY, items: { type: Type.STRING } },
    clarificationQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
    actionableSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["primaryGoal", "subProblems", "missingInformation", "actionableSteps"],
};

export interface ServerReasoningParams {
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  consentEnabled?: boolean;
  apiKey?: string;
  useGemini?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Iniettabile nei test per simulare errori Gemini o timeout senza chiamate di rete */
  geminiCaller?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

export interface ServerReasoningOutput {
  result: ReasoningResult;
  guidanceForGemini: string;
  usedFallback: boolean;
  fallbackReason?: "safety_blocked" | "disabled" | "missing_api_key" | "timeout" | "gemini_error";
}

export async function executeServerReasoning(
  params: ServerReasoningParams
): Promise<ServerReasoningOutput> {
  // 1. Priorità assoluta al Safety Engine pre-modello
  const safety = evaluatePreModelSafety(params.message);
  if (safety.crisisDetected) {
    const blocked = runStructuredReasoning({
      message: params.message,
      history: params.history,
      context: params.context,
      consentEnabled: false,
      crisisBlocked: true,
    });
    return {
      result: blocked,
      guidanceForGemini: "",
      usedFallback: true,
      fallbackReason: "safety_blocked",
    };
  }

  // 2. Baseline deterministica locale (sempre disponibile, veloce e verificabile)
  const baseline = runStructuredReasoning({
    message: params.message,
    history: params.history,
    context: params.context,
    consentEnabled: Boolean(params.consentEnabled),
    crisisBlocked: false,
  });

  if (!params.useGemini || baseline.complexity === "simple") {
    return {
      result: baseline,
      guidanceForGemini: buildReasoningGuidanceForGemini(baseline),
      usedFallback: false,
    };
  }

  if (!params.apiKey && !params.geminiCaller) {
    return {
      result: baseline,
      guidanceForGemini: buildReasoningGuidanceForGemini(baseline),
      usedFallback: true,
      fallbackReason: "missing_api_key",
    };
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_REASONING_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prompt = [
    "Analizza in italiano la richiesta seguente e restituisci SOLO JSON conforme allo schema.",
    "Non formulare diagnosi, non inventare fatti mancanti, non esporre catene di pensiero private.",
    `Richiesta utente: "${params.message.slice(0, 600)}"`,
  ].join("\n");

  try {
    const rawJson = params.geminiCaller
      ? await params.geminiCaller(prompt, controller.signal)
      : await (async () => {
          const ai = createGeminiClient(params.apiKey!);
          const res = await ai.models.generateContent({
            model: process.env.AURA_REASONING_MODEL?.trim() || DEFAULT_REASONING_MODEL,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: REASONING_JSON_SCHEMA,
              abortSignal: controller.signal,
            },
          });
          return res.text ?? "";
        })();

    const parsed = JSON.parse(rawJson) as {
      primaryGoal?: unknown;
      subProblems?: unknown;
      missingInformation?: unknown;
      clarificationQuestions?: unknown;
      actionableSteps?: unknown;
    };

    const enriched: ReasoningResult = {
      ...baseline,
      primaryGoal:
        typeof parsed.primaryGoal === "string" && parsed.primaryGoal.trim()
          ? parsed.primaryGoal.trim().slice(0, 160)
          : baseline.primaryGoal,
      subProblems:
        Array.isArray(parsed.subProblems) && parsed.subProblems.length > 0
          ? parsed.subProblems
              .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
              .slice(0, 5)
          : baseline.subProblems,
      missingInformation: Array.isArray(parsed.missingInformation)
        ? parsed.missingInformation
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .slice(0, 4)
        : baseline.missingInformation,
      clarificationQuestions: Array.isArray(parsed.clarificationQuestions)
        ? parsed.clarificationQuestions
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .slice(0, 2)
        : baseline.clarificationQuestions,
      actionableSteps:
        Array.isArray(parsed.actionableSteps) && parsed.actionableSteps.length > 0
          ? parsed.actionableSteps
              .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
              .slice(0, 4)
          : baseline.actionableSteps,
      source: "gemini-structured",
    };

    return {
      result: enriched,
      guidanceForGemini: buildReasoningGuidanceForGemini(enriched),
      usedFallback: false,
    };
  } catch {
    return {
      result: baseline,
      guidanceForGemini: buildReasoningGuidanceForGemini(baseline),
      usedFallback: true,
      fallbackReason: timedOut ? "timeout" : "gemini_error",
    };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}
