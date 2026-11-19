import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Play,
  ShieldAlert,
  ShieldCheck,
  Square,
  Wrench,
} from "lucide-react";
import { runOrchestration } from "../orchestration/orchestrationEngine";
import { createDefaultAuraToolRegistry } from "../orchestration/toolRegistry";
import type { OrchestrationRun } from "../orchestration/types";

interface OrchestrationDashboardProps {
  consent: boolean;
  crisisBlocked: boolean;
}

const RISK_COLORS: Record<string, string> = {
  BASSO: "#10b981",
  MEDIO: "#f59e0b",
  ALTO: "#ef4444",
};

export function OrchestrationDashboard({
  consent,
  crisisBlocked,
}: OrchestrationDashboardProps) {
  const registry = useMemo(() => createDefaultAuraToolRegistry(), []);
  const tools = useMemo(() => registry.list(), [registry]);

  const [requestInput, setRequestInput] = useState("");
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId]
  );

  async function executeRequest(
    requestText: string,
    approvedStepIds: string[] = []
  ) {
    if (!requestText.trim() || crisisBlocked) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    try {
      const result = await runOrchestration(
        {
          request: requestText.trim(),
          consentEnabled: consent,
          crisisBlocked,
          approvedStepIds,
          signal: controller.signal,
        },
        registry
      );
      setRuns((prev) => [result, ...prev].slice(0, 20));
      setSelectedRunId(result.id);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStopProcess() {
    abortRef.current?.abort();
    setRunning(false);
  }

  const completedRunsCount = runs.filter((r) => r.status === "completed").length;
  const awaitingApprovalCount = runs.filter(
    (r) => r.status === "awaiting_approval"
  ).length;
  const errorCount = runs.reduce((acc, r) => acc + r.errors.length, 0);

  return (
    <section className="content" aria-label="Dashboard Orchestrazione Strumenti AURA">
      <div className="page-heading">
        <span className="eyebrow">AURA V3 / TOOL ORCHESTRATION ENGINE</span>
        <h1>Orchestrazione strumenti.</h1>
        <p>
          Coordina i motori interni di AURA in sequenza con validazione, livelli di rischio e approvazione esplicita.
        </p>
      </div>

      {crisisBlocked && (
        <div className="safety-box" role="alert">
          <ShieldCheck size={18} />
          <span>
            Il Safety Engine ha la precedenza: l&apos;orchestrazione degli strumenti è sospesa in questa sessione.
          </span>
        </div>
      )}

      {/* Metriche operative */}
      <div className="grid three">
        <div className="metric-card">
          <div className="metric-top">
            <span>STRUMENTI REGISTRATI</span>
            <Wrench size={17} />
          </div>
          <div className="metric-value">{tools.length}</div>
          <span className="metric-caption">Motori interni verificati</span>
        </div>

        <div className="metric-card">
          <div className="metric-top">
            <span>COMPLETATE / IN ATTESA</span>
            <Check size={17} />
          </div>
          <div className="metric-value">
            {completedRunsCount}
            <small> / {awaitingApprovalCount} in attesa</small>
          </div>
          <span className="metric-caption">
            {running ? "Operazione in corso..." : "Sistema pronto"}
          </span>
        </div>

        <div className="metric-card">
          <div className="metric-top">
            <span>ERRORI TRACCIATI</span>
            <AlertTriangle size={17} />
          </div>
          <div className="metric-value">{errorCount}</div>
          <span className="metric-caption">
            {consent ? "Consenso memoria attivo" : "Memoria disattivata"}
          </span>
        </div>
      </div>

      {/* Avvio nuova orchestrazione */}
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void executeRequest(requestInput);
        }}
        style={{ display: "grid", gap: "10px" }}
      >
        <div className="panel-head">
          <div>
            <span className="eyebrow">ESEGUI COORDINAMENTO</span>
            <h2>Avvia una richiesta multi-strumento</h2>
          </div>
          <span className="panel-icon"><Cpu size={19} /></span>
        </div>

        <label className="field-label" htmlFor="orch-request-input">
          Richiesta per l&apos;orchestratore
        </label>
        <input
          id="orch-request-input"
          type="text"
          value={requestInput}
          onChange={(e) => setRequestInput(e.target.value)}
          placeholder="Es. Analizza il mio obiettivo e crea un piano settimanale con micro-missioni"
          style={{
            padding: "10px 12px",
            borderRadius: "10px",
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(255,255,255,0.04)",
            color: "inherit",
          }}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <button
            type="submit"
            className="primary-btn"
            disabled={running || crisisBlocked || !requestInput.trim()}
          >
            <Play size={15} /> {running ? "Esecuzione in corso..." : "Esegui orchestrazione"}
          </button>

          {running && (
            <button
              type="button"
              className="mood"
              style={{ borderColor: "#ef4444", color: "#ef4444" }}
              onClick={handleStopProcess}
            >
              <Square size={14} /> Interrompi processo
            </button>
          )}
        </div>
      </form>

      {/* Dettaglio esecuzione selezionata */}
      {selectedRun && (
        <div className="panel" style={{ display: "grid", gap: "12px" }}>
          <div className="panel-head">
            <div>
              <span className="eyebrow">
                DETTAGLIO OPERAZIONE · {selectedRun.status.toUpperCase()}
              </span>
              <h2>{selectedRun.request}</h2>
              <p style={{ fontSize: "13px", opacity: 0.85, margin: "4px 0 0" }}>
                {selectedRun.finalSummary}
              </p>
            </div>
          </div>

          <div style={{ fontSize: "12px", opacity: 0.8 }}>
            Fasi completate: {selectedRun.completedPhases.join(" → ")}
          </div>

          <div style={{ display: "grid", gap: "8px" }}>
            {selectedRun.steps.map((step) => (
              <div
                key={step.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: "rgba(255,255,255,0.03)",
                  display: "grid",
                  gap: "6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <strong>{step.toolName}</strong>
                  <span
                    style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "999px",
                      border: `1px solid ${RISK_COLORS[step.riskLevel] ?? "#94a3b8"}`,
                      color: RISK_COLORS[step.riskLevel] ?? "#94a3b8",
                    }}
                  >
                    Rischio {step.riskLevel} · {step.status}
                  </span>
                </div>

                {step.result?.summary && (
                  <p style={{ margin: 0, fontSize: "13px", opacity: 0.85 }}>
                    {step.result.summary} ({step.result.durationMs} ms)
                  </p>
                )}

                {step.error && (
                  <p style={{ margin: 0, fontSize: "12px", color: "#f87171" }}>
                    <ShieldAlert size={13} style={{ display: "inline", marginRight: "4px" }} />
                    {step.error}
                  </p>
                )}

                {step.status === "awaiting_approval" && (
                  <div>
                    <p style={{ margin: "0 0 6px", fontSize: "12px", opacity: 0.9 }}>
                      {step.approvalReason}
                    </p>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() =>
                        void executeRequest(selectedRun.request, [step.id])
                      }
                    >
                      Approva questa operazione specifica
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strumenti disponibili + Cronologia */}
      <div className="grid two">
        <div className="panel" style={{ display: "grid", gap: "8px" }}>
          <span className="eyebrow">STRUMENTI DISPONIBILI ({tools.length})</span>
          {tools.map((tool) => (
            <div
              key={tool.id}
              style={{
                padding: "8px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.08)",
                fontSize: "13px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <strong>{tool.name}</strong>
                <span style={{ fontSize: "11px", color: RISK_COLORS[tool.riskLevel] }}>
                  {tool.riskLevel}
                </span>
              </div>
              <p style={{ margin: "2px 0 0", opacity: 0.8, fontSize: "12px" }}>
                {tool.description}
              </p>
            </div>
          ))}
        </div>

        <div className="panel" style={{ display: "grid", gap: "8px" }}>
          <span className="eyebrow">CRONOLOGIA ATTIVITÀ ({runs.length})</span>
          {runs.length === 0 ? (
            <p style={{ margin: 0, fontSize: "13px", opacity: 0.8 }}>
              Nessuna orchestrazione eseguita in questa sessione.
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                className={selectedRun?.id === r.id ? "mood selected" : "mood"}
                style={{ textAlign: "left", display: "grid", gap: "2px" }}
                onClick={() => setSelectedRunId(r.id)}
              >
                <strong>{r.request.slice(0, 60)}</strong>
                <span style={{ fontSize: "11px", opacity: 0.8 }}>
                  {r.status} · {r.steps.length} strumenti
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
