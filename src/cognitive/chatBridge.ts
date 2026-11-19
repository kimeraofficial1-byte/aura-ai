import type { OrchestrationRequest, ToolStorageAdapter } from "../orchestration/types";
import type { CognitiveCoordinator } from "./cognitiveCoordinator";
import type {
  CognitiveEngineId,
  CognitiveIntent,
  CognitiveResult,
  CognitiveSessionContext,
} from "./types";

export interface PendingCognitiveAction {
  executionId: string;
  originalInput: string;
  intent: CognitiveIntent;
  operationId: string;
  description: string;
  engines: CognitiveEngineId[];
  explicitSteps?: OrchestrationRequest["explicitSteps"];
}

export interface ChatCognitiveRouteOutcome {
  mode: "stream_gemini" | "direct" | "awaiting_confirmation";
  reply?: string;
  crisisDetected?: boolean;
  pendingAction?: PendingCognitiveAction;
  result: CognitiveResult;
}

export function formatCognitiveChatReply(result: CognitiveResult): string {
  if (result.status === "safety_blocked") {
    return (
      result.safetyReply ??
      "In questo momento la priorità è il tuo supporto immediato."
    );
  }

  if (result.status === "needs_clarification") {
    return (
      result.clarificationQuestion ??
      "Puoi darmi qualche dettaglio in più prima di procedere?"
    );
  }

  if (result.status === "timeout") {
    return "La richiesta ha impiegato troppo tempo ed è stata interrotta in sicurezza. Puoi riprovare tra poco.";
  }

  if (result.status === "cancelled") {
    return "Operazione annullata come richiesto. Nessun dato è stato modificato.";
  }

  if (result.status === "failed") {
    return `Non è stato possibile completare l'operazione: ${result.summary}`;
  }

  if (result.status === "awaiting_authorization") {
    return `Ho preparato l'operazione (${result.intent}), ma prima di eseguirla ho bisogno della tua conferma esplicita.`;
  }

  if (result.intent === "READ") {
    const op = result.data?.operational;
    const summary = result.data?.orchestration?.finalSummary ?? result.summary;
    if (!op) return summary;
    const parts: string[] = [summary];
    if (op.plans.length > 0 && /pian/i.test(summary)) {
      parts.push(
        `Piani attuali: ${op.plans
          .slice(0, 5)
          .map((p) => `• ${p.title} (${p.status})`)
          .join("\n")}`
      );
    }
    if (op.missions.length > 0 && /mission/i.test(summary)) {
      parts.push(
        `Missioni attuali: ${op.missions
          .slice(0, 5)
          .map((m) => `• ${m.title} (${m.status})`)
          .join("\n")}`
      );
    }
    if (op.growthGoals.length > 0 && /obiettiv/i.test(summary)) {
      parts.push(
        `Obiettivi attuali: ${op.growthGoals
          .slice(0, 5)
          .map((g) => `• ${g.title} (${g.status})`)
          .join("\n")}`
      );
    }
    return parts.join("\n\n");
  }

  if (result.intent === "ANALYZE") {
    const suggestions = result.data?.proactive?.suggestions ?? [];
    if (suggestions.length === 0) {
      return `${result.summary} Non risultano criticità urgenti sui dati operativi attuali.`;
    }
    const list = suggestions
      .slice(0, 3)
      .map((s) => `• ${s.title}: ${s.proposedAction}`)
      .join("\n");
    return `${result.summary}\n\nProposte prioritarie:\n${list}`;
  }

  return result.summary;
}

export function buildPendingCognitiveAction(
  originalInput: string,
  result: CognitiveResult,
  explicitSteps?: OrchestrationRequest["explicitSteps"]
): PendingCognitiveAction | null {
  if (result.status !== "awaiting_authorization") return null;
  const auth = result.authorizationsRequired[0];
  const operationId = auth?.id ?? `op-${result.intent.toLowerCase()}`;
  const description =
    auth?.reason ??
    `Conferma richiesta per l'operazione ${result.intent} su "${originalInput}".`;

  return {
    executionId: result.executionId,
    originalInput,
    intent: result.intent,
    operationId,
    description,
    engines: result.selectedEngines,
    explicitSteps,
  };
}

export async function routeChatMessageWithCoordinator(
  coordinator: CognitiveCoordinator,
  params: {
    input: string;
    consentEnabled: boolean;
    crisisBlocked?: boolean;
    sessionContext?: CognitiveSessionContext;
    approvedOperationIds?: string[];
    explicitSteps?: OrchestrationRequest["explicitSteps"];
    storage?: ToolStorageAdapter;
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<ChatCognitiveRouteOutcome> {
  const result = await coordinator.execute({
    input: params.input,
    consentEnabled: params.consentEnabled,
    crisisBlocked: params.crisisBlocked,
    sessionContext: params.sessionContext,
    approvedOperationIds: params.approvedOperationIds,
    explicitSteps: params.explicitSteps,
    storage: params.storage,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  if (result.status === "safety_blocked") {
    return {
      mode: "direct",
      reply: formatCognitiveChatReply(result),
      crisisDetected: true,
      result,
    };
  }

  if (result.status === "needs_clarification") {
    return {
      mode: "direct",
      reply: formatCognitiveChatReply(result),
      result,
    };
  }

  if (result.status === "awaiting_authorization") {
    const pendingAction =
      buildPendingCognitiveAction(params.input, result, params.explicitSteps) ?? undefined;
    return {
      mode: "awaiting_confirmation",
      reply: formatCognitiveChatReply(result),
      pendingAction,
      result,
    };
  }

  // CHAT standard -> instrada al normale streaming SSE di Gemini (Personalità V2 + Reasoning + Voice V2)
  if (result.intent === "CHAT" && result.status === "completed") {
    return {
      mode: "stream_gemini",
      result,
    };
  }

  return {
    mode: "direct",
    reply: formatCognitiveChatReply(result),
    result,
  };
}
