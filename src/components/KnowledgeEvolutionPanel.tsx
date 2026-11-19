import { useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  History,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import type {
  EvolvedKnowledgeEntry,
  KnowledgeEntryStatus,
} from "../cognitive/knowledgeEvolutionStore";

const ALL_STATUSES: KnowledgeEntryStatus[] = [
  "proposed",
  "validated",
  "rejected",
  "superseded",
  "revoked",
  "expired",
];

const STATUS_LABELS: Record<KnowledgeEntryStatus, string> = {
  proposed: "Proposed",
  validated: "Validated",
  rejected: "Rejected",
  superseded: "Superseded",
  revoked: "Revoked",
  expired: "Expired",
};

interface PendingConfirmAction {
  type: "approve" | "reject" | "restore" | "clear";
  entryId?: string;
  version?: number;
  label: string;
}

interface KnowledgeEvolutionPanelProps {
  entries: EvolvedKnowledgeEntry[];
  learningConsent: boolean;
  crisisBlocked: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRevise: (id: string, content: string, reason: string) => void;
  onRestoreRevision: (id: string, version: number) => void;
  onExportJson: () => void;
  onClearAll: () => void;
}

export function KnowledgeEvolutionPanel({
  entries,
  learningConsent,
  crisisBlocked,
  onApprove,
  onReject,
  onRevise,
  onRestoreRevision,
  onExportJson,
  onClearAll,
}: KnowledgeEvolutionPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [activeStatus, setActiveStatus] = useState<KnowledgeEntryStatus | "all">("all");
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [reviseEntryId, setReviseEntryId] = useState<string | null>(null);
  const [reviseContent, setReviseContent] = useState("");
  const [reviseReason, setReviseReason] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);

  const filteredEntries =
    activeStatus === "all"
      ? entries
      : entries.filter((entry) => entry.status === activeStatus);

  function executeConfirmedAction() {
    if (!pendingConfirm) return;
    if (pendingConfirm.type === "approve" && pendingConfirm.entryId) {
      onApprove(pendingConfirm.entryId);
    } else if (pendingConfirm.type === "reject" && pendingConfirm.entryId) {
      onReject(pendingConfirm.entryId);
    } else if (
      pendingConfirm.type === "restore" &&
      pendingConfirm.entryId &&
      pendingConfirm.version
    ) {
      onRestoreRevision(pendingConfirm.entryId, pendingConfirm.version);
    } else if (pendingConfirm.type === "clear") {
      onClearAll();
    }
    setPendingConfirm(null);
  }

  return (
    <div className="aura-evolution-subpanel">
      <div className="aura-evolution-subpanel-header">
        <button
          type="button"
          className="aura-evolution-collapse-btn"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          <span className="aura-evolution-title-inline">
            <BookOpen size={16} />
            <strong>Knowledge Evolution ({entries.length})</strong>
          </span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        <div className="aura-evolution-actions-inline">
          <button
            type="button"
            className="aura-evolution-btn"
            onClick={onExportJson}
            disabled={!learningConsent || crisisBlocked}
          >
            <Download size={14} /> Esporta JSON
          </button>
          <button
            type="button"
            className="aura-evolution-btn aura-evolution-btn-danger"
            onClick={() =>
              setPendingConfirm({
                type: "clear",
                label:
                  "Confermi di voler cancellare tutte le conoscenze evolutive locali? AI Memory e dati operativi resteranno intatti.",
              })
            }
            disabled={crisisBlocked}
          >
            <Trash2 size={14} /> Cancella
          </button>
        </div>
      </div>

      {pendingConfirm && (
        <div className="aura-evolution-confirm-box" role="alertdialog" aria-label="Conferma operazione">
          <p>{pendingConfirm.label}</p>
          <div className="aura-evolution-actions-inline">
            <button
              type="button"
              className="aura-evolution-btn aura-evolution-btn-primary"
              onClick={executeConfirmedAction}
            >
              <Check size={14} /> Conferma esplicita
            </button>
            <button
              type="button"
              className="aura-evolution-btn"
              onClick={() => setPendingConfirm(null)}
            >
              <X size={14} /> Annulla
            </button>
          </div>
        </div>
      )}

      {!expanded ? null : !learningConsent ? (
        <div className="aura-evolution-notice">
          <ShieldAlert size={15} />
          <span>
            Consenso apprendimento OFF: lettura e modifica delle conoscenze sono bloccate. Puoi
            comunque cancellare i dati salvati tramite il pulsante &quot;Cancella&quot; con conferma
            esplicita.
          </span>
        </div>
      ) : (
        <div className="aura-evolution-knowledge-body">
          <div className="aura-evolution-filter-row" role="tablist" aria-label="Filtro stato conoscenze">
            <button
              type="button"
              className={`aura-evolution-filter-btn ${activeStatus === "all" ? "active" : ""}`}
              onClick={() => setActiveStatus("all")}
            >
              Tutte ({entries.length})
            </button>
            {ALL_STATUSES.map((st) => {
              const count = entries.filter((e) => e.status === st).length;
              return (
                <button
                  key={st}
                  type="button"
                  className={`aura-evolution-filter-btn ${activeStatus === st ? "active" : ""}`}
                  onClick={() => setActiveStatus(st)}
                >
                  {STATUS_LABELS[st]} ({count})
                </button>
              );
            })}
          </div>

          {filteredEntries.length === 0 ? (
            <p className="aura-evolution-muted">
              Nessuna conoscenza presente in questa categoria.
            </p>
          ) : (
            <div className="aura-evolution-entry-list">
              {filteredEntries.map((entry) => (
                <article key={entry.id} className="aura-evolution-entry-card">
                  <div className="aura-evolution-dim-head">
                    <strong>{entry.title}</strong>
                    <span className="aura-evolution-badge">
                      {STATUS_LABELS[entry.status]} · v{entry.version}
                    </span>
                  </div>
                  <p className="aura-evolution-dim-text">{entry.content}</p>
                  <div className="aura-evolution-meta-grid">
                    <span>Evidenza: {entry.evidenceType}</span>
                    <span>Confidenza: {Math.round(entry.confidence * 100)}%</span>
                    <span>Fonte: {entry.dataSource}</span>
                    <span>Creazione: {new Date(entry.timestamp).toLocaleDateString("it-IT")}</span>
                    {entry.lastVerifiedAt && (
                      <span>
                        Verifica: {new Date(entry.lastVerifiedAt).toLocaleDateString("it-IT")}
                      </span>
                    )}
                    {entry.expiresAt && (
                      <span>
                        Scadenza: {new Date(entry.expiresAt).toLocaleDateString("it-IT")}
                      </span>
                    )}
                  </div>
                  <p className="aura-evolution-muted">Nota: {entry.uncertaintyNote}</p>

                  <div className="aura-evolution-actions-inline">
                    {entry.status === "proposed" && (
                      <>
                        <button
                          type="button"
                          className="aura-evolution-btn aura-evolution-btn-primary"
                          onClick={() =>
                            setPendingConfirm({
                              type: "approve",
                              entryId: entry.id,
                              label: `Approvare esplicitamente "${entry.title}"?`,
                            })
                          }
                          disabled={crisisBlocked}
                        >
                          <Check size={14} /> Approva
                        </button>
                        <button
                          type="button"
                          className="aura-evolution-btn aura-evolution-btn-danger"
                          onClick={() =>
                            setPendingConfirm({
                              type: "reject",
                              entryId: entry.id,
                              label: `Rifiutare esplicitamente "${entry.title}"? Non potrà essere riattivata automaticamente.`,
                            })
                          }
                          disabled={crisisBlocked}
                        >
                          <X size={14} /> Rifiuta
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      className="aura-evolution-btn"
                      onClick={() =>
                        setOpenHistoryId((prev) => (prev === entry.id ? null : entry.id))
                      }
                    >
                      <History size={14} /> Storico ({entry.history.length})
                    </button>

                    {entry.status !== "rejected" && entry.status !== "expired" && (
                      <button
                        type="button"
                        className="aura-evolution-btn"
                        onClick={() => {
                          setReviseEntryId(entry.id);
                          setReviseContent(entry.content);
                          setReviseReason("");
                        }}
                        disabled={crisisBlocked}
                      >
                        Revisiona
                      </button>
                    )}
                  </div>

                  {reviseEntryId === entry.id && (
                    <div className="aura-evolution-revise-box">
                      <label className="aura-evolution-label">
                        Nuovo contenuto operativo (non sensibile):
                        <textarea
                          className="aura-evolution-textarea"
                          value={reviseContent}
                          onChange={(e) => setReviseContent(e.target.value)}
                          rows={2}
                        />
                      </label>
                      <label className="aura-evolution-label">
                        Motivo della revisione:
                        <input
                          type="text"
                          className="aura-evolution-input"
                          value={reviseReason}
                          onChange={(e) => setReviseReason(e.target.value)}
                          placeholder="Es. Aggiornamento preferenza operativa"
                        />
                      </label>
                      <div className="aura-evolution-actions-inline">
                        <button
                          type="button"
                          className="aura-evolution-btn aura-evolution-btn-primary"
                          onClick={() => {
                            if (reviseContent.trim()) {
                              onRevise(
                                entry.id,
                                reviseContent.trim(),
                                reviseReason.trim() || "Revisione manuale utente"
                              );
                            }
                            setReviseEntryId(null);
                          }}
                        >
                          Salva nuova versione
                        </button>
                        <button
                          type="button"
                          className="aura-evolution-btn"
                          onClick={() => setReviseEntryId(null)}
                        >
                          Annulla
                        </button>
                      </div>
                    </div>
                  )}

                  {openHistoryId === entry.id && (
                    <div className="aura-evolution-history-box">
                      <strong>Storico immutabile revisioni:</strong>
                      {entry.history.map((rev) => (
                        <div key={rev.version} className="aura-evolution-history-row">
                          <div>
                            <strong>v{rev.version}</strong> ({rev.actor}) ·{" "}
                            {new Date(rev.timestamp).toLocaleDateString("it-IT")}
                            <div className="aura-evolution-muted">{rev.changeReason}</div>
                          </div>
                          {rev.version !== entry.version && entry.status !== "rejected" && (
                            <button
                              type="button"
                              className="aura-evolution-btn"
                              onClick={() =>
                                setPendingConfirm({
                                  type: "restore",
                                  entryId: entry.id,
                                  version: rev.version,
                                  label: `Ripristinare la revisione v${rev.version} di "${entry.title}" come nuova versione validata?`,
                                })
                              }
                              disabled={crisisBlocked}
                            >
                              <RotateCcw size={13} /> Ripristina v{rev.version}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
