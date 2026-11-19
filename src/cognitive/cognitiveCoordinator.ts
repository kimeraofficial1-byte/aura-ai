import { orchestratePersonalContext } from "../context/contextOrchestrator";
import { createEmptyLongTermMemory } from "../memory/extractor";
import { AuraMemoryStore } from "../memory/storage";
import { runOrchestration } from "../orchestration/orchestrationEngine";
import type { OrchestrationRun, ToolStorageAdapter } from "../orchestration/types";
import { DataRepository } from "../persistence/dataManagement";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { analyzeProactiveOpportunities } from "../proactive/proactiveEngine";
import type { ProactiveAnalysisResult } from "../proactive/types";
import { runStructuredReasoning } from "../reasoning/reasoningEngine";
import type {
  CognitiveAdapters,
  CognitiveAuthorizationRequirement,
  CognitiveEngineId,
  CognitiveErrorEntry,
  CognitiveIntent,
  CognitiveIntentClassification,
  CognitivePhase,
  CognitiveRequest,
  CognitiveResult,
  CognitiveSafetyCheckResult,
  CognitiveTraceEvent,
} from "./types";

const CRISIS_PATTERNS: readonly RegExp[] = [
  /\b(suicid\w*|togliermi la vita|farla finita|voglio morire|non voglio più vivere)\b/i,
  /\b(autolesion\w*|tagliarmi|farmi del male)\b/i,
];

const DELETE_REGEX = /\b(elimina|cancella|rimuovi|svuota|distruggi)\b/i;
const UPDATE_REGEX = /\b(modifica|aggiorna|cambia|rinomina|sposta|correggi)\b/i;
const PLAN_REGEX = /\b(pianifica|crea un piano|nuovo piano|organizza un piano|programma settimanale)\b/i;
const CREATE_REGEX = /\b(crea|genera|aggiungi|nuova missione|nuovo obiettivo|nuovo piano)\b/i;
const READ_REGEX =
  /\b(mostra|mostrami|apri|elenca|visualizza|recupera|vedi|leggi|quali sono|controlla|verifica)\b/i;
const ANALYZE_REGEX =
  /\b(analizza|valuta|riassumi|confronta|spiega|proattivit[aà]|suggerimenti|priorit[aà])\b/i;
const TARGET_DOMAIN_REGEX =
  /\b(pian[oi]|mission[ei]|obiettiv[oi]|memori[ae]|progress[oi]|attivit[aà]|stato|giornata)\b/i;

function createExecutionId(): string {
  return `cog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Controllo di sicurezza preventivo (Safety Gate) eseguito sempre prima del routing.
 */
export function evaluateCognitiveSafety(
  input: string,
  crisisBlocked?: boolean
): CognitiveSafetyCheckResult {
  if (crisisBlocked) {
    return {
      safe: false,
      crisisDetected: true,
      reply:
        "Elaborazione interrotta dal Safety Engine: in questo momento la priorità è il tuo supporto immediato.",
    };
  }
  const normalized = input.trim();
  if (CRISIS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      safe: false,
      crisisDetected: true,
      reply:
        "Sento che stai attraversando un momento molto difficile. In questo momento la priorità è la tua sicurezza: se sei in pericolo immediato chiama il 112 o contatta una persona fidata o il Telefono Amico (02 2327 2327).",
    };
  }
  return { safe: true, crisisDetected: false };
}

/**
 * Classificatore deterministico degli intenti cognitivi.
 * Non classifica mai richieste ambigue come operazioni distruttive.
 */
export function classifyCognitiveIntent(input: string): CognitiveIntentClassification {
  const clean = input.trim();
  if (!clean || clean.length < 2) {
    return {
      intent: "CHAT",
      ambiguous: true,
      clarificationQuestion:
        "Non ho ricevuto abbastanza dettagli. Come posso aiutarti oggi?",
      reason: "Input vuoto o troppo breve.",
    };
  }

  const hasTarget = TARGET_DOMAIN_REGEX.test(clean);

  // Richieste potenzialmente distruttive senza target chiaro -> richiesta di chiarimento (mai DELETE automatico)
  if (DELETE_REGEX.test(clean)) {
    if (!hasTarget) {
      return {
        intent: "CHAT",
        ambiguous: true,
        clarificationQuestion:
          "Vuoi eliminare un piano, una missione o un obiettivo specifico? Indica quale elemento prima di procedere.",
        reason: "Verbo di eliminazione rilevato senza target specificato.",
      };
    }
    return {
      intent: "DELETE",
      ambiguous: false,
      reason: "Richiesta esplicita di eliminazione su dominio operativo.",
    };
  }

  if (UPDATE_REGEX.test(clean)) {
    if (!hasTarget) {
      return {
        intent: "CHAT",
        ambiguous: true,
        clarificationQuestion:
          "Quale piano, missione o obiettivo desideri modificare e con quali dettagli?",
        reason: "Verbo di modifica rilevato senza target specificato.",
      };
    }
    return {
      intent: "UPDATE",
      ambiguous: false,
      reason: "Richiesta esplicita di aggiornamento.",
    };
  }

  if (PLAN_REGEX.test(clean)) {
    return {
      intent: "PLAN",
      ambiguous: false,
      reason: "Richiesta esplicita di pianificazione strutturata.",
    };
  }

  if (CREATE_REGEX.test(clean)) {
    if (!hasTarget) {
      return {
        intent: "CHAT",
        ambiguous: true,
        clarificationQuestion:
          "Cosa desideri creare esattamente (un piano, una missione o un obiettivo di crescita)?",
        reason: "Verbo di creazione rilevato senza target specificato.",
      };
    }
    return {
      intent: "CREATE",
      ambiguous: false,
      reason: "Richiesta esplicita di creazione.",
    };
  }

  if (READ_REGEX.test(clean) && hasTarget) {
    return {
      intent: "READ",
      ambiguous: false,
      reason: "Richiesta di consultazione dati esistenti.",
    };
  }

  if (ANALYZE_REGEX.test(clean)) {
    return {
      intent: "ANALYZE",
      ambiguous: false,
      reason: "Richiesta di analisi o valutazione.",
    };
  }

  // Frasi troppo vaghe di una sola parola non conversazionale (es. "fai", "sistema", "gestisci")
  if (/^(fai|sistema|gestisci|procedi|esegui)\.?$/i.test(clean)) {
    return {
      intent: "CHAT",
      ambiguous: true,
      clarificationQuestion:
        "Puoi specificare quale azione o informazione ti serve in questo momento?",
      reason: "Comando generico privo di oggetto.",
    };
  }

  return {
    intent: "CHAT",
    ambiguous: false,
    reason: "Interazione conversazionale standard.",
  };
}

export function createDefaultCognitiveAdapters(
  storage?: ToolStorageAdapter
): CognitiveAdapters {
  const repository = new DataRepository(storage);
  const memoryStore = new AuraMemoryStore(storage);
  const learningEngine = new ControlledLearningEngine(true);

  return {
    evaluateSafety: evaluateCognitiveSafety,
    repository,
    memoryStore,
    learningEngine,
    orchestrateContext: orchestratePersonalContext,
    runReasoning: runStructuredReasoning,
    runOrchestration,
    analyzeProactive: analyzeProactiveOpportunities,
  };
}

async function withTimeoutAndAbort<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  if (externalSignal?.aborted) {
    const err = new Error("Esecuzione annullata dal chiamante.");
    err.name = "AbortError";
    throw err;
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const err = new Error(
          timedOut
            ? `Timeout superato (${timeoutMs} ms) durante l'esecuzione cognitiva.`
            : "Esecuzione cognitiva annullata."
        );
        err.name = timedOut ? "TimeoutError" : "AbortError";
        reject(err);
      };

      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });

      work(controller.signal).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Cognitive Coordinator V1.
 * Coordina in modo deterministico, tracciabile e sicuro gli engine esistenti di AURA AI
 * attraverso un ciclo a 10 fasi senza duplicarne la logica.
 */
export class CognitiveCoordinator {
  private readonly adapters: CognitiveAdapters;

  constructor(adapters?: Partial<CognitiveAdapters>, storage?: ToolStorageAdapter) {
    const defaults = createDefaultCognitiveAdapters(storage);
    this.adapters = { ...defaults, ...adapters };
  }

  async execute(request: CognitiveRequest): Promise<CognitiveResult> {
    const executionId = createExecutionId();
    const completedPhases: CognitivePhase[] = [];
    const selectedEngines: CognitiveEngineId[] = [];
    const authorizationsRequired: CognitiveAuthorizationRequirement[] = [];
    const errors: CognitiveErrorEntry[] = [];
    const trace: CognitiveTraceEvent[] = [];

    const recordPhase = (phase: CognitivePhase, summary: string) => {
      if (!completedPhases.includes(phase)) {
        completedPhases.push(phase);
      }
      trace.push({
        phase,
        timestamp: new Date().toISOString(),
        summary,
      });
    };

    const addEngine = (engine: CognitiveEngineId) => {
      if (!selectedEngines.includes(engine)) {
        selectedEngines.push(engine);
      }
    };

    // ==================== 1. RECEIVE ====================
    recordPhase("RECEIVE", "Input utente ricevuto dal Cognitive Coordinator.");

    if (request.signal?.aborted) {
      errors.push({ phase: "RECEIVE", message: "Esecuzione annullata prima dell'avvio." });
      recordPhase("RESPONSE", "Esecuzione interrotta su richiesta di cancellazione.");
      return {
        executionId,
        intent: "CHAT",
        completedPhases,
        selectedEngines,
        authorizationsRequired,
        status: "cancelled",
        verified: false,
        summary: "Operazione annullata prima dell'elaborazione.",
        errors,
        trace,
      };
    }

    // ==================== 2. SAFETY (Priorità assoluta) ====================
    addEngine("safety_engine");
    const safety = this.adapters.evaluateSafety(request.input, request.crisisBlocked);
    recordPhase(
      "SAFETY",
      safety.safe
        ? "Controllo Safety superato."
        : "Segnale di crisi rilevato: elaborazione bloccata."
    );

    if (!safety.safe || safety.crisisDetected) {
      recordPhase("RESPONSE", "Restituita risposta prioritaria di supporto Safety.");
      return {
        executionId,
        intent: "CHAT",
        completedPhases,
        selectedEngines,
        authorizationsRequired,
        status: "safety_blocked",
        verified: true,
        summary: safety.reply ?? "Elaborazione bloccata dal Safety Engine.",
        safetyReply: safety.reply,
        errors,
        trace,
      };
    }

    // ==================== 3. INTENT ====================
    const intentClassification = classifyCognitiveIntent(request.input);
    const intent: CognitiveIntent = intentClassification.intent;
    recordPhase(
      "INTENT",
      `Intento classificato: ${intent}${intentClassification.ambiguous ? " (ambiguo)" : ""}. ${intentClassification.reason}`
    );

    if (intentClassification.ambiguous) {
      recordPhase("RESPONSE", "Richiesto chiarimento all'utente prima di qualsiasi azione.");
      return {
        executionId,
        intent,
        completedPhases,
        selectedEngines,
        authorizationsRequired,
        status: "needs_clarification",
        verified: true,
        summary:
          intentClassification.clarificationQuestion ??
          "Puoi chiarire meglio la tua richiesta?",
        clarificationQuestion: intentClassification.clarificationQuestion,
        errors,
        trace,
      };
    }

    // ==================== 4. CONTEXT ====================
    // Separazione rigorosa:
    // A. Dati operativi da DataRepository (sempre disponibili anche con Memoria AI OFF)
    // B. Memoria AI personale solo se consentEnabled === true
    // C. Contesto sessione temporaneo
    // D. Controlled Learning separato
    addEngine("persistence_v2");
    addEngine("context_engine");
    const repo = request.storage
      ? new DataRepository(request.storage)
      : this.adapters.repository;
    const operationalSnapshot = repo.loadSnapshot();

    const longTermMemory =
      request.consentEnabled && this.adapters.memoryStore
        ? this.adapters.memoryStore.getLongTermMemory()
        : createEmptyLongTermMemory();
    const checkIns =
      request.consentEnabled && this.adapters.memoryStore
        ? this.adapters.memoryStore.getCheckIns()
        : [];
    const emotionalTrends =
      request.consentEnabled && this.adapters.memoryStore
        ? this.adapters.memoryStore.getEmotionalTrends()
        : [];

    const contextBundle = this.adapters.orchestrateContext({
      userMessage: request.input,
      consentEnabled: request.consentEnabled,
      crisisBlocked: false,
      longTermMemory,
      emotionalTrends,
      missions: operationalSnapshot.missions,
      growthGoals: operationalSnapshot.growthGoals,
      checkIns,
    });

    const learningEnabled = this.adapters.learningEngine?.isEnabled() ?? false;
    if (learningEnabled) {
      addEngine("controlled_learning_engine");
    }

    recordPhase(
      "CONTEXT",
      `Contesto recuperato (${contextBundle.items.length} elementi autorizzati; memoria AI ${
        request.consentEnabled ? "ON" : "OFF"
      }).`
    );

    // ==================== 5. REASONING ====================
    addEngine("reasoning_engine");
    const reasoningResult = this.adapters.runReasoning({
      message: request.input,
      consentEnabled: request.consentEnabled,
      crisisBlocked: false,
    });
    recordPhase(
      "REASONING",
      `Analisi strutturata completata (${reasoningResult.complexity}, ${reasoningResult.subProblems.length} sotto-problemi).`
    );

    // ==================== 6. ROUTING ====================
    const requiresOrchestration =
      intent === "READ" ||
      intent === "CREATE" ||
      intent === "UPDATE" ||
      intent === "DELETE" ||
      intent === "PLAN";
    const requiresProactive = intent === "ANALYZE";

    if (requiresOrchestration) {
      addEngine("orchestration_engine");
      if (intent === "PLAN") {
        addEngine("planning_engine");
      }
    }
    if (requiresProactive) {
      addEngine("proactive_engine");
    }

    recordPhase(
      "ROUTING",
      `Engine selezionati per ${intent}: ${selectedEngines.join(", ")}.`
    );

    // ==================== 7. AUTHORIZATION ====================
    const approvedSet = new Set(request.approvedOperationIds ?? []);
    if (intent === "DELETE" || intent === "UPDATE" || intent === "CREATE" || intent === "PLAN") {
      const explicitIds = (request.explicitSteps ?? [])
        .map((s, idx) => s.id ?? `step-${idx + 1}`);
      const primaryOpId = explicitIds[0] ?? `op-${intent.toLowerCase()}`;
      const isApproved =
        approvedSet.has(primaryOpId) ||
        (explicitIds.length > 0 && explicitIds.every((id) => approvedSet.has(id)));

      authorizationsRequired.push({
        id: primaryOpId,
        engine: intent === "PLAN" ? "planning_engine" : "orchestration_engine",
        operation: intent,
        reason:
          intent === "DELETE"
            ? "Operazione irreversibile: richiede conferma esplicita dell'utente."
            : `Operazione di modifica (${intent}): richiede autorizzazione esplicita dell'utente.`,
        approved: isApproved,
      });

      if (!isApproved) {
        recordPhase(
          "AUTHORIZATION",
          `Autorizzazione mancante per operazione ${intent} (${primaryOpId}).`
        );
        recordPhase("RESPONSE", "In attesa di conferma esplicita dell'utente.");
        return {
          executionId,
          intent,
          completedPhases,
          selectedEngines,
          authorizationsRequired,
          status: "awaiting_authorization",
          verified: false,
          summary: `Conferma esplicita richiesta prima di eseguire l'operazione ${intent}.`,
          data: {
            operational: {
              plans: operationalSnapshot.plans,
              missions: operationalSnapshot.missions,
              growthGoals: operationalSnapshot.growthGoals,
            },
            reasoning: reasoningResult,
            contextItemsCount: contextBundle.items.length,
            learningEnabled,
          },
          errors,
          trace,
        };
      }
    }
    recordPhase("AUTHORIZATION", "Permessi e autorizzazioni verificati.");

    // ==================== 8. EXECUTION ====================
    let orchestrationRun: OrchestrationRun | undefined;
    let proactiveResult: ProactiveAnalysisResult | undefined;
    const timeoutMs = request.timeoutMs ?? 10_000;

    try {
      await withTimeoutAndAbort(
        async (signal) => {
          if (requiresOrchestration) {
            orchestrationRun = await this.adapters.runOrchestration({
              request: request.input,
              consentEnabled: request.consentEnabled,
              crisisBlocked: false,
              explicitSteps: request.explicitSteps,
              approvedStepIds: request.approvedOperationIds,
              storage: request.storage,
              signal,
            });
          } else if (requiresProactive) {
            proactiveResult = this.adapters.analyzeProactive({
              plans: operationalSnapshot.plans,
              missions: operationalSnapshot.missions,
              growthGoals: operationalSnapshot.growthGoals,
              consentEnabled: request.consentEnabled,
              crisisBlocked: false,
            });
          }
        },
        timeoutMs,
        request.signal
      );
      recordPhase("EXECUTION", `Esecuzione completata per intento ${intent}.`);
    } catch (error) {
      const errName = error instanceof Error ? error.name : "Error";
      const errMsg =
        error instanceof Error ? error.message : "Errore imprevisto durante l'esecuzione.";
      errors.push({ phase: "EXECUTION", message: errMsg });

      const status =
        errName === "TimeoutError"
          ? "timeout"
          : errName === "AbortError"
          ? "cancelled"
          : "failed";

      recordPhase("EXECUTION", `Esecuzione interrotta (${status}): ${errMsg}`);
      recordPhase("RESPONSE", "Restituito stato di errore controllato.");

      return {
        executionId,
        intent,
        completedPhases,
        selectedEngines,
        authorizationsRequired,
        status,
        verified: false,
        summary: errMsg,
        data: {
          reasoning: reasoningResult,
          contextItemsCount: contextBundle.items.length,
          learningEnabled,
        },
        errors,
        trace,
      };
    }

    // ==================== 9. VERIFICATION ====================
    let verified = true;
    let finalStatus: CognitiveResult["status"] = "completed";
    let summary = "";

    if (orchestrationRun) {
      const run: typeof orchestrationRun = orchestrationRun;
      if (run.status === "safety_blocked") {
        finalStatus = "safety_blocked";
        verified = true;
        summary = run.safetyReply ?? run.finalSummary;
      } else if (run.status === "awaiting_approval") {
        finalStatus = "awaiting_authorization";
        verified = false;
        summary = run.finalSummary;
      } else if (run.status === "failed") {
        finalStatus = "failed";
        verified = false;
        summary = run.finalSummary;
        run.errors.forEach((e) => errors.push({ phase: "VERIFICATION", message: e }));
      } else if (run.status === "cancelled") {
        finalStatus = "cancelled";
        verified = false;
        summary = run.finalSummary;
      } else {
        verified = run.steps.every(
          (s) => s.status === "completed" || s.status === "blocked"
        );
        summary = run.finalSummary;
      }
    } else if (proactiveResult) {
      const proactive: typeof proactiveResult = proactiveResult;
      verified = !proactive.safetyBlocked;
      summary = `Analisi completata: ${proactive.suggestions.length} suggerimenti operativi rilevati.`;
    } else {
      // CHAT: nessuna mutazione dati, risposta strutturata pronta per il layer conversazionale
      verified = true;
      summary = `Richiesta conversazionale pronta (${reasoningResult.complexity}, nessuna modifica ai dati).`;
    }

    recordPhase(
      "VERIFICATION",
      `Verifica completata: verified=${verified}, status=${finalStatus}.`
    );

    // ==================== 10. RESPONSE ====================
    const updatedOperational = repo.loadSnapshot();
    recordPhase("RESPONSE", "Risultato cognitivo strutturato pronto.");

    return {
      executionId,
      intent,
      completedPhases,
      selectedEngines,
      authorizationsRequired,
      status: finalStatus,
      verified,
      summary,
      data: {
        operational: {
          plans: updatedOperational.plans,
          missions: updatedOperational.missions,
          growthGoals: updatedOperational.growthGoals,
        },
        reasoning: reasoningResult,
        orchestration: orchestrationRun,
        proactive: proactiveResult,
        contextItemsCount: contextBundle.items.length,
        learningEnabled,
      },
      errors,
      trace,
    };
  }
}
