import type { GrowthGoal } from "../src/growth/types";
import type { AdaptiveMission } from "../src/missions/types";
import type { OrchestrationRequest } from "../src/orchestration/types";
import { DataRepository } from "../src/persistence/dataManagement";
import { MemoryStorageAdapter } from "../src/persistence/storageAdapters";
import type { PersonalPlan } from "../src/planning/types";
import type { CognitiveSessionContext } from "../src/cognitive/types";

export interface ServerCognitiveRouteBody {
  input: string;
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  requestId?: string;
  sessionContext?: CognitiveSessionContext;
  approvedOperationIds?: string[];
  explicitSteps?: OrchestrationRequest["explicitSteps"];
  timeoutMs?: number;
  /**
   * Snapshot operativo opzionale fornito esplicitamente dal client.
   * Il backend Node.js non accede direttamente a localStorage/IndexedDB del browser
   * e non inventa mai dati assenti.
   */
  operationalSnapshot?: {
    plans?: PersonalPlan[];
    missions?: AdaptiveMission[];
    growthGoals?: GrowthGoal[];
  };
}

export interface ServerCognitiveContext {
  storage: MemoryStorageAdapter;
  repository: DataRepository;
  consentEnabled: boolean;
  hasOperationalData: boolean;
  sessionContext?: CognitiveSessionContext;
}

const MAX_INPUT_LENGTH = 4000;
const MAX_TIMEOUT_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export function validateCognitiveRouteRequest(
  body: unknown
): { ok: true; data: ServerCognitiveRouteBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Payload JSON mancante o non valido." };
  }

  const raw = body as Record<string, unknown>;
  if (typeof raw.input !== "string" || raw.input.trim().length === 0) {
    return { ok: false, error: "Il campo 'input' è obbligatorio e non può essere vuoto." };
  }

  if (raw.input.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      error: `Il campo 'input' supera il limite massimo di ${MAX_INPUT_LENGTH} caratteri.`,
    };
  }

  const consentEnabled = raw.consentEnabled === true;
  const crisisBlocked = raw.crisisBlocked === true;
  const requestId =
    typeof raw.requestId === "string" && raw.requestId.trim().length > 0
      ? raw.requestId.trim().slice(0, 100)
      : undefined;

  const approvedOperationIds = Array.isArray(raw.approvedOperationIds)
    ? raw.approvedOperationIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : undefined;

  const timeoutMs =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.min(Math.round(raw.timeoutMs), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const sessionContext: CognitiveSessionContext | undefined =
    raw.sessionContext && typeof raw.sessionContext === "object"
      ? {
          recentMood:
            typeof (raw.sessionContext as Record<string, unknown>).recentMood === "string"
              ? String((raw.sessionContext as Record<string, unknown>).recentMood).slice(0, 60)
              : undefined,
          recentStress:
            typeof (raw.sessionContext as Record<string, unknown>).recentStress === "number"
              ? Number((raw.sessionContext as Record<string, unknown>).recentStress)
              : undefined,
          activeTab:
            typeof (raw.sessionContext as Record<string, unknown>).activeTab === "string"
              ? String((raw.sessionContext as Record<string, unknown>).activeTab).slice(0, 40)
              : undefined,
        }
      : undefined;

  const explicitSteps = Array.isArray(raw.explicitSteps)
    ? (raw.explicitSteps as OrchestrationRequest["explicitSteps"])
    : undefined;

  let operationalSnapshot: ServerCognitiveRouteBody["operationalSnapshot"];
  if (raw.operationalSnapshot && typeof raw.operationalSnapshot === "object") {
    const snap = raw.operationalSnapshot as Record<string, unknown>;
    operationalSnapshot = {
      plans: Array.isArray(snap.plans) ? (snap.plans as PersonalPlan[]) : undefined,
      missions: Array.isArray(snap.missions) ? (snap.missions as AdaptiveMission[]) : undefined,
      growthGoals: Array.isArray(snap.growthGoals) ? (snap.growthGoals as GrowthGoal[]) : undefined,
    };
  }

  return {
    ok: true,
    data: {
      input: raw.input.trim(),
      consentEnabled,
      crisisBlocked,
      requestId,
      sessionContext,
      approvedOperationIds,
      explicitSteps,
      timeoutMs,
      operationalSnapshot,
    },
  };
}

/**
 * Costruisce un contesto cognitivo isolato per singola richiesta HTTP.
 * - Non condivide mai stato tra richieste simultanee.
 * - Non inventa dati operativi assenti.
 * - Rispetta sempre il consenso alla Memoria AI.
 */
export function buildServerCognitiveContext(
  req: ServerCognitiveRouteBody
): ServerCognitiveContext {
  const storage = new MemoryStorageAdapter();
  const repository = new DataRepository(storage);

  let hasOperationalData = false;
  if (req.operationalSnapshot) {
    if (req.operationalSnapshot.plans && req.operationalSnapshot.plans.length > 0) {
      repository.savePlans(req.operationalSnapshot.plans);
      hasOperationalData = true;
    }
    if (req.operationalSnapshot.missions && req.operationalSnapshot.missions.length > 0) {
      repository.saveMissions(req.operationalSnapshot.missions);
      hasOperationalData = true;
    }
    if (req.operationalSnapshot.growthGoals && req.operationalSnapshot.growthGoals.length > 0) {
      repository.saveGrowthGoals(req.operationalSnapshot.growthGoals);
      hasOperationalData = true;
    }
  }

  return {
    storage,
    repository,
    consentEnabled: req.consentEnabled,
    hasOperationalData,
    sessionContext: req.sessionContext,
  };
}
