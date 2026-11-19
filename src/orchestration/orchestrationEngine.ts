import { createDefaultAuraToolRegistry, ToolRegistry } from "./toolRegistry";
import type {
  OrchestrationIntent,
  OrchestrationPhase,
  OrchestrationRequest,
  OrchestrationRun,
  OrchestrationStep,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Classificazione obbligatoria dell'intento prima della selezione degli strumenti (V1.1).
 * Ordine di precedenza: DELETE -> UPDATE -> READ -> CREATE -> ANALYZE.
 */
export function classifyOrchestrationIntent(request: string): OrchestrationIntent {
  const lower = request.trim().toLowerCase();

  if (/\b(elimina|cancella|rimuovi|svuota|delete|remove)\b/.test(lower)) {
    return "DELETE";
  }

  if (
    /\b(modifica|aggiorna|cambia|ricalcola|sospendi|riprendi|sposta|rinomina|update|edit)\b/.test(
      lower
    )
  ) {
    return "UPDATE";
  }

  if (
    /\b(mostra|mostrami|apri|consulta|recupera|vedi|vedere|elenca|lista|quali sono|leggi|visualizza|verifica i miei|controlla i miei|fammi vedere|dammi i miei|dimmi i miei)\b/.test(
      lower
    )
  ) {
    return "READ";
  }

  if (
    /\b(crea|genera|aggiungi|nuovo|nuova|nuove|nuovi|organizza|prepara|pianifica|imposta|inizia|proponi)\b/.test(
      lower
    )
  ) {
    return "CREATE";
  }

  return "ANALYZE";
}

/**
 * Rileva cicli nelle dipendenze tra step per prevenire loop infiniti.
 */
export function hasDependencyCycle(steps: OrchestrationStep[]): boolean {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    if (step) {
      for (const dep of step.dependsOn) {
        if (dfs(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const step of steps) {
    if (dfs(step.id)) return true;
  }
  return false;
}

/**
 * Seleziona automaticamente gli strumenti appropriati rispettando l'intento classificato.
 * In modalità READ seleziona esclusivamente operazioni di lettura reale (mai CREATE).
 */
export function selectToolsForRequest(
  request: string,
  registry: ToolRegistry,
  consentEnabled: boolean,
  intent: OrchestrationIntent = classifyOrchestrationIntent(request)
): Array<{
  id: string;
  toolId: string;
  operation: OrchestrationIntent;
  input: Record<string, unknown>;
  dependsOn: string[];
}> {
  const lower = request.toLowerCase();
  const selected: Array<{
    id: string;
    toolId: string;
    operation: OrchestrationIntent;
    input: Record<string, unknown>;
    dependsOn: string[];
  }> = [];

  // Gestione dedicata per intento READ: solo letture reali, zero creazioni automatiche
  if (intent === "READ") {
    if (/pian|scadenz|calendario/.test(lower) && registry.has("planning_engine")) {
      selected.push({
        id: "step-read-planning",
        toolId: "planning_engine",
        operation: "READ",
        input: {},
        dependsOn: [],
      });
    }
    if (/mission/.test(lower) && registry.has("mission_engine")) {
      selected.push({
        id: "step-read-missions",
        toolId: "mission_engine",
        operation: "READ",
        input: {},
        dependsOn: [],
      });
    }
    if (/obiettiv|crescit|progress/.test(lower) && registry.has("growth_engine")) {
      selected.push({
        id: "step-read-growth",
        toolId: "growth_engine",
        operation: "READ",
        input: {},
        dependsOn: [],
      });
    }
    if (/ricord|memoria/.test(lower) && registry.has("memory_engine")) {
      selected.push({
        id: "step-read-memory",
        toolId: "memory_engine",
        operation: "READ",
        input: {},
        dependsOn: [],
      });
    }

    if (selected.length > 0) {
      return selected;
    }
  }

  const step1Id = "step-1-emotion";
  if (registry.has("emotion_engine")) {
    selected.push({
      id: step1Id,
      toolId: "emotion_engine",
      operation: "ANALYZE",
      input: { message: request },
      dependsOn: [],
    });
  }

  const step2Id = "step-2-reasoning";
  if (registry.has("reasoning_engine")) {
    selected.push({
      id: step2Id,
      toolId: "reasoning_engine",
      operation: "ANALYZE",
      input: { message: request },
      dependsOn: selected.length > 0 ? [step1Id] : [],
    });
  }

  if (
    intent === "CREATE" &&
    /pian|organizz|scadenz|obiettivo|settiman|mese|programm|calendario/.test(lower) &&
    registry.has("planning_engine")
  ) {
    selected.push({
      id: "step-3-planning",
      toolId: "planning_engine",
      operation: "CREATE",
      input: {
        declaredGoal: request,
        horizon: /mensil|mese/.test(lower)
          ? "monthly"
          : /oggi|giorn/.test(lower)
          ? "daily"
          : "weekly",
      },
      dependsOn: [step2Id],
    });
  }

  if (
    intent === "CREATE" &&
    /mission|passo|azione|esercizio/.test(lower) &&
    registry.has("mission_engine")
  ) {
    selected.push({
      id: "step-4-missions",
      toolId: "mission_engine",
      operation: "CREATE",
      input: { availableMinutes: 15, energyLevel: "media" },
      dependsOn: [step2Id],
    });
  }

  if (/crescit|progress|riflession/.test(lower) && registry.has("growth_engine")) {
    selected.push({
      id: "step-5-growth",
      toolId: "growth_engine",
      operation: "ANALYZE",
      input: {},
      dependsOn: [step2Id],
    });
  }

  if (/ricord|memoria/.test(lower) && consentEnabled && registry.has("memory_engine")) {
    selected.push({
      id: "step-6-memory",
      toolId: "memory_engine",
      operation: "READ",
      input: {},
      dependsOn: [],
    });
  }

  return selected;
}

async function executeSingleToolWithTimeoutAndRetry(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, tool.maxRetries + 1);
  let lastError = "Errore sconosciuto";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.signal.aborted) {
      return {
        ok: false,
        verified: false,
        summary: "Operazione interrotta dall'utente.",
        error: "aborted",
        durationMs: Date.now() - startedAt,
        attempts: attempt - 1,
      };
    }

    const stepController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stepController.abort();
    }, tool.timeoutMs);

    const onParentAbort = () => stepController.abort();
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const result = await tool.execute(input, {
        ...ctx,
        signal: stepController.signal,
      });

      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);

      if (ctx.signal.aborted) {
        return {
          ok: false,
          verified: false,
          summary: "Operazione interrotta dall'utente.",
          error: "aborted",
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      if (!result.verified) {
        return {
          ok: false,
          verified: false,
          data: result.data,
          summary: "Risultato non verificabile: operazione non dichiarata completata.",
          error: "unverified_result",
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      return {
        ok: true,
        verified: true,
        data: result.data,
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onParentAbort);

      if (ctx.signal.aborted) {
        return {
          ok: false,
          verified: false,
          summary: "Operazione interrotta dall'utente.",
          error: "aborted",
          durationMs: Date.now() - startedAt,
          attempts: attempt,
        };
      }

      lastError = timedOut
        ? `Timeout dopo ${tool.timeoutMs} ms`
        : tool.onError
        ? tool.onError(error, input)
        : error instanceof Error
        ? error.message
        : String(error);
    }
  }

  return {
    ok: false,
    verified: false,
    summary: `Strumento ${tool.name} fallito dopo ${maxAttempts} tentativi.`,
    error: lastError,
    durationMs: Date.now() - startedAt,
    attempts: maxAttempts,
  };
}

/**
 * Esegue il ciclo completo di orchestrazione in 10 fasi con classificazione intento V1.1.
 */
export async function runOrchestration(
  req: OrchestrationRequest,
  registry: ToolRegistry = createDefaultAuraToolRegistry()
): Promise<OrchestrationRun> {
  const nowIso = new Date().toISOString();
  const completedPhases: OrchestrationPhase[] = [];
  const errors: string[] = [];
  const intent = classifyOrchestrationIntent(req.request);

  const run: OrchestrationRun = {
    id: makeId("orch"),
    request: req.request.trim(),
    intent,
    createdAt: nowIso,
    updatedAt: nowIso,
    currentPhase: "RICEZIONE",
    completedPhases,
    status: "running",
    steps: [],
    errors,
    finalSummary: "",
    safetyBlocked: Boolean(req.crisisBlocked),
    source: "local",
  };

  // FASE 1: RICEZIONE
  completedPhases.push("RICEZIONE");

  // Priorità assoluta al Safety Engine
  if (req.crisisBlocked) {
    run.status = "safety_blocked";
    run.safetyBlocked = true;
    run.safetyReply =
      "Elaborazione interrotta dal Safety Engine: in questo momento la priorità è il tuo supporto immediato.";
    run.finalSummary = run.safetyReply;
    run.currentPhase = "RISPOSTA";
    completedPhases.push("RISPOSTA");
    return run;
  }

  if (!run.request) {
    run.status = "failed";
    errors.push("Richiesta vuota.");
    run.finalSummary = "Nessuna richiesta ricevuta per l'orchestrazione.";
    run.currentPhase = "RISPOSTA";
    completedPhases.push("RISPOSTA");
    return run;
  }

  // FASE 2: ANALISI (classificazione intento già eseguita)
  run.currentPhase = "ANALISI";
  completedPhases.push("ANALISI");

  // FASE 3: SELEZIONE
  run.currentPhase = "SELEZIONE";
  const rawSteps =
    req.explicitSteps && req.explicitSteps.length > 0
      ? req.explicitSteps.map((s, idx) => ({
          id: s.id || `step-${idx + 1}-${s.toolId}`,
          toolId: s.toolId,
          operation: s.operation ?? intent,
          input: s.input ?? {},
          dependsOn: s.dependsOn ?? [],
        }))
      : selectToolsForRequest(run.request, registry, req.consentEnabled, intent);
  completedPhases.push("SELEZIONE");

  // Prevenzione chiamate duplicate (stesso toolId + operation + input identico)
  const seenSignatures = new Set<string>();
  const dedupedSteps: OrchestrationStep[] = [];

  for (const s of rawSteps) {
    const signature = `${s.toolId}:${s.operation}:${JSON.stringify(s.input)}`;
    if (seenSignatures.has(signature)) {
      continue;
    }
    seenSignatures.add(signature);
    const tool = registry.get(s.toolId);
    dedupedSteps.push({
      id: s.id,
      toolId: s.toolId,
      toolName: tool?.name ?? s.toolId,
      riskLevel: tool?.riskLevel ?? "ALTO",
      operation: s.operation,
      input: s.input,
      dependsOn: s.dependsOn,
      status: "pending",
      approvalRequired: false,
    });
  }

  run.steps = dedupedSteps;

  // FASE 4: VALIDAZIONE (controllo strumento, operazione supportata e parametri)
  run.currentPhase = "VALIDAZIONE";
  for (const step of run.steps) {
    const tool = registry.get(step.toolId);
    if (!tool || !tool.implemented) {
      step.status = "blocked";
      step.error = `Strumento "${step.toolId}" non registrato o non implementato.`;
      errors.push(step.error);
      continue;
    }
    if (!tool.supportedOperations.includes(step.operation)) {
      step.status = "blocked";
      step.error = `Operazione "${step.operation}" non supportata da "${tool.name}" (supportate: ${tool.supportedOperations.join(", ")}).`;
      errors.push(step.error);
      continue;
    }
    const validation = tool.validateInput(step.input, step.operation);
    if (!validation.valid) {
      step.status = "failed";
      step.error = validation.error ?? "Parametri non validi.";
      errors.push(`${tool.name}: ${step.error}`);
    }
  }
  completedPhases.push("VALIDAZIONE");

  // FASE 5: PIANIFICAZIONE (controllo cicli infiniti)
  run.currentPhase = "PIANIFICAZIONE";
  if (hasDependencyCycle(run.steps)) {
    run.status = "failed";
    const cycleErr = "Rilevato ciclo infinito nelle dipendenze tra strumenti: esecuzione annullata.";
    errors.push(cycleErr);
    run.steps.forEach((s) => {
      if (s.status === "pending") s.status = "cancelled";
    });
    run.finalSummary = cycleErr;
    run.currentPhase = "RISPOSTA";
    completedPhases.push("RISPOSTA");
    return run;
  }
  completedPhases.push("PIANIFICAZIONE");

  // FASE 6: AUTORIZZAZIONE (livelli di rischio + consenso + conferme per UPDATE/DELETE)
  run.currentPhase = "AUTORIZZAZIONE";
  const approvedSet = new Set(req.approvedStepIds ?? []);
  let needsUserApproval = false;

  for (const step of run.steps) {
    if (step.status !== "pending") continue;
    const tool = registry.get(step.toolId)!;

    // Livello ALTO: sempre bloccato
    if (tool.riskLevel === "ALTO" || tool.requiredPermissions.includes("external_action")) {
      step.status = "blocked";
      step.approvalRequired = true;
      step.approvalReason =
        "Operazione ad alto rischio o esterna bloccata: richiede un'integrazione sicura e autorizzazione esplicita.";
      step.error = step.approvalReason;
      errors.push(`${tool.name}: ${step.approvalReason}`);
      continue;
    }

    // Consenso memoria obbligatorio se lo strumento dichiara requiresConsent o memory_consent
    if (
      (tool.requiresConsent || tool.requiredPermissions.includes("memory_consent")) &&
      !req.consentEnabled
    ) {
      step.status = "blocked";
      step.error = "Accesso alla memoria negato: consenso non attivo.";
      errors.push(`${tool.name}: ${step.error}`);
      continue;
    }

    // DELETE richiede SEMPRE conferma esplicita specifica per lo step
    if (step.operation === "DELETE" && !approvedSet.has(step.id)) {
      step.status = "awaiting_approval";
      step.approvalRequired = true;
      step.approvalReason = `Conferma esplicita richiesta per eliminare dati tramite "${tool.name}".`;
      needsUserApproval = true;
      continue;
    }

    // UPDATE su strumenti che modificano dati richiede autorizzazione esplicita
    if (
      step.operation === "UPDATE" &&
      (tool.modifiesData || tool.requiresConfirmation) &&
      !approvedSet.has(step.id)
    ) {
      step.status = "awaiting_approval";
      step.approvalRequired = true;
      step.approvalReason = `Autorizzazione richiesta per modificare dati esistenti tramite "${tool.name}".`;
      needsUserApproval = true;
      continue;
    }

    // CREATE su livello MEDIO con persistenza attiva richiede approvazione specifica
    if (
      step.operation === "CREATE" &&
      tool.riskLevel === "MEDIO" &&
      req.consentEnabled &&
      tool.requiredPermissions.includes("plan_write") &&
      !approvedSet.has(step.id)
    ) {
      step.status = "awaiting_approval";
      step.approvalRequired = true;
      step.approvalReason = `Conferma esplicita richiesta per "${tool.name}" (modifica dati persistenti).`;
      needsUserApproval = true;
    }
  }
  completedPhases.push("AUTORIZZAZIONE");

  if (needsUserApproval) {
    run.status = "awaiting_approval";
    run.updatedAt = new Date().toISOString();
    run.finalSummary =
      "Alcune operazioni richiedono la tua autorizzazione esplicita prima di procedere.";
    return run;
  }

  // FASE 7: ESECUZIONE sequenziale con rispetto dipendenze e segnale di interruzione
  run.currentPhase = "ESECUZIONE";
  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  req.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (req.signal?.aborted) abortController.abort();

  for (const step of run.steps) {
    if (step.status !== "pending") continue;

    if (abortController.signal.aborted) {
      step.status = "cancelled";
      continue;
    }

    // Verifica dipendenze soddisfatte
    const failedDep = step.dependsOn.find((depId) => {
      const dep = run.steps.find((s) => s.id === depId);
      return !dep || dep.status !== "completed";
    });
    if (failedDep) {
      step.status = "cancelled";
      step.error = `Annullato perché la dipendenza "${failedDep}" non è completata.`;
      continue;
    }

    step.status = "running";
    const tool = registry.get(step.toolId)!;
    const ctx: ToolExecutionContext = {
      intent: step.operation,
      consentEnabled: req.consentEnabled,
      crisisBlocked: false,
      signal: abortController.signal,
      approvedStepIds: approvedSet,
      storage: req.storage,
    };
    const result = await executeSingleToolWithTimeoutAndRetry(tool, step.input, ctx);
    step.result = result;

    if (result.ok && result.verified) {
      step.status = "completed";
    } else if (result.error === "aborted") {
      step.status = "cancelled";
    } else {
      step.status = "failed";
      step.error = result.error ?? result.summary;
      errors.push(`${tool.name}: ${step.error}`);
    }
  }

  req.signal?.removeEventListener("abort", onExternalAbort);
  completedPhases.push("ESECUZIONE");

  // FASE 8: VERIFICA
  run.currentPhase = "VERIFICA";
  const completedCount = run.steps.filter((s) => s.status === "completed").length;
  const failedCount = run.steps.filter((s) => s.status === "failed").length;
  const cancelledCount = run.steps.filter((s) => s.status === "cancelled").length;
  const blockedCount = run.steps.filter((s) => s.status === "blocked").length;
  completedPhases.push("VERIFICA");

  // FASE 9: RECUPERO
  run.currentPhase = "RECUPERO";
  if (abortController.signal.aborted) {
    run.status = "cancelled";
  } else if (failedCount > 0 && completedCount === 0) {
    run.status = "failed";
  } else if (blockedCount > 0 && completedCount === 0) {
    run.status = "failed";
  } else {
    run.status = "completed";
  }
  completedPhases.push("RECUPERO");

  // FASE 10: RISPOSTA
  run.currentPhase = "RISPOSTA";
  run.updatedAt = new Date().toISOString();
  const stepSummaries = run.steps
    .filter((s) => s.status === "completed" && s.result?.summary)
    .map((s) => `${s.toolName}: ${s.result!.summary}`);

  if (run.status === "cancelled") {
    run.finalSummary = `Processo interrotto dall'utente (${completedCount} completate, ${cancelledCount} annullate).`;
  } else if (stepSummaries.length > 0) {
    run.finalSummary = stepSummaries.join(" | ");
  } else {
    run.finalSummary = errors[0] ?? "Nessuna operazione completata.";
  }

  completedPhases.push("RISPOSTA");
  return run;
}
