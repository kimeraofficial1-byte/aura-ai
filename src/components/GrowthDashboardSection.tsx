import { useMemo, useState } from "react";
import {
  AlertCircle,
  Award,
  Calendar,
  Check,
  Clock,
  Edit3,
  PauseCircle,
  PlayCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import {
  buildPersonalGrowthProfile,
  buildProgressTimeline,
  buildWeeklyReflection,
  evaluateAchievements,
} from "../growth/engine";
import type {
  GrowthGoal,
  GrowthGoalStatus,
  PersonalInsightsResult,
  TimelinePeriodFilter,
} from "../growth/types";
import { isSafeForLongTermMemory } from "../memory/privacyFilter";
import type { CheckInRecord } from "../memory/types";
import type { EmotionalTrendEntry } from "../emotion/types";
import type { AdaptiveMission } from "../missions/types";

interface GrowthDashboardSectionProps {
  goals: GrowthGoal[];
  preferences: string[];
  missions: AdaptiveMission[];
  checkIns: CheckInRecord[];
  emotionalTrends: EmotionalTrendEntry[];
  consent: boolean;
  insightsResult: PersonalInsightsResult | null;
  generatingInsights: boolean;
  crisisBlocked: boolean;
  onCreateGoal: (title: string, description?: string) => boolean;
  onEditGoal: (id: string, patch: { title?: string; description?: string }) => void;
  onChangeGoalStatus: (id: string, status: GrowthGoalStatus) => void;
  onDeleteGoal: (id: string) => void;
  onAddGoalStep: (goalId: string, stepTitle: string) => boolean;
  onToggleGoalStep: (goalId: string, stepId: string) => void;
  onRemoveGoalStep: (goalId: string, stepId: string) => void;
  onRefreshInsights: (focusPrompt?: string) => void;
}

const GOAL_STATUS_LABEL: Record<GrowthGoalStatus, string> = {
  attivo: "Attivo",
  in_pausa: "In pausa",
  completato: "Completato",
};

const PERIOD_LABELS: Array<{ id: TimelinePeriodFilter; label: string }> = [
  { id: "7d", label: "Ultimi 7 giorni" },
  { id: "30d", label: "Ultimi 30 giorni" },
  { id: "all", label: "Tutto" },
];

export function GrowthDashboardSection({
  goals,
  preferences,
  missions,
  checkIns,
  emotionalTrends,
  consent,
  insightsResult,
  generatingInsights,
  crisisBlocked,
  onCreateGoal,
  onEditGoal,
  onChangeGoalStatus,
  onDeleteGoal,
  onAddGoalStep,
  onToggleGoalStep,
  onRemoveGoalStep,
  onRefreshInsights,
}: GrowthDashboardSectionProps) {
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [newGoalDesc, setNewGoalDesc] = useState("");
  const [goalError, setGoalError] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [stepDrafts, setStepDrafts] = useState<Record<string, string>>({});
  const [timelinePeriod, setTimelinePeriod] = useState<TimelinePeriodFilter>("30d");
  const [insightPrompt, setInsightPrompt] = useState("");

  const profile = useMemo(
    () =>
      buildPersonalGrowthProfile({
        goals,
        preferences,
        missions,
        checkIns,
        consentEnabled: consent,
      }),
    [goals, preferences, missions, checkIns, consent]
  );

  const achievements = useMemo(
    () => evaluateAchievements({ goals, missions, checkIns }),
    [goals, missions, checkIns]
  );

  const weeklyReflection = useMemo(
    () =>
      buildWeeklyReflection({
        goals,
        missions,
        checkIns,
        emotionalTrends,
      }),
    [goals, missions, checkIns, emotionalTrends]
  );

  const timelineEntries = useMemo(
    () =>
      buildProgressTimeline(
        { goals, missions, checkIns, achievements },
        timelinePeriod
      ),
    [goals, missions, checkIns, achievements, timelinePeriod]
  );

  function handleCreateGoalSubmit() {
    const clean = newGoalTitle.trim();
    if (!clean) return;
    if (
      !isSafeForLongTermMemory(clean) ||
      (newGoalDesc.trim() && !isSafeForLongTermMemory(newGoalDesc))
    ) {
      setGoalError(
        "Per la tua sicurezza e privacy, contenuti di crisi, diagnosi o farmaci non vengono salvati negli obiettivi."
      );
      return;
    }
    const ok = onCreateGoal(clean, newGoalDesc.trim() || undefined);
    if (ok) {
      setGoalError(null);
      setNewGoalTitle("");
      setNewGoalDesc("");
    }
  }

  function startEditingGoal(goal: GrowthGoal) {
    setEditingGoalId(goal.id);
    setEditTitle(goal.title);
    setEditDesc(goal.description ?? "");
  }

  function saveGoalEdit(id: string) {
    if (!editTitle.trim() || !isSafeForLongTermMemory(editTitle)) {
      setGoalError("Il titolo non è valido o contiene termini non consentiti.");
      return;
    }
    if (editDesc.trim() && !isSafeForLongTermMemory(editDesc)) {
      setGoalError("La descrizione contiene contenuti clinici o sensibili non consentiti.");
      return;
    }
    setGoalError(null);
    onEditGoal(id, { title: editTitle.trim(), description: editDesc.trim() });
    setEditingGoalId(null);
  }

  function handleAddStepSubmit(goalId: string) {
    const raw = (stepDrafts[goalId] ?? "").trim();
    if (!raw) return;
    if (!isSafeForLongTermMemory(raw)) {
      setGoalError(
        "I passaggi non possono contenere contenuti di crisi, diagnosi o farmaci."
      );
      return;
    }
    const added = onAddGoalStep(goalId, raw);
    if (added) {
      setGoalError(null);
      setStepDrafts((prev) => ({ ...prev, [goalId]: "" }));
    }
  }

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <div className="growth-engine-wrap">
      {/* 1. Dashboard Crescita Personale */}
      <div className="section-title">
        <div>
          <span className="eyebrow">PERSONAL GROWTH ENGINE</span>
          <h2>Profilo e crescita personale</h2>
        </div>
      </div>

      <div className="panel growth-profile-panel" data-testid="growth-profile-panel">
        <div className="growth-stats-grid">
          <div className="growth-stat-box">
            <span>OBIETTIVI DICHIARATI</span>
            <strong>{profile.declaredGoalsCount}</strong>
            <small>
              {profile.activeGoalsCount} attivi · {profile.pausedGoalsCount} in pausa ·{" "}
              {profile.completedGoalsCount} completati
            </small>
          </div>
          <div className="growth-stat-box">
            <span>MISSIONI &amp; CHECK-IN</span>
            <strong>{profile.completedMissionsCount + profile.availableCheckInsCount}</strong>
            <small>
              {profile.completedMissionsCount} missioni · {profile.availableCheckInsCount} check-in
            </small>
          </div>
          <div className="growth-stat-box">
            <span>TRAGUARDI NON COMPETITIVI</span>
            <strong>
              {unlockedCount}/{achievements.length}
            </strong>
            <small>Senza classifiche né penalità</small>
          </div>
        </div>
        {profile.expressedPreferences.length > 0 && (
          <div className="growth-pref-line">
            <strong>Preferenze dichiarate:</strong>{" "}
            {profile.expressedPreferences.join(" · ")}
          </div>
        )}
      </div>

      {/* 2. Goal Evolution */}
      <div className="panel goal-evolution-panel" data-testid="goal-evolution-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">GOAL EVOLUTION</span>
            <h2>I tuoi obiettivi personali ({goals.length})</h2>
          </div>
          <span className="panel-icon">
            <Target size={18} />
          </span>
        </div>

        <div className="growth-goal-form">
          <input
            type="text"
            value={newGoalTitle}
            onChange={(e) => setNewGoalTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreateGoalSubmit();
              }
            }}
            placeholder="Nuovo obiettivo personale (es. Creare una routine serale leggera)..."
            aria-label="Titolo nuovo obiettivo crescita"
          />
          <input
            type="text"
            value={newGoalDesc}
            onChange={(e) => setNewGoalDesc(e.target.value)}
            placeholder="Nota o motivo personale facoltativo..."
            aria-label="Descrizione facoltativa obiettivo"
          />
          <button
            type="button"
            className="primary-btn"
            onClick={handleCreateGoalSubmit}
            disabled={!newGoalTitle.trim()}
          >
            <Plus size={14} /> Crea obiettivo
          </button>
        </div>

        {goalError && <div className="memory-warning">{goalError}</div>}

        {goals.length === 0 ? (
          <p className="trend-empty-state">
            Nessun obiettivo creato finora. Puoi aggiungerne uno, suddividerlo in piccoli
            passaggi o metterlo in pausa quando vuoi.
          </p>
        ) : (
          <div className="growth-goals-list" data-testid="growth-goals-list">
            {goals.map((goal) => {
              const isEditing = editingGoalId === goal.id;
              const stepsDone = goal.steps.filter((s) => s.done).length;
              return (
                <article
                  key={goal.id}
                  className={`growth-goal-card status-${goal.status}`}
                  data-testid={`growth-goal-card-${goal.id}`}
                >
                  <div className="growth-goal-top">
                    <div className="mission-badges">
                      <span className={`mission-status-badge ${goal.status}`}>
                        {GOAL_STATUS_LABEL[goal.status]}
                      </span>
                      {goal.steps.length > 0 && (
                        <span className="mission-cat-badge">
                          {stepsDone}/{goal.steps.length} passaggi
                        </span>
                      )}
                    </div>
                    <div className="growth-goal-controls">
                      {!isEditing && (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => startEditingGoal(goal)}
                          aria-label={`Modifica obiettivo ${goal.title}`}
                        >
                          <Edit3 size={12} /> Modifica
                        </button>
                      )}
                      {goal.status === "attivo" && (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => onChangeGoalStatus(goal.id, "in_pausa")}
                          aria-label={`Metti in pausa ${goal.title}`}
                        >
                          <PauseCircle size={12} /> In pausa
                        </button>
                      )}
                      {goal.status === "in_pausa" && (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => onChangeGoalStatus(goal.id, "attivo")}
                          aria-label={`Riprendi ${goal.title}`}
                        >
                          <PlayCircle size={12} /> Riprendi
                        </button>
                      )}
                      {goal.status !== "completato" ? (
                        <button
                          type="button"
                          className="complete-btn checked"
                          onClick={() => onChangeGoalStatus(goal.id, "completato")}
                          aria-label={`Completa obiettivo ${goal.title}`}
                        >
                          <Check size={12} /> Completa
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => onChangeGoalStatus(goal.id, "attivo")}
                          aria-label={`Riapri ${goal.title}`}
                        >
                          <PlayCircle size={12} /> Riapri
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger-btn"
                        onClick={() => onDeleteGoal(goal.id)}
                        aria-label={`Elimina obiettivo ${goal.title}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="mission-edit-box">
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        aria-label="Modifica titolo obiettivo crescita"
                      />
                      <input
                        type="text"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        aria-label="Modifica descrizione obiettivo crescita"
                        placeholder="Descrizione facoltativa..."
                      />
                      <div className="mission-edit-actions">
                        <button
                          type="button"
                          className="mini-action-btn"
                          onClick={() => saveGoalEdit(goal.id)}
                        >
                          Salva modifica
                        </button>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => setEditingGoalId(null)}
                        >
                          Annulla
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <h3 className="growth-goal-title">{goal.title}</h3>
                      {goal.description && (
                        <p className="growth-goal-desc">{goal.description}</p>
                      )}
                    </div>
                  )}

                  {/* Piccoli passaggi */}
                  <div className="growth-steps-box">
                    {goal.steps.length > 0 && (
                      <ul className="growth-steps-list">
                        {goal.steps.map((step) => (
                          <li key={step.id} className={step.done ? "step-done" : ""}>
                            <label className="growth-step-check">
                              <input
                                type="checkbox"
                                checked={step.done}
                                onChange={() => onToggleGoalStep(goal.id, step.id)}
                              />
                              <span>{step.title}</span>
                            </label>
                            <button
                              type="button"
                              className="chip-remove"
                              aria-label={`Rimuovi passaggio ${step.title}`}
                              onClick={() => onRemoveGoalStep(goal.id, step.id)}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="growth-step-add">
                      <input
                        type="text"
                        value={stepDrafts[goal.id] ?? ""}
                        onChange={(e) =>
                          setStepDrafts((prev) => ({ ...prev, [goal.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddStepSubmit(goal.id);
                          }
                        }}
                        placeholder="Suddividi in un piccolo passaggio..."
                        aria-label={`Aggiungi passaggio per ${goal.title}`}
                      />
                      <button
                        type="button"
                        className="mini-action-btn"
                        onClick={() => handleAddStepSubmit(goal.id)}
                        disabled={!(stepDrafts[goal.id] ?? "").trim()}
                      >
                        <Plus size={12} /> Passaggio
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Achievement System (Non competitivo) */}
      <div className="panel" data-testid="growth-achievements-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">TRAGUARDI NON COMPETITIVI</span>
            <h2>Piccole tappe personali</h2>
          </div>
          <span className="panel-icon">
            <Award size={18} />
          </span>
        </div>
        <div className="achievements-grid">
          {achievements.map((ach) => (
            <div
              key={ach.id}
              className={`achievement-card ${ach.unlocked ? "unlocked" : "locked"}`}
            >
              <div className="achievement-top">
                <strong>{ach.title}</strong>
                <span className={`mission-status-badge ${ach.unlocked ? "completata" : ""}`}>
                  {ach.unlocked ? "Raggiunto" : "In corso"}
                </span>
              </div>
              <p>{ach.description}</p>
              <small>{ach.progressLabel}</small>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Weekly Reflection */}
      <div className="panel" data-testid="weekly-reflection-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">WEEKLY REFLECTION</span>
            <h2>Riepilogo settimanale</h2>
          </div>
          <span className="panel-icon">
            <Calendar size={18} />
          </span>
        </div>

        <p className="weekly-note">{weeklyReflection.dataSufficiencyNote}</p>

        <div className="weekly-grid">
          <div className="weekly-block">
            <strong>Attività &amp; Missioni completate ({weeklyReflection.completedMissions.length})</strong>
            {weeklyReflection.completedMissions.length === 0 ? (
              <p className="memory-placeholder">Nessuna missione completata negli ultimi 7 giorni.</p>
            ) : (
              <ul>
                {weeklyReflection.completedMissions.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="weekly-block">
            <strong>Obiettivi su cui hai lavorato ({weeklyReflection.goalsWorkedOn.length})</strong>
            {weeklyReflection.goalsWorkedOn.length === 0 ? (
              <p className="memory-placeholder">Nessun obiettivo modificato questa settimana.</p>
            ) : (
              <ul>
                {weeklyReflection.goalsWorkedOn.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="weekly-block">
            <strong>Difficoltà dichiarate</strong>
            {weeklyReflection.declaredDifficulties.length === 0 ? (
              <p className="memory-placeholder">Nessuna difficoltà specifica registrata.</p>
            ) : (
              <ul>
                {weeklyReflection.declaredDifficulties.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="weekly-block">
            <strong>Piccoli progressi &amp; spunti facoltativi</strong>
            <ul>
              {weeklyReflection.observableSmallProgress.map((p, i) => (
                <li key={`p-${i}`}>{p}</li>
              ))}
              {weeklyReflection.optionalNextWeekSuggestions.map((s, i) => (
                <li key={`s-${i}`} className="weekly-suggestion">
                  Spunto facoltativo: {s}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* 5. Personal Insights */}
      <div className="panel" data-testid="personal-insights-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">PERSONAL INSIGHTS</span>
            <h2>Osservazioni prudenti sui tuoi dati</h2>
          </div>
          <span className="panel-icon">
            <Sparkles size={18} />
          </span>
        </div>

        <div className="adaptive-generate-row">
          <input
            type="text"
            value={insightPrompt}
            onChange={(e) => setInsightPrompt(e.target.value)}
            placeholder="Domanda facoltativa sui tuoi progressi (es. su cosa potrei concentrarmi?)..."
            aria-label="Richiesta facoltativa per osservazioni personali"
            disabled={crisisBlocked || generatingInsights}
          />
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              onRefreshInsights(insightPrompt);
              setInsightPrompt("");
            }}
            disabled={crisisBlocked || generatingInsights}
          >
            <Sparkles size={14} />
            {generatingInsights ? "Analisi prudente..." : "Aggiorna osservazioni"}
          </button>
        </div>

        {crisisBlocked && (
          <div className="memory-warning" role="alert">
            <AlertCircle size={14} /> Generazione osservazioni sospesa per sicurezza. Se sei in
            emergenza chiama il 112.
          </div>
        )}

        {insightsResult?.insufficientData && (
          <div className="emotion-uncertain-alert" data-testid="insights-insufficient-data">
            <AlertCircle size={15} />
            <span>
              {insightsResult.insufficientDataMessage ||
                "Dati disponibili ancora insufficienti per formulare osservazioni affidabili."}
            </span>
          </div>
        )}

        {insightsResult && !insightsResult.insufficientData && insightsResult.insights.length > 0 && (
          <div className="insights-list" data-testid="insights-cards-list">
            {insightsResult.insights.map((ins) => (
              <article key={ins.id} className="insight-card">
                <h3>{ins.title}</h3>
                <div className="insight-section">
                  <span className="insight-tag facts">Fatti registrati</span>
                  <ul>
                    {ins.observedFacts.map((fact, idx) => (
                      <li key={idx}>{fact}</li>
                    ))}
                  </ul>
                </div>
                <div className="insight-section">
                  <span className="insight-tag cautious">Lettura prudente e facoltativa</span>
                  <p>{ins.cautiousInterpretation}</p>
                </div>
                <small className="insight-confidence">{ins.confidenceNote}</small>
              </article>
            ))}
          </div>
        )}

        {!insightsResult && (
          <p className="chart-note">
            Premi &ldquo;Aggiorna osservazioni&rdquo; per generare un&apos;analisi che distingue
            chiaramente i fatti registrati dalle ipotesi prudenti, senza diagnosi.
          </p>
        )}
      </div>

      {/* 6. Progress Timeline + Filtri temporali */}
      <div className="panel" data-testid="progress-timeline-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">PROGRESS TIMELINE</span>
            <h2>Cronologia dei progressi ({timelineEntries.length})</h2>
          </div>
          <span className="panel-icon">
            <Clock size={18} />
          </span>
        </div>

        <div className="mood-options" role="group" aria-label="Filtro periodo cronologia">
          {PERIOD_LABELS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={timelinePeriod === p.id ? "mood selected" : "mood"}
              onClick={() => setTimelinePeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {timelineEntries.length === 0 ? (
          <p className="trend-empty-state">
            Nessun evento registrato nel periodo selezionato.
          </p>
        ) : (
          <ul className="trend-history-list" data-testid="progress-timeline-list">
            {timelineEntries.slice(0, 20).map((item) => (
              <li key={item.id} className="trend-history-item">
                <div className="trend-item-main">
                  <span className="mission-cat-badge">{item.badge}</span>
                  <strong>{item.title}</strong>
                  <span className="trend-secondary">{item.detail}</span>
                </div>
                <div className="trend-item-meta">
                  <span>
                    {new Date(item.date).toLocaleDateString("it-IT", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="disclaimer growth-timeline-note">
          <ShieldCheck size={16} />
          <span>
            {consent
              ? "Memoria attiva: obiettivi, cronologia e progressi non sensibili vengono salvati localmente e inclusi in esportazione/eliminazione."
              : "Memoria disattivata: i progressi restano solo nella sessione corrente e non vengono salvati su disco."}
          </span>
        </div>
      </div>
    </div>
  );
}
