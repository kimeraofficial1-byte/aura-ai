import type {
  CognitiveEngineDescriptor,
  CognitiveEventHandler,
  DependencyCheckResult,
  SynapticEngineId,
  SynapticEngineRegistrationOptions,
  SynapticEngineStatus,
} from "./synapticTypes";

const VALID_STATUSES = new Set<SynapticEngineStatus>([
  "available",
  "unavailable",
  "disabled",
]);

interface InternalEngineEntry {
  descriptor: CognitiveEngineDescriptor;
  handler?: CognitiveEventHandler<Record<string, unknown>, unknown>;
  registrationOrder: number;
}

function cloneDescriptor(d: CognitiveEngineDescriptor): CognitiveEngineDescriptor {
  return {
    ...d,
    capabilities: [...d.capabilities],
    supportedEvents: [...d.supportedEvents],
    dependencies: [...d.dependencies],
  };
}

function normalizeStringArray(values: string[], label: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`Il campo "${label}" del descrittore motore deve essere un array.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Synaptic Registry V1 (Fase 11.1).
 * Registro centralizzato e deterministico dei descrittori dei motori cognitivi AURA AI
 * e dei relativi adapter opzionali in sola lettura.
 * Non modifica mai la logica interna dei motori registrati.
 */
export class SynapticRegistry {
  private readonly entries = new Map<string, InternalEngineEntry>();
  private registrationCounter = 0;

  register<TPayload = Record<string, unknown>, TResult = unknown>(
    descriptor: CognitiveEngineDescriptor,
    options: SynapticEngineRegistrationOptions<TPayload, TResult> = {}
  ): CognitiveEngineDescriptor {
    if (!descriptor || typeof descriptor !== "object") {
      throw new Error("Descrittore del motore cognitivo mancante o non valido.");
    }
    const engineId = descriptor.engineId?.trim();
    if (!engineId) {
      throw new Error("engineId obbligatorio per registrare un motore nel SynapticRegistry.");
    }
    if (!descriptor.name?.trim()) {
      throw new Error(`Nome mancante per il motore "${engineId}".`);
    }
    if (!descriptor.version?.trim()) {
      throw new Error(`Versione mancante per il motore "${engineId}".`);
    }
    if (!VALID_STATUSES.has(descriptor.status)) {
      throw new Error(
        `Stato motore non valido per "${engineId}": "${String(descriptor.status)}".`
      );
    }
    if (typeof descriptor.readOnly !== "boolean") {
      throw new Error(`Il flag readOnly deve essere booleano per "${engineId}".`);
    }
    if (options.handler !== undefined && typeof options.handler !== "function") {
      throw new Error(`L'handler opzionale di "${engineId}" deve essere una funzione.`);
    }

    const alreadyExists = this.entries.has(engineId);
    if (alreadyExists && !options.replace) {
      throw new Error(
        `Il motore "${engineId}" è già registrato nel SynapticRegistry.`
      );
    }

    const capabilities = normalizeStringArray(descriptor.capabilities, "capabilities");
    const supportedEvents = normalizeStringArray(
      descriptor.supportedEvents,
      "supportedEvents"
    );
    const dependencies = normalizeStringArray(descriptor.dependencies, "dependencies");

    if (supportedEvents.length === 0) {
      throw new Error(
        `Il motore "${engineId}" deve dichiarare almeno un evento supportato in supportedEvents.`
      );
    }

    const normalized: CognitiveEngineDescriptor = {
      engineId,
      name: descriptor.name.trim(),
      version: descriptor.version.trim(),
      capabilities,
      supportedEvents,
      dependencies,
      status: descriptor.status,
      readOnly: descriptor.readOnly,
      priorityOrder:
        typeof descriptor.priorityOrder === "number" && Number.isFinite(descriptor.priorityOrder)
          ? descriptor.priorityOrder
          : 0,
      description: descriptor.description?.trim(),
    };

    const existingOrder = this.entries.get(engineId)?.registrationOrder;
    const registrationOrder = existingOrder ?? ++this.registrationCounter;

    this.entries.set(engineId, {
      descriptor: normalized,
      handler: options.handler as CognitiveEventHandler<Record<string, unknown>, unknown> | undefined,
      registrationOrder,
    });

    return cloneDescriptor(normalized);
  }

  unregister(engineId: SynapticEngineId): boolean {
    return this.entries.delete(engineId.trim());
  }

  has(engineId: SynapticEngineId): boolean {
    return this.entries.has(engineId.trim());
  }

  get(engineId: SynapticEngineId): CognitiveEngineDescriptor | undefined {
    const entry = this.entries.get(engineId.trim());
    return entry ? cloneDescriptor(entry.descriptor) : undefined;
  }

  getHandler(
    engineId: SynapticEngineId
  ): CognitiveEventHandler<Record<string, unknown>, unknown> | undefined {
    return this.entries.get(engineId.trim())?.handler;
  }

  setStatus(engineId: SynapticEngineId, status: SynapticEngineStatus): boolean {
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`Stato non valido: "${String(status)}".`);
    }
    const entry = this.entries.get(engineId.trim());
    if (!entry) return false;
    entry.descriptor.status = status;
    return true;
  }

  list(filter?: {
    status?: SynapticEngineStatus;
    readOnly?: boolean;
  }): CognitiveEngineDescriptor[] {
    const entries = Array.from(this.entries.values())
      .filter((entry) => {
        if (filter?.status !== undefined && entry.descriptor.status !== filter.status) {
          return false;
        }
        if (filter?.readOnly !== undefined && entry.descriptor.readOnly !== filter.readOnly) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const diff = (b.descriptor.priorityOrder ?? 0) - (a.descriptor.priorityOrder ?? 0);
        return diff !== 0 ? diff : a.registrationOrder - b.registrationOrder;
      });

    return entries.map((e) => cloneDescriptor(e.descriptor));
  }

  findByEvent(
    eventType: string,
    options?: { includeNonAvailable?: boolean }
  ): CognitiveEngineDescriptor[] {
    return this.findMatchingEngines({
      eventType,
      includeNonAvailable: options?.includeNonAvailable,
    });
  }

  findByCapability(
    capability: string,
    options?: { includeNonAvailable?: boolean }
  ): CognitiveEngineDescriptor[] {
    return this.findMatchingEngines({
      requiredCapabilities: [capability],
      includeNonAvailable: options?.includeNonAvailable,
    });
  }

  findMatchingEngines(criteria: {
    eventType?: string;
    requiredCapabilities?: string[];
    includeNonAvailable?: boolean;
    targetEngineIds?: string[];
  }): CognitiveEngineDescriptor[] {
    const eventType = criteria.eventType?.trim();
    const requiredCaps = (criteria.requiredCapabilities ?? [])
      .map((c) => c.trim())
      .filter(Boolean);
    const targetIds = criteria.targetEngineIds
      ? new Set(criteria.targetEngineIds.map((id) => id.trim()).filter(Boolean))
      : null;

    const matched = Array.from(this.entries.values())
      .filter((entry) => {
        const d = entry.descriptor;
        if (!criteria.includeNonAvailable && d.status !== "available") {
          return false;
        }
        if (targetIds && !targetIds.has(d.engineId)) {
          return false;
        }
        if (
          eventType &&
          !d.supportedEvents.includes(eventType) &&
          !d.supportedEvents.includes("*")
        ) {
          return false;
        }
        if (requiredCaps.length > 0) {
          const capSet = new Set(d.capabilities);
          if (!requiredCaps.every((cap) => capSet.has(cap))) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const diff = (b.descriptor.priorityOrder ?? 0) - (a.descriptor.priorityOrder ?? 0);
        return diff !== 0 ? diff : a.registrationOrder - b.registrationOrder;
      });

    return matched.map((e) => cloneDescriptor(e.descriptor));
  }

  checkDependencies(engineId: SynapticEngineId): DependencyCheckResult {
    const entry = this.entries.get(engineId.trim());
    if (!entry) {
      return {
        satisfied: false,
        missing: [engineId.trim()],
        unavailable: [],
      };
    }

    const missing: string[] = [];
    const unavailable: string[] = [];

    for (const depId of entry.descriptor.dependencies) {
      const depEntry = this.entries.get(depId);
      if (!depEntry) {
        missing.push(depId);
      } else if (depEntry.descriptor.status !== "available") {
        unavailable.push(depId);
      }
    }

    return {
      satisfied: missing.length === 0 && unavailable.length === 0,
      missing,
      unavailable,
    };
  }

  clear(): void {
    this.entries.clear();
  }
}
