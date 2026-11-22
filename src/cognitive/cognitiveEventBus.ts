import {
  COGNITIVE_EVENT_PRIORITY_WEIGHTS,
  type BusSubscriberHandler,
  type CognitiveBusDispatchResult,
  type CognitiveEvent,
  type CognitiveEventBusConfig,
  type CognitiveEventBusSubscribeOptions,
  type CognitiveEventPriority,
  type CognitiveEventSubscription,
  type CreateCognitiveEventInput,
  type SubscriberDeliveryOutcome,
} from "./synapticTypes";

const VALID_PRIORITIES = new Set<CognitiveEventPriority>([
  "low",
  "normal",
  "high",
  "critical",
]);

interface InternalSubscription {
  subscriberId: string;
  eventType: string;
  priority: CognitiveEventPriority;
  sequence: number;
  once: boolean;
  handler: BusSubscriberHandler<unknown>;
}

interface QueuedEventEntry {
  event: CognitiveEvent<Record<string, unknown>>;
  sequence: number;
}

function generateSynapticId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSafePayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    return [...payload] as unknown as T;
  }
  return { ...(payload as Record<string, unknown>) } as T;
}

function validateCognitiveEvent(
  event: unknown,
  maxEventDepth: number
): { ok: true } | { ok: false; status: "rejected_invalid" | "rejected_loop"; reason: string } {
  if (!event || typeof event !== "object") {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Evento cognitivo mancante o non valido.",
    };
  }

  const candidate = event as Partial<CognitiveEvent>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Identificativo evento (id) mancante o non valido.",
    };
  }
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Tipo evento (type) mancante o non valido.",
    };
  }
  if (typeof candidate.source !== "string" || !candidate.source.trim()) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Origine evento (source) mancante o non valida.",
    };
  }
  if (typeof candidate.correlationId !== "string" || !candidate.correlationId.trim()) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Identificativo di correlazione (correlationId) mancante o non valido.",
    };
  }
  if (typeof candidate.timestamp !== "string" || Number.isNaN(Date.parse(candidate.timestamp))) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Timestamp evento mancante o non valido.",
    };
  }
  if (!candidate.priority || !VALID_PRIORITIES.has(candidate.priority)) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: `Priorità evento non valida: "${String(candidate.priority)}".`,
    };
  }
  if (
    typeof candidate.hopDepth !== "number" ||
    !Number.isInteger(candidate.hopDepth) ||
    candidate.hopDepth < 0
  ) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Profondità di propagazione (hopDepth) non valida.",
    };
  }
  if (!Array.isArray(candidate.causationChain) || !Array.isArray(candidate.visitedEngines)) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Struttura di tracciamento causale (causationChain/visitedEngines) non valida.",
    };
  }
  if (candidate.payload === null || typeof candidate.payload !== "object" || Array.isArray(candidate.payload)) {
    return {
      ok: false,
      status: "rejected_invalid",
      reason: "Payload dell'evento mancante o corrotto (atteso oggetto JSON).",
    };
  }

  if (candidate.hopDepth > maxEventDepth) {
    return {
      ok: false,
      status: "rejected_loop",
      reason: `Profondità massima di propagazione superata (${candidate.hopDepth} > ${maxEventDepth}).`,
    };
  }
  if (candidate.causationChain.includes(candidate.id)) {
    return {
      ok: false,
      status: "rejected_loop",
      reason: `Ciclo causale rilevato sull'evento "${candidate.id}".`,
    };
  }

  return { ok: true };
}

/**
 * Cognitive Event Bus V1 (Fase 11.1).
 * Bus tipizzato publish/subscribe deterministico per comunicazione interna tra motori cognitivi:
 * - isolamento degli errori dei sottoscrittori;
 * - ordinamento per priorità (critical > high > normal > low) e sequenza FIFO;
 * - deduplicazione degli eventi già elaborati;
 * - protezione da cicli e limiti di coda;
 * - tracciamento correlationId e cleanup deterministico.
 */
export class CognitiveEventBus {
  private readonly maxQueueSize: number;
  private readonly maxEventDepth: number;
  private readonly maxDedupeHistory: number;
  private readonly maxSubscribersPerEvent: number;

  private readonly subscribers = new Map<string, InternalSubscription[]>();
  private readonly processedEventIds: string[] = [];
  private readonly processedEventIdSet = new Set<string>();
  private readonly queue: QueuedEventEntry[] = [];

  private subscriberCounter = 0;
  private queueCounter = 0;
  private disposed = false;

  constructor(config: CognitiveEventBusConfig = {}) {
    this.maxQueueSize = Math.max(1, config.maxQueueSize ?? 250);
    this.maxEventDepth = Math.max(0, config.maxEventDepth ?? 8);
    this.maxDedupeHistory = Math.max(10, config.maxDedupeHistory ?? 1000);
    this.maxSubscribersPerEvent = Math.max(1, config.maxSubscribersPerEvent ?? 100);
  }

  createEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    input: CreateCognitiveEventInput<TPayload>
  ): CognitiveEvent<TPayload> {
    const parent = input.parentEvent;
    const id = input.id?.trim() || generateSynapticId("evt");
    const correlationId =
      input.correlationId?.trim() ||
      parent?.correlationId ||
      generateSynapticId("corr");
    const parentEventId = input.parentEventId ?? parent?.id;
    const hopDepth =
      typeof input.hopDepth === "number"
        ? input.hopDepth
        : parent
          ? parent.hopDepth + 1
          : 0;
    const causationChain = input.causationChain
      ? [...input.causationChain]
      : parent
        ? [...parent.causationChain, parent.id]
        : [];
    const visitedEngines = input.visitedEngines
      ? [...input.visitedEngines]
      : parent
        ? [...parent.visitedEngines]
        : [];

    return {
      id,
      type: input.type.trim(),
      source: input.source.trim(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      correlationId,
      parentEventId,
      hopDepth,
      causationChain,
      visitedEngines,
      priority: input.priority ?? "normal",
      payload: cloneSafePayload(input.payload),
      metadata: input.metadata ? { ...input.metadata } : undefined,
    };
  }

  subscribe<TPayload = Record<string, unknown>>(
    eventType: string,
    handler: BusSubscriberHandler<TPayload>,
    options: CognitiveEventBusSubscribeOptions = {}
  ): CognitiveEventSubscription {
    if (this.disposed) {
      throw new Error("CognitiveEventBus è stato dismesso (disposed).");
    }
    const normalizedType = eventType.trim();
    if (!normalizedType) {
      throw new Error("Il tipo di evento per la sottoscrizione non può essere vuoto.");
    }
    if (typeof handler !== "function") {
      throw new Error("Il gestore del sottoscrittore deve essere una funzione.");
    }

    const priority = options.priority ?? "normal";
    if (!VALID_PRIORITIES.has(priority)) {
      throw new Error(`Priorità sottoscrittore non valida: "${String(priority)}".`);
    }

    const existing = this.subscribers.get(normalizedType) ?? [];
    if (existing.length >= this.maxSubscribersPerEvent) {
      throw new Error(
        `Limite massimo di sottoscrittori raggiunto per "${normalizedType}" (${this.maxSubscribersPerEvent}).`
      );
    }

    this.subscriberCounter += 1;
    const subscriberId =
      options.subscriberId?.trim() || `sub-${normalizedType}-${this.subscriberCounter}`;

    const entry: InternalSubscription = {
      subscriberId,
      eventType: normalizedType,
      priority,
      sequence: this.subscriberCounter,
      once: options.once === true,
      handler: handler as BusSubscriberHandler<unknown>,
    };

    const updated = [...existing, entry].sort((a, b) => {
      const diff =
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[b.priority] -
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[a.priority];
      return diff !== 0 ? diff : a.sequence - b.sequence;
    });
    this.subscribers.set(normalizedType, updated);

    return {
      subscriberId,
      eventType: normalizedType,
      unsubscribe: () => {
        this.unsubscribe(normalizedType, subscriberId);
      },
    };
  }

  unsubscribe(eventType: string, subscriberId: string): boolean {
    const normalizedType = eventType.trim();
    const list = this.subscribers.get(normalizedType);
    if (!list) return false;
    const filtered = list.filter((s) => s.subscriberId !== subscriberId);
    if (filtered.length === list.length) return false;
    if (filtered.length === 0) {
      this.subscribers.delete(normalizedType);
    } else {
      this.subscribers.set(normalizedType, filtered);
    }
    return true;
  }

  getSubscriberCount(eventType?: string): number {
    if (eventType !== undefined) {
      return (this.subscribers.get(eventType.trim()) ?? []).length;
    }
    let total = 0;
    for (const list of this.subscribers.values()) {
      total += list.length;
    }
    return total;
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.processedEventIdSet.has(eventId);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private rememberProcessedEvent(eventId: string): void {
    if (this.processedEventIdSet.has(eventId)) return;
    this.processedEventIdSet.add(eventId);
    this.processedEventIds.push(eventId);
    if (this.processedEventIds.length > this.maxDedupeHistory) {
      const oldest = this.processedEventIds.shift();
      if (oldest) {
        this.processedEventIdSet.delete(oldest);
      }
    }
  }

  private getMatchedSubscriptions(eventType: string): InternalSubscription[] {
    const exact = this.subscribers.get(eventType) ?? [];
    const wildcard = eventType === "*" ? [] : (this.subscribers.get("*") ?? []);
    return [...exact, ...wildcard].sort((a, b) => {
      const diff =
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[b.priority] -
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[a.priority];
      return diff !== 0 ? diff : a.sequence - b.sequence;
    });
  }

  enqueue<TPayload extends Record<string, unknown>>(
    event: CognitiveEvent<TPayload>
  ): {
    accepted: boolean;
    status: "queued" | "duplicate_ignored" | "rejected_invalid" | "rejected_loop" | "rejected_queue_limit" | "disposed";
    reason?: string;
  } {
    if (this.disposed) {
      return {
        accepted: false,
        status: "disposed",
        reason: "CognitiveEventBus è stato dismesso.",
      };
    }

    const validation = validateCognitiveEvent(event, this.maxEventDepth);
    if (!validation.ok) {
      return {
        accepted: false,
        status: validation.status,
        reason: validation.reason,
      };
    }

    if (
      this.processedEventIdSet.has(event.id) ||
      this.queue.some((q) => q.event.id === event.id)
    ) {
      return {
        accepted: false,
        status: "duplicate_ignored",
        reason: `Evento duplicato ignorato (${event.id}).`,
      };
    }

    if (this.queue.length >= this.maxQueueSize) {
      return {
        accepted: false,
        status: "rejected_queue_limit",
        reason: `Limite coda eventi raggiunto (${this.maxQueueSize}).`,
      };
    }

    this.queueCounter += 1;
    this.queue.push({
      event: {
        ...event,
        causationChain: [...event.causationChain],
        visitedEngines: [...event.visitedEngines],
        payload: cloneSafePayload(event.payload),
        metadata: event.metadata ? { ...event.metadata } : undefined,
      },
      sequence: this.queueCounter,
    });

    this.queue.sort((a, b) => {
      const diff =
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[b.event.priority] -
        COGNITIVE_EVENT_PRIORITY_WEIGHTS[a.event.priority];
      return diff !== 0 ? diff : a.sequence - b.sequence;
    });

    return { accepted: true, status: "queued" };
  }

  async flushQueue(signal?: AbortSignal): Promise<CognitiveBusDispatchResult[]> {
    const results: CognitiveBusDispatchResult[] = [];
    while (this.queue.length > 0) {
      if (signal?.aborted) break;
      const next = this.queue.shift();
      if (!next) break;
      const dispatched = await this.publish(next.event, signal);
      results.push(dispatched);
    }
    return results;
  }

  async publish<TPayload extends Record<string, unknown>>(
    event: CognitiveEvent<TPayload>,
    signal?: AbortSignal
  ): Promise<CognitiveBusDispatchResult> {
    const safeEventId =
      event && typeof event === "object" && typeof event.id === "string"
        ? event.id
        : "";
    const safeCorrelationId =
      event && typeof event === "object" && typeof event.correlationId === "string"
        ? event.correlationId
        : "";

    if (this.disposed) {
      return {
        accepted: false,
        status: "disposed",
        eventId: safeEventId,
        correlationId: safeCorrelationId,
        matchedSubscribers: 0,
        deliveredCount: 0,
        failedCount: 0,
        outcomes: [],
        reason: "CognitiveEventBus è stato dismesso.",
      };
    }

    const validation = validateCognitiveEvent(event, this.maxEventDepth);
    if (!validation.ok) {
      return {
        accepted: false,
        status: validation.status,
        eventId: safeEventId,
        correlationId: safeCorrelationId,
        matchedSubscribers: 0,
        deliveredCount: 0,
        failedCount: 0,
        outcomes: [],
        reason: validation.reason,
      };
    }

    if (this.processedEventIdSet.has(event.id)) {
      return {
        accepted: false,
        status: "duplicate_ignored",
        eventId: event.id,
        correlationId: event.correlationId,
        matchedSubscribers: 0,
        deliveredCount: 0,
        failedCount: 0,
        outcomes: [],
        reason: `Evento duplicato ignorato (${event.id}).`,
      };
    }

    this.rememberProcessedEvent(event.id);

    const matched = this.getMatchedSubscriptions(event.type);
    const outcomes: SubscriberDeliveryOutcome[] = [];
    const controller = new AbortController();
    const effectiveSignal = signal ?? controller.signal;

    const eventSnapshot: CognitiveEvent<Record<string, unknown>> = {
      ...event,
      causationChain: [...event.causationChain],
      visitedEngines: [...event.visitedEngines],
      payload: cloneSafePayload(event.payload),
      metadata: event.metadata ? { ...event.metadata } : undefined,
    };

    for (const sub of matched) {
      if (effectiveSignal.aborted) break;
      if (sub.once) {
        this.unsubscribe(sub.eventType, sub.subscriberId);
      }

      const start = Date.now();
      try {
        const res = await sub.handler(eventSnapshot, effectiveSignal);
        outcomes.push({
          subscriberId: sub.subscriberId,
          status: "delivered",
          durationMs: Math.max(0, Date.now() - start),
          result: res,
        });
      } catch (err) {
        outcomes.push({
          subscriberId: sub.subscriberId,
          status: "error",
          durationMs: Math.max(0, Date.now() - start),
          error:
            err instanceof Error
              ? err.message
              : "Errore sconosciuto nel sottoscrittore dell'evento.",
        });
      }
    }

    const deliveredCount = outcomes.filter((o) => o.status === "delivered").length;
    const failedCount = outcomes.filter((o) => o.status === "error").length;

    return {
      accepted: true,
      status: "dispatched",
      eventId: event.id,
      correlationId: event.correlationId,
      matchedSubscribers: matched.length,
      deliveredCount,
      failedCount,
      outcomes,
    };
  }

  clearSubscribers(): void {
    this.subscribers.clear();
  }

  clearHistory(): void {
    this.processedEventIds.length = 0;
    this.processedEventIdSet.clear();
    this.queue.length = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
    this.queue.length = 0;
    this.processedEventIds.length = 0;
    this.processedEventIdSet.clear();
  }
}
