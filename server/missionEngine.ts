import { ThinkingLevel, Type } from "@google/genai";
import { parseAndValidateEmotionalAnalysisJson } from "../src/emotion/analyzer";
import { isSafeForLongTermMemory, normalizeText } from "../src/memory/privacyFilter";
import {
  generateAdaptiveMissionsLocal,
  parseAndValidateMissionsJson,
} from "../src/missions/engine";
import {
  MISSION_CATEGORIES,
  type AdaptiveMission,
  type EnergyLevel,
  type MissionGenerationContext,
  type MissionGenerationResult,
} from "../src/missions/types";
import { createGeminiClient, getAuraModelName, mapGeminiError } from "./auraAgent";
import { CRISIS_EMERGENCY_REPLY, evaluatePreModelSafety } from "./safety";

const MISSION_GEMINI_TIMEOUT_MS = 22_000;

const MISSIONS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    missions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Titolo breve in italiano." },
          description: { type: Type.STRING, description: "Descrizione accogliente, mai colpevolizzante." },
          category: {
            type: Type.STRING,
            description: `Esattamente una tra: ${MISSION_CATEGORIES.join(", ")}.`,
          },
          estimatedMinutes: { type: Type.INTEGER, description: "Durata stimata in minuti." },
          effortLevel: {
            type: Type.STRING,
            description: "Uno tra: basso, medio, alto.",
          },
          goal: { type: Type.STRING, description: "Obiettivo semplice collegato al contesto reale." },
          instructions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Da 2 a 4 istruzioni pratiche e chiare.",
          },
          adaptationNote: {
            type: Type.STRING,
            description: "Breve nota su come è stata adattata a tempo/energia.",
          },
        },
        required: [
          "title",
          "description",
          "category",
          "estimatedMinutes",
          "effortLevel",
          "goal",
          "instructions",
        ],
      },
    },
  },
  required: ["missions"],
};

export interface ValidatedMissionRequest extends MissionGenerationContext {
  useGemini: boolean;
}

export function validateMissionGenerateRequest(
  rawBody: unknown
): { ok: true; data: ValidatedMissionRequest } | { ok: false; error: string } {
  if (!rawBody || typeof rawBody !== "object") {
    return { ok: false, error: "Formato della richiesta missioni non valido." };
  }

  const body = rawBody as Record<string, unknown>;
  const availableMinutes =
    typeof body.availableMinutes === "number" && Number.isFinite(body.availableMinutes)
      ? Math.max(2, Math.min(60, Math.round(body.availableMinutes)))
      : 10;

  const energyLevel: EnergyLevel =
    body.energyLevel === "bassa" ||
    body.energyLevel === "media" ||
    body.energyLevel === "buona"
      ? body.energyLevel
      : "media";

  const sanitizeList = (val: unknown, maxLen = 140): string[] => {
    if (!Array.isArray(val)) return [];
    return val
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().slice(0, maxLen))
      .filter((x) => x.length > 0)
      .slice(0, 10);
  };

  const goals = sanitizeList(body.goals);
  const preferences = sanitizeList(body.preferences);
  const recentMood =
    typeof body.recentMood === "string" ? body.recentMood.trim().slice(0, 64) : undefined;
  const recentStress =
    typeof body.recentStress === "number" && Number.isFinite(body.recentStress)
      ? Math.max(0, Math.min(10, Math.round(body.recentStress)))
      : undefined;

  let emotionalAnalysis = null;
  if (body.emotionalAnalysis && typeof body.emotionalAnalysis === "object") {
    const validatedEmotion = parseAndValidateEmotionalAnalysisJson(body.emotionalAnalysis);
    if (validatedEmotion.ok) {
      emotionalAnalysis = validatedEmotion.data;
    }
  }

  const existingMissions: AdaptiveMission[] = Array.isArray(body.existingMissions)
    ? body.existingMissions
        .filter((m): m is AdaptiveMission => {
          if (!m || typeof m !== "object") return false;
          const rec = m as Record<string, unknown>;
          return typeof rec.title === "string" && typeof rec.status === "string";
        })
        .slice(-30)
    : [];

  const focusNote =
    typeof body.focusNote === "string" ? body.focusNote.trim().slice(0, 400) : undefined;

  return {
    ok: true,
    data: {
      availableMinutes,
      energyLevel,
      goals,
      preferences,
      recentMood,
      recentStress,
      emotionalAnalysis,
      consentEnabled: body.consentEnabled === true,
      existingMissions,
      focusNote,
      useGemini: body.useGemini !== false,
    },
  };
}

function checkMissionContextSafety(ctx: MissionGenerationContext): boolean {
  const textsToCheck = [
    ctx.focusNote ?? "",
    ...ctx.goals,
    ...ctx.preferences,
  ].filter(Boolean);

  return textsToCheck.some((text) => evaluatePreModelSafety(text).crisisDetected);
}

function buildMissionGeminiPrompt(ctx: MissionGenerationContext): string {
  const safeGoals = ctx.goals.filter((g) => isSafeForLongTermMemory(g));
  const safePrefs = ctx.preferences.filter((p) => isSafeForLongTermMemory(p));
  const rejectedTitles = ctx.existingMissions
    .filter((m) => m.status === "rifiutata" || m.status === "annullata")
    .map((m) => m.title);
  const completedCount = ctx.existingMissions.filter((m) => m.status === "completata").length;

  const uncertain =
    Boolean(ctx.emotionalAnalysis?.uncertain) ||
    ctx.emotionalAnalysis?.primaryEmotion === "Incerto";

  const emotionLine = ctx.emotionalAnalysis
    ? uncertain
      ? "Contesto emotivo attuale: incerto/sfumato -> NON fare supposizioni emotive; proponi esclusivamente attività neutre, gentili e facoltative."
      : `Contesto emotivo non clinico: ${ctx.emotionalAnalysis.primaryEmotion} (intensità ${ctx.emotionalAnalysis.intensity}/10). Usa solo come riferimento contestuale delicato.`
    : "Contesto emotivo attuale: non disponibile.";

  return [
    `Tempo disponibile dichiarato: massimo ${ctx.availableMinutes} minuti per missione.`,
    `Livello di energia attuale: ${ctx.energyLevel}. (Se 'bassa', usa solo effortLevel='basso'.)`,
    `Missioni già completate: ${completedCount}. (Aumenta la complessità a 'medio' o 'alto' solo se energia buona e completate >= 2.)`,
    safeGoals.length > 0
      ? `Obiettivi reali dichiarati dall'utente: ${safeGoals.join(" | ")}.`
      : "Obiettivi dichiarati: nessuno specificato. NON inventare obiettivi personali dell'utente.",
    safePrefs.length > 0
      ? `Preferenze espresse reali: ${safePrefs.join(" | ")}.`
      : "Preferenze espresse: nessuna specificata. NON inventare preferenze.",
    ctx.recentMood || typeof ctx.recentStress === "number"
      ? `Check-in recente: umore "${ctx.recentMood ?? "non indicato"}", stress ${ctx.recentStress ?? "non indicato"}/10.`
      : "Check-in recente: non disponibile.",
    emotionLine,
    rejectedTitles.length > 0
      ? `Titoli già rifiutati/annullati da NON riproporre: ${rejectedTitles.join(" | ")}.`
      : "Nessuna missione rifiutata in precedenza.",
    ctx.focusNote ? `Richiesta attuale dell'utente: "${ctx.focusNote}".` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateAdaptiveMissions(params: {
  context: MissionGenerationContext;
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
}): Promise<MissionGenerationResult> {
  const { context } = params;

  // 1. SAFETY ENGINE HA PRIORITÀ ASSOLUTA
  if (checkMissionContextSafety(context)) {
    return {
      missions: [],
      source: "local-adaptive",
      askUserPreference: false,
      fallbackUsed: false,
      blockedBySafety: true,
      safetyReply: CRISIS_EMERGENCY_REPLY,
    };
  }

  const localResult = generateAdaptiveMissionsLocal(context, 3);
  const hasCustomGenerator = typeof params.generateJsonFn === "function";
  const shouldUseGemini =
    params.useGemini !== false && (hasCustomGenerator || Boolean(params.apiKey?.trim()));

  if (!shouldUseGemini || (!hasCustomGenerator && !params.apiKey?.trim())) {
    return {
      ...localResult,
      fallbackUsed: params.useGemini !== false && !params.apiKey?.trim(),
      fallbackReason: !params.apiKey?.trim() ? "MISSING_API_KEY" : undefined,
    };
  }

  const model = getAuraModelName();
  const timeoutMs = params.timeoutMs ?? MISSION_GEMINI_TIMEOUT_MS;
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
    "Sei il modulo Adaptive Mission Engine di AURA AI.",
    "Genera esattamente 3 micro-missioni di benessere quotidiane personalizzate in italiano.",
    `Categorie consentite (esatte): ${MISSION_CATEGORIES.join(", ")}.`,
    "REGOLE RIGOROSE:",
    "- NON inventare obiettivi, preferenze o ricordi non forniti nel prompt.",
    "- NON formulare diagnosi cliniche né usare tono colpevolizzante, classifiche o pressioni.",
    "- Rispetta rigorosamente il limite di tempo disponibile e riduci l'impegno a 'basso' se l'energia è bassa o lo stress è elevato.",
    "- Non riproporre missioni presenti nell'elenco dei titoli rifiutati.",
    "- Restituisci esclusivamente JSON valido conforme allo schema.",
  ].join("\n");

  const thinkingLevel = model.includes("gemini-3.1-flash-lite")
    ? ThinkingLevel.MINIMAL
    : ThinkingLevel.LOW;

  try {
    const prompt = buildMissionGeminiPrompt(context);
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
          responseSchema: MISSIONS_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel },
          abortSignal: controller.signal,
        },
      });
      rawText = response.text ?? "";
    }

    const parsed = parseAndValidateMissionsJson(rawText, {
      maxMinutes: context.availableMinutes,
      energyLevel: context.energyLevel,
      source: "gemini-json",
    });

    if (!parsed.ok) {
      return {
        ...localResult,
        fallbackUsed: true,
        fallbackReason: "INVALID_JSON_SCHEMA",
      };
    }

    const rejectedSet = new Set(
      context.existingMissions
        .filter((m) => m.status === "rifiutata" || m.status === "annullata")
        .map((m) => normalizeText(m.title))
    );
    const filteredMissions = parsed.missions.filter(
      (m) => !rejectedSet.has(normalizeText(m.title))
    );

    if (filteredMissions.length === 0) {
      return {
        ...localResult,
        fallbackUsed: true,
        fallbackReason: "FILTERED_REJECTED_MISSIONS",
      };
    }

    return {
      missions: filteredMissions,
      source: "gemini-json",
      askUserPreference: localResult.askUserPreference,
      preferencePrompt: localResult.preferencePrompt,
      fallbackUsed: false,
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
