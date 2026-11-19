import {
  LocalStorageAdapter,
  MemoryStorageAdapter,
  type MinimalWebStorage,
} from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import { evaluateLearningSafety } from "./learningSafetyGuard";
import type {
  Confidence,
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
  LearningGuardDecision,
  LearningPayload,
} from "./selfLearningTypes";

export const KNOWLEDGE_EVOLUTION_STORAGE_KEY = "aura_knowledge_evolution_v1";

export type KnowledgeEntryStatus =
  | "proposed"
  | "validated"
  | "rejected"
  | "superseded"
  | "revoked"
  | "expired";

export type KnowledgeRevisionActor = "system_proposal" | "user_decision";

export interface KnowledgeRevision {
  version: number;
  timestamp: string;
  previousStatus: KnowledgeEntryStatus | "none";
  changeReason: string;
  actor: KnowledgeRevisionActor;
  snapshotTitle: string;
  snapshotContent: string;
}

export interface EvolvedKnowledgeEntry {
  id: string;
  version: number;
  status: KnowledgeEntryStatus;
  title: string;
  content: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  confidence: Confidence;
  dataSource: string;
  timestamp: string;
  lastVerifiedAt?: string;
  uncertaintyNote: string;
  expiresAt?: string;
  history: KnowledgeRevision[];
}

export interface ProposeKnowledgeInput {
  id?: string;
  title: string;
  content: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  confidence: Confidence;
  dataSource: string;
  uncertaintyNote: string;
  expiresAt?: string;
  targetSubsystem?: string;
  nowIso?: string;
}

export interface ReviseKnowledgeInput {
  title?: string;
  content?: string;
  uncertaintyNote?: string;
  expiresAt?: string;
  changeReason: string;
  actor?: KnowledgeRevisionActor;
  nowIso?: string;
}

export interface KnowledgeStoreOperationResult<T = EvolvedKnowledgeEntry> {
  allowed: boolean;
  reason: string;
  data?: T;
  guardDecision: LearningGuardDecision;
}

export interface KnowledgeEvolutionExport {
  exportType: "aura_knowledge_evolution";
  version: 1;
  exportedAt: string;
  totalEntries: number;
  entries: EvolvedKnowledgeEntry[];
}

const VALID_STATUSES = new Set<KnowledgeEntryStatus>([
  "proposed",
  "validated",
  "rejected",
  "superseded",
  "revoked",
  "expired",
]);

function generateKnowledgeId(): string {
  return `know-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidEntry(raw: unknown): raw is EvolvedKnowledgeEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.trim().length > 0 &&
    typeof e.version === "number" &&
    Number.isInteger(e.version) &&
    e.version >= 1 &&
    typeof e.status === "string" &&
    VALID_STATUSES.has(e.status as KnowledgeEntryStatus) &&
    typeof e.title === "string" &&
    typeof e.content === "string" &&
    typeof e.dataSource === "string" &&
    typeof e.timestamp === "string" &&
    typeof e.uncertaintyNote === "string" &&
    Array.isArray(e.history)
  );
}

function isEntryExpired(entry: EvolvedKnowledgeEntry, nowIso: string): boolean {
  if (entry.status === "expired") return true;
  if (!entry.expiresAt) return false;
  const expMs = Date.parse(entry.expiresAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(expMs) || Number.isNaN(nowMs)) return false;
  return expMs <= nowMs;
}

/**
 * Knowledge Evolution Store V1.
 * Base di conoscenza operativa locale ed evolutiva su storage dedicato `aura_knowledge_evolution_v1`.
 * - Separato da AuraMemoryStore, DataRepository, aura_adaptive_learning_v1 e AuthorizationLedger.
 * - Ogni proposta nasce con status = "proposed" e richiede approvazione esplicita dell'utente.
 * - Storico delle revisioni immutabile e append-only.
 */
export class KnowledgeEvolutionStore {
  private readonly adapter: StorageAdapter;

  constructor(storage?: MinimalWebStorage | StorageAdapter | null) {
    if (storage && "isAvailable" in storage) {
      this.adapter = storage;
    } else if (storage === null) {
      this.adapter = new MemoryStorageAdapter();
    } else {
      const local = new LocalStorageAdapter(storage);
      this.adapter = local.isAvailable() ? local : new MemoryStorageAdapter();
    }
  }

  private readAllRaw(): { ok: boolean; corrupted: boolean; entries: EvolvedKnowledgeEntry[] } {
    if (!this.adapter.isAvailable()) {
      return { ok: false, corrupted: false, entries: [] };
    }
    try {
      const raw = this.adapter.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY);
      if (!raw) return { ok: true, corrupted: false, entries: [] };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(isValidEntry)) {
        return { ok: false, corrupted: true, entries: [] };
      }
      return { ok: true, corrupted: false, entries: parsed };
    } catch {
      return { ok: false, corrupted: true, entries: [] };
    }
  }

  private writeAllRaw(entries: EvolvedKnowledgeEntry[]): boolean {
    try {
      this.adapter.setItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY, JSON.stringify(entries));
      return true;
    } catch {
      return false;
    }
  }

  proposeEntry(
    consentState: LearningConsentState,
    input: ProposeKnowledgeInput,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();

    const payload: LearningPayload = {
      stage: "proposal",
      evidenceType: input.evidenceType,
      epistemicTag: input.epistemicTag,
      confidence: input.confidence,
      dataSource: input.dataSource,
      timestamp: nowIso,
      uncertaintyNote: input.uncertaintyNote,
      summary: `${input.title}: ${input.content}`,
      targetSubsystem: input.targetSubsystem,
      userExplicitApproval: false,
    };

    const guardDecision = evaluateLearningSafety({
      operation: "propose",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload,
      nowIso,
    });

    if (!guardDecision.allowed || !guardDecision.sanitizedPayload) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    const cleanTitle = input.title.trim().slice(0, 120);
    const cleanContent = input.content.trim().slice(0, 320);
    const entry: EvolvedKnowledgeEntry = {
      id: input.id?.trim() || generateKnowledgeId(),
      version: 1,
      status: "proposed",
      title: cleanTitle,
      content: cleanContent,
      evidenceType: guardDecision.sanitizedPayload.evidenceType,
      epistemicTag: guardDecision.sanitizedPayload.epistemicTag,
      confidence: guardDecision.sanitizedPayload.confidence,
      dataSource: guardDecision.sanitizedPayload.dataSource,
      timestamp: nowIso,
      uncertaintyNote: guardDecision.sanitizedPayload.uncertaintyNote,
      expiresAt: input.expiresAt,
      history: [
        {
          version: 1,
          timestamp: nowIso,
          previousStatus: "none",
          changeReason: "Proposta iniziale creata in attesa di approvazione esplicita.",
          actor: "system_proposal",
          snapshotTitle: cleanTitle,
          snapshotContent: cleanContent,
        },
      ],
    };

    const next = [entry, ...loaded.entries.filter((e) => e.id !== entry.id)];
    if (!this.writeAllRaw(next)) {
      return {
        allowed: false,
        reason: "Errore nel salvataggio della proposta nello storage locale (fail-closed).",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "storage_unavailable",
        },
      };
    }

    return {
      allowed: true,
      reason: "Proposta operativa registrata con stato proposed.",
      data: entry,
      guardDecision,
    };
  }

  confirmEntry(
    consentState: LearningConsentState,
    id: string,
    explicitConfirmation: boolean,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();
    const target = loaded.entries.find((e) => e.id === id);

    const payload: LearningPayload | undefined = target
      ? {
          stage: "approval",
          evidenceType: explicitConfirmation ? "explicit_feedback" : target.evidenceType,
          epistemicTag: target.epistemicTag,
          confidence: target.confidence,
          dataSource: target.dataSource,
          timestamp: nowIso,
          uncertaintyNote: target.uncertaintyNote,
          summary: `${target.title}: ${target.content}`,
          userExplicitApproval: explicitConfirmation === true,
        }
      : undefined;

    const guardDecision = evaluateLearningSafety({
      operation: "approve",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    if (!target) {
      return {
        allowed: false,
        reason: "Voce di conoscenza non trovata.",
        guardDecision,
      };
    }

    if (target.status === "rejected") {
      return {
        allowed: false,
        reason: "Una voce rifiutata (rejected) non può essere riattivata automaticamente.",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
        },
      };
    }

    if (isEntryExpired(target, nowIso)) {
      return {
        allowed: false,
        reason: "Impossibile validare una voce scaduta.",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
        },
      };
    }

    const nextVersion = target.version + 1;
    const updated: EvolvedKnowledgeEntry = {
      ...target,
      version: nextVersion,
      status: "validated",
      lastVerifiedAt: nowIso,
      history: [
        ...target.history,
        {
          version: nextVersion,
          timestamp: nowIso,
          previousStatus: target.status,
          changeReason: "Approvazione esplicita dell'utente.",
          actor: "user_decision",
          snapshotTitle: target.title,
          snapshotContent: target.content,
        },
      ],
    };

    const next = loaded.entries.map((e) => (e.id === id ? updated : e));
    if (!this.writeAllRaw(next)) {
      return {
        allowed: false,
        reason: "Errore nel salvataggio della conferma nello storage locale.",
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "storage_unavailable",
        },
      };
    }

    return {
      allowed: true,
      reason: "Conoscenza operativa validata tramite conferma esplicita.",
      data: updated,
      guardDecision,
    };
  }

  rejectEntry(
    consentState: LearningConsentState,
    id: string,
    explicitRejection: boolean,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();
    const target = loaded.entries.find((e) => e.id === id);

    const guardDecision = evaluateLearningSafety({
      operation: "write",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload: target
        ? {
            stage: "approval",
            evidenceType: "explicit_feedback",
            epistemicTag: target.epistemicTag,
            confidence: target.confidence,
            dataSource: target.dataSource,
            timestamp: nowIso,
            uncertaintyNote: target.uncertaintyNote,
            summary: `Rifiuto esplicito: ${target.title}`,
          }
        : undefined,
      nowIso,
    });

    if (!guardDecision.allowed || !explicitRejection || !target) {
      return {
        allowed: false,
        reason: !explicitRejection
          ? "Il rifiuto richiede una decisione esplicita dell'utente."
          : guardDecision.reason,
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
        },
      };
    }

    const nextVersion = target.version + 1;
    const updated: EvolvedKnowledgeEntry = {
      ...target,
      version: nextVersion,
      status: "rejected",
      history: [
        ...target.history,
        {
          version: nextVersion,
          timestamp: nowIso,
          previousStatus: target.status,
          changeReason: "Rifiuto esplicito dell'utente.",
          actor: "user_decision",
          snapshotTitle: target.title,
          snapshotContent: target.content,
        },
      ],
    };

    const next = loaded.entries.map((e) => (e.id === id ? updated : e));
    this.writeAllRaw(next);

    return {
      allowed: true,
      reason: "Proposta rifiutata esplicitamente.",
      data: updated,
      guardDecision,
    };
  }

  listEntries(
    consentState: LearningConsentState,
    options?: {
      includeExpired?: boolean;
      statusFilter?: KnowledgeEntryStatus;
      crisisBlocked?: boolean;
      userTextForSafetyCheck?: string;
      nowIso?: string;
    }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry[]> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();

    const guardDecision = evaluateLearningSafety({
      operation: "read",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        data: [],
        guardDecision,
      };
    }

    const includeExpired = options?.includeExpired === true;
    const filtered = loaded.entries.filter((entry) => {
      if (!includeExpired && isEntryExpired(entry, nowIso)) return false;
      if (options?.statusFilter && entry.status !== options.statusFilter) return false;
      return true;
    });

    return {
      allowed: true,
      reason: "Elenco conoscenze recuperato in sola lettura.",
      data: filtered,
      guardDecision,
    };
  }

  getEntry(
    consentState: LearningConsentState,
    id: string,
    options?: {
      includeExpired?: boolean;
      crisisBlocked?: boolean;
      userTextForSafetyCheck?: string;
      nowIso?: string;
    }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry | undefined> {
    const listRes = this.listEntries(consentState, options);
    if (!listRes.allowed) {
      return {
        allowed: false,
        reason: listRes.reason,
        guardDecision: listRes.guardDecision,
      };
    }
    const found = (listRes.data ?? []).find((e) => e.id === id);
    return {
      allowed: true,
      reason: found ? "Voce trovata." : "Voce non trovata o scaduta.",
      data: found,
      guardDecision: listRes.guardDecision,
    };
  }

  reviseEntry(
    consentState: LearningConsentState,
    id: string,
    changes: ReviseKnowledgeInput,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry> {
    const nowIso = changes.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();
    const target = loaded.entries.find((e) => e.id === id);

    const newTitle = (changes.title ?? target?.title ?? "").trim().slice(0, 120);
    const newContent = (changes.content ?? target?.content ?? "").trim().slice(0, 320);
    const newUncertainty = (changes.uncertaintyNote ?? target?.uncertaintyNote ?? "").trim();

    const guardDecision = evaluateLearningSafety({
      operation: "write",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload: target
        ? {
            stage: "proposal",
            evidenceType: target.evidenceType,
            epistemicTag: target.epistemicTag,
            confidence: target.confidence,
            dataSource: target.dataSource,
            timestamp: nowIso,
            uncertaintyNote: newUncertainty,
            summary: `${newTitle}: ${newContent}`,
          }
        : undefined,
      nowIso,
    });

    if (!guardDecision.allowed || !target) {
      return {
        allowed: false,
        reason: !target ? "Voce da revisionare non trovata." : guardDecision.reason,
        guardDecision,
      };
    }

    const nextVersion = target.version + 1;
    const updated: EvolvedKnowledgeEntry = {
      ...target,
      version: nextVersion,
      status: "proposed",
      title: newTitle,
      content: newContent,
      uncertaintyNote: newUncertainty,
      expiresAt: changes.expiresAt ?? target.expiresAt,
      history: [
        ...target.history,
        {
          version: nextVersion,
          timestamp: nowIso,
          previousStatus: target.status,
          changeReason: changes.changeReason.trim() || "Revisione operativa.",
          actor: changes.actor ?? "user_decision",
          snapshotTitle: newTitle,
          snapshotContent: newContent,
        },
      ],
    };

    const next = loaded.entries.map((e) => (e.id === id ? updated : e));
    this.writeAllRaw(next);

    return {
      allowed: true,
      reason: "Nuova versione creata con storico immutabile preservato (richiede conferma per validazione).",
      data: updated,
      guardDecision,
    };
  }

  restoreValidatedRevision(
    consentState: LearningConsentState,
    id: string,
    targetVersion: number,
    explicitConfirmation: boolean,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): KnowledgeStoreOperationResult<EvolvedKnowledgeEntry> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();
    const target = loaded.entries.find((e) => e.id === id);
    const revision = target?.history.find((h) => h.version === targetVersion);

    const guardDecision = evaluateLearningSafety({
      operation: "approve",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload:
        target && revision
          ? {
              stage: "approval",
              evidenceType: "explicit_feedback",
              epistemicTag: target.epistemicTag,
              confidence: target.confidence,
              dataSource: target.dataSource,
              timestamp: nowIso,
              uncertaintyNote: target.uncertaintyNote,
              summary: `${revision.snapshotTitle}: ${revision.snapshotContent}`,
              userExplicitApproval: explicitConfirmation === true,
            }
          : undefined,
      nowIso,
    });

    if (!guardDecision.allowed || !target || !revision) {
      return {
        allowed: false,
        reason: !target || !revision ? "Revisione richiesta non trovata." : guardDecision.reason,
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
        },
      };
    }

    const nextVersion = target.version + 1;
    const restored: EvolvedKnowledgeEntry = {
      ...target,
      version: nextVersion,
      status: "validated",
      title: revision.snapshotTitle,
      content: revision.snapshotContent,
      lastVerifiedAt: nowIso,
      history: [
        ...target.history,
        {
          version: nextVersion,
          timestamp: nowIso,
          previousStatus: target.status,
          changeReason: `Ripristino confermato della revisione v${targetVersion}.`,
          actor: "user_decision",
          snapshotTitle: revision.snapshotTitle,
          snapshotContent: revision.snapshotContent,
        },
      ],
    };

    const next = loaded.entries.map((e) => (e.id === id ? restored : e));
    this.writeAllRaw(next);

    return {
      allowed: true,
      reason: `Revisione v${targetVersion} ripristinata come versione v${nextVersion} validata.`,
      data: restored,
      guardDecision,
    };
  }

  pruneStaleEntries(
    consentState: LearningConsentState,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): KnowledgeStoreOperationResult<{ prunedCount: number }> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();
    const loaded = this.readAllRaw();

    const guardDecision = evaluateLearningSafety({
      operation: "write",
      consentState,
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      corruptedDataDetected: loaded.corrupted,
      payload: {
        stage: "verification",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
        confidence: 1,
        dataSource: "KnowledgeEvolutionStore",
        timestamp: nowIso,
        uncertaintyNote: "Verifica scadenze temporali delle voci locali.",
        summary: "Manutenzione voci scadute",
      },
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        guardDecision,
      };
    }

    let prunedCount = 0;
    const updated = loaded.entries.map((entry) => {
      if (entry.status !== "expired" && isEntryExpired(entry, nowIso)) {
        prunedCount += 1;
        const nextVersion = entry.version + 1;
        return {
          ...entry,
          version: nextVersion,
          status: "expired" as const,
          history: [
            ...entry.history,
            {
              version: nextVersion,
              timestamp: nowIso,
              previousStatus: entry.status,
              changeReason: "Voce marcata come expired per raggiungimento expiresAt.",
              actor: "system_proposal" as const,
              snapshotTitle: entry.title,
              snapshotContent: entry.content,
            },
          ],
        };
      }
      return entry;
    });

    if (prunedCount > 0) {
      this.writeAllRaw(updated);
    }

    return {
      allowed: true,
      reason: `Verifica scadenze completata: ${prunedCount} voci marcate come expired.`,
      data: { prunedCount },
      guardDecision,
    };
  }

  exportJson(
    consentState: LearningConsentState,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): { allowed: boolean; json?: string; reason: string; guardDecision: LearningGuardDecision } {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const listRes = this.listEntries(consentState, {
      ...options,
      includeExpired: true,
      nowIso,
    });

    if (!listRes.allowed) {
      return {
        allowed: false,
        reason: listRes.reason,
        guardDecision: listRes.guardDecision,
      };
    }

    const entries = listRes.data ?? [];
    const payload: KnowledgeEvolutionExport = {
      exportType: "aura_knowledge_evolution",
      version: 1,
      exportedAt: nowIso,
      totalEntries: entries.length,
      entries,
    };

    return {
      allowed: true,
      json: JSON.stringify(payload, null, 2),
      reason: "Esportazione JSON della base di conoscenza completata.",
      guardDecision: listRes.guardDecision,
    };
  }

  clear(
    consentState: LearningConsentState,
    confirmed: boolean,
    options?: { crisisBlocked?: boolean; userTextForSafetyCheck?: string; nowIso?: string }
  ): KnowledgeStoreOperationResult<{ cleared: boolean }> {
    const nowIso = options?.nowIso ?? new Date().toISOString();
    const storageAvailable = this.adapter.isAvailable();

    const guardDecision = evaluateLearningSafety({
      operation: "clear",
      consentState: {
        ...consentState,
        explicitClearRequested: confirmed === true && consentState.explicitClearRequested !== false,
      },
      crisisBlocked: options?.crisisBlocked,
      userTextForSafetyCheck: options?.userTextForSafetyCheck,
      storageAvailable,
      nowIso,
    });

    if (!guardDecision.allowed) {
      return {
        allowed: false,
        reason: guardDecision.reason,
        data: { cleared: false },
        guardDecision,
      };
    }

    try {
      this.adapter.removeItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY);
      return {
        allowed: true,
        reason:
          "Base di conoscenza evolutiva cancellata con conferma esplicita (AI Memory e dati operativi intatti).",
        data: { cleared: true },
        guardDecision,
      };
    } catch {
      return {
        allowed: false,
        reason: "Errore nella cancellazione dello storage locale (fail-closed).",
        data: { cleared: false },
        guardDecision: {
          ...guardDecision,
          allowed: false,
          failClosed: true,
          blockedBy: "storage_unavailable",
        },
      };
    }
  }
}
