import { ThinkingLevel, Type } from "@google/genai";
import { buildEmotionalTrendSummaryForGemini } from "../src/emotion/empathy";
import {
  generateLocalPersonalInsights,
  parseAndValidateInsightsJson,
  sanitizeGrowthGoalList,
} from "../src/growth/engine";
import type {
  PersonalInsightsContext,
  PersonalInsightsResult,
} from "../src/growth/types";
import { isSafeForLongTermMemory } from "../src/memory/privacyFilter";
import type { CheckInRecord } from "../src/memory/types";
import type { AdaptiveMission } from "../src/missions/types";
import { createGeminiClient, getAuraModelName, mapGeminiError } from "./auraAgent";
import { CRISIS_EMERGENCY_REPLY, evaluatePreModelSafety } from "./safety";

const INSIGHTS_GEMINI_TIMEOUT_MS = 22_000;

const INSIGHTS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    insufficientData: {
      type: Type.BOOLEAN,
      description: "Vero se i dati reali disponibili non bastano per osservazioni affidabili.",
    },
    insufficientDataMessage: {
      type: Type.STRING,
      description: "Messaggio chiaro e trasparente se insufficientData è vero.",
    },
    insights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Titolo breve e neutro." },
          observedFacts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Fatti numerici o eventi realmente registrati nel contesto.",
          },
          cautiousInterpretation: {
            type: Type.STRING,
            description:
              "Osservazione prudente e ipotetica, chiaramente distinta dai fatti e priva di diagnosi.",
          },
          confidenceNote: {
            type: Type.STRING,
            description: "Nota trasparente sul livello di copertura dei dati.",
          },
        },
        required: ["title", "observedFacts", "cautiousInterpretation", "confidenceNote"],
      },
    },
  },
  required: ["insufficientData", "insights"],
};

export interface ValidatedGrowthInsightsRequest extends PersonalInsightsContext {
  useGemini: boolean;
}

export function validateGrowthInsightsRequest(
  rawBody: unknown
): { ok: true; data: ValidatedGrowthInsightsRequest } | { ok: false; error: string } {
  if (!rawBody || typeof rawBody !== "object") {
    return { ok: false, error: "Formato della richiesta di crescita personale non valido." };
  }

  const body = rawBody as Record<string, unknown>;
  const goals = sanitizeGrowthGoalList(body.goals);
  const preferences = Array.isArray(body.preferences)
    ? body.preferences
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim().slice(0, 120))
        .filter((p) => p.length > 0 && isSafeForLongTermMemory(p))
        .slice(0, 10)
    : [];

  const missions: AdaptiveMission[] = Array.isArray(body.missions)
    ? body.missions
        .filter((m): m is AdaptiveMission => {
          if (!m || typeof m !== "object") return false;
          const r = m as Record<string, unknown>;
          return (
            typeof r.id === "string" &&
            typeof r.title === "string" &&
            typeof r.status === "string" &&
            typeof r.category === "string"
          );
        })
        .slice(-30)
    : [];

  const checkIns: CheckInRecord[] = Array.isArray(body.checkIns)
    ? body.checkIns
        .filter((c): c is CheckInRecord => {
          if (!c || typeof c !== "object") return false;
          const r = c as Record<string, unknown>;
          return (
            typeof r.date === "string" &&
            typeof r.stress === "number" &&
            Number.isFinite(r.stress) &&
            typeof r.mood === "string"
          );
        })
        .slice(-30)
    : [];

  const emotionalTrends = Array.isArray(body.emotionalTrends)
    ? body.emotionalTrends.slice(-20)
    : [];

  const focusPrompt =
    typeof body.focusPrompt === "string"
      ? body.focusPrompt.trim().slice(0, 300)
      : undefined;

  return {
    ok: true,
    data: {
      goals,
      preferences,
      missions,
      checkIns,
      emotionalTrends,
      latestAnalysis: null,
      consentEnabled: body.consentEnabled === true,
      focusPrompt,
      useGemini: body.useGemini !== false,
    },
  };
}

function checkGrowthContextSafety(ctx: PersonalInsightsContext): boolean {
  const texts: string[] = [
    ctx.focusPrompt ?? "",
    ...ctx.preferences,
    ...ctx.goals.flatMap((g) => [
      g.title,
      g.description ?? "",
      ...g.steps.map((s) => s.title),
    ]),
  ].filter(Boolean);

  return texts.some((t) => evaluatePreModelSafety(t).crisisDetected);
}

function buildGrowthGeminiPrompt(ctx: PersonalInsightsContext): string {
  const safeGoals = ctx.goals.filter((g) => isSafeForLongTermMemory(g.title));
  const completedMissions = ctx.missions.filter((m) => m.status === "completata");
  const skippedMissions = ctx.missions.filter(
    (m) => m.status === "rifiutata" || m.status === "annullata"
  );

  const lines: string[] = [
    `Consenso memoria persistente attivo: ${ctx.consentEnabled ? "sì" : "no (solo sessione)"}.`,
    `Obiettivi reali dichiarati (${safeGoals.length}): ${
      safeGoals.length > 0
        ? safeGoals
            .map(
              (g) =>
                `"${g.title}" [stato: ${g.status}, passaggi: ${g.steps.filter((s) => s.done).length}/${g.steps.length}]`
            )
            .join("; ")
        : "nessuno."
    }`,
    `Preferenze espresse reali: ${
      ctx.preferences.length > 0 ? ctx.preferences.join(" | ") : "nessuna specificata."
    }`,
    `Check-in disponibili (${ctx.checkIns.length}): ${
      ctx.checkIns.length > 0
        ? ctx.checkIns
            .slice(-7)
            .map((c) => `${c.date.slice(0, 10)}: umore=${c.mood}, stress=${c.stress}/10`)
            .join(" | ")
        : "nessuno."
    }`,
    `Missioni completate (${completedMissions.length}): ${
      completedMissions.length > 0
        ? completedMissions
            .slice(-6)
            .map((m) => `${m.title} (${m.category})`)
            .join(" | ")
        : "nessuna."
    }`,
    `Missioni saltate/interrotte (${skippedMissions.length}) — da trattare senza giudizio.`,
  ];

  const trendSummary = buildEmotionalTrendSummaryForGemini({
    consentEnabled: ctx.consentEnabled,
    trends: ctx.emotionalTrends,
  });
  if (trendSummary) {
    lines.push(trendSummary);
  } else {
    lines.push("Storico emotivo a lungo termine: non incluso (assenza consenso o vuoto).");
  }

  if (ctx.focusPrompt) {
    lines.push(`Domanda specifica dell'utente: "${ctx.focusPrompt}".`);
  }

  return lines.join("\n");
}

export async function generatePersonalInsights(params: {
  context: PersonalInsightsContext;
  apiKey?: string;
  useGemini?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  generateJsonFn?: (args: {
    model: string;
    prompt: string;
    systemInstruction: string;
    signal: AbortSignal;
  }) => Promise<string>;
}): Promise<PersonalInsightsResult> {
  const { context } = params;

  // 1. SAFETY ENGINE HA SEMPRE LA PRIORITÀ ASSOLUTA
  if (checkGrowthContextSafety(context)) {
    return {
      insights: [],
      insufficientData: false,
      source: "local-reflective",
      fallbackUsed: false,
      blockedBySafety: true,
      safetyReply: CRISIS_EMERGENCY_REPLY,
      generatedAt: new Date().toISOString(),
    };
  }

  const localResult = generateLocalPersonalInsights(context);
  if (localResult.insufficientData) {
    return localResult;
  }

  const hasCustomGenerator = typeof params.generateJsonFn === "function";
  const shouldUseGemini =
    params.useGemini !== false && (hasCustomGenerator || Boolean(params.apiKey?.trim()));

  if (!shouldUseGemini || (!hasCustomGenerator && !params.apiKey?.trim())) {
    return {
      ...localResult,
      fallbackUsed: params.useGemini !== false && !params.apiKey?.trim(),
      fallbackReason: params.useGemini !== false && !params.apiKey?.trim() ? "MISSING_API_KEY" : undefined,
    };
  }

  const model = getAuraModelName();
  const timeoutMs = params.timeoutMs ?? INSIGHTS_GEMINI_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();

  if (params.signal) {
    if (params.signal.aborted) {
      clearTimeout(timer);
      return { ...localResult, fallbackUsed: true, fallbackReason: "ABORTED" };
    }
    params.signal.addEventListener("abort", onAbort, { once: true });
  }

  const systemInstruction = [
    "Sei il modulo Personal Growth Insights di AURA AI.",
    "Produci 1 o 2 osservazioni prudenti in italiano basate ESCLUSIVAMENTE sui dati reali forniti.",
    "REGOLE ASSOLUTE:",
    "- Separa nettamente i FATTI REGISTRATI (observedFacts) dalla LETTURA PRUDENTE (cautiousInterpretation).",
    "- NON formulare diagnosi, NON dedurre tratti psicologici non dichiarati, NON attribuire emozioni non confermate.",
    "- NON inventare ricordi, eventi o progressi inesistenti.",
    "- NON presentare correlazioni come certezze.",
    "- Se i dati non bastano, imposta insufficientData=true e spiegalo con chiarezza.",
    "- Restituisci esclusivamente JSON valido conforme allo schema.",
  ].join("\n");

  const thinkingLevel = model.includes("gemini-3.1-flash-lite")
    ? ThinkingLevel.MINIMAL
    : ThinkingLevel.LOW;

  try {
    const prompt = buildGrowthGeminiPrompt(context);
    let rawText = "";
    if (params.generateJsonFn) {
      rawText = await params.generateJsonFn({
        model,
        prompt,
        systemInstruction,
        signal: controller.signal,
      });
    } else {
      const ai = createGeminiClient(params.apiKey ?? "");
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: INSIGHTS_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel },
          abortSignal: controller.signal,
        },
      });
      rawText = response.text ?? "";
    }

    const parsed = parseAndValidateInsightsJson(rawText);
    if (!parsed.ok) {
      return {
        ...localResult,
        fallbackUsed: true,
        fallbackReason: "INVALID_JSON_SCHEMA",
      };
    }

    return {
      insights: parsed.insights,
      insufficientData: parsed.insufficientData,
      insufficientDataMessage: parsed.insufficientDataMessage,
      source: "gemini-json",
      fallbackUsed: false,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const mapped = mapGeminiError(error);
    return {
      ...localResult,
      fallbackUsed: true,
      fallbackReason: mapped.code,
    };
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onAbort);
  }
}
