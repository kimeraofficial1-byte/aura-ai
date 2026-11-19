import { createPlan } from "../src/planning/planningEngine";
import type { PersonalPlan, PlanCreateInput, TaskPriority } from "../src/planning/types";
import { createGeminiClient } from "./auraAgent";
import { evaluatePreModelSafety } from "./safety";

const DEFAULT_PLANNING_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_PLANNING_TIMEOUT_MS = 6000;

export interface ServerPlanningParams extends PlanCreateInput {
  apiKey?: string;
  useGemini?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Hook per test unitari deterministici senza chiamate di rete */
  geminiCaller?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

export interface ServerPlanningOutput {
  crisisDetected: boolean;
  safetyReply?: string;
  plan?: PersonalPlan;
  usedFallback: boolean;
  fallbackReason?: string;
}

interface GeminiPlanEnrichment {
  desiredOutcome?: string;
  tasks?: Array<{
    title: string;
    description: string;
    priority?: TaskPriority;
    estimatedMinutes?: number;
  }>;
  uncertainties?: string[];
}

function parseGeminiPlanJson(raw: string): GeminiPlanEnrichment | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as GeminiPlanEnrichment;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Orchestratore server-side per Planning Engine V1.
 * 1. Controllo Safety Engine pre-modello (priorità assoluta).
 * 2. Baseline deterministica locale (con Reasoning Engine V1).
 * 3. Arricchimento opzionale via Gemini con timeout e fallback locale garantito.
 */
export async function executeServerPlanning(
  params: ServerPlanningParams
): Promise<ServerPlanningOutput> {
  // 1. Priorità assoluta al Safety Engine pre-modello
  const safety = evaluatePreModelSafety(params.declaredGoal);
  if (safety.crisisDetected) {
    return {
      crisisDetected: true,
      safetyReply: safety.reply,
      usedFallback: false,
    };
  }

  // 2. Baseline deterministica locale
  const baseline = createPlan({
    ...params,
    crisisBlocked: false,
  });

  if (!params.useGemini) {
    return {
      crisisDetected: false,
      plan: baseline,
      usedFallback: false,
    };
  }

  if (!params.apiKey && !params.geminiCaller) {
    return {
      crisisDetected: false,
      plan: baseline,
      usedFallback: true,
      fallbackReason: "missing_api_key",
    };
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const prompt = [
    "Sei il modulo Planning Engine di AURA AI. Rispondi SOLO con JSON valido in italiano.",
    "Non formulare diagnosi, non inventare fatti non dichiarati, non proporre azioni esterne autonome.",
    `Obiettivo dichiarato: "${params.declaredGoal.slice(0, 400)}"`,
    `Orizzonte: ${params.horizon}, limite giornaliero: ${baseline.dailyMinutesLimit} minuti.`,
    'Schema JSON: {"desiredOutcome": string, "tasks": [{"title": string, "description": string, "priority": "alta"|"media"|"bassa", "estimatedMinutes": number}], "uncertainties": [string]}',
  ].join("\n");

  try {
    const rawJson = params.geminiCaller
      ? await params.geminiCaller(prompt, controller.signal)
      : await (async () => {
          const ai = createGeminiClient(params.apiKey!);
          const response = await ai.models.generateContent({
            model: DEFAULT_PLANNING_MODEL,
            contents: prompt,
            config: {
              temperature: 0.2,
              maxOutputTokens: 600,
              responseMimeType: "application/json",
              abortSignal: controller.signal,
            },
          });
          return response.text ?? "";
        })();

    const enriched = parseGeminiPlanJson(rawJson);
    if (!enriched) {
      return {
        crisisDetected: false,
        plan: baseline,
        usedFallback: true,
        fallbackReason: "invalid_gemini_json",
      };
    }

    const mergedTasks =
      Array.isArray(enriched.tasks) && enriched.tasks.length > 0
        ? baseline.tasks.map((task, idx) => {
            const gTask = enriched.tasks?.[idx];
            if (!gTask || !gTask.title?.trim()) return task;
            const validPriority: TaskPriority =
              gTask.priority === "alta" || gTask.priority === "media" || gTask.priority === "bassa"
                ? gTask.priority
                : task.priority;
            const clampedMinutes =
              typeof gTask.estimatedMinutes === "number" && gTask.estimatedMinutes >= 5
                ? Math.min(baseline.dailyMinutesLimit, Math.round(gTask.estimatedMinutes))
                : task.estimatedMinutes;
            return {
              ...task,
              title: gTask.title.trim().slice(0, 120),
              description: gTask.description?.trim().slice(0, 260) || task.description,
              priority: validPriority,
              estimatedMinutes: clampedMinutes,
            };
          })
        : baseline.tasks;

    const mergedPlan: PersonalPlan = {
      ...baseline,
      desiredOutcome: enriched.desiredOutcome?.trim() || baseline.desiredOutcome,
      tasks: mergedTasks,
      uncertainties: Array.isArray(enriched.uncertainties) && enriched.uncertainties.length > 0
        ? Array.from(new Set([...baseline.uncertainties, ...enriched.uncertainties.slice(0, 3)]))
        : baseline.uncertainties,
      source: "gemini",
    };

    return {
      crisisDetected: false,
      plan: mergedPlan,
      usedFallback: false,
    };
  } catch (error) {
    return {
      crisisDetected: false,
      plan: baseline,
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
