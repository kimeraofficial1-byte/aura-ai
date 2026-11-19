import { useState } from "react";
import {
  AlertCircle,
  Check,
  CircleHelp,
  Clock,
  Edit3,
  PauseCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { isSafeForLongTermMemory } from "../memory/privacyFilter";
import type {
  AdaptiveMission,
  EnergyLevel,
  MissionStatus,
} from "../missions/types";

interface MissionsViewProps {
  missions: AdaptiveMission[];
  goals: string[];
  availableMinutes: number;
  energyLevel: EnergyLevel;
  consent: boolean;
  generating: boolean;
  crisisBlocked: boolean;
  preferencePrompt: string | null;
  generationNotice: string | null;
  onChangeAvailableMinutes: (minutes: number) => void;
  onChangeEnergyLevel: (level: EnergyLevel) => void;
  onGenerateMissions: (focusNote?: string) => void;
  onTransitionStatus: (id: string, status: MissionStatus) => void;
  onEditMission: (
    id: string,
    patch: { title?: string; description?: string; estimatedMinutes?: number }
  ) => void;
  onAddGoal: (goal: string) => boolean;
  onRemoveGoal: (index: number) => void;
}

const STATUS_LABELS: Record<MissionStatus, string> = {
  proposta: "Proposta",
  accettata: "Accettata",
  completata: "Completata",
  rifiutata: "Rifiutata",
  annullata: "Annullata",
};

const EFFORT_LABELS: Record<AdaptiveMission["effortLevel"], string> = {
  basso: "Impegno basso",
  medio: "Impegno medio",
  alto: "Impegno graduale",
};

export function MissionsView({
  missions,
  goals,
  availableMinutes,
  energyLevel,
  consent,
  generating,
  crisisBlocked,
  preferencePrompt,
  generationNotice,
  onChangeAvailableMinutes,
  onChangeEnergyLevel,
  onGenerateMissions,
  onTransitionStatus,
  onEditMission,
  onAddGoal,
  onRemoveGoal,
}: MissionsViewProps) {
  const [goalDraft, setGoalDraft] = useState("");
  const [goalWarning, setGoalWarning] = useState<string | null>(null);
  const [focusNote, setFocusNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editMinutes, setEditMinutes] = useState(5);

  const activeMissions = missions.filter(
    (m) => m.status === "proposta" || m.status === "accettata"
  );
  const completedMissions = missions.filter((m) => m.status === "completata");
  const historyMissions = missions
    .filter(
      (m) =>
        m.status === "completata" ||
        m.status === "rifiutata" ||
        m.status === "annullata"
    )
    .slice()
    .reverse();

  const totalTodayScope = activeMissions.length + completedMissions.length;
  const progressPct =
    totalTodayScope > 0 ? Math.round((completedMissions.length / totalTodayScope) * 100) : 0;

  function startEdit(m: AdaptiveMission) {
    setEditingId(m.id);
    setEditTitle(m.title);
    setEditDesc(m.description);
    setEditMinutes(m.estimatedMinutes);
  }

  function saveEdit(id: string) {
    onEditMission(id, {
      title: editTitle,
      description: editDesc,
      estimatedMinutes: editMinutes,
    });
    setEditingId(null);
  }

  function handleAddGoalSubmit() {
    const clean = goalDraft.trim();
    if (!clean) return;
    if (!isSafeForLongTermMemory(clean)) {
      setGoalWarning(
        "Per la tua sicurezza e privacy, contenuti di crisi, diagnosi o farmaci non possono essere aggiunti agli obiettivi."
      );
      return;
    }
    const added = onAddGoal(clean);
    if (added) {
      setGoalWarning(null);
      setGoalDraft("");
    }
  }

  return (
    <section className="content missions-content">
      <div className="page-heading">
        <span className="eyebrow">ADAPTIVE MISSION ENGINE</span>
        <h1>
          Piccoli passi.
          <br />
          <span>Il tuo ritmo.</span>
        </h1>
        <p>
          Proposte adattive e facoltative calibrate su tempo, energia ed equilibrio emotivo.
        </p>
      </div>

      {/* Indicatore dei progressi non punitivo */}
      <div className="mission-progress" data-testid="mission-progress-bar">
        <div>
          <b>
            {completedMissions.length} di {Math.max(1, totalTodayScope)}
          </b>
          <span>missioni completate · nessuna penalità se salti o cambi idea</span>
        </div>
        <div className="progress-track">
          <i style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {/* Sezione Obiettivi personali */}
      <div className="panel goals-panel" data-testid="personal-goals-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">OBIETTIVI PERSONALI</span>
            <h2>Ciò che conta per te</h2>
          </div>
          <span className="panel-icon">
            <Target size={18} />
          </span>
        </div>

        <div className="memory-chips">
          {goals.length === 0 ? (
            <span className="memory-placeholder">
              Nessun obiettivo personale impostato. Aggiungine uno per orientare le missioni.
            </span>
          ) : (
            goals.map((goal, idx) => (
              <span key={`${goal}-${idx}`} className="memory-chip">
                <span>{goal}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Rimuovi obiettivo ${goal}`}
                  onClick={() => onRemoveGoal(idx)}
                >
                  <X size={12} />
                </button>
              </span>
            ))
          )}
        </div>

        <div className="memory-add-row">
          <input
            type="text"
            value={goalDraft}
            onChange={(e) => setGoalDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddGoalSubmit();
              }
            }}
            placeholder="Es. Fare pause brevi al pomeriggio o dormire con più calma..."
            aria-label="Nuovo obiettivo personale"
          />
          <button
            type="button"
            className="mini-action-btn"
            onClick={handleAddGoalSubmit}
            disabled={!goalDraft.trim()}
          >
            <Plus size={13} /> Aggiungi obiettivo
          </button>
        </div>

        {goalWarning && <div className="memory-warning">{goalWarning}</div>}
      </div>

      {/* Controlli adattivi (Tempo + Energia + Generazione) */}
      <div className="panel adaptive-controls-panel">
        <div className="adaptive-controls-grid">
          <div>
            <label className="field-label">Tempo disponibile</label>
            <div className="mood-options compact-options">
              {[5, 10, 15, 30].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  className={availableMinutes === mins ? "mood selected" : "mood"}
                  onClick={() => onChangeAvailableMinutes(mins)}
                >
                  {mins} min
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="field-label">Energia attuale</label>
            <div className="mood-options compact-options">
              {(
                [
                  { id: "bassa", label: "Bassa" },
                  { id: "media", label: "Media" },
                  { id: "buona", label: "Buona" },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={energyLevel === item.id ? "mood selected" : "mood"}
                  onClick={() => onChangeEnergyLevel(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="adaptive-generate-row">
          <input
            type="text"
            value={focusNote}
            onChange={(e) => setFocusNote(e.target.value)}
            placeholder="Preferenza opzionale per adesso (es. qualcosa di calmo o creativo)..."
            aria-label="Preferenza opzionale per nuove missioni"
            disabled={crisisBlocked || generating}
          />
          <button
            type="button"
            className="primary-btn"
            onClick={() => {
              onGenerateMissions(focusNote);
              setFocusNote("");
            }}
            disabled={crisisBlocked || generating}
          >
            <Sparkles size={15} />
            {generating ? "Calibrazione..." : "Genera missioni del giorno"}
          </button>
        </div>

        {crisisBlocked && (
          <div className="memory-warning" role="alert">
            <AlertCircle size={14} /> La generazione automatica è sospesa per tutelare la tua
            sicurezza. Se sei in pericolo immediato chiama il 112 o chiedi aiuto a una persona
            fidata.
          </div>
        )}

        {preferencePrompt && !crisisBlocked && (
          <div className="emotion-uncertain-alert" data-testid="mission-uncertain-prompt">
            <CircleHelp size={15} />
            <span>{preferencePrompt}</span>
          </div>
        )}

        {generationNotice && <div className="memory-notice">{generationNotice}</div>}
      </div>

      {/* Sezione Missioni del giorno */}
      <div className="section-title">
        <div>
          <span className="eyebrow">MISSIONI DEL GIORNO</span>
          <h2>Proposte e attività in corso ({activeMissions.length})</h2>
        </div>
      </div>

      {activeMissions.length === 0 ? (
        <div className="panel">
          <p className="trend-empty-state">
            Nessuna missione attiva al momento. Quando vuoi, puoi generarne di nuove calibrate sul
            tuo ritmo attuale.
          </p>
        </div>
      ) : (
        <div className="mission-list" data-testid="daily-missions-list">
          {activeMissions.map((m) => {
            const isEditing = editingId === m.id;
            return (
              <article
                className={`mission-card adaptive-card status-${m.status}`}
                key={m.id}
                data-testid={`mission-card-${m.id}`}
              >
                <div className="mission-card-top">
                  <div className="mission-badges">
                    <span className="mission-cat-badge">{m.category}</span>
                    <span className={`mission-status-badge ${m.status}`}>
                      {STATUS_LABELS[m.status]}
                    </span>
                  </div>
                  <div className="mission-meta-pills">
                    <span>
                      <Clock size={12} /> {m.durationLabel}
                    </span>
                    <span className={`effort-pill ${m.effortLevel}`}>
                      {EFFORT_LABELS[m.effortLevel]}
                    </span>
                  </div>
                </div>

                {isEditing ? (
                  <div className="mission-edit-box">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      aria-label="Modifica titolo missione"
                    />
                    <textarea
                      rows={2}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      aria-label="Modifica descrizione missione"
                    />
                    <div className="mission-edit-actions">
                      <label>
                        Durata (min):
                        <input
                          type="number"
                          min={1}
                          max={60}
                          value={editMinutes}
                          onChange={(e) => setEditMinutes(Number(e.target.value))}
                        />
                      </label>
                      <button
                        type="button"
                        className="mini-action-btn"
                        onClick={() => saveEdit(m.id)}
                      >
                        Salva modifica
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => setEditingId(null)}
                      >
                        Annulla
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mission-info">
                    <h3>{m.title}</h3>
                    <p>{m.description}</p>
                    <div className="mission-goal-line">
                      <strong>Obiettivo:</strong> {m.goal}
                    </div>
                    <ol className="mission-steps">
                      {m.instructions.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    {m.adaptationNote && (
                      <div className="mission-adaptation-note">{m.adaptationNote}</div>
                    )}
                  </div>
                )}

                {!isEditing && (
                  <div className="mission-actions-bar">
                    {m.status === "proposta" && (
                      <>
                        <button
                          type="button"
                          className="complete-btn"
                          onClick={() => onTransitionStatus(m.id, "accettata")}
                        >
                          <Check size={14} /> Accetta
                        </button>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => onTransitionStatus(m.id, "rifiutata")}
                        >
                          <X size={14} /> Rifiuta
                        </button>
                      </>
                    )}

                    {(m.status === "proposta" || m.status === "accettata") && (
                      <button
                        type="button"
                        className="complete-btn checked"
                        onClick={() => onTransitionStatus(m.id, "completata")}
                      >
                        <Check size={14} /> Completa
                      </button>
                    )}

                    {m.status === "accettata" && (
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => onTransitionStatus(m.id, "annullata")}
                      >
                        <PauseCircle size={14} /> Interrompi
                      </button>
                    )}

                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => startEdit(m)}
                      aria-label={`Modifica ${m.title}`}
                    >
                      <Edit3 size={13} /> Modifica
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Storico delle missioni */}
      <div className="panel history-missions-panel" data-testid="mission-history-panel">
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">STORICO DELLE MISSIONI</span>
            <h2>Attività completate, rifiutate o interrotte ({historyMissions.length})</h2>
          </div>
        </div>

        {historyMissions.length === 0 ? (
          <p className="trend-empty-state">
            Lo storico si aggiornerà man mano che completi, rifiuti o interrompi una missione.
          </p>
        ) : (
          <ul className="trend-history-list" data-testid="mission-history-list">
            {historyMissions.slice(0, 12).map((item) => (
              <li key={item.id} className="trend-history-item">
                <div className="trend-item-main">
                  <strong>{item.title}</strong>
                  <span className="mission-cat-badge">{item.category}</span>
                  <span className={`mission-status-badge ${item.status}`}>
                    {STATUS_LABELS[item.status]}
                  </span>
                </div>
                <div className="trend-item-meta">
                  <span>{item.durationLabel}</span>
                  <span>{EFFORT_LABELS[item.effortLevel]}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="chart-note">
          {consent
            ? "Memoria attiva: obiettivi e storico missioni non sensibili sono salvati localmente in questo browser."
            : "Memoria disattivata: obiettivi e storico missioni restano solo nella sessione corrente."}
        </p>
      </div>

      <div className="disclaimer">
        <ShieldCheck size={17} />
        <span>
          Le missioni sono proposte facoltative di benessere quotidiano e non sostituiscono il
          supporto di professionisti qualificati.
        </span>
      </div>
    </section>
  );
}
