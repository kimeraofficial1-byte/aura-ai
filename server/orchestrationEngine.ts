import { runOrchestration } from "../src/orchestration/orchestrationEngine";
import { createDefaultAuraToolRegistry, ToolRegistry } from "../src/orchestration/toolRegistry";
import type { OrchestrationRequest, OrchestrationRun } from "../src/orchestration/types";
import { createGeminiClient } from "./auraAgent";
import { evaluatePreModelSafety } from "./safety";

const DEFAULT_ORCHESTRATION_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_GEMINI_TIMEOUT_MS = 5000;

export interface ServerOrchestrationParams extends OrchestrationRequest {
  apiKey?: string;
  useGemini?: boolean;
  timeoutMs?: number;
  registry?: ToolRegistry;
  /** Hook per test unitari deterministici senza rete */
  geminiCaller?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

interface GeminiToolProposal {
  steps?: Array<{
    toolId: string;
    input?: Record<string, unknown>;
  }>;
}

function parseGeminiToolProposal(raw: string): GeminiToolProposal | null {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as GeminiToolProposal;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Orchestratore server-side per AURA AI V3 Tool Orchestration Engine V1.
 * 1. Controllo Safety Engine pre-modello (priorità assoluta).
 * 2. Gemini può proporre gli strumenti da usare, ma il server valida autonomamente
 *    ogni chiamata, i parametri e i permessi tramite runOrchestration.
 * 3. Fallback deterministico locale garantito in caso di errore o timeout Gemini.
 */
export async function executeServerOrchestration(
  params: ServerOrchestrationParams
): Promise<{ run: OrchestrationRun; usedFallback: boolean; fallbackReason?: string }> {
  const registry = params.registry ?? createDefaultAuraToolRegistry();

  // 1. Priorità assoluta al Safety Engine pre-modello
  const safety = evaluatePreModelSafety(params.request);
  if (safety.crisisDetected) {
    const blockedRun = await runOrchestration(
      {
        ...params,
        crisisBlocked: true,
      },
      registry
    );
    return {
      run: {
        ...blockedRun,
        safetyReply: safety.reply ?? blockedRun.safetyReply,
        finalSummary: safety.reply ?? blockedRun.finalSummary,
      },
      usedFallback: false,
    };
  }

  if (!params.useGemini || (params.explicitSteps && params.explicitSteps.length > 0)) {
    const run = await runOrchestration(params, registry);
    return { run, usedFallback: false };
  }

  if (!params.apiKey && !params.geminiCaller) {
    const run = await runOrchestration(params, registry);
    return { run, usedFallback: true, fallbackReason: "missing_api_key" };
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const availableToolsList = registry
    .list()
    .map((t) => `- ${t.id} (${t.riskLevel}): ${t.description}`)
    .join("\n");

  const prompt = [
    "Proponi SOLO in JSON quali strumenti interni usare per soddisfare la richiesta utente.",
    "Non controllare i permessi: il server validerà autonomamente ogni chiamata.",
    "Strumenti disponibili:",
    availableToolsList,
    `Richiesta utente: "${params.request.slice(0, 400)}"`,
    'Formato JSON: {"steps": [{"toolId": string, "input": object}]}',
  ].join("\n");

  try {
    const rawJson = params.geminiCaller
      ? await params.geminiCaller(prompt, controller.signal)
      : await (async () => {
          const ai = createGeminiClient(params.apiKey!);
          const response = await ai.models.generateContent({
            model: DEFAULT_ORCHESTRATION_MODEL,
            contents: prompt,
            config: {
              temperature: 0.1,
              maxOutputTokens: 400,
              responseMimeType: "application/json",
              abortSignal: controller.signal,
            },
          });
          return response.text ?? "";
        })();

    const proposal = parseGeminiToolProposal(rawJson);
    if (!proposal || !Array.isArray(proposal.steps) || proposal.steps.length === 0) {
      const run = await runOrchestration(params, registry);
      return { run, usedFallback: true, fallbackReason: "invalid_gemini_proposal" };
    }

    // Il server valida autonomamente ogni chiamata tramite runOrchestration
    const run = await runOrchestration(
      {
        ...params,
        explicitSteps: proposal.steps.map((s, idx) => {
          const toolId = String(s.toolId);
          const tool = registry.get(toolId);
          const inferredOp =
            tool && tool.readOnly && tool.supportedOperations.includes("ANALYZE")
              ? ("ANALYZE" as const)
              : undefined;
          return {
            id: `gemini-step-${idx + 1}-${toolId}`,
            toolId,
            operation: inferredOp,
            input: s.input && typeof s.input === "object" ? s.input : {},
            dependsOn: idx > 0 ? [`gemini-step-${idx}-${proposal.steps![idx - 1].toolId}`] : [],
          };
        }),
      },
      registry
    );

    return {
      run: { ...run, source: "gemini" },
      usedFallback: false,
    };
  } catch (error) {
    const run = await runOrchestration(params, registry);
    return {
      run,
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
