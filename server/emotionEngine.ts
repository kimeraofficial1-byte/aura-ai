import { ThinkingLevel, Type } from "@google/genai";
import {
  analyzeEmotionDeterministic,
  parseAndValidateEmotionalAnalysisJson,
} from "../src/emotion/analyzer";
import { EMOTION_CATEGORIES, type EmotionalAnalysis } from "../src/emotion/types";
import type { ChatHistoryItem, WellnessContext } from "../src/types/aura";
import { createGeminiClient } from "./auraAgent";
import { evaluatePreModelSafety } from "./safety";

const DEFAULT_EMOTION_MODEL = "gemini-3.1-flash-lite";
const EMOTION_CLASSIFIER_TIMEOUT_MS = 6_000;

export function getEmotionClassifierModelName(): string {
  return process.env.AURA_EMOTION_MODEL?.trim() || DEFAULT_EMOTION_MODEL;
}

const EMOTION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    primaryEmotion: {
      type: Type.STRING,
      description: `Una sola categoria esatta tra: ${EMOTION_CATEGORIES.join(", ")}.`,
    },
    secondaryEmotions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Eventuali altre emozioni secondarie presenti tra le 12 categorie (max 3).",
    },
    intensity: {
      type: Type.INTEGER,
      description: "Intensità emotiva percepita da 0 a 10.",
    },
    confidence: {
      type: Type.NUMBER,
      description: "Confidenza della classificazione da 0.0 a 1.0. Usa < 0.55 se il messaggio è vago o ambiguo.",
    },
    uncertain: {
      type: Type.BOOLEAN,
      description: "true se il risultato è incerto o ambiguo.",
    },
    evidence: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Brevi parole o espressioni letterali tratte dal messaggio dell'utente.",
    },
    stressSignals: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Brevi segnali non clinici di carico o stress (es. carico lavorativo, scarso riposo).",
    },
  },
  required: [
    "primaryEmotion",
    "secondaryEmotions",
    "intensity",
    "confidence",
    "uncertain",
    "evidence",
    "stressSignals",
  ],
};

const EMOTION_CLASSIFIER_SYSTEM_INSTRUCTION = [
  "Sei un analizzatore emotivo prudente e non clinico per AURA AI.",
  `Classifica il messaggio dell'utente usando ESCLUSIVAMENTE queste 12 categorie italiane esatte: ${EMOTION_CATEGORIES.join(", ")}.`,
  "REGOLE RIGOROSE:",
  "- Non formulare diagnosi mediche, psichiatriche o psicologiche.",
  "- Non inventare emozioni o frasi assenti dal messaggio dell'utente.",
  "- Se il messaggio è ambiguo, contraddittorio o troppo vago, usa primaryEmotion='Incerto' oppure imposta confidence < 0.55 e uncertain=true.",
  "- Se il messaggio è puramente informativo o neutro senza valenza emotiva, usa primaryEmotion='Neutro'.",
  "- In 'evidence' riporta solo brevi estratti testuali realmente presenti nel messaggio.",
  "- Restituisci esclusivamente JSON valido conforme allo schema.",
].join("\n");

export async function classifyEmotionWithGemini(params: {
  apiKey: string;
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmotionalAnalysis | null> {
  const safety = evaluatePreModelSafety(params.message);
  if (safety.crisisDetected) {
    return null;
  }

  const model = getEmotionClassifierModelName();
  const ai = createGeminiClient(params.apiKey);
  const timeoutMs = params.timeoutMs ?? EMOTION_CLASSIFIER_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) {
      clearTimeout(timer);
      return null;
    }
    params.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const recentSnippet = (params.history ?? [])
    .slice(-4)
    .map((h) => `${h.role === "user" ? "Utente" : "AURA"}: ${h.text}`)
    .join("\n");

  const promptParts: string[] = [];
  if (recentSnippet) {
    promptParts.push(`Contesto recente:\n${recentSnippet}`);
  }
  if (params.context?.mood || typeof params.context?.stress === "number") {
    promptParts.push(
      `Check-in attuale: umore="${params.context?.mood ?? "non indicato"}", stress=${params.context?.stress ?? "non indicato"}/10.`
    );
  }
  promptParts.push(`Messaggio attuale dell'utente da analizzare:\n"${params.message}"`);

  const thinkingLevel =
    model.includes("gemini-3.1-flash-lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: promptParts.join("\n\n"),
      config: {
        systemInstruction: EMOTION_CLASSIFIER_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: EMOTION_RESPONSE_SCHEMA,
        thinkingConfig: { thinkingLevel },
        abortSignal: controller.signal,
      },
    });

    const parsed = parseAndValidateEmotionalAnalysisJson(response.text ?? "", {
      sourceText: params.message,
      source: "gemini-json",
    });

    return parsed.ok ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function analyzeMessageEmotion(params: {
  apiKey?: string;
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
  signal?: AbortSignal;
  useGeminiClassifier?: boolean;
  timeoutMs?: number;
}): Promise<{ crisisBlocked: boolean; analysis: EmotionalAnalysis | null }> {
  // Il controllo di crisi pre-modello ha sempre priorità assoluta
  const safety = evaluatePreModelSafety(params.message);
  if (safety.crisisDetected) {
    return { crisisBlocked: true, analysis: null };
  }

  const deterministic = analyzeEmotionDeterministic(params.message, {
    mood: params.context?.mood,
    stress: params.context?.stress,
    history: params.history,
  });

  const enableLlmClassifier =
    params.useGeminiClassifier ??
    process.env.AURA_ENABLE_LLM_EMOTION_CLASSIFIER === "true";

  if (!enableLlmClassifier || !params.apiKey?.trim()) {
    return { crisisBlocked: false, analysis: deterministic };
  }

  const llmAnalysis = await classifyEmotionWithGemini({
    apiKey: params.apiKey,
    message: params.message,
    history: params.history,
    context: params.context,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  if (!llmAnalysis) {
    return { crisisBlocked: false, analysis: deterministic };
  }

  // Fusione prudente: conserva eventuali segnali testuali certi se il modello non ne ha inclusi
  const mergedEvidence =
    llmAnalysis.evidence.length > 0 ? llmAnalysis.evidence : deterministic.evidence;
  const mergedStressSignals = Array.from(
    new Set([...llmAnalysis.stressSignals, ...deterministic.stressSignals])
  ).slice(0, 4);

  return {
    crisisBlocked: false,
    analysis: {
      ...llmAnalysis,
      evidence: mergedEvidence,
      stressSignals: mergedStressSignals,
      source: "hybrid",
    },
  };
}
