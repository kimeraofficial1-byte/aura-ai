import { CognitiveCoordinator } from "../src/cognitive/cognitiveCoordinator";
import type { CognitiveAdapters, CognitiveResult } from "../src/cognitive/types";
import {
  buildServerCognitiveContext,
  type ServerCognitiveRouteBody,
} from "./cognitiveContext";
import { evaluatePreModelSafety } from "./safety";

export interface ServerCognitiveHealth {
  ok: true;
  engine: "cognitive-coordinator-v1";
  safetyPriority: true;
  storageModel: "per-request-isolated";
  geminiConfigured: boolean;
}

export interface ServerCognitiveRouteResponse {
  ok: boolean;
  result: CognitiveResult;
  meta: {
    engine: "cognitive-coordinator-v1";
    storageModel: "per-request-isolated";
    hasOperationalData: boolean;
    latencyMs: number;
  };
}

export function getServerCognitiveHealth(): ServerCognitiveHealth {
  return {
    ok: true,
    engine: "cognitive-coordinator-v1",
    safetyPriority: true,
    storageModel: "per-request-isolated",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
  };
}

/**
 * Router cognitivo server-side V1.
 * Riutilizza direttamente CognitiveCoordinator V1 con:
 * - Safety Engine server-side prioritario (server/safety.ts);
 * - Contesto operativo isolato per singola richiesta (nessuna condivisione tra utenti/richieste);
 * - Nessuna invenzione di dati assenti;
 * - Rispetto rigoroso delle autorizzazioni per singola operazione e di AbortSignal/timeout.
 */
export async function routeServerCognitiveRequest(
  req: ServerCognitiveRouteBody,
  options?: {
    signal?: AbortSignal;
    adapterOverrides?: Partial<CognitiveAdapters>;
  }
): Promise<ServerCognitiveRouteResponse> {
  const startedAt = Date.now();
  const ctx = buildServerCognitiveContext(req);

  const coordinator = new CognitiveCoordinator(
    {
      evaluateSafety: (input: string, crisisBlocked?: boolean) => {
        if (crisisBlocked) {
          return {
            safe: false,
            crisisDetected: true,
            reply:
              "Elaborazione interrotta dal Safety Engine: in questo momento la priorità è il tuo supporto immediato.",
          };
        }
        const preModel = evaluatePreModelSafety(input);
        if (preModel.crisisDetected) {
          return {
            safe: false,
            crisisDetected: true,
            reply: preModel.reply,
          };
        }
        return { safe: true, crisisDetected: false };
      },
      repository: ctx.repository,
      // Nessuna memoria personale AI persistente sul server senza consenso/storage dedicato
      memoryStore: undefined,
      ...options?.adapterOverrides,
    },
    ctx.storage
  );

  const result = await coordinator.execute({
    input: req.input,
    consentEnabled: ctx.consentEnabled,
    crisisBlocked: req.crisisBlocked,
    sessionContext: ctx.sessionContext,
    approvedOperationIds: req.approvedOperationIds,
    explicitSteps: req.explicitSteps,
    storage: ctx.storage,
    timeoutMs: req.timeoutMs,
    signal: options?.signal,
  });

  return {
    ok:
      result.status === "completed" ||
      result.status === "awaiting_authorization" ||
      result.status === "needs_clarification" ||
      result.status === "safety_blocked",
    result,
    meta: {
      engine: "cognitive-coordinator-v1",
      storageModel: "per-request-isolated",
      hasOperationalData: ctx.hasOperationalData,
      latencyMs: Date.now() - startedAt,
    },
  };
}
