import { orchestratePersonalContext } from "../context/contextOrchestrator";
import { analyzeEmotionDeterministic } from "../emotion/analyzer";
import { generateLocalPersonalInsights } from "../growth/engine";
import { buildMemorySummaryForGemini, createEmptyLongTermMemory } from "../memory/extractor";
import { AuraMemoryStore } from "../memory/storage";
import { generateAdaptiveMissionsLocal } from "../missions/engine";
import { DataRepository } from "../persistence/dataManagement";
import { createPlan, updatePlanDetails } from "../planning/planningEngine";
import type { PersonalPlan } from "../planning/types";
import { runStructuredReasoning } from "../reasoning/reasoningEngine";
import type { OrchestrationIntent, ToolDefinition, ToolExecutionContext } from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (!tool.id?.trim()) {
      throw new Error("Tool ID obbligatorio.");
    }
    if (!tool.implemented) {
      throw new Error(
        `Impossibile registrare lo strumento "${tool.id}": implementazione reale non verificata.`
      );
    }
    if (!Array.isArray(tool.supportedOperations) || tool.supportedOperations.length === 0) {
      throw new Error(
        `Lo strumento "${tool.id}" deve dichiarare almeno un'operazione in supportedOperations.`
      );
    }
    this.tools.set(tool.id, tool as unknown as ToolDefinition);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveOperationalRepository(
  ctx: ToolExecutionContext,
  injectedRepository: DataRepository
): DataRepository {
  return ctx.storage ? new DataRepository(ctx.storage) : injectedRepository;
}

/**
 * Crea il registro predefinito con i 7 motori interni reali di AURA AI (V1.1 + Persistence V2).
 * Ogni strumento dichiara esplicitamente supportedOperations, readOnly, modifiesData,
 * requiresConsent e requiresConfirmation, e usa DataRepository come fonte primaria
 * per i dati operativi (piani, missioni, obiettivi), indipendentemente dal consenso Memoria AI.
 */
export function createDefaultAuraToolRegistry(
  repository: DataRepository = new DataRepository()
): ToolRegistry {
  const registry = new ToolRegistry();

  // 1. Reasoning Engine V1 (solo analisi/lettura)
  registry.register({
    id: "reasoning_engine",
    name: "Reasoning Engine V1",
    description: "Analizza richieste complesse, identifica obiettivi, sotto-problemi, incertezze e strategie.",
    category: "reasoning",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE", "READ"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 3000,
    maxRetries: 1,
    implemented: true,
    validateInput: (input) => {
      if (!input || typeof input !== "object" || !isNonEmptyString((input as Record<string, unknown>).message)) {
        return { valid: false, error: "Parametro 'message' obbligatorio e non vuoto." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const result = runStructuredReasoning({
        message: String(input.message),
        consentEnabled: ctx.consentEnabled,
        crisisBlocked: ctx.crisisBlocked,
      });
      return {
        verified: result.completedPhases.length > 0,
        data: result,
        summary: `Ragionamento completato (${result.complexity}, ${result.subProblems.length} sotto-problemi).`,
      };
    },
  });

  // 2. Planning Engine V1 (READ reale separato da CREATE / UPDATE / DELETE)
  registry.register<Record<string, unknown>, unknown>({
    id: "planning_engine",
    name: "Planning Engine V1",
    description: "Recupera piani esistenti (READ) oppure crea, aggiorna o elimina piani con priorità e scadenze.",
    category: "planning",
    riskLevel: "MEDIO",
    requiredPermissions: ["plan_write"],
    supportedOperations: ["READ", "CREATE", "UPDATE", "DELETE"],
    readOnly: false,
    modifiesData: true,
    requiresConsent: false,
    requiresConfirmation: true,
    timeoutMs: 4000,
    maxRetries: 1,
    implemented: true,
    validateInput: (input, intent?: OrchestrationIntent) => {
      if (intent === "READ") {
        return { valid: true };
      }
      if (intent === "UPDATE" || intent === "DELETE") {
        if (!input || typeof input !== "object" || !isNonEmptyString((input as Record<string, unknown>).planId)) {
          return { valid: false, error: "Parametro 'planId' obbligatorio per aggiornare o eliminare un piano." };
        }
        return { valid: true };
      }
      if (!input || typeof input !== "object" || !isNonEmptyString((input as Record<string, unknown>).declaredGoal)) {
        return { valid: false, error: "Parametro 'declaredGoal' obbligatorio per creare un piano." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const repo = resolveOperationalRepository(ctx, repository);

      // OPERAZIONE READ: lettura reale da DataRepository (anche con Memoria AI OFF), VIETATA qualsiasi creazione
      if (ctx.intent === "READ") {
        const plans = repo.getPlans();
        if (plans.length === 0) {
          return {
            verified: true,
            data: { plans: [], consentEnabled: ctx.consentEnabled },
            summary:
              "Nessun piano esistente trovato nell'archivio operativo locale (nessuna creazione automatica).",
          };
        }
        return {
          verified: true,
          data: { plans, consentEnabled: ctx.consentEnabled },
          summary: `Recuperati ${plans.length} piani esistenti da DataRepository: ${plans
            .slice(0, 3)
            .map((p) => p.title)
            .join(", ")}.`,
        };
      }

      // OPERAZIONE UPDATE: modifica esplicita di un piano esistente su DataRepository
      if (ctx.intent === "UPDATE") {
        const plans = repo.getPlans();
        const target = plans.find((p) => p.id === String(input.planId));
        if (!target) {
          return {
            verified: false,
            data: null,
            summary: `Piano "${String(input.planId)}" non trovato per l'aggiornamento.`,
          };
        }
        const updated = updatePlanDetails(target, {
          title: typeof input.title === "string" ? input.title : undefined,
          desiredOutcome: typeof input.desiredOutcome === "string" ? input.desiredOutcome : undefined,
          dailyMinutesLimit:
            typeof input.dailyMinutesLimit === "number" ? input.dailyMinutesLimit : undefined,
        });
        const nextPlans = plans.map((p) => (p.id === updated.id ? updated : p));
        repo.savePlans(nextPlans);
        return {
          verified: true,
          data: updated,
          summary: `Piano "${updated.title}" aggiornato con successo.`,
        };
      }

      // OPERAZIONE DELETE: eliminazione esplicita di un piano esistente su DataRepository
      if (ctx.intent === "DELETE") {
        const plans = repo.getPlans();
        const targetId = String(input.planId);
        const exists = plans.some((p) => p.id === targetId);
        if (!exists) {
          return {
            verified: false,
            data: null,
            summary: `Piano "${targetId}" non trovato per l'eliminazione.`,
          };
        }
        const remaining = plans.filter((p) => p.id !== targetId);
        repo.savePlans(remaining);
        return {
          verified: true,
          data: { deletedPlanId: targetId, remainingCount: remaining.length },
          summary: `Piano "${targetId}" eliminato su conferma esplicita.`,
        };
      }

      // OPERAZIONE CREATE: creazione esplicita di un nuovo piano su DataRepository
      const horizonRaw = input.horizon;
      const horizon =
        horizonRaw === "daily" || horizonRaw === "weekly" || horizonRaw === "monthly"
          ? horizonRaw
          : "weekly";
      const plan: PersonalPlan = createPlan({
        declaredGoal: String(input.declaredGoal),
        horizon,
        dailyMinutesLimit:
          typeof input.dailyMinutesLimit === "number" ? input.dailyMinutesLimit : 30,
        consentEnabled: ctx.consentEnabled,
        crisisBlocked: ctx.crisisBlocked,
      });
      const existing = repo.getPlans();
      repo.savePlans([plan, ...existing]);
      return {
        verified: Boolean(plan.id && plan.tasks.length > 0),
        data: plan,
        summary: `Piano "${plan.title}" creato con ${plan.tasks.length} attività.`,
      };
    },
  });

  // 3. Memory Engine V1 (READ strettamente protetto dal consenso)
  registry.register({
    id: "memory_engine",
    name: "Memory Engine V1",
    description: "Consulta il riepilogo della memoria personale esclusivamente con consenso attivo.",
    category: "memory",
    riskLevel: "MEDIO",
    requiredPermissions: ["memory_consent"],
    supportedOperations: ["READ"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: true,
    requiresConfirmation: false,
    timeoutMs: 2000,
    maxRetries: 0,
    implemented: true,
    validateInput: (input) => {
      if (input !== undefined && typeof input !== "object") {
        return { valid: false, error: "Input non valido per Memory Engine." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      if (!ctx.consentEnabled) {
        throw new Error("Consenso alla memoria non attivo: accesso negato.");
      }
      const store = ctx.storage ? new AuraMemoryStore(ctx.storage) : null;
      const memory =
        (input?.memory as ReturnType<typeof createEmptyLongTermMemory> | undefined) ??
        (store ? store.getLongTermMemory() : createEmptyLongTermMemory());
      const summary = buildMemorySummaryForGemini({
        consentEnabled: ctx.consentEnabled,
        memory,
      });
      return {
        verified: typeof summary === "string",
        data: { summary },
        summary: summary
          ? "Riepilogo memoria recuperato con consenso."
          : "Memoria vuota (consenso attivo).",
      };
    },
  });

  // 4. Emotional Intelligence Engine V1 (solo analisi/lettura)
  registry.register({
    id: "emotion_engine",
    name: "Emotional Intelligence Engine V1",
    description: "Analizza il tono emotivo del messaggio senza formulare diagnosi.",
    category: "emotion",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE", "READ"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 2500,
    maxRetries: 1,
    implemented: true,
    validateInput: (input) => {
      if (!input || typeof input !== "object" || !isNonEmptyString((input as Record<string, unknown>).message)) {
        return { valid: false, error: "Parametro 'message' obbligatorio." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>) => {
      const analysis = analyzeEmotionDeterministic(String(input.message));
      return {
        verified: Boolean(analysis.primaryEmotion),
        data: analysis,
        summary: `Tono rilevato: ${analysis.primaryEmotion} (intensità ${analysis.intensity}/10, nessuna diagnosi).`,
      };
    },
  });

  // 5. Personal Growth Engine V1 (READ obiettivi reali dallo storage, oppure ANALYZE)
  registry.register<Record<string, unknown>, unknown>({
    id: "growth_engine",
    name: "Personal Growth Engine V1",
    description: "Recupera obiettivi e progressi esistenti (READ) o genera riflessioni di crescita.",
    category: "growth",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["READ", "ANALYZE"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 3000,
    maxRetries: 1,
    implemented: true,
    validateInput: (input) => {
      if (input !== undefined && typeof input !== "object") {
        return { valid: false, error: "Input non valido per Personal Growth Engine." };
      }
      return { valid: true };
    },
    execute: async (_input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      if (ctx.intent === "READ") {
        const repo = resolveOperationalRepository(ctx, repository);
        const goals = repo.getGrowthGoals();
        if (goals.length === 0) {
          return {
            verified: true,
            data: { goals: [], consentEnabled: ctx.consentEnabled },
            summary:
              "Nessun obiettivo di crescita esistente trovato nell'archivio operativo (nessuna modifica effettuata).",
          };
        }
        return {
          verified: true,
          data: { goals, consentEnabled: ctx.consentEnabled },
          summary: `Recuperati ${goals.length} obiettivi di crescita esistenti da DataRepository: ${goals
            .slice(0, 3)
            .map((g) => g.title)
            .join(", ")}.`,
        };
      }

      const insights = generateLocalPersonalInsights({
        goals: [],
        preferences: [],
        missions: [],
        checkIns: [],
        emotionalTrends: [],
        consentEnabled: ctx.consentEnabled,
      });
      return {
        verified: Boolean(insights && Array.isArray(insights.insights)),
        data: insights,
        summary: `Generati ${insights.insights.length} spunti di crescita personale.`,
      };
    },
  });

  // 6. Adaptive Mission Engine V1 (READ missioni esistenti senza rigenerarle, oppure CREATE)
  registry.register<Record<string, unknown>, unknown>({
    id: "mission_engine",
    name: "Adaptive Mission Engine V1",
    description: "Recupera le missioni già generate (READ) o propone nuove micro-missioni sostenibili (CREATE).",
    category: "missions",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["READ", "CREATE"],
    readOnly: false,
    modifiesData: true,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 3000,
    maxRetries: 1,
    implemented: true,
    validateInput: (input) => {
      if (input !== undefined && typeof input !== "object") {
        return { valid: false, error: "Input non valido per Mission Engine." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      // OPERAZIONE READ: recupera le missioni salvate da DataRepository SENZA rigenerarle (anche con Memoria AI OFF)
      if (ctx.intent === "READ") {
        const repo = resolveOperationalRepository(ctx, repository);
        const missions = repo.getMissions();
        if (missions.length === 0) {
          return {
            verified: true,
            data: { missions: [], consentEnabled: ctx.consentEnabled },
            summary:
              "Nessuna missione esistente trovata nell'archivio operativo locale (nessuna rigenerazione eseguita).",
          };
        }
        return {
          verified: true,
          data: { missions, consentEnabled: ctx.consentEnabled },
          summary: `Recuperate ${missions.length} missioni esistenti da DataRepository senza rigenerarle.`,
        };
      }

      const availableMinutes =
        typeof input?.availableMinutes === "number" ? input.availableMinutes : 10;
      const energyRaw = input?.energyLevel;
      const energyLevel =
        energyRaw === "bassa" || energyRaw === "media" || energyRaw === "buona"
          ? energyRaw
          : "media";
      const result = generateAdaptiveMissionsLocal(
        {
          availableMinutes,
          energyLevel,
          goals: [],
          preferences: [],
          consentEnabled: ctx.consentEnabled,
          existingMissions: [],
        },
        2
      );
      return {
        verified: Array.isArray(result.missions) && result.missions.length > 0,
        data: result,
        summary: `Generate ${result.missions.length} micro-missioni adattive.`,
      };
    },
  });

  // 7. Context Integration Engine V2 (solo lettura/analisi)
  registry.register({
    id: "context_engine",
    name: "Context Integration Engine V2",
    description: "Coordina il contesto personale rispettando provenienza, consenso e limiti di dimensione.",
    category: "context",
    riskLevel: "BASSO",
    requiredPermissions: ["internal_read"],
    supportedOperations: ["ANALYZE", "READ"],
    readOnly: true,
    modifiesData: false,
    requiresConsent: false,
    requiresConfirmation: false,
    timeoutMs: 2500,
    maxRetries: 1,
    implemented: true,
    validateInput: (input) => {
      if (!input || typeof input !== "object" || !isNonEmptyString((input as Record<string, unknown>).userMessage)) {
        return { valid: false, error: "Parametro 'userMessage' obbligatorio." };
      }
      return { valid: true };
    },
    execute: async (input: Record<string, unknown>, ctx: ToolExecutionContext) => {
      const bundle = orchestratePersonalContext({
        userMessage: String(input.userMessage),
        consentEnabled: ctx.consentEnabled,
        crisisBlocked: ctx.crisisBlocked,
        longTermMemory: createEmptyLongTermMemory(),
        emotionalTrends: [],
        missions: [],
        growthGoals: [],
        checkIns: [],
      });
      return {
        verified: Boolean(bundle && Array.isArray(bundle.items)),
        data: bundle,
        summary: `Contesto orchestrato con ${bundle.items.length} elementi autorizzati.`,
      };
    },
  });

  return registry;
}
