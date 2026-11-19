import {
  LocalStorageAdapter,
  MemoryStorageAdapter,
  type MinimalWebStorage,
} from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import type {
  CognitiveTimelineEvent,
  CognitiveTimelineExport,
} from "./continuityTypes";

export const COGNITIVE_TIMELINE_STORAGE_KEY = "aura_cognitive_timeline_v1";
const MAX_TIMELINE_EVENTS = 200;

function isValidTimelineEvent(item: unknown): item is CognitiveTimelineEvent {
  if (!item || typeof item !== "object") return false;
  const e = item as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.trim().length > 0 &&
    typeof e.date === "string" &&
    typeof e.source === "string" &&
    typeof e.category === "string" &&
    typeof e.title === "string" &&
    typeof e.description === "string" &&
    typeof e.reliability === "number"
  );
}

/**
 * Cronologia Cognitiva locale (dominio operativo, separata dalla Memoria AI personale).
 * Funziona localmente anche con Memoria AI OFF, supporta consultazione, esportazione JSON
 * e cancellazione con conferma esplicita.
 */
export class CognitiveTimeline {
  private readonly adapter: StorageAdapter;

  constructor(storage?: MinimalWebStorage | StorageAdapter | null) {
    if (storage && "isAvailable" in storage) {
      this.adapter = storage;
    } else {
      const local = new LocalStorageAdapter(storage);
      this.adapter = local.isAvailable() ? local : new MemoryStorageAdapter();
    }
  }

  getEvents(): CognitiveTimelineEvent[] {
    const raw = this.adapter.getItem(COGNITIVE_TIMELINE_STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidTimelineEvent).slice(0, MAX_TIMELINE_EVENTS);
    } catch {
      return [];
    }
  }

  recordEvent(
    event: Omit<CognitiveTimelineEvent, "id" | "date"> & {
      id?: string;
      date?: string;
    }
  ): CognitiveTimelineEvent {
    const existing = this.getEvents();
    const entry: CognitiveTimelineEvent = {
      ...event,
      id:
        event.id ??
        `tl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: event.date ?? new Date().toISOString(),
      reliability: Math.max(0, Math.min(1, Number(event.reliability.toFixed(2)))),
    };

    const deduped = [entry, ...existing.filter((e) => e.id !== entry.id)].slice(
      0,
      MAX_TIMELINE_EVENTS
    );
    this.adapter.setItem(COGNITIVE_TIMELINE_STORAGE_KEY, JSON.stringify(deduped));
    return entry;
  }

  exportTimelineData(): CognitiveTimelineExport {
    const events = this.getEvents();
    return {
      exportType: "aura_cognitive_timeline",
      version: 1,
      exportedAt: new Date().toISOString(),
      totalEvents: events.length,
      events,
    };
  }

  exportTimelineJson(): string {
    return JSON.stringify(this.exportTimelineData(), null, 2);
  }

  clearTimeline(confirmed: boolean): boolean {
    if (!confirmed) return false;
    this.adapter.removeItem(COGNITIVE_TIMELINE_STORAGE_KEY);
    return true;
  }
}
