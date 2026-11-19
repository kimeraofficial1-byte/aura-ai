import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  DataExportManager,
  DataImportManager,
  type DataRepository,
} from "../persistence/dataManagement";
import type {
  ImportPreview,
  IntegrityReport,
  OperationalDataSnapshot,
} from "../persistence/types";

interface AuraDataCenterProps {
  repository: DataRepository;
  snapshot: OperationalDataSnapshot;
  consent: boolean;
  onRefreshFromRepository: () => void;
  onOpenAiMemorySettings: () => void;
  onExportAiMemory: () => void;
  onDeleteOperationalData: () => void;
}

export function AuraDataCenter({
  repository,
  snapshot,
  consent,
  onRefreshFromRepository,
  onOpenAiMemorySettings,
  onExportAiMemory,
  onDeleteOperationalData,
}: AuraDataCenterProps) {
  const exportManager = useMemo(() => new DataExportManager(), []);
  const importManager = useMemo(() => new DataImportManager(), []);
  const storageStatus = useMemo(() => repository.getStorageStatus(), [repository]);

  const [integrityReport, setIntegrityReport] = useState<IntegrityReport | null>(null);
  const [importText, setImportText] = useState("");
  const [showImportBox, setShowImportBox] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleExportOperational() {
    const json = exportManager.exportOperationalJson(repository);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aura-dati-operativi-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function handlePreviewImport() {
    const preview = importManager.previewImport(importText, snapshot);
    setImportPreview(preview);
    setImportNotice(null);
  }

  function handleConfirmImport(mode: "merge" | "overwrite") {
    if (!importPreview || !importPreview.valid) return;
    importManager.applyImport(repository, importPreview, { mode, confirmed: true });
    onRefreshFromRepository();
    setImportPreview(null);
    setImportText("");
    setShowImportBox(false);
    setImportNotice(
      mode === "merge"
        ? "Importazione completata in modalità unione (duplicati gestiti)."
        : "Importazione completata con sovrascrittura confermata."
    );
  }

  return (
    <section className="content" aria-label="AURA Data Center">
      <div className="page-heading">
        <span className="eyebrow">AURA DATA CENTER / LOCAL-FIRST</span>
        <h1>Gestione dati e privacy.</h1>
        <p>
          I dati operativi (piani, missioni, obiettivi) restano salvati localmente su questo dispositivo e sono rigorosamente separati dalla memoria personale AI.
        </p>
      </div>

      {/* Metriche stato storage */}
      <div className="grid three">
        <div className="metric-card">
          <div className="metric-top">
            <span>STATO STORAGE</span>
            <HardDrive size={17} />
          </div>
          <div className="metric-value text-value">
            {storageStatus.available ? "Attivo" : "Sessione"}
          </div>
          <span className="metric-caption">
            {storageStatus.adapterName}
            {storageStatus.indexedDbSupported ? " + IndexedDB" : ""} · Schema v{storageStatus.schemaVersion}
          </span>
        </div>

        <div className="metric-card">
          <div className="metric-top">
            <span>DATI OPERATIVI SALVATI</span>
            <Database size={17} />
          </div>
          <div className="metric-value">
            {snapshot.plans.length + snapshot.missions.length + snapshot.growthGoals.length}
          </div>
          <span className="metric-caption">
            {snapshot.plans.length} piani · {snapshot.missions.length} missioni · {snapshot.growthGoals.length} obiettivi
          </span>
        </div>

        <div className="metric-card">
          <div className="metric-top">
            <span>MEMORIA PERSONALE AI</span>
            <ShieldCheck size={17} />
          </div>
          <div className="metric-value text-value">
            {consent ? "Consenso attivo" : "Disattivata"}
          </div>
          <span className="metric-caption">
            Ultimo salvataggio: {new Date(snapshot.updatedAt).toLocaleString("it-IT")}
          </span>
        </div>
      </div>

      {/* Azioni principali */}
      <div className="panel" style={{ display: "grid", gap: "12px" }}>
        <div className="panel-head">
          <div>
            <span className="eyebrow">OPERAZIONI LOCALI</span>
            <h2>Controllo completo dei tuoi dati</h2>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <button type="button" className="primary-btn" onClick={handleExportOperational}>
            <Download size={15} /> Esporta dati operativi
          </button>

          <button
            type="button"
            className="mood"
            onClick={() => {
              setShowImportBox((prev) => !prev);
              setImportPreview(null);
            }}
          >
            <Upload size={15} /> Importa dati
          </button>

          <button
            type="button"
            className="mood"
            onClick={() => setIntegrityReport(repository.verifyIntegrity())}
          >
            <CheckCircle2 size={15} /> Verifica integrità
          </button>

          <button type="button" className="mood" onClick={onOpenAiMemorySettings}>
            <Settings2 size={15} /> Gestisci memoria AI
          </button>

          {consent && (
            <button type="button" className="mood" onClick={onExportAiMemory}>
              <Download size={15} /> Esporta memoria AI
            </button>
          )}

          {confirmDelete ? (
            <button
              type="button"
              className="mood"
              style={{ borderColor: "#ef4444", color: "#ef4444" }}
              onClick={() => {
                onDeleteOperationalData();
                setConfirmDelete(false);
              }}
            >
              Conferma eliminazione dati operativi
            </button>
          ) : (
            <button
              type="button"
              className="mood"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} /> Elimina dati operativi
            </button>
          )}
        </div>

        {importNotice && (
          <p style={{ margin: 0, fontSize: "13px", color: "#34d399" }}>{importNotice}</p>
        )}

        {/* Risultato verifica integrità */}
        {integrityReport && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.1)",
              fontSize: "13px",
            }}
          >
            <strong>
              Integrità: {integrityReport.valid ? "OK" : "Anomalie rilevate"}
            </strong>{" "}
            · {integrityReport.validRecords}/{integrityReport.totalRecords} record validi (Schema v
            {integrityReport.schemaVersion})
            {integrityReport.issues.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                {integrityReport.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Importazione con anteprima e conferma */}
        {showImportBox && (
          <div
            style={{
              display: "grid",
              gap: "10px",
              padding: "12px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <label className="field-label" htmlFor="aura-import-json">
              Incolla il JSON esportato dei dati operativi
            </label>
            <textarea
              id="aura-import-json"
              rows={4}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"exportType":"aura_operational_data", ...}'
              style={{
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(0,0,0,0.2)",
                color: "inherit",
                fontFamily: "monospace",
                fontSize: "12px",
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <button
                type="button"
                className="primary-btn"
                disabled={!importText.trim()}
                onClick={handlePreviewImport}
              >
                Anteprima importazione
              </button>
              <button
                type="button"
                className="mood"
                onClick={() => {
                  setShowImportBox(false);
                  setImportPreview(null);
                  setImportText("");
                }}
              >
                Annulla
              </button>
            </div>

            {importPreview && (
              <div
                style={{
                  padding: "10px",
                  borderRadius: "8px",
                  border: "1px solid rgba(255,255,255,0.12)",
                  fontSize: "13px",
                  display: "grid",
                  gap: "6px",
                }}
              >
                {!importPreview.valid ? (
                  <span style={{ color: "#f87171" }}>{importPreview.error}</span>
                ) : (
                  <>
                    <strong>Anteprima pronta (Schema v{importPreview.schemaVersion})</strong>
                    <span>
                      In ingresso: {importPreview.incomingPlans} piani,{" "}
                      {importPreview.incomingMissions} missioni,{" "}
                      {importPreview.incomingGoals} obiettivi.
                    </span>
                    <span>
                      Duplicati rilevati:{" "}
                      {importPreview.duplicatePlanIds.length +
                        importPreview.duplicateMissionIds.length +
                        importPreview.duplicateGoalIds.length}
                    </span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => handleConfirmImport("merge")}
                      >
                        Conferma unione (mantieni esistenti)
                      </button>
                      <button
                        type="button"
                        className="mood"
                        style={{ borderColor: "#f59e0b", color: "#f59e0b" }}
                        onClick={() => handleConfirmImport("overwrite")}
                      >
                        Conferma sovrascrittura
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="disclaimer">
        <ShieldCheck size={17} />
        <span>
          Separazione privacy: il salvataggio locale dei piani e delle missioni non autorizza mai Gemini a utilizzarli come memoria personale AI senza il tuo consenso esplicito.
        </span>
      </div>
    </section>
  );
}
