import { useState } from "react";
import { Download, Plus, Trash2, X } from "lucide-react";
import type { LongTermMemory } from "../memory/types";
import { isSafeForLongTermMemory } from "../memory/privacyFilter";

interface MemoryModalSectionProps {
  consent: boolean;
  memory: LongTermMemory;
  onUpdateMemory: (next: LongTermMemory) => void;
  onExportData: () => void;
  onDeleteMemory: () => void;
}

export function MemoryModalSection({
  consent,
  memory,
  onUpdateMemory,
  onExportData,
  onDeleteMemory,
}: MemoryModalSectionProps) {
  const [prefDraft, setPrefDraft] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [filterWarning, setFilterWarning] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  function addItem(bucket: "preferences" | "goalsAndStrategies", raw: string, clear: () => void) {
    const clean = raw.trim();
    if (!clean) return;
    if (!isSafeForLongTermMemory(clean)) {
      setFilterWarning(
        "Per la tua privacy, contenuti clinici, sanitari o di crisi non vengono salvati nella memoria."
      );
      return;
    }
    setFilterWarning(null);
    onUpdateMemory({
      ...memory,
      [bucket]: [...memory[bucket], clean],
      updatedAt: new Date().toISOString(),
    });
    clear();
  }

  function removeItem(
    bucket: "preferences" | "goalsAndStrategies" | "conversationTopics",
    index: number
  ) {
    onUpdateMemory({
      ...memory,
      [bucket]: memory[bucket].filter((_, i) => i !== index),
      updatedAt: new Date().toISOString(),
    });
  }

  function handleNotesChange(value: string) {
    if (value.trim() && !isSafeForLongTermMemory(value)) {
      setFilterWarning(
        "Le note non possono contenere diagnosi, farmaci o contenuti di emergenza."
      );
      return;
    }
    setFilterWarning(null);
    onUpdateMemory({
      ...memory,
      userNotes: value.slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
  }

  function handleExport() {
    onExportData();
    setActionNotice("Dati esportati in formato JSON.");
  }

  function handleConfirmDelete() {
    onDeleteMemory();
    setConfirmDelete(false);
    setFilterWarning(null);
    setActionNotice("Memoria locale eliminata completamente.");
  }

  const hasAnyStoredItems =
    memory.preferences.length > 0 ||
    memory.goalsAndStrategies.length > 0 ||
    memory.conversationTopics.length > 0 ||
    memory.completedMissions.length > 0 ||
    memory.userNotes.trim().length > 0;

  return (
    <div className="memory-section">
      <div className="memory-header-row">
        <div>
          <span className="eyebrow">AURA MEMORY ENGINE</span>
          <h3>Memoria consultabile e modificabile</h3>
        </div>
        <span className={`memory-badge ${consent ? "active" : "inactive"}`}>
          {consent ? "MEMORIA ATTIVA" : "MEMORIA DISATTIVATA"}
        </span>
      </div>

      {!consent ? (
        <p className="memory-empty-note">
          La memoria è disattivata. Senza consenso esplicito, AURA non conserva conversazioni,
          preferenze o check-in dopo la chiusura della pagina.
        </p>
      ) : (
        <>
          <div className="memory-group">
            <label className="memory-label">Preferenze condivise</label>
            <div className="memory-chips">
              {memory.preferences.length === 0 ? (
                <span className="memory-placeholder">Nessuna preferenza salvata.</span>
              ) : (
                memory.preferences.map((item, idx) => (
                  <span key={`${item}-${idx}`} className="memory-chip">
                    <span>{item}</span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Rimuovi preferenza ${item}`}
                      onClick={() => removeItem("preferences", idx)}
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
                value={prefDraft}
                onChange={(e) => setPrefDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addItem("preferences", prefDraft, () => setPrefDraft(""));
                  }
                }}
                placeholder="Aggiungi o correggi una preferenza..."
                aria-label="Nuova preferenza"
              />
              <button
                type="button"
                className="mini-action-btn"
                onClick={() => addItem("preferences", prefDraft, () => setPrefDraft(""))}
                disabled={!prefDraft.trim()}
              >
                <Plus size={13} /> Aggiungi
              </button>
            </div>
          </div>

          <div className="memory-group">
            <label className="memory-label">Obiettivi e strategie di benessere</label>
            <div className="memory-chips">
              {memory.goalsAndStrategies.length === 0 ? (
                <span className="memory-placeholder">Nessun obiettivo salvato.</span>
              ) : (
                memory.goalsAndStrategies.map((item, idx) => (
                  <span key={`${item}-${idx}`} className="memory-chip">
                    <span>{item}</span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Rimuovi obiettivo ${item}`}
                      onClick={() => removeItem("goalsAndStrategies", idx)}
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
                    addItem("goalsAndStrategies", goalDraft, () => setGoalDraft(""));
                  }
                }}
                placeholder="Aggiungi obiettivo o strategia utile..."
                aria-label="Nuovo obiettivo o strategia"
              />
              <button
                type="button"
                className="mini-action-btn"
                onClick={() => addItem("goalsAndStrategies", goalDraft, () => setGoalDraft(""))}
                disabled={!goalDraft.trim()}
              >
                <Plus size={13} /> Aggiungi
              </button>
            </div>
          </div>

          <div className="memory-group">
            <label className="memory-label">Riepilogo temi recenti</label>
            <div className="memory-chips">
              {memory.conversationTopics.length === 0 ? (
                <span className="memory-placeholder">Nessun tema registrato.</span>
              ) : (
                memory.conversationTopics.map((item, idx) => (
                  <span key={`${item}-${idx}`} className="memory-chip">
                    <span>{item}</span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Rimuovi tema ${item}`}
                      onClick={() => removeItem("conversationTopics", idx)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          {memory.completedMissions.length > 0 && (
            <div className="memory-group">
              <label className="memory-label">Missioni completate registrate</label>
              <div className="memory-missions-line">{memory.completedMissions.join(" · ")}</div>
            </div>
          )}

          <div className="memory-group">
            <label className="memory-label" htmlFor="aura-user-notes">
              Correzioni o note personali per AURA
            </label>
            <textarea
              id="aura-user-notes"
              className="memory-notes"
              rows={2}
              value={memory.userNotes}
              onChange={(e) => handleNotesChange(e.target.value)}
              placeholder="Es. Preferisco esercizi brevi la sera; correggi qui ciò che AURA deve ricordare..."
            />
          </div>

          {!hasAnyStoredItems && (
            <p className="memory-empty-note">
              La memoria è attiva ma ancora vuota: si aggiornerà automaticamente durante le tue
              conversazioni sicure o con le note qui sopra.
            </p>
          )}
        </>
      )}

      {filterWarning && <div className="memory-warning">{filterWarning}</div>}
      {actionNotice && <div className="memory-notice">{actionNotice}</div>}

      <div className="memory-actions-row">
        <button type="button" className="secondary-btn" onClick={handleExport}>
          <Download size={14} /> ESPORTA I MIEI DATI
        </button>

        {!confirmDelete ? (
          <button
            type="button"
            className="danger-btn"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} /> ELIMINA MEMORIA
          </button>
        ) : (
          <div className="confirm-delete-group">
            <button type="button" className="danger-btn solid" onClick={handleConfirmDelete}>
              Conferma eliminazione
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setConfirmDelete(false)}
            >
              Annulla
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
