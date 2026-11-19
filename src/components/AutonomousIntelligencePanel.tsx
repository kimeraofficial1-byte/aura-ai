import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Download,
  History,
  Lock,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import { DataRepository } from "../persistence/dataManagement";
import type { PersonalPlan, TaskPriority, TaskStatus } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { ProactiveMode } from "../proactive/types";
import {
  AuthorizationLedger,
  ControlledExecutionEngine,
  type GranularAuthorization,
  type WhitelistedActionType,
} from "../cognitive/authorizationLedger";
import { runAutonomousCognitiveCycle } from "../cognitive/autonomousIntelligenceEngine";

interface AutonomousIntelligencePanelProps {
  mode: ProactiveMode;
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  consent: boolean;
  crisisBlocked: boolean;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  learningEngine: ControlledLearningEngine;
}

const MODE_DESCRIPTIONS: Record<ProactiveMode, { can: string; cannot: string }> = {
  PASSIVE: {
    can: "Sintetizza localmente obiettivi, progressi, difficoltà e incertezze.",
    cannot: "Non propone esecuzioni e non modifica alcun dato.",
  },
  ASSISTED: {
    can: "Syntetizza la situazione e confronta strategie alternative (STANDARD, LIGHT, DEFERRED).",
    cannot: "Non esegue alcuna modifica automatica: ogni decisione resta a te.",
  },
  "USER-AUTHORIZED": {
    can: "Può eseguire esclusivamente le 3 azioni reversibili in whitelist su singole attività, solo con permesso attivo nel ledger e doppia conferma esplicita.",
    cannot: "Non può cancellare dati, inviare messaggi, usare permessi generici o agire in caso di crisi.",
  },
};

const ACTION_LABELS: Record<WhitelistedActionType, { label: string; property: string; valueLabel: string }> = {
  complete_plan_task: {
    label: "Segna attività come completata",
    property: "status",
    valueLabel: "completed",
  },
  update_plan_task_status: {
    label: "Aggiorna stato attività",
    property: "status",
    valueLabel: "in_progress",
  },
  update_plan_task_priority: {
    label: "Aggiorna priorità attività",
    property: "priority",
    valueLabel: "alta",
  },
};

export function AutonomousIntelligencePanel({
  mode,
  plans,
  missions,
  growthGoals,
  consent,
  crisisBlocked,
  availableMinutes = 20,
  energyLevel = "media",
  learningEngine,
}: AutonomousIntelligencePanelProps) {
  const repository = useMemo(() => new DataRepository(), []);
  const ledger = useMemo(() => new AuthorizationLedger(), []);
  const executor = useMemo(() => new ControlledExecutionEngine(ledger, repository), [ledger, repository]);

  const [version, setVersion] = useState(0);
  const [selectedAction, setSelectedAction] = useState<WhitelistedActionType>("complete_plan_task");
  const [selectedTaskKey, setSelectedTaskKey] = useState<string>("");
  const [nextStatusValue, setNextStatusValue] = useState<TaskStatus>("in_progress");
  const [nextPriorityValue, setNextPriorityValue] = useState<TaskPriority>("alta");
  const [durationHours, setDurationHours] = useState<number>(2);
  const [maxUses, setMaxUses] = useState<number>(1);
  const [grantStepConfirm, setGrantStepConfirm] = useState<boolean>(false);

  const [pendingExecutionAuth, setPendingExecutionAuth] = useState<GranularAuthorization | null>(null);
  const [clearStep, setClearStep] = useState<0 | 1 | 2>(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const cycle = useMemo(
    () =>
      runAutonomousCognitiveCycle({
        mode,
        plans,
        missions,
        growthGoals,
        consentEnabled: consent,
        crisisBlocked,
        availableMinutes,
        energyLevel,
        learningEngine,
      }),
    [mode, plans, missions, growthGoals, consent, crisisBlocked, availableMinutes, energyLevel, learningEngine]
  );

  const taskOptions = useMemo(() => {
    const items: Array<{ key: string; label: string; status: TaskStatus; priority: TaskPriority }> = [];
    for (const plan of plans) {
      for (const task of plan.tasks) {
        items.push({
          key: `${plan.id}:${task.id}`,
          label: `${plan.title} → ${task.title}`,
          status: task.status,
          priority: task.priority,
        });
      }
    }
    return items;
  }, [plans]);

  const effectiveTaskKey = selectedTaskKey || taskOptions[0]?.key || "";
  const selectedTaskInfo = taskOptions.find((t) => t.key === effectiveTaskKey);

  const authorizations = useMemo(() => ledger.getAuthorizations(), [ledger, version]);
  const auditEvents = useMemo(() => ledger.getAuditEvents(), [ledger, version]);

  function getTargetValueLabel(): string {
    if (selectedAction === "complete_plan_task") return "completed";
    if (selectedAction === "update_plan_task_status") return nextStatusValue;
    return nextPriorityValue;
  }

  function handleConfirmGrantAuthorization() {
    setErrorNotice(null);
    setNotice(null);
    if (!effectiveTaskKey) {
      setErrorNotice("Seleziona una singola attività specifica prima di creare un'autorizzazione.");
      return;
    }
    const expiresAt = new Date(Date.now() + durationHours * 3600_000).toISOString();
    const res = ledger.grantAuthorization({
      actionType: selectedAction,
      resourceType: "plan_task",
      resourceId: effectiveTaskKey,
      scope: `${ACTION_LABELS[selectedAction].property}=${getTargetValueLabel()}`,
      expiresAt,
      maxUses,
      userExplicitlyConfirmed: true,
      reason: `Autorizzazione esplicita per ${selectedTaskInfo?.label ?? effectiveTaskKey}`,
    });
    if (!res.granted) {
      setErrorNotice(res.reason);
      return;
    }
    setGrantStepConfirm(false);
    setVersion((v) => v + 1);
    setNotice(
      `Autorizzazione specifica creata (${ACTION_LABELS[selectedAction].label}, scadenza ${durationHours}h, max ${maxUses} utilizzi).`
    );
  }

  function handleConfirmExecute(auth: GranularAuthorization) {
    setErrorNotice(null);
    setNotice(null);

    const payload: { nextStatus?: TaskStatus; nextPriority?: TaskPriority } = {};
    if (auth.actionType === "update_plan_task_status") {
      payload.nextStatus = (auth.scope.split("=")[1] as TaskStatus) || nextStatusValue;
    } else if (auth.actionType === "update_plan_task_priority") {
      payload.nextPriority = (auth.scope.split("=")[1] as TaskPriority) || nextPriorityValue;
    }

    const res = executor.execute({
      requestId: `ui-exec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      mode,
      authorizationId: auth.id,
      actionType: auth.actionType,
      resourceType: auth.resourceType,
      resourceId: auth.resourceId,
      scope: auth.scope,
      executionConfirmedByUser: true,
      crisisBlocked,
      payload,
    });

    setPendingExecutionAuth(null);
    setVersion((v) => v + 1);

    if (!res.executed) {
      setErrorNotice(res.reason);
      return;
    }
    setNotice(res.reason);
  }

  function handleRevokeOne(authId: string) {
    setErrorNotice(null);
    ledger.revokeAuthorization(authId, "Revoca immediata da interfaccia Android");
    if (pendingExecutionAuth?.id === authId) {
      setPendingExecutionAuth(null);
    }
    setVersion((v) => v + 1);
    setNotice("Autorizzazione revocata immediatamente.");
  }

  function handleRevokeAll() {
    setErrorNotice(null);
    const count = ledger.revokeAllAuthorizations("Revoca globale immediata utente");
    setPendingExecutionAuth(null);
    setVersion((v) => v + 1);
    setNotice(`Revocate immediatamente ${count} autorizzazioni attive.`);
  }

  function handleRollback(auditEventId: string) {
    setErrorNotice(null);
    const ok = executor.rollbackExecution(auditEventId);
    setVersion((v) => v + 1);
    if (!ok) {
      setErrorNotice(
        "Rollback bloccato: la risorsa non è ripristinabile o è stata modificata successivamente."
      );
      return;
    }
    setNotice("Stato precedente ripristinato correttamente.");
  }

  function handleExportLedger() {
    const json = ledger.exportLedgerJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aura-autonomy-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice("Registro autorizzazioni esportato in JSON.");
  }

  function handleFinalClearLedger() {
    ledger.clearLedger(true);
    setClearStep(0);
    setPendingExecutionAuth(null);
    setVersion((v) => v + 1);
    setNotice(
      "Registro AuthorizationLedger cancellato. Piani, missioni, obiettivi, AI Memory e CognitiveTimeline sono rimasti intatti."
    );
  }

  const modeInfo = MODE_DESCRIPTIONS[mode];

  return (
    <div className="panel aura-autonomy-panel" aria-label="Autonomous Cognitive Intelligence V1">
      <div className="panel-head">
        <div>
          <span className="eyebrow">AUTONOMOUS COGNITIVE INTELLIGENCE V1</span>
          <h2>Sintesi autonoma, strategie e autorizzazioni</h2>
        </div>
        <span className="panel-icon">
          <Cpu size={18} />
        </span>
      </div>

      {cycle.safetyBlocked && (
        <div className="aura-autonomy-alert aura-autonomy-alert--error" role="alert">
          <ShieldAlert size={16} />
          <span>{cycle.safetyReason ?? cycle.statusMessage}</span>
        </div>
      )}

      {notice && (
        <div className="aura-autonomy-alert aura-autonomy-alert--info" role="status">
          <ShieldCheck size={16} />
          <span>{notice}</span>
        </div>
      )}

      {errorNotice && (
        <div className="aura-autonomy-alert aura-autonomy-alert--error" role="alert">
          <AlertTriangle size={16} />
          <span>{errorNotice}</span>
        </div>
      )}

      {/* C. STATO DI AUTONOMIA */}
      <div className="aura-autonomy-section">
        <div className="aura-autonomy-section-head">
          <Lock size={15} />
          <strong>Stato di autonomia: {mode}</strong>
        </div>
        <p className="aura-autonomy-text">
          <strong>Cosa può fare AURA:</strong> {modeInfo.can}
        </p>
        <p className="aura-autonomy-text">
          <strong>Cosa NON può fare AURA:</strong> {modeInfo.cannot}
        </p>
        <p className="aura-autonomy-meta">
          Memoria AI: {consent ? "ON" : "OFF (registro autorizzazioni indipendente)"} · Nessuna attività nascosta in background.
        </p>
      </div>

      {/* A. SITUAZIONE ATTUALE */}
      <div className="aura-autonomy-section">
        <div className="aura-autonomy-section-head">
          <ShieldCheck size={15} />
          <strong>A. Situazione attuale</strong>
        </div>
        <p className="aura-autonomy-text">{cycle.situation.currentSituationSummary}</p>

        <div className="aura-autonomy-grid">
          <div className="aura-autonomy-card">
            <span className="aura-autonomy-kicker">OBIETTIVI ATTIVI ({cycle.situation.activeGoals.length})</span>
            {cycle.situation.activeGoals.length === 0 ? (
              <p className="aura-autonomy-meta">Nessun obiettivo attivo documentato.</p>
            ) : (
              cycle.situation.activeGoals.slice(0, 3).map((g) => (
                <p key={g.id} className="aura-autonomy-item">
                  <strong>{g.label}</strong> — {g.detail}
                </p>
              ))
            )}
          </div>

          <div className="aura-autonomy-card">
            <span className="aura-autonomy-kicker">PROGRESSI DOCUMENTATI ({cycle.situation.documentedProgress.length})</span>
            {cycle.situation.documentedProgress.length === 0 ? (
              <p className="aura-autonomy-meta">Nessun progresso recente registrato.</p>
            ) : (
              cycle.situation.documentedProgress.slice(0, 3).map((p) => (
                <p key={p.id} className="aura-autonomy-item">
                  <strong>{p.label}</strong> — {p.detail}
                </p>
              ))
            )}
          </div>

          <div className="aura-autonomy-card">
            <span className="aura-autonomy-kicker">DIFFICOLTÀ & SCADENZE ({cycle.situation.detectedDifficulties.length + cycle.situation.deadlinesAndDependencies.length})</span>
            {cycle.situation.detectedDifficulties.length === 0 &&
            cycle.situation.deadlinesAndDependencies.length === 0 ? (
              <p className="aura-autonomy-meta">Nessuna criticità o scadenza bloccante rilevata.</p>
            ) : (
              [...cycle.situation.detectedDifficulties, ...cycle.situation.deadlinesAndDependencies]
                .slice(0, 3)
                .map((d) => (
                  <p key={d.id} className="aura-autonomy-item">
                    <strong>{d.label}</strong> — {d.detail}
                  </p>
                ))
            )}
          </div>

          <div className="aura-autonomy-card">
            <span className="aura-autonomy-kicker">BISOGNI FUTURI & INCERTEZZE</span>
            {cycle.situation.potentialFutureNeeds.slice(0, 2).map((n) => (
              <p key={n.id} className="aura-autonomy-item">
                <strong>{n.label}</strong> ({n.epistemicTag.replace(/_/g, " ")}) — {n.detail}
              </p>
            ))}
            {[...cycle.situation.missingData, ...cycle.situation.uncertaintyFactors]
              .slice(0, 2)
              .map((u) => (
                <p key={u.id} className="aura-autonomy-meta">
                  Incertezza: {u.detail}
                </p>
              ))}
          </div>
        </div>
      </div>

      {/* B. STRATEGIE ALTERNATIVE */}
      <div className="aura-autonomy-section">
        <div className="aura-autonomy-section-head">
          <Cpu size={15} />
          <strong>B. Strategie alternative ({cycle.strategies.length})</strong>
        </div>
        {cycle.strategies.length === 0 ? (
          <p className="aura-autonomy-meta">
            {mode === "PASSIVE"
              ? "In modalità PASSIVE AURA esegue solo la sintesi locale senza proporre strategie."
              : "Dati insufficienti per generare strategie alternative confrontabili."}
          </p>
        ) : (
          <div className="aura-autonomy-strategy-list">
            {cycle.strategies.map((s) => (
              <div key={s.id} className="aura-autonomy-card">
                <div className="aura-autonomy-card-top">
                  <strong>{s.title}</strong>
                  <span className="aura-autonomy-badge">{s.category} · Impegno {s.effortRequired}</span>
                </div>
                <p className="aura-autonomy-item">{s.goal}</p>
                <p className="aura-autonomy-meta">
                  <strong>Benefici:</strong> {s.potentialBenefits.join(" · ")}
                </p>
                <p className="aura-autonomy-meta">
                  <strong>Rischi:</strong> {s.risks.join(" · ")}
                </p>
                <p className="aura-autonomy-meta">
                  <strong>Impatto altri obiettivi:</strong> {s.impactOnOtherGoals} ·{" "}
                  <strong>Incertezza:</strong> {s.uncertaintyLevel}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* D. AUTORIZZAZIONI GRANULARI */}
      <div className="aura-autonomy-section">
        <div className="aura-autonomy-section-head">
          <Lock size={15} />
          <strong>D. Autorizzazioni granulari ({authorizations.length})</strong>
        </div>

        <div className="aura-autonomy-form">
          <label className="aura-autonomy-field">
            <span>Attività specifica</span>
            <select
              className="aura-autonomy-select"
              value={effectiveTaskKey}
              onChange={(e) => setSelectedTaskKey(e.target.value)}
              disabled={taskOptions.length === 0}
            >
              {taskOptions.length === 0 ? (
                <option value="">Nessuna attività disponibile nei piani</option>
              ) : (
                taskOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="aura-autonomy-field">
            <span>Azione reversibile (whitelist)</span>
            <select
              className="aura-autonomy-select"
              value={selectedAction}
              onChange={(e) => setSelectedAction(e.target.value as WhitelistedActionType)}
            >
              <option value="complete_plan_task">Segna attività come completata</option>
              <option value="update_plan_task_status">Aggiorna stato attività</option>
              <option value="update_plan_task_priority">Aggiorna priorità attività</option>
            </select>
          </label>

          {selectedAction === "update_plan_task_status" && (
            <label className="aura-autonomy-field">
              <span>Nuovo stato</span>
              <select
                className="aura-autonomy-select"
                value={nextStatusValue}
                onChange={(e) => setNextStatusValue(e.target.value as TaskStatus)}
              >
                <option value="pending">pending</option>
                <option value="in_progress">in_progress</option>
                <option value="paused">paused</option>
                <option value="completed">completed</option>
              </select>
            </label>
          )}

          {selectedAction === "update_plan_task_priority" && (
            <label className="aura-autonomy-field">
              <span>Nuova priorità</span>
              <select
                className="aura-autonomy-select"
                value={nextPriorityValue}
                onChange={(e) => setNextPriorityValue(e.target.value as TaskPriority)}
              >
                <option value="alta">alta</option>
                <option value="media">media</option>
                <option value="bassa">bassa</option>
              </select>
            </label>
          )}

          <div className="aura-autonomy-inline-fields">
            <label className="aura-autonomy-field">
              <span>Durata (ore, max 168)</span>
              <select
                className="aura-autonomy-select"
                value={durationHours}
                onChange={(e) => setDurationHours(Number(e.target.value))}
              >
                <option value={1}>1 ora</option>
                <option value={2}>2 ore</option>
                <option value={6}>6 ore</option>
                <option value={24}>24 ore</option>
              </select>
            </label>
            <label className="aura-autonomy-field">
              <span>Max utilizzi</span>
              <select
                className="aura-autonomy-select"
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
              >
                <option value={1}>1 utilizzo</option>
                <option value={2}>2 utilizzi</option>
                <option value={3}>3 utilizzi</option>
              </select>
            </label>
          </div>

          {!grantStepConfirm ? (
            <div className="aura-autonomy-actions">
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--primary"
                disabled={taskOptions.length === 0 || crisisBlocked}
                onClick={() => setGrantStepConfirm(true)}
              >
                <Lock size={15} /> Prepara autorizzazione specifica
              </button>
              {authorizations.some((a) => a.status === "active") && (
                <button
                  type="button"
                  className="aura-autonomy-button aura-autonomy-button--danger"
                  onClick={handleRevokeAll}
                >
                  <X size={15} /> Revoca tutte
                </button>
              )}
            </div>
          ) : (
            <div className="aura-autonomy-confirm-box" role="region" aria-label="Conferma creazione autorizzazione">
              <strong>Conferma esplicita creazione permesso</strong>
              <ul className="aura-autonomy-confirm-list">
                <li>Attività: <strong>{selectedTaskInfo?.label ?? effectiveTaskKey}</strong></li>
                <li>Proprietà modificata: <strong>{ACTION_LABELS[selectedAction].property}</strong></li>
                <li>Valore applicato: <strong>{getTargetValueLabel()}</strong></li>
                <li>Durata permesso: <strong>{durationHours} ore</strong></li>
                <li>Utilizzi massimi: <strong>{maxUses}</strong></li>
              </ul>
              <div className="aura-autonomy-actions">
                <button
                  type="button"
                  className="aura-autonomy-button aura-autonomy-button--primary"
                  onClick={handleConfirmGrantAuthorization}
                >
                  <Check size={15} /> Conferma permesso
                </button>
                <button
                  type="button"
                  className="aura-autonomy-button aura-autonomy-button--neutral"
                  onClick={() => setGrantStepConfirm(false)}
                >
                  <X size={15} /> Annulla
                </button>
              </div>
            </div>
          )}
        </div>

        {pendingExecutionAuth && (
          <div className="aura-autonomy-confirm-box" role="region" aria-label="Seconda conferma esecuzione">
            <strong>Seconda conferma esplicita prima dell&apos;esecuzione</strong>
            <p className="aura-autonomy-text">
              Eseguire <strong>{ACTION_LABELS[pendingExecutionAuth.actionType].label}</strong> sulla risorsa{" "}
              <strong>{pendingExecutionAuth.resourceId}</strong> ({pendingExecutionAuth.scope})? Il permesso verrà
              verificato nuovamente nel ledger locale.
            </p>
            <div className="aura-autonomy-actions">
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--primary"
                onClick={() => handleConfirmExecute(pendingExecutionAuth)}
              >
                <Play size={15} /> Conferma esecuzione
              </button>
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--neutral"
                onClick={() => setPendingExecutionAuth(null)}
              >
                <X size={15} /> Annulla
              </button>
            </div>
          </div>
        )}

        {authorizations.length > 0 && (
          <div className="aura-autonomy-list">
            {authorizations.slice(0, 5).map((auth) => (
              <div key={auth.id} className="aura-autonomy-card">
                <div className="aura-autonomy-card-top">
                  <strong>{ACTION_LABELS[auth.actionType].label}</strong>
                  <span className="aura-autonomy-badge">{auth.status.toUpperCase()}</span>
                </div>
                <p className="aura-autonomy-meta">
                  Risorsa: {auth.resourceId} · Ambito: {auth.scope}
                </p>
                <p className="aura-autonomy-meta">
                  Utilizzi residui: {Math.max(0, auth.maxUses - auth.usedCount)}/{auth.maxUses} · Scadenza:{" "}
                  {new Date(auth.expiresAt).toLocaleString("it-IT")}
                </p>
                <div className="aura-autonomy-actions">
                  <button
                    type="button"
                    className="aura-autonomy-button aura-autonomy-button--primary"
                    disabled={auth.status !== "active" || mode !== "USER-AUTHORIZED" || crisisBlocked}
                    onClick={() => setPendingExecutionAuth(auth)}
                  >
                    <Play size={15} /> Esegui
                  </button>
                  {auth.status === "active" && (
                    <button
                      type="button"
                      className="aura-autonomy-button aura-autonomy-button--danger"
                      onClick={() => handleRevokeOne(auth.id)}
                    >
                      <X size={15} /> Revoca
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* E. REGISTRO ATTIVITÀ */}
      <div className="aura-autonomy-section">
        <div className="aura-autonomy-section-head">
          <History size={15} />
          <strong>E. Registro attività ({auditEvents.length})</strong>
        </div>

        {auditEvents.length === 0 ? (
          <p className="aura-autonomy-meta">Nessun evento registrato nel ledger locale.</p>
        ) : (
          <div className="aura-autonomy-list">
            {auditEvents.slice(0, 5).map((ev) => (
              <div key={ev.id} className="aura-autonomy-card">
                <div className="aura-autonomy-card-top">
                  <strong>{ev.eventType.replace(/_/g, " ")}</strong>
                  <span className="aura-autonomy-badge">{ev.outcome.toUpperCase()}</span>
                </div>
                <p className="aura-autonomy-meta">{ev.detail}</p>
                <p className="aura-autonomy-meta">
                  {new Date(ev.timestamp).toLocaleString("it-IT")}
                </p>
                {ev.eventType === "execution_succeeded" && ev.rollbackSnapshot && (
                  <div className="aura-autonomy-actions">
                    <button
                      type="button"
                      className="aura-autonomy-button aura-autonomy-button--secondary"
                      onClick={() => handleRollback(ev.id)}
                    >
                      <RotateCcw size={15} /> Ripristina stato
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="aura-autonomy-actions">
          <button
            type="button"
            className="aura-autonomy-button aura-autonomy-button--secondary"
            onClick={handleExportLedger}
          >
            <Download size={15} /> Esporta registro JSON
          </button>

          {clearStep === 0 && (
            <button
              type="button"
              className="aura-autonomy-button aura-autonomy-button--danger"
              onClick={() => setClearStep(1)}
            >
              <Trash2 size={15} /> Cancella registro
            </button>
          )}
          {clearStep === 1 && (
            <>
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--danger"
                onClick={() => setClearStep(2)}
              >
                Conferma (1/2)
              </button>
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--neutral"
                onClick={() => setClearStep(0)}
              >
                Annulla
              </button>
            </>
          )}
          {clearStep === 2 && (
            <>
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--danger"
                onClick={handleFinalClearLedger}
              >
                Conferma definitiva (2/2)
              </button>
              <button
                type="button"
                className="aura-autonomy-button aura-autonomy-button--neutral"
                onClick={() => setClearStep(0)}
              >
                Annulla
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
