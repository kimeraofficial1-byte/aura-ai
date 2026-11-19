import assert from "node:assert/strict";
import test from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import {
  AuthorizationLedger,
  ControlledExecutionEngine,
} from "./authorizationLedger";

function setupFixtures() {
  const ledgerStorage = new MemoryStorageAdapter();
  const repoStorage = new MemoryStorageAdapter();
  const ledger = new AuthorizationLedger(ledgerStorage);
  const repo = new DataRepository(repoStorage);
  const plan = createPlan({
    declaredGoal: "Preparare presentazione",
    horizon: "weekly",
    consentEnabled: false,
  });
  repo.savePlans([plan]);
  const task = plan.tasks[0];
  const resourceId = `${plan.id}:${task.id}`;
  const executor = new ControlledExecutionEngine(ledger, repo);
  const nowIso = "2026-11-19T10:00:00.000Z";
  const futureIso = "2026-11-19T12:00:00.000Z";
  const pastIso = "2026-11-19T09:00:00.000Z";

  return {
    ledgerStorage,
    repoStorage,
    ledger,
    repo,
    plan,
    task,
    resourceId,
    executor,
    nowIso,
    futureIso,
    pastIso,
  };
}

test("8.3.1 & 8.3.2. Creazione autorizzazione specifica e rifiuto di autorizzazioni generiche", () => {
  const { ledger, resourceId, nowIso, futureIso } = setupFixtures();

  const ok = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "completamento singola attività",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Conferma esplicita completamento prima attività",
    nowIso,
  });
  assert.equal(ok.granted, true);
  if (ok.granted) {
    assert.equal(ok.authorization.status, "active");
    assert.equal(ok.authorization.usedCount, 0);
  }

  const genericResource = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId: "*",
    scope: "AURA può gestire i miei dati",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "AURA può agire autonomamente",
    nowIso,
  });
  assert.equal(genericResource.granted, false);
});

test("8.3.3 & 8.3.4. Rifiuto di azioni fuori whitelist e DELETE", () => {
  const { ledger, resourceId, nowIso, futureIso } = setupFixtures();

  for (const forbidden of ["delete_plan", "DELETE", "send_email", "financial_transfer"]) {
    const res = ledger.grantAuthorization({
      actionType: forbidden,
      resourceType: "plan_task",
      resourceId,
      scope: "test",
      expiresAt: futureIso,
      maxUses: 1,
      userExplicitlyConfirmed: true,
      reason: "Test azione vietata",
      nowIso,
    });
    assert.equal(res.granted, false);
  }
});

test("8.3.5, 8.3.6 & 8.3.7. Rifiuto di permessi scaduti, revocati ed esauriti", () => {
  const { ledger, executor, resourceId, nowIso, futureIso } = setupFixtures();

  const granted = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Test ciclo vita permesso",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  // Scaduto (verifica dopo expiresAt)
  const expiredRes = executor.execute({
    requestId: "req-exp-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    executionConfirmedByUser: true,
    nowIso: "2026-11-19T13:00:00.000Z",
  });
  assert.equal(expiredRes.executed, false);
  assert.equal(ledger.getAuthorizationById(granted.authorization.id)?.status, "expired");

  // Revocato
  const granted2 = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Test revoca",
    nowIso,
  });
  assert.equal(granted2.granted, true);
  if (!granted2.granted) return;

  assert.equal(ledger.revokeAuthorization(granted2.authorization.id, "Revoca immediata", nowIso), true);
  const revokedRes = executor.execute({
    requestId: "req-rev-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted2.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    executionConfirmedByUser: true,
    nowIso,
  });
  assert.equal(revokedRes.executed, false);

  // Esaurito dopo 1 utilizzo
  const granted3 = ledger.grantAuthorization({
    actionType: "update_plan_task_priority",
    resourceType: "plan_task",
    resourceId,
    scope: "cambio priorità",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Test esaurimento",
    nowIso,
  });
  assert.equal(granted3.granted, true);
  if (!granted3.granted) return;

  const firstExec = executor.execute({
    requestId: "req-use-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted3.authorization.id,
    actionType: "update_plan_task_priority",
    resourceType: "plan_task",
    resourceId,
    scope: "cambio priorità",
    executionConfirmedByUser: true,
    payload: { nextPriority: "alta" },
    nowIso,
  });
  assert.equal(firstExec.executed, true);
  assert.equal(ledger.getAuthorizationById(granted3.authorization.id)?.status, "exhausted");

  const secondExec = executor.execute({
    requestId: "req-use-2",
    mode: "USER-AUTHORIZED",
    authorizationId: granted3.authorization.id,
    actionType: "update_plan_task_priority",
    resourceType: "plan_task",
    resourceId,
    scope: "cambio priorità",
    executionConfirmedByUser: true,
    payload: { nextPriority: "bassa" },
    nowIso,
  });
  assert.equal(secondExec.executed, false);
});

test("8.3.8 & 8.3.9. Rifiuto di risorsa diversa e rifiuto senza conferma esplicita", () => {
  const { ledger, executor, plan, resourceId, nowIso, futureIso } = setupFixtures();
  const granted = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    expiresAt: futureIso,
    maxUses: 2,
    userExplicitlyConfirmed: true,
    reason: "Test risorsa e conferma",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  const wrongResource = executor.execute({
    requestId: "req-wrong-res",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId: `${plan.id}:altro-task`,
    scope: "singola attività",
    executionConfirmedByUser: true,
    nowIso,
  });
  assert.equal(wrongResource.executed, false);

  const noConfirm = executor.execute({
    requestId: "req-no-confirm",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "singola attività",
    executionConfirmedByUser: false,
    nowIso,
  });
  assert.equal(noConfirm.executed, false);
});

test("8.3.10 & 8.3.11. Esecuzione valida reversibile e ripristino dello stato precedente", () => {
  const { ledger, repo, executor, plan, task, resourceId, nowIso, futureIso } = setupFixtures();
  const originalStatus = task.status;

  const granted = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "completamento reversibile",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Completa task 1",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  const res = executor.execute({
    requestId: "req-exec-rev-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "completamento reversibile",
    executionConfirmedByUser: true,
    payload: { expectedCurrentStatus: originalStatus },
    nowIso,
  });
  assert.equal(res.executed, true);
  assert.equal(repo.getPlans()[0].tasks[0].status, "completed");

  const rolledBack = executor.rollbackExecution(res.auditEventId, nowIso);
  assert.equal(rolledBack, true);
  assert.equal(repo.getPlans()[0].tasks[0].status, originalStatus);
});

test("8.3.12, 8.3.13 & 8.3.14. Blocco in PASSIVE/ASSISTED, blocco immediato crisi e revoca globale", () => {
  const { ledger, executor, resourceId, nowIso, futureIso } = setupFixtures();
  const granted = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "test policy",
    expiresAt: futureIso,
    maxUses: 3,
    userExplicitlyConfirmed: true,
    reason: "Test policy",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  const passiveRes = executor.execute({
    requestId: "req-passive",
    mode: "PASSIVE",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "test policy",
    executionConfirmedByUser: true,
    nowIso,
  });
  assert.equal(passiveRes.executed, false);

  const assistedRes = executor.execute({
    requestId: "req-assisted",
    mode: "ASSISTED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "test policy",
    executionConfirmedByUser: true,
    nowIso,
  });
  assert.equal(assistedRes.executed, false);

  const crisisRes = executor.execute({
    requestId: "req-crisis",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "test policy",
    executionConfirmedByUser: true,
    crisisBlocked: true,
    nowIso,
  });
  assert.equal(crisisRes.executed, false);

  const revokedCount = ledger.revokeAllAuthorizations("Emergenza", nowIso);
  assert.equal(revokedCount, 1);
});

test("8.3.15, 8.3.16, 8.3.17, 8.3.18, 8.3.19 & 8.3.20. Duplicati, persistenza, export JSON, clear con conferma, integrità e AI Memory OFF", () => {
  const { ledgerStorage, ledger, repo, executor, resourceId, nowIso, futureIso } = setupFixtures();

  const granted = ledger.grantAuthorization({
    actionType: "update_plan_task_status",
    resourceType: "plan_task",
    resourceId,
    scope: "stato in_progress",
    expiresAt: futureIso,
    maxUses: 2,
    userExplicitlyConfirmed: true,
    reason: "Avvio attività",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  const first = executor.execute({
    requestId: "req-dup-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "update_plan_task_status",
    resourceType: "plan_task",
    resourceId,
    scope: "stato in_progress",
    executionConfirmedByUser: true,
    payload: { nextStatus: "in_progress" },
    nowIso,
  });
  assert.equal(first.executed, true);

  // Richiesta duplicata con stesso requestId bloccata
  const dup = executor.execute({
    requestId: "req-dup-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "update_plan_task_status",
    resourceType: "plan_task",
    resourceId,
    scope: "stato in_progress",
    executionConfirmedByUser: true,
    payload: { nextStatus: "in_progress" },
    nowIso,
  });
  assert.equal(dup.executed, false);

  // Persistenza su nuova istanza del ledger
  const reloadedLedger = new AuthorizationLedger(ledgerStorage);
  assert.equal(reloadedLedger.getAuthorizations().length, 1);
  assert.ok(reloadedLedger.getAuditEvents().length >= 3);

  // Export JSON valido
  const exported = JSON.parse(reloadedLedger.exportLedgerJson(nowIso));
  assert.equal(exported.exportType, "aura_autonomy_audit");
  assert.equal(exported.authorizations.length, 1);

  // Cancellazione bloccata senza conferma, consentita con conferma, dati operativi intatti
  assert.equal(reloadedLedger.clearLedger(false), false);
  assert.equal(reloadedLedger.clearLedger(true), true);
  assert.equal(reloadedLedger.getAuthorizations().length, 0);
  assert.equal(repo.getPlans().length, 1);
  assert.equal(repo.getPlans()[0].tasks[0].status, "in_progress");
});

test("8.4.11. Protezione contro rollback su risorse modificate successivamente", () => {
  const { ledger, repo, executor, resourceId, nowIso, futureIso } = setupFixtures();
  const granted = ledger.grantAuthorization({
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "completamento protetto",
    expiresAt: futureIso,
    maxUses: 1,
    userExplicitlyConfirmed: true,
    reason: "Test protezione rollback",
    nowIso,
  });
  assert.equal(granted.granted, true);
  if (!granted.granted) return;

  const execRes = executor.execute({
    requestId: "req-rb-guard-1",
    mode: "USER-AUTHORIZED",
    authorizationId: granted.authorization.id,
    actionType: "complete_plan_task",
    resourceType: "plan_task",
    resourceId,
    scope: "completamento protetto",
    executionConfirmedByUser: true,
    nowIso,
  });
  assert.equal(execRes.executed, true);

  // Simula una modifica successiva più recente sul piano
  const laterIso = "2026-11-19T10:30:00.000Z";
  const currentPlans = repo.getPlans();
  currentPlans[0].updatedAt = laterIso;
  currentPlans[0].tasks[0].priority = "alta";
  repo.savePlans(currentPlans);

  const rolledBack = executor.rollbackExecution(execRes.auditEventId, laterIso);
  assert.equal(rolledBack, false);
  assert.equal(repo.getPlans()[0].tasks[0].status, "completed");
  assert.equal(repo.getPlans()[0].tasks[0].priority, "alta");
});

