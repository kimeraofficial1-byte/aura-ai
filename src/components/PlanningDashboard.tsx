import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  Clock,
  Download,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  getPlanProgressMetrics,
  hasUnmetDependencies,
} from "../planning/planningEngine";
import type {
  HorizonBucket,
  PersonalPlan,
  PlanHorizon,
  TaskStatus,
} from "../planning/types";

interface PlanningDashboardProps {
  plans: PersonalPlan[];
  consent: boolean;
  crisisBlocked: boolean;
  onCreatePlan: (input: {
    declaredGoal: string;
    desiredOutcome?: string;
    horizon: PlanHorizon;
    dailyMinutesLimit: number;
    constraints: string[];
  }) => void;
  onTogglePausePlan: (planId: string) => void;
  onRecalculatePlan: (
    planId: string,
    reason: string,
    newDailyMinutesLimit?: number
  ) => void;
  onTransitionTaskStatus: (
    planId: string,
    taskId: string,
    status: TaskStatus
  ) => void;
  onDeletePlan: (planId: string) => void;
  onExportPlans: () => void;
  onDeleteAllPlans: () => void;
}

const HORIZON_LABELS: Record<PlanHorizon, string> = {
  daily: "Giornaliero",
  weekly: "Settimanale",
  monthly: "Mensile",
};

const PRIORITY_COLORS: Record<string, string> = {
  alta: "#ef4444",
  media: "#f59e0b",
  bassa: "#10b981",
};

export function PlanningDashboard({
  plans,
  consent,
  crisisBlocked,
  onCreatePlan,
  onTogglePausePlan,
  onRecalculatePlan,
  onTransitionTaskStatus,
  onDeletePlan,
  onExportPlans,
  onDeleteAllPlans,
}: PlanningDashboardProps) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>(plans[0]?.id ?? "");
  const [bucketFilter, setBucketFilter] = useState<"tutti" | HorizonBucket>("tutti");
  const [showNewForm, setShowNewForm] = useState<boolean>(plans.length === 0);

  // Form creazione piano
  const [goalInput, setGoalInput] = useState("");
  const [outcomeInput, setOutcomeInput] = useState("");
  const [horizonInput, setHorizonInput] = useState<PlanHorizon>("weekly");
  const [minutesInput, setMinutesInput] = useState(30);
  const [constraintInput, setConstraintInput] = useState("");

  // Conferme utente per decisioni importanti
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [recalcNote, setRecalcNote] = useState("");
  const [showRecalcBox, setShowRecalcBox] = useState(false);

  const activePlan = useMemo(
    () => plans.find((p) => p.id === selectedPlanId) ?? plans[0] ?? null,
    [plans, selectedPlanId]
  );

  const metrics = useMemo(
    () => (activePlan ? getPlanProgressMetrics(activePlan) : null),
    [activePlan]
  );

  const filteredTasks = useMemo(() => {
    if (!activePlan) return [];
    if (bucketFilter === "tutti") return activePlan.tasks;
    return activePlan.tasks.filter((t) => t.horizonBucket === bucketFilter);
  }, [activePlan, bucketFilter]);

  function handleSubmitNewPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!goalInput.trim() || crisisBlocked) return;
    const constraints = constraintInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onCreatePlan({
      declaredGoal: goalInput.trim(),
      desiredOutcome: outcomeInput.trim() || undefined,
      horizon: horizonInput,
      dailyMinutesLimit: minutesInput,
      constraints,
    });
    setGoalInput("");
    setOutcomeInput("");
    setConstraintInput("");
    setShowNewForm(false);
  }

  return (
    <section className="content" aria-label="Dashboard Pianificazione AURA">
      <div className="page-heading">
        <span className="eyebrow">AURA V3 / PLANNING ENGINE</span>
        <h1>Pianificazione intelligente.</h1>
        <p>
          Trasforma i tuoi obiettivi dichiarati in passi realistici, con stime trasparenti e pieno controllo.
        </p>
      </div>

      {crisisBlocked && (
        <div className="safety-box" role="alert">
          <ShieldCheck size={18} />
          <span>
            Il Safety Engine ha rilevato una situazione delicata: la pianificazione è temporaneamente sospesa per dare priorità al tuo benessere.
          </span>
        </div>
      )}

      {/* Barra azioni superiori */}
      <div className="panel" style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            className="primary-btn"
            disabled={crisisBlocked}
            onClick={() => setShowNewForm((prev) => !prev)}
          >
            <Plus size={16} /> {showNewForm ? "Chiudi modulo" : "Nuovo piano"}
          </button>
          {plans.length > 0 && (
            <button type="button" className="text-btn" onClick={onExportPlans}>
              <Download size={15} /> Esporta piani (JSON)
            </button>
          )}
        </div>
        <span style={{ fontSize: "12px", opacity: 0.8 }}>
          {consent
            ? "Memoria attiva: piani salvati localmente su questo dispositivo."
            : "Memoria disattivata: i piani restano solo in questa sessione."}
        </span>
      </div>

      {/* Modulo creazione nuovo piano */}
      {showNewForm && (
        <form className="panel" onSubmit={handleSubmitNewPlan} style={{ display: "grid", gap: "12px" }}>
          <div className="panel-head">
            <div>
              <span className="eyebrow">NUOVO OBIETTIVO</span>
              <h2>Crea un piano sostenibile</h2>
            </div>
            <span className="panel-icon"><Calendar size={19} /></span>
          </div>

          <label className="field-label" htmlFor="plan-goal-input">
            Obiettivo dichiarato *
          </label>
          <input
            id="plan-goal-input"
            type="text"
            required
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            placeholder="Es. Preparare il colloquio di lavoro in 2 settimane"
            style={{ padding: "10px 12px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", color: "inherit" }}
          />

          <label className="field-label" htmlFor="plan-outcome-input">
            Risultato desiderato (opzionale)
          </label>
          <input
            id="plan-outcome-input"
            type="text"
            value={outcomeInput}
            onChange={(e) => setOutcomeInput(e.target.value)}
            placeholder="Es. Avere CV aggiornato e 3 simulazioni completate"
            style={{ padding: "10px 12px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", color: "inherit" }}
          />

          <div className="grid two">
            <div>
              <label className="field-label" htmlFor="plan-horizon-select">
                Orizzonte temporale
              </label>
              <select
                id="plan-horizon-select"
                value={horizonInput}
                onChange={(e) => setHorizonInput(e.target.value as PlanHorizon)}
                style={{ width: "100%", padding: "10px 12px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "inherit" }}
              >
                <option value="daily">Giornaliero</option>
                <option value="weekly">Settimanale</option>
                <option value="monthly">Mensile</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="plan-minutes-input">
                Tempo disponibile al giorno: <strong>{minutesInput} min</strong>
              </label>
              <input
                id="plan-minutes-input"
                className="stress-range"
                type="range"
                min={10}
                max={120}
                step={5}
                value={minutesInput}
                onChange={(e) => setMinutesInput(Number(e.target.value))}
              />
            </div>
          </div>

          <label className="field-label" htmlFor="plan-constraints-input">
            Vincoli o limiti personali dichiarati (separati da virgola)
          </label>
          <input
            id="plan-constraints-input"
            type="text"
            value={constraintInput}
            onChange={(e) => setConstraintInput(e.target.value)}
            placeholder="Es. Solo la sera dopo le 19, energia limitata il mercoledì"
            style={{ padding: "10px 12px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", color: "inherit" }}
          />

          <button type="submit" className="primary-btn full" disabled={crisisBlocked || !goalInput.trim()}>
            Crea piano strutturato
          </button>
        </form>
      )}

      {/* Selettore piani attivi */}
      {plans.length > 0 && (
        <div className="panel" style={{ display: "grid", gap: "10px" }}>
          <span className="eyebrow">OBIETTIVI ATTIVI ({plans.length})</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {plans.map((p) => (
              <button
                key={p.id}
                type="button"
                className={activePlan?.id === p.id ? "mood selected" : "mood"}
                onClick={() => {
                  setSelectedPlanId(p.id);
                  setConfirmDeleteId(null);
                  setShowRecalcBox(false);
                }}
              >
                {p.title} · {p.progressPercent}% {p.status === "paused" ? "(In pausa)" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Dettaglio piano selezionato */}
      {activePlan && metrics ? (
        <>
          {/* Metriche principali */}
          <div className="grid three">
            <div className="metric-card">
              <div className="metric-top">
                <span>AVANZAMENTO</span>
                <Check size={17} />
              </div>
              <div className="metric-value">
                {metrics.progressPercent}
                <small>%</small>
              </div>
              <span className="metric-caption">
                {metrics.completedTasks}/{metrics.totalTasks} attività completate
              </span>
              <div className="mini-track">
                <i style={{ width: `${metrics.progressPercent}%` }} />
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-top">
                <span>ATTIVITÀ DI OGGI</span>
                <Clock size={17} />
              </div>
              <div className="metric-value">{metrics.todayTasks}</div>
              <span className="metric-caption">
                Limite: {activePlan.dailyMinutesLimit} min/giorno · {HORIZON_LABELS[activePlan.horizon]}
              </span>
            </div>

            <div className="metric-card">
              <div className="metric-top">
                <span>IN RITARDO</span>
                <AlertTriangle size={17} />
              </div>
              <div className="metric-value">{metrics.overdueTasks}</div>
              <span className="metric-caption">
                Scadenza obiettivo: {activePlan.targetDate}
              </span>
            </div>
          </div>

          {/* Controlli del piano */}
          <div className="panel" style={{ display: "grid", gap: "12px" }}>
            <div className="panel-head">
              <div>
                <span className="eyebrow">
                  PIANO {HORIZON_LABELS[activePlan.horizon].toUpperCase()} · {activePlan.status.toUpperCase()}
                </span>
                <h2>{activePlan.title}</h2>
                <p style={{ fontSize: "13px", opacity: 0.85, marginTop: "4px" }}>
                  {activePlan.desiredOutcome}
                </p>
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                className="primary-btn"
                onClick={() => setShowRecalcBox((prev) => !prev)}
              >
                <RefreshCw size={15} /> Aggiorna / Ricalcola piano
              </button>

              <button
                type="button"
                className="mood"
                onClick={() => onTogglePausePlan(activePlan.id)}
              >
                {activePlan.status === "paused" ? (
                  <>
                    <Play size={14} /> Riprendi piano
                  </>
                ) : (
                  <>
                    <Pause size={14} /> Sospendi piano
                  </>
                )}
              </button>

              {confirmDeleteId === activePlan.id ? (
                <button
                  type="button"
                  className="mood"
                  style={{ borderColor: "#ef4444", color: "#ef4444" }}
                  onClick={() => {
                    onDeletePlan(activePlan.id);
                    setConfirmDeleteId(null);
                  }}
                >
                  Conferma eliminazione
                </button>
              ) : (
                <button
                  type="button"
                  className="mood"
                  onClick={() => setConfirmDeleteId(activePlan.id)}
                >
                  <Trash2 size={14} /> Elimina piano
                </button>
              )}
            </div>

            {showRecalcBox && (
              <div style={{ display: "grid", gap: "8px", padding: "12px", borderRadius: "10px", background: "rgba(255,255,255,0.04)" }}>
                <label className="field-label" htmlFor="recalc-reason-input">
                  Cosa è cambiato? (es. imprevisto, meno tempo oggi)
                </label>
                <input
                  id="recalc-reason-input"
                  type="text"
                  value={recalcNote}
                  onChange={(e) => setRecalcNote(e.target.value)}
                  placeholder="Es. Ho avuto un imprevisto e ho solo 20 minuti al giorno"
                  style={{ padding: "8px 10px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "inherit" }}
                />
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    onRecalculatePlan(
                      activePlan.id,
                      recalcNote.trim() || "Aggiornamento richiesto dall'utente"
                    );
                    setRecalcNote("");
                    setShowRecalcBox(false);
                  }}
                >
                  Conferma ricalcolo piano
                </button>
              </div>
            )}

            {/* Filtri attività */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {(["tutti", "oggi", "settimana", "mese"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={bucketFilter === b ? "mood selected" : "mood"}
                  onClick={() => setBucketFilter(b)}
                >
                  {b === "tutti" ? "Tutte" : b.charAt(0).toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>

            {/* Lista attività */}
            <div style={{ display: "grid", gap: "10px" }}>
              {filteredTasks.map((task) => {
                const blocked = hasUnmetDependencies(activePlan, task.id);
                return (
                  <div
                    key={task.id}
                    style={{
                      padding: "12px",
                      borderRadius: "12px",
                      border: "1px solid rgba(255,255,255,0.1)",
                      background: "rgba(255,255,255,0.03)",
                      display: "grid",
                      gap: "6px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px", flexWrap: "wrap" }}>
                      <div>
                        <strong style={{ textDecoration: task.status === "completed" ? "line-through" : "none" }}>
                          {task.title}
                        </strong>
                        <p style={{ fontSize: "13px", opacity: 0.8, margin: "4px 0 0" }}>
                          {task.description}
                        </p>
                      </div>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "3px 8px",
                          borderRadius: "999px",
                          border: `1px solid ${PRIORITY_COLORS[task.priority] ?? "#94a3b8"}`,
                          color: PRIORITY_COLORS[task.priority] ?? "#94a3b8",
                        }}
                      >
                        Priorità {task.priority}
                      </span>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "12px", opacity: 0.8 }}>
                      <span>Scadenza: {task.dueDate}</span>
                      <span>Stima: ~{task.estimatedMinutes} min</span>
                      <span>Stato: {task.status}</span>
                      {blocked && <span>In attesa di attività precedente</span>}
                    </div>

                    {task.status === "overdue" || task.status === "paused" ? (
                      <div style={{ fontSize: "12px", opacity: 0.85 }}>
                        <strong>Alternativa suggerita:</strong> {task.alternatives[0]}
                      </div>
                    ) : null}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
                      {task.status !== "completed" && (
                        <button
                          type="button"
                          className="mood selected"
                          onClick={() => onTransitionTaskStatus(activePlan.id, task.id, "completed")}
                        >
                          <Check size={13} /> Completa
                        </button>
                      )}
                      {task.status !== "paused" && task.status !== "completed" && (
                        <button
                          type="button"
                          className="mood"
                          onClick={() => onTransitionTaskStatus(activePlan.id, task.id, "paused")}
                        >
                          Sospendi
                        </button>
                      )}
                      {task.status === "paused" && (
                        <button
                          type="button"
                          className="mood"
                          onClick={() => onTransitionTaskStatus(activePlan.id, task.id, "pending")}
                        >
                          Riattiva
                        </button>
                      )}
                      {task.status !== "cancelled" && task.status !== "completed" && (
                        <button
                          type="button"
                          className="mood"
                          onClick={() => onTransitionTaskStatus(activePlan.id, task.id, "cancelled")}
                        >
                          Annulla
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cronologia revisioni e incertezze */}
          <div className="grid two">
            <div className="panel" style={{ display: "grid", gap: "8px" }}>
              <span className="eyebrow">CRONOLOGIA REVISIONI</span>
              {activePlan.revisions.slice(0, 4).map((rev) => (
                <div key={rev.id} style={{ fontSize: "13px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                  <strong>{rev.reason}</strong>
                  <p style={{ margin: "2px 0 0", opacity: 0.8 }}>{rev.explanation}</p>
                </div>
              ))}
            </div>

            <div className="panel" style={{ display: "grid", gap: "8px" }}>
              <span className="eyebrow">INCERTEZZE E PRIVACY</span>
              {activePlan.uncertainties.slice(0, 3).map((u, idx) => (
                <p key={idx} style={{ fontSize: "13px", opacity: 0.85, margin: 0 }}>
                  • {u}
                </p>
              ))}
              {plans.length > 0 && (
                <div style={{ marginTop: "8px" }}>
                  {confirmDeleteAll ? (
                    <button
                      type="button"
                      className="mood"
                      style={{ borderColor: "#ef4444", color: "#ef4444" }}
                      onClick={() => {
                        onDeleteAllPlans();
                        setConfirmDeleteAll(false);
                      }}
                    >
                      Conferma cancellazione di tutti i piani
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => setConfirmDeleteAll(true)}
                    >
                      <Trash2 size={14} /> Cancella tutti i dati dei piani
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="panel">
          <p style={{ margin: 0, opacity: 0.85 }}>
            Nessun piano attivo al momento. Usa il pulsante &ldquo;Nuovo piano&rdquo; per trasformare un tuo obiettivo dichiarato in passi concreti.
          </p>
        </div>
      )}
    </section>
  );
}
