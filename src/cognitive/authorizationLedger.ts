import type { DataRepository } from "../persistence/dataManagement";
import {
  LocalStorageAdapter,
  MemoryStorageAdapter,
} from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import type { TaskPriority, TaskStatus } from "../planning/types";
import type { ProactiveMode } from "../proactive/types";
import { evaluateCognitiveSafety } from "./cognitiveCoordinator";

export const AUTHORIZATION_LEDGER_STORAGE_KEY = "aura_autonomy_audit_v1";

export const WHITELISTED_ACTIONS = [
  "update_plan_task_status",
  "complete_plan_task",
  "update_plan_task_priority",
] as const;

export type WhitelistedActionType = (typeof WHITELISTED_ACTIONS)[number];

export type AuthorizationStatus = "active" | "revoked" | "expired" | "exhausted";

export type AuthorizedResourceType = "plan_task";

export interface GranularAuthorization {
  id: string;
  actionType: WhitelistedActionType;
  resourceType: AuthorizedResourceType;
  resourceId: string; // formato: "<planId>:<taskId>"
  scope: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  status: AuthorizationStatus;
  userExplicitlyConfirmed: boolean;
  reason: string;
}

export type AuditEventType =
  | "authorization_granted"
  | "authorization_rejected"
  | "authorization_revoked"
  | "execution_succeeded"
  | "execution_blocked"
  | "execution_error"
  | "rollback_succeeded";

export interface RollbackSnapshot {
  planId: string;
  taskId: string;
  previousStatus: TaskStatus;
  previousPriority: TaskPriority;
  previousCompletedAt?: string;
}

export interface AuthorizationAuditEvent {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  authorizationId?: string;
  actionType: string;
  resourceId?: string;
  outcome: "allowed" | "blocked" | "revoked" | "error" | "rolled_back";
  detail: string;
  rollbackSnapshot?: RollbackSnapshot;
}

export interface AuthorizationLedgerExport {
  exportType: "aura_autonomy_audit";
  version: 1;
  exportedAt: string;
  authorizations: GranularAuthorization[];
  events: AuthorizationAuditEvent[];
}

export interface GrantAuthorizationInput {
  actionType: string;
  resourceType: AuthorizedResourceType;
  resourceId: string;
  scope: string;
  expiresAt: string;
  maxUses: number;
  userExplicitlyConfirmed: boolean;
  reason: string;
  nowIso?: string;
}

export interface ControlledExecutionRequest {
  requestId: string;
  mode: ProactiveMode;
  authorizationId: string;
  actionType: string;
  resourceType: AuthorizedResourceType;
  resourceId: string; // "<planId>:<taskId>"
  scope: string;
  executionConfirmedByUser: boolean;
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  nowIso?: string;
  payload?: {
    nextStatus?: TaskStatus;
    nextPriority?: TaskPriority;
    expectedCurrentStatus?: TaskStatus;
    expectedCurrentPriority?: TaskPriority;
  };
}

export interface ControlledExecutionResult {
  executed: boolean;
  status: "executed" | "blocked" | "error";
  reason: string;
  auditEventId: string;
  rollbackSnapshot?: RollbackSnapshot;
}

const GENERIC_PATTERNS = [
  /^\*$/,
  /^all$/i,
  /^tutti$/i,
  /^any$/i,
  /gestire i miei dati/i,
  /agire autonomamente/i,
  /modificare tutti/i,
  /accesso completo/i,
  /permesso generale/i,
];

const MAX_PERMISSION_DURATION_MS = 7 * 24 * 3600_000; // 7 giorni max, nessuna autorizzazione permanente
const MAX_USES_LIMIT = 5;

function createDefaultStorage(): StorageAdapter {
  if (typeof window !== "undefined" && window.localStorage) {
    return new LocalStorageAdapter(window.localStorage);
  }
  return new MemoryStorageAdapter();
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isWhitelistedAction(actionType: string): actionType is WhitelistedActionType {
  return (WHITELISTED_ACTIONS as readonly string[]).includes(actionType);
}

function isGenericOrInvalidText(value: string): boolean {
  const clean = value.trim();
  if (!clean) return true;
  return GENERIC_PATTERNS.some((rx) => rx.test(clean));
}

function parsePlanTaskResourceId(resourceId: string): { planId: string; taskId: string } | null {
  const parts = resourceId.split(":");
  if (parts.length !== 2) return null;
  const [planId, taskId] = parts.map((p) => p.trim());
  if (!planId || !taskId || isGenericOrInvalidText(planId) || isGenericOrInvalidText(taskId)) {
    return null;
  }
  return { planId, taskId };
}

interface StoredLedgerState {
  version: 1;
  authorizations: GranularAuthorization[];
  events: AuthorizationAuditEvent[];
}

export class AuthorizationLedger {
  private readonly storage: StorageAdapter;
  private readonly storageKey: string;

  constructor(
    storage: StorageAdapter = createDefaultStorage(),
    storageKey: string = AUTHORIZATION_LEDGER_STORAGE_KEY
  ) {
    this.storage = storage;
    this.storageKey = storageKey;
  }

  private loadState(): StoredLedgerState {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return { version: 1, authorizations: [], events: [] };
      const parsed = JSON.parse(raw) as Partial<StoredLedgerState>;
      return {
        version: 1,
        authorizations: Array.isArray(parsed.authorizations) ? parsed.authorizations : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return { version: 1, authorizations: [], events: [] };
    }
  }

  private saveState(state: StoredLedgerState): void {
    this.storage.setItem(this.storageKey, JSON.stringify(state));
  }

  recordAuditEvent(
    event: Omit<AuthorizationAuditEvent, "id" | "timestamp">,
    nowIso?: string
  ): AuthorizationAuditEvent {
    const state = this.loadState();
    const created: AuthorizationAuditEvent = {
      ...event,
      id: generateId("audit"),
      timestamp: nowIso ?? new Date().toISOString(),
    };
    state.events.unshift(created);
    this.saveState(state);
    return created;
  }

  grantAuthorization(
    input: GrantAuthorizationInput
  ): { granted: true; authorization: GranularAuthorization } | { granted: false; reason: string } {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);

    const reject = (reason: string) => {
      this.recordAuditEvent(
        {
          eventType: "authorization_rejected",
          actionType: input.actionType,
          resourceId: input.resourceId,
          outcome: "blocked",
          detail: reason,
        },
        nowIso
      );
      return { granted: false as const, reason };
    };

    if (!input.userExplicitlyConfirmed) {
      return reject("Conferma esplicita dell'utente obbligatoria per creare un'autorizzazione.");
    }
    if (!isWhitelistedAction(input.actionType)) {
      return reject(`Azione "${input.actionType}" non presente nella whitelist reversibile.`);
    }
    if (input.resourceType !== "plan_task") {
      return reject(`Tipo di risorsa "${input.resourceType}" non supportato.`);
    }
    if (!parsePlanTaskResourceId(input.resourceId)) {
      return reject(
        "Risorsa non valida o generica: è richiesto un identificativo specifico '<planId>:<taskId>'."
      );
    }
    if (isGenericOrInvalidText(input.scope) || isGenericOrInvalidText(input.reason)) {
      return reject("Ambito o motivazione generici o mancanti: autorizzazioni generiche vietate.");
    }

    const expiresMs = Date.parse(input.expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
      return reject("Scadenza non valida o già trascorsa.");
    }
    if (expiresMs - nowMs > MAX_PERMISSION_DURATION_MS) {
      return reject("Durata eccessiva: non sono ammesse autorizzazioni permanenti o oltre 7 giorni.");
    }
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > MAX_USES_LIMIT) {
      return reject(`Numero massimo di utilizzi non valido (consentito 1..${MAX_USES_LIMIT}).`);
    }

    const state = this.loadState();
    const authorization: GranularAuthorization = {
      id: generateId("auth"),
      actionType: input.actionType,
      resourceType: input.resourceType,
      resourceId: input.resourceId.trim(),
      scope: input.scope.trim(),
      createdAt: nowIso,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses,
      usedCount: 0,
      status: "active",
      userExplicitlyConfirmed: true,
      reason: input.reason.trim(),
    };

    state.authorizations.unshift(authorization);
    state.events.unshift({
      id: generateId("audit"),
      timestamp: nowIso,
      eventType: "authorization_granted",
      authorizationId: authorization.id,
      actionType: authorization.actionType,
      resourceId: authorization.resourceId,
      outcome: "allowed",
      detail: `Autorizzazione concessa (${authorization.scope}, max ${authorization.maxUses} utilizzi).`,
    });
    this.saveState(state);

    return { granted: true, authorization };
  }

  revokeAuthorization(authorizationId: string, reason = "Revoca manuale utente", nowIso?: string): boolean {
    const state = this.loadState();
    const target = state.authorizations.find((a) => a.id === authorizationId);
    if (!target) return false;

    target.status = "revoked";
    state.events.unshift({
      id: generateId("audit"),
      timestamp: nowIso ?? new Date().toISOString(),
      eventType: "authorization_revoked",
      authorizationId: target.id,
      actionType: target.actionType,
      resourceId: target.resourceId,
      outcome: "revoked",
      detail: reason,
    });
    this.saveState(state);
    return true;
  }

  revokeAllAuthorizations(reason = "Revoca globale utente", nowIso?: string): number {
    const state = this.loadState();
    const ts = nowIso ?? new Date().toISOString();
    let count = 0;
    for (const auth of state.authorizations) {
      if (auth.status === "active") {
        auth.status = "revoked";
        count += 1;
      }
    }
    state.events.unshift({
      id: generateId("audit"),
      timestamp: ts,
      eventType: "authorization_revoked",
      actionType: "revoke_all",
      outcome: "revoked",
      detail: `${reason} (${count} permessi attivi revocati).`,
    });
    this.saveState(state);
    return count;
  }

  updateAuthorizationState(
    authorizationId: string,
    updater: (auth: GranularAuthorization) => void
  ): GranularAuthorization | null {
    const state = this.loadState();
    const target = state.authorizations.find((a) => a.id === authorizationId);
    if (!target) return null;
    updater(target);
    this.saveState(state);
    return target;
  }

  getAuthorizations(): GranularAuthorization[] {
    return this.loadState().authorizations;
  }

  getAuthorizationById(id: string): GranularAuthorization | undefined {
    return this.loadState().authorizations.find((a) => a.id === id);
  }

  getAuditEvents(): AuthorizationAuditEvent[] {
    return this.loadState().events;
  }

  exportLedgerData(nowIso?: string): AuthorizationLedgerExport {
    const state = this.loadState();
    return {
      exportType: "aura_autonomy_audit",
      version: 1,
      exportedAt: nowIso ?? new Date().toISOString(),
      authorizations: state.authorizations,
      events: state.events,
    };
  }

  exportLedgerJson(nowIso?: string): string {
    return JSON.stringify(this.exportLedgerData(nowIso), null, 2);
  }

  clearLedger(confirmed: boolean): boolean {
    if (!confirmed) return false;
    this.storage.removeItem(this.storageKey);
    return true;
  }
}

export class ControlledExecutionEngine {
  private readonly ledger: AuthorizationLedger;
  private readonly repository: DataRepository;
  private readonly processedRequestIds = new Set<string>();
  private readonly inFlightLocks = new Set<string>();

  constructor(ledger: AuthorizationLedger, repository: DataRepository) {
    this.ledger = ledger;
    this.repository = repository;
  }

  execute(request: ControlledExecutionRequest): ControlledExecutionResult {
    const nowIso = request.nowIso ?? new Date().toISOString();
    const nowMs = Date.parse(nowIso);
    const lockKey = `${request.authorizationId}:${request.resourceId}`;

    const block = (reason: string): ControlledExecutionResult => {
      const ev = this.ledger.recordAuditEvent(
        {
          eventType: "execution_blocked",
          authorizationId: request.authorizationId,
          actionType: request.actionType,
          resourceId: request.resourceId,
          outcome: "blocked",
          detail: reason,
        },
        nowIso
      );
      return { executed: false, status: "blocked", reason, auditEventId: ev.id };
    };

    // Protezione duplicati e concorrenza
    if (!request.requestId.trim() || this.processedRequestIds.has(request.requestId)) {
      return block("Richiesta duplicata o priva di identificativo univoco.");
    }
    if (this.inFlightLocks.has(lockKey)) {
      return block("Esecuzione concorrente già in corso sulla stessa risorsa/autorizzazione.");
    }

    this.inFlightLocks.add(lockKey);
    try {
      // 2. Safety Gate prioritario
      const safetyCheck = request.userTextForSafetyCheck
        ? evaluateCognitiveSafety(request.userTextForSafetyCheck)
        : { safe: true, crisisDetected: false };
      if (request.crisisBlocked || !safetyCheck.safe || safetyCheck.crisisDetected) {
        return block("Bloccato dal Safety System per priorità assoluta di sicurezza.");
      }

      // 3. Verifica modalità autonomia
      if (request.mode !== "USER-AUTHORIZED") {
        return block(
          `Modalità ${request.mode}: nessuna esecuzione consentita (richiesta modalità USER-AUTHORIZED con permesso specifico).`
        );
      }

      // 4. Verifica whitelist
      if (!isWhitelistedAction(request.actionType)) {
        return block(`Azione "${request.actionType}" non autorizzabile (fuori whitelist).`);
      }

      // 5. Verifica autorizzazione dal ledger locale (mai da un booleano esterno)
      const auth = this.ledger.getAuthorizationById(request.authorizationId);
      if (!auth) {
        return block("Autorizzazione non trovata nel ledger locale.");
      }
      if (auth.actionType !== request.actionType) {
        return block("Tipo di azione non corrispondente all'autorizzazione nel ledger.");
      }
      if (auth.resourceType !== request.resourceType || auth.resourceId !== request.resourceId) {
        return block("Risorsa richiesta diversa da quella autorizzata nel ledger.");
      }
      if (auth.scope !== request.scope.trim()) {
        return block("Ambito dell'operazione non corrispondente al permesso autorizzato.");
      }

      // 6. Verifica stato attivo e scadenza automatica
      if (auth.status === "revoked") {
        return block("Autorizzazione revocata: esecuzione vietata.");
      }
      if (Date.parse(auth.expiresAt) <= nowMs) {
        this.ledger.updateAuthorizationState(auth.id, (a) => {
          a.status = "expired";
        });
        return block("Autorizzazione scaduta.");
      }
      if (auth.status !== "active") {
        return block(`Autorizzazione non attiva (stato: ${auth.status}).`);
      }

      // 7. Verifica utilizzi residui
      if (auth.usedCount >= auth.maxUses) {
        this.ledger.updateAuthorizationState(auth.id, (a) => {
          a.status = "exhausted";
        });
        return block("Autorizzazione esaurita (limite utilizzi raggiunto).");
      }

      // 8. Conferma esplicita per questa esecuzione
      if (!auth.userExplicitlyConfirmed || !request.executionConfirmedByUser) {
        return block("Conferma esplicita dell'utente mancante per questa specifica esecuzione.");
      }

      // 9. Verifica stato risorsa in DataRepository
      const parsed = parsePlanTaskResourceId(request.resourceId);
      if (!parsed) {
        return block("Identificativo risorsa non valido.");
      }

      const plans = this.repository.getPlans();
      const planIdx = plans.findIndex((p) => p.id === parsed.planId);
      if (planIdx === -1) {
        return block("Piano non trovato in DataRepository.");
      }
      const plan = plans[planIdx];
      const taskIdx = plan.tasks.findIndex((t) => t.id === parsed.taskId);
      if (taskIdx === -1) {
        return block("Attività non trovata nel piano specificato.");
      }
      const task = plan.tasks[taskIdx];

      if (
        request.payload?.expectedCurrentStatus &&
        task.status !== request.payload.expectedCurrentStatus
      ) {
        return block("Stato attuale dell'attività cambiato in modo incompatibile dall'autorizzazione.");
      }
      if (
        request.payload?.expectedCurrentPriority &&
        task.priority !== request.payload.expectedCurrentPriority
      ) {
        return block("Priorità attuale dell'attività cambiata in modo incompatibile dall'autorizzazione.");
      }

      // Snapshot per reversibilità garantita
      const rollbackSnapshot: RollbackSnapshot = {
        planId: plan.id,
        taskId: task.id,
        previousStatus: task.status,
        previousPriority: task.priority,
        previousCompletedAt: task.completedAt,
      };

      // 10. Esecuzione controllata dell'unica azione autorizzata
      const updatedTask = { ...task };
      if (request.actionType === "complete_plan_task") {
        updatedTask.status = "completed";
        updatedTask.completedAt = nowIso;
      } else if (request.actionType === "update_plan_task_status") {
        if (!request.payload?.nextStatus) {
          return block("Nuovo stato attività mancante nel payload.");
        }
        updatedTask.status = request.payload.nextStatus;
        if (request.payload.nextStatus === "completed") {
          updatedTask.completedAt = nowIso;
        }
      } else if (request.actionType === "update_plan_task_priority") {
        if (!request.payload?.nextPriority) {
          return block("Nuova priorità attività mancante nel payload.");
        }
        updatedTask.priority = request.payload.nextPriority;
      }

      const updatedPlans = plans.map((p, idx) =>
        idx === planIdx
          ? {
              ...p,
              updatedAt: nowIso,
              tasks: p.tasks.map((t, tIdx) => (tIdx === taskIdx ? updatedTask : t)),
            }
          : p
      );
      this.repository.savePlans(updatedPlans);

      // 11. Verifica post-condizione
      const verifiedPlan = this.repository.getPlans().find((p) => p.id === parsed.planId);
      const verifiedTask = verifiedPlan?.tasks.find((t) => t.id === parsed.taskId);
      if (!verifiedTask) {
        throw new Error("Verifica post-esecuzione fallita.");
      }

      // 12. Aggiornamento utilizzi e audit log
      this.processedRequestIds.add(request.requestId);
      this.ledger.updateAuthorizationState(auth.id, (a) => {
        a.usedCount += 1;
        if (a.usedCount >= a.maxUses) {
          a.status = "exhausted";
        }
      });

      const auditEvent = this.ledger.recordAuditEvent(
        {
          eventType: "execution_succeeded",
          authorizationId: auth.id,
          actionType: request.actionType,
          resourceId: request.resourceId,
          outcome: "allowed",
          detail: `Azione reversibile "${request.actionType}" eseguita su ${request.resourceId}.`,
          rollbackSnapshot,
        },
        nowIso
      );

      return {
        executed: true,
        status: "executed",
        reason: "Operazione autorizzata eseguita e verificata con snapshot di ripristino.",
        auditEventId: auditEvent.id,
        rollbackSnapshot,
      };
    } catch (err) {
      // Fail-closed
      const ev = this.ledger.recordAuditEvent(
        {
          eventType: "execution_error",
          authorizationId: request.authorizationId,
          actionType: request.actionType,
          resourceId: request.resourceId,
          outcome: "error",
          detail: `Fail-closed: ${err instanceof Error ? err.message : "errore sconosciuto"}`,
        },
        nowIso
      );
      return {
        executed: false,
        status: "error",
        reason: "Esecuzione interrotta (fail-closed) per errore interno.",
        auditEventId: ev.id,
      };
    } finally {
      this.inFlightLocks.delete(lockKey);
    }
  }

  rollbackExecution(auditEventId: string, nowIso?: string): boolean {
    const event = this.ledger.getAuditEvents().find((e) => e.id === auditEventId);
    if (!event?.rollbackSnapshot) return false;

    const snap = event.rollbackSnapshot;
    const plans = this.repository.getPlans();
    const planIdx = plans.findIndex((p) => p.id === snap.planId);
    if (planIdx === -1) return false;

    const targetPlan = plans[planIdx];
    const eventMs = Date.parse(event.timestamp);
    const planUpdatedMs = Date.parse(targetPlan.updatedAt);
    if (!Number.isNaN(eventMs) && !Number.isNaN(planUpdatedMs) && planUpdatedMs > eventMs) {
      this.ledger.recordAuditEvent(
        {
          eventType: "execution_blocked",
          authorizationId: event.authorizationId,
          actionType: event.actionType,
          resourceId: event.resourceId,
          outcome: "blocked",
          detail: "Rollback bloccato: la risorsa è stata modificata successivamente all'esecuzione.",
        },
        nowIso
      );
      return false;
    }

    const updatedPlans = plans.map((p, idx) =>
      idx === planIdx
        ? {
            ...p,
            updatedAt: nowIso ?? new Date().toISOString(),
            tasks: p.tasks.map((t) =>
              t.id === snap.taskId
                ? {
                    ...t,
                    status: snap.previousStatus,
                    priority: snap.previousPriority,
                    completedAt: snap.previousCompletedAt,
                  }
                : t
            ),
          }
        : p
    );
    this.repository.savePlans(updatedPlans);

    this.ledger.recordAuditEvent(
      {
        eventType: "rollback_succeeded",
        authorizationId: event.authorizationId,
        actionType: event.actionType,
        resourceId: event.resourceId,
        outcome: "rolled_back",
        detail: `Stato precedente ripristinato per ${snap.planId}:${snap.taskId}.`,
      },
      nowIso
    );
    return true;
  }
}
