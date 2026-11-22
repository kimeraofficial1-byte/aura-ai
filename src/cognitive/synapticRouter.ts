import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import { SynapticRegistry } from "./synapticRegistry";
import {
  type CognitiveEngineDescriptor,
  type CognitiveEvent,
  type SynapticRouteExecutionRecord,
  type SynapticRoutingOptions,
  type SynapticRoutingResult,
  type SynapticSafetyEvaluator,
  type SynapticSafetyInput,
  type SynapticSafetyVerdict,
} from "./synapticTypes";

export interface SynapticRouterConfig {
  safetyEvaluator?: SynapticSafetyEvaluator;
  defaultTimeoutMs?: number;
  maxHops?: number;
  maxConcurrentPerEngine?: number;
  maxGlobalConcurrent?: number;
}

function extractSafetyText(input: SynapticSafetyInput): string | undefined {
  if (typeof input.userTextForSafetyCheck === "string") {
    return input.userTextForSafetyCheck;
  }
  const payload = input.event?.payload;
  if (payload && typeof payload === "object") {
    for (const key of ["userText", "input", "message", "text", "query"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

export function defaultSynapticSafetyEvaluator(
  input: SynapticSafetyInput
): SynapticSafetyVerdict {
  const nowIso = input?.nowIso ?? new Date().toISOString();

  if (!input || !input.event || typeof input.event !== "object") {
    return {
      allowed: false,
      failClosed: true,
      reason: "Controllo sicurezza fail-closed: evento mancante o non valido.",
    };
  }

  if (input.corruptedDataDetected) {
    return {
      allowed: false,
      failClosed: true,
      reason: "Controllo sicurezza fail-closed: rilevati dati danneggiati o incoerenti.",
    };
  }

  const safetyText = extractSafetyText(input) ?? "";
  const crisisCheck = evaluateCognitiveSafety(safetyText, input.crisisBlocked);
  if (input.crisisBlocked || !crisisCheck.safe || crisisCheck.crisisDetected) {
    return {
      allowed: false,
      failClosed: true,
      reason:
        crisisCheck.reply ??
        "Elaborazione bloccata dal Safety System per priorità assoluta di sicurezza.",
      crisisCheck,
    };
  }

  if (input.consentState) {
    const metaSafetyDecision = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: input.consentState,
      usesLearningData: input.usesLearningData ?? false,
      crisisBlocked: input.crisisBlocked,
      userTextForSafetyCheck: safetyText || undefined,
      corruptedDataDetected: input.corruptedDataDetected,
      nowIso,
    });
    if (!metaSafetyDecision.allowed) {
      return {
        allowed: false,
        failClosed: true,
        reason: metaSafetyDecision.reason,
        crisisCheck,
        metaSafetyDecision,
      };
    }
    return {
      allowed: true,
      failClosed: false,
      reason: "Controllo sicurezza sinaptico superato.",
      crisisCheck,
      metaSafetyDecision,
    };
  }

  return {
    allowed: true,
    failClosed: false,
    reason: "Controllo sicurezza sinaptico superato.",
    crisisCheck,
  };
}

function validateRouteEvent(
  event: unknown
): { ok: true; event: CognitiveEvent } | { ok: false; reason: string } {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "Evento di routing mancante o corrotto." };
  }
  const candidate = event as Partial<CognitiveEvent>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id.trim() ||
    typeof candidate.type !== "string" ||
    !candidate.type.trim() ||
    typeof candidate.source !== "string" ||
    !candidate.source.trim() ||
    typeof candidate.correlationId !== "string" ||
    !candidate.correlationId.trim() ||
    typeof candidate.hopDepth !== "number" ||
    !Number.isInteger(candidate.hopDepth) ||
    candidate.hopDepth < 0 ||
    !Array.isArray(candidate.causationChain) ||
    !Array.isArray(candidate.visitedEngines) ||
    candidate.payload === null ||
    typeof candidate.payload !== "object" ||
    Array.isArray(candidate.payload)
  ) {
    return {
      ok: false,
      reason: "Evento cognitivo malformato: routing interrotto in modalità fail-closed.",
    };
  }
  return { ok: true, event: candidate as CognitiveEvent };
}

async function runWithTimeoutAndAbort<T>(
  work: (signal: AbortSignal) => Promise<T> | T,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  if (externalSignal?.aborted) {
    const abortErr = new Error("Routing annullato dal chiamante prima dell'avvio.");
    abortErr.name = "AbortError";
    throw abortErr;
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
            ? `Timeout di routing superato (${timeoutMs} ms).`
            : "Routing sinaptico annullato."
        );
        err.name = timedOut ? "TimeoutError" : "AbortError";
        reject(err);
      };

      if (controller.signal.aborted) {
        onAbort();
        return;
      }

      controller.signal.addEventListener("abort", onAbort, { once: true });

      Promise.resolve()
        .then(() => work(controller.signal))
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Synaptic Router V1 (Fase 11.1).
 * Instrada eventi cognitivi verso i motori registrati compatibili applicando:
 * - gate di sicurezza fail-closed;
 * - verifica stato (available/unavailable/disabled) e dipendenze;
 * - protezione da cicli, duplicazioni e limiti di concorrenza;
 * - timeout e cancellazione tramite AbortSignal;
 * - blocco assoluto di esecuzioni autonome o mutazioni non consentite in Fase 11.1.
 */
export class SynapticRouter {
  private readonly registry: SynapticRegistry;
  private readonly safetyEvaluator?: SynapticSafetyEvaluator;
  private readonly defaultTimeoutMs: number;
  private readonly maxHops: number;
  private readonly maxConcurrentPerEngine: number;
  private readonly maxGlobalConcurrent: number;

  private globalInFlight = 0;
  private readonly perEngineInFlight = new Map<string, number>();
  private readonly executedActivationKeys = new Set<string>();

  constructor(registry: SynapticRegistry, config: SynapticRouterConfig = {}) {
    this.registry = registry;
    this.safetyEvaluator =
      "safetyEvaluator" in config
        ? config.safetyEvaluator
        : defaultSynapticSafetyEvaluator;
    this.defaultTimeoutMs = Math.max(1, config.defaultTimeoutMs ?? 5000);
    this.maxHops = Math.max(0, config.maxHops ?? 6);
    this.maxConcurrentPerEngine = Math.max(1, config.maxConcurrentPerEngine ?? 2);
    this.maxGlobalConcurrent = Math.max(1, config.maxGlobalConcurrent ?? 8);
  }

  getActiveConcurrency(): { global: number; byEngine: Record<string, number> } {
    const byEngine: Record<string, number> = {};
    for (const [k, v] of this.perEngineInFlight.entries()) {
      if (v > 0) byEngine[k] = v;
    }
    return { global: this.globalInFlight, byEngine };
  }

  clearActivationHistory(): void {
    this.executedActivationKeys.clear();
  }

  private evaluateSafetyFailClosed(
    event: CognitiveEvent,
    options: SynapticRoutingOptions
  ): SynapticSafetyVerdict {
    if (typeof this.safetyEvaluator !== "function") {
      return {
        allowed: false,
        failClosed: true,
        reason:
          "Safety guard mancante o non configurato: routing bloccato in modalità fail-closed.",
      };
    }

    try {
      const verdict = this.safetyEvaluator({
        event,
        ...options.safetyInput,
      });
      if (!verdict || typeof verdict.allowed !== "boolean") {
        return {
          allowed: false,
          failClosed: true,
          reason:
            "Esito del Safety guard non valido o corrotto: routing bloccato (fail-closed).",
        };
      }
      return verdict;
    } catch (err) {
      return {
        allowed: false,
        failClosed: true,
        reason: `Errore nel Safety guard (fail-closed): ${
          err instanceof Error ? err.message : "errore sconosciuto"
        }`,
      };
    }
  }

  async route(
    rawEvent: CognitiveEvent,
    options: SynapticRoutingOptions = {}
  ): Promise<SynapticRoutingResult> {
    const timestamp = new Date().toISOString();

    // 1. Validazione integrità evento (fail-closed)
    const validated = validateRouteEvent(rawEvent);
    if (!validated.ok) {
      const fallbackSafety: SynapticSafetyVerdict = {
        allowed: false,
        failClosed: true,
        reason: validated.reason,
      };
      return {
        allowed: false,
        safetyBlocked: true,
        status: "blocked",
        eventId:
          rawEvent && typeof rawEvent === "object" && typeof rawEvent.id === "string"
            ? rawEvent.id
            : "",
        eventType:
          rawEvent && typeof rawEvent === "object" && typeof rawEvent.type === "string"
            ? rawEvent.type
            : "",
        correlationId:
          rawEvent &&
          typeof rawEvent === "object" &&
          typeof rawEvent.correlationId === "string"
            ? rawEvent.correlationId
            : "",
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict: fallbackSafety,
        reason: validated.reason,
        timestamp,
      };
    }

    const event = validated.event;

    // 2. Policy guard Fase 11.1: nessuna esecuzione autonoma o mutazione ammessa
    if (options.allowMutation === true) {
      const reason =
        "Mutazioni ed esecuzioni autonome disabilitate nella Fase 11.1 (solo coordinamento in sola lettura).";
      return {
        allowed: false,
        safetyBlocked: false,
        status: "blocked",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict: {
          allowed: false,
          failClosed: true,
          reason,
        },
        reason,
        timestamp,
      };
    }

    // 3. Controllo Safety fail-closed
    const safetyVerdict = this.evaluateSafetyFailClosed(event, options);
    if (!safetyVerdict.allowed) {
      return {
        allowed: false,
        safetyBlocked: true,
        status: "safety_blocked",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict,
        reason: safetyVerdict.reason,
        timestamp,
      };
    }

    // 4. Controllo cancellazione preventiva
    if (options.signal?.aborted) {
      return {
        allowed: false,
        safetyBlocked: false,
        status: "cancelled",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict,
        reason: "Routing sinaptico annullato dal chiamante.",
        timestamp,
      };
    }

    // 5. Selezione deterministica dei motori compatibili
    const candidates = this.registry.findMatchingEngines({
      eventType: event.type,
      requiredCapabilities: options.requiredCapabilities,
      targetEngineIds: options.targetEngineIds,
      includeNonAvailable: true,
    });

    if (candidates.length === 0) {
      return {
        allowed: true,
        safetyBlocked: false,
        status: "no_matching_engines",
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        matchedEngines: [],
        executedEngines: [],
        skippedOrBlockedEngines: [],
        records: [],
        safetyVerdict,
        reason: `Nessun motore compatibile trovato per l'evento "${event.type}".`,
        timestamp,
      };
    }

    const effectiveMaxHops = options.maxHops ?? this.maxHops;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const preventDuplicate = options.preventDuplicateActivation !== false;
    const orderedCandidates = candidates;

    const records: SynapticRouteExecutionRecord[] = [];

    for (const descriptor of orderedCandidates) {
      if (options.signal?.aborted) {
        records.push({
          engineId: descriptor.engineId,
          descriptor,
          status: "cancelled",
          reason: "Routing annullato prima dell'invocazione del motore.",
          durationMs: 0,
        });
        continue;
      }

      const record = await this.dispatchToEngine(descriptor, event, {
        effectiveMaxHops,
        timeoutMs,
        preventDuplicate,
        signal: options.signal,
      });
      records.push(record);
    }

    const matchedEngines = orderedCandidates.map((c) => c.engineId);
    const executedEngines = records
      .filter((r) => r.status === "executed")
      .map((r) => r.engineId);
    const skippedOrBlockedEngines = records
      .filter((r) => r.status !== "executed")
      .map((r) => r.engineId);

    const hasTimeout = records.some((r) => r.status === "timeout");
    const hasCancelled = records.every((r) => r.status === "cancelled");
    const status: SynapticRoutingResult["status"] = hasCancelled
      ? "cancelled"
      : executedEngines.length > 0 && skippedOrBlockedEngines.length === 0
        ? "completed"
        : executedEngines.length > 0
          ? "partial"
          : hasTimeout
            ? "timeout"
            : "blocked";

    return {
      allowed: true,
      safetyBlocked: false,
      status,
      eventId: event.id,
      eventType: event.type,
      correlationId: event.correlationId,
      matchedEngines,
      executedEngines,
      skippedOrBlockedEngines,
      records,
      safetyVerdict,
      reason:
        executedEngines.length > 0
          ? `Routing completato su ${executedEngines.length}/${matchedEngines.length} motori compatibili.`
          : `Nessun motore eseguito su ${matchedEngines.length} candidati (${records.map((r) => `${r.engineId}:${r.status}`).join(", ")}).`,
      timestamp,
    };
  }

  private async dispatchToEngine(
    descriptor: CognitiveEngineDescriptor,
    event: CognitiveEvent,
    params: {
      effectiveMaxHops: number;
      timeoutMs: number;
      preventDuplicate: boolean;
      signal?: AbortSignal;
    }
  ): Promise<SynapticRouteExecutionRecord> {
    const start = Date.now();

    if (descriptor.status === "disabled") {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "skipped_disabled",
        reason: `Motore "${descriptor.engineId}" disabilitato nel SynapticRegistry.`,
        durationMs: 0,
      };
    }

    if (descriptor.status === "unavailable") {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "skipped_unavailable",
        reason: `Motore "${descriptor.engineId}" attualmente non disponibile.`,
        durationMs: 0,
      };
    }

    if (!descriptor.readOnly) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_mutation_policy",
        reason: `Motore "${descriptor.engineId}" non è marcato readOnly: invocazione autonoma bloccata nella Fase 11.1.`,
        durationMs: 0,
      };
    }

    if (event.hopDepth > params.effectiveMaxHops) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_loop",
        reason: `Limite massimo hop superato (${event.hopDepth} > ${params.effectiveMaxHops}).`,
        durationMs: 0,
      };
    }

    if (event.visitedEngines.includes(descriptor.engineId)) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_loop",
        reason: `Prevenuto ciclo rientrante sul motore "${descriptor.engineId}" nella correlazione "${event.correlationId}".`,
        durationMs: 0,
      };
    }

    const activationKey = `${event.id}::${descriptor.engineId}`;
    const correlationKey = `${event.correlationId}::${event.type}::${descriptor.engineId}`;
    if (
      params.preventDuplicate &&
      (this.executedActivationKeys.has(activationKey) ||
        this.executedActivationKeys.has(correlationKey))
    ) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_duplicate",
        reason: `Attivazione duplicata bloccata per "${descriptor.engineId}" su evento/correlazione.`,
        durationMs: 0,
      };
    }

    const depCheck = this.registry.checkDependencies(descriptor.engineId);
    if (depCheck.missing.length > 0) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_missing_dependency",
        reason: `Dipendenze mancanti per "${descriptor.engineId}": ${depCheck.missing.join(", ")}.`,
        durationMs: 0,
      };
    }
    if (depCheck.unavailable.length > 0) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_dependency_unavailable",
        reason: `Dipendenze non disponibili per "${descriptor.engineId}": ${depCheck.unavailable.join(", ")}.`,
        durationMs: 0,
      };
    }

    const engineInFlight = this.perEngineInFlight.get(descriptor.engineId) ?? 0;
    if (
      this.globalInFlight >= this.maxGlobalConcurrent ||
      engineInFlight >= this.maxConcurrentPerEngine
    ) {
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "blocked_concurrency",
        reason: `Limite di concorrenza raggiunto per "${descriptor.engineId}".`,
        durationMs: 0,
      };
    }

    const handler = this.registry.getHandler(descriptor.engineId);
    if (!handler) {
      this.executedActivationKeys.add(activationKey);
      if (params.preventDuplicate) {
        this.executedActivationKeys.add(correlationKey);
      }
      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "executed",
        reason: `Descrittore consultivo "${descriptor.engineId}" instradato (nessun handler collegato).`,
        durationMs: Math.max(0, Date.now() - start),
        output: { acknowledged: true, readOnly: true },
      };
    }

    this.globalInFlight += 1;
    this.perEngineInFlight.set(descriptor.engineId, engineInFlight + 1);
    if (params.preventDuplicate) {
      this.executedActivationKeys.add(activationKey);
      this.executedActivationKeys.add(correlationKey);
    }

    const routedEvent: CognitiveEvent = {
      ...event,
      causationChain: [...event.causationChain],
      visitedEngines: [...event.visitedEngines, descriptor.engineId],
      payload: { ...event.payload },
      metadata: event.metadata ? { ...event.metadata } : undefined,
    };

    try {
      const output = await runWithTimeoutAndAbort(
        (signal) =>
          handler({
            event: routedEvent,
            correlationId: event.correlationId,
            descriptor,
            signal,
            advisoryOnly: true,
            readOnly: true,
          }),
        params.timeoutMs,
        params.signal
      );

      return {
        engineId: descriptor.engineId,
        descriptor,
        status: "executed",
        reason: `Motore "${descriptor.engineId}" eseguito in sola lettura.`,
        durationMs: Math.max(0, Date.now() - start),
        output,
      };
    } catch (err) {
      const errName = err instanceof Error ? err.name : "Error";
      const errMsg =
        err instanceof Error
          ? err.message
          : "Errore imprevisto durante il routing del motore.";

      const status =
        errName === "TimeoutError"
          ? "timeout"
          : errName === "AbortError"
            ? "cancelled"
            : "error";

      return {
        engineId: descriptor.engineId,
        descriptor,
        status,
        reason: errMsg,
        error: errMsg,
        durationMs: Math.max(0, Date.now() - start),
      };
    } finally {
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const current = this.perEngineInFlight.get(descriptor.engineId) ?? 1;
      if (current <= 1) {
        this.perEngineInFlight.delete(descriptor.engineId);
      } else {
        this.perEngineInFlight.set(descriptor.engineId, current - 1);
      }
    }
  }
}
