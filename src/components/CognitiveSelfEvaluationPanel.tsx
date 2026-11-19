import { useState } from "react";
import { Activity, ChevronDown, ChevronUp, RefreshCw, ShieldAlert } from "lucide-react";
import type { CognitiveSelfEvaluationReport } from "../cognitive/cognitiveSelfEvaluation";

interface CognitiveSelfEvaluationPanelProps {
  report: CognitiveSelfEvaluationReport | null;
  learningConsent: boolean;
  crisisBlocked: boolean;
  onRunEvaluation: () => void;
}

export function CognitiveSelfEvaluationPanel({
  report,
  learningConsent,
  crisisBlocked,
  onRunEvaluation,
}: CognitiveSelfEvaluationPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const canRun = learningConsent && !crisisBlocked;

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
            <Activity size={16} />
            <strong>Autovalutazione Cognitiva</strong>
          </span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        <button
          type="button"
          className="aura-evolution-btn aura-evolution-btn-primary"
          onClick={onRunEvaluation}
          disabled={!canRun}
        >
          <RefreshCw size={14} /> Avvia autovalutazione
        </button>
      </div>

      {!expanded ? null : !learningConsent ? (
        <div className="aura-evolution-notice">
          <ShieldAlert size={15} />
          <span>
            Consenso apprendimento OFF: l&apos;autovalutazione cognitiva è bloccata dal Learning
            Safety Guard.
          </span>
        </div>
      ) : crisisBlocked ? (
        <div className="aura-evolution-notice aura-evolution-notice-danger">
          <ShieldAlert size={15} />
          <span>
            Stato di crisi attivo: il Safety System blocca ogni autovalutazione.
          </span>
        </div>
      ) : !report ? (
        <p className="aura-evolution-muted">
          Nessuna autovalutazione eseguita in questa sessione. Premi &quot;Avvia autovalutazione&quot;
          per analizzare localmente le 5 dimensioni (nessun timer in background, nessun invio a
          Gemini).
        </p>
      ) : (
        <div className="aura-evolution-eval-body">
          <div className="aura-evolution-meta-row">
            <span>
              Stato:{" "}
              <strong>
                {report.status === "completed"
                  ? "Completata"
                  : report.status === "insufficient_data"
                    ? "Dati insufficienti"
                    : "Bloccata"}
              </strong>
            </span>
            <span>Affidabilità: {Math.round(report.confidence * 100)}%</span>
            <span>Fonte: {report.dataSource}</span>
          </div>

          <p className="aura-evolution-muted">{report.uncertaintyNote}</p>

          <div className="aura-evolution-dimensions">
            {/* 1. Utilità suggerimenti */}
            <div className="aura-evolution-dim-card">
              <div className="aura-evolution-dim-head">
                <strong>1. Utilità dei suggerimenti</strong>
                <span className="aura-evolution-badge">
                  {report.metrics.suggestionUtility.evaluable ? "Valutabile" : "Non valutabile"}
                </span>
              </div>
              {report.metrics.suggestionUtility.evaluable ? (
                <p className="aura-evolution-dim-text">
                  Rapporto positivo:{" "}
                  <strong>
                    {report.metrics.suggestionUtility.positiveRatio !== null
                      ? `${Math.round(report.metrics.suggestionUtility.positiveRatio * 100)}%`
                      : "N/D"}
                  </strong>{" "}
                  (accettati: {report.metrics.suggestionUtility.accepted}, completati:{" "}
                  {report.metrics.suggestionUtility.completed}, rifiutati:{" "}
                  {report.metrics.suggestionUtility.rejected}, sospesi:{" "}
                  {report.metrics.suggestionUtility.suspended})
                </p>
              ) : (
                <p className="aura-evolution-muted">{report.metrics.suggestionUtility.note}</p>
              )}
            </div>

            {/* 2. Precisione operativa */}
            <div className="aura-evolution-dim-card">
              <div className="aura-evolution-dim-head">
                <strong>2. Precisione operativa</strong>
                <span className="aura-evolution-badge">
                  {report.metrics.operationalAccuracy.evaluable ? "Valutabile" : "Non valutabile"}
                </span>
              </div>
              {report.metrics.operationalAccuracy.evaluable ? (
                <p className="aura-evolution-dim-text">
                  MAE: {report.metrics.operationalAccuracy.meanAbsoluteErrorMinutes} min ·
                  Affidabilità:{" "}
                  {report.metrics.operationalAccuracy.reliability !== null
                    ? `${Math.round(report.metrics.operationalAccuracy.reliability * 100)}%`
                    : "N/D"}{" "}
                  ({report.metrics.operationalAccuracy.sampleCount} campioni)
                </p>
              ) : (
                <p className="aura-evolution-muted">{report.metrics.operationalAccuracy.note}</p>
              )}
            </div>

            {/* 3. Qualità strategie */}
            <div className="aura-evolution-dim-card">
              <div className="aura-evolution-dim-head">
                <strong>3. Qualità delle strategie</strong>
                <span className="aura-evolution-badge">
                  {report.metrics.strategyQuality.evaluable ? "Valutabile" : "Non valutabile"}
                </span>
              </div>
              {report.metrics.strategyQuality.evaluable ? (
                <p className="aura-evolution-dim-text">
                  Strategia consigliata:{" "}
                  <strong>{report.metrics.strategyQuality.recommendedStrategy}</strong> · STANDARD:{" "}
                  {report.metrics.strategyQuality.STANDARD.weight ?? "N/D"} · LIGHT:{" "}
                  {report.metrics.strategyQuality.LIGHT.weight ?? "N/D"} · DEFERRED:{" "}
                  {report.metrics.strategyQuality.DEFERRED.weight ?? "N/D"}
                </p>
              ) : (
                <p className="aura-evolution-muted">{report.metrics.strategyQuality.note}</p>
              )}
            </div>

            {/* 4. Sicurezza */}
            <div className="aura-evolution-dim-card">
              <div className="aura-evolution-dim-head">
                <strong>4. Sicurezza</strong>
                <span className="aura-evolution-badge">
                  {report.metrics.safetyMetrics.evaluable ? "Valutabile" : "Non valutabile"}
                </span>
              </div>
              {report.metrics.safetyMetrics.evaluable ? (
                <p className="aura-evolution-dim-text">
                  Eventi audit: {report.metrics.safetyMetrics.totalAuditEvents} · Rollback:{" "}
                  {report.metrics.safetyMetrics.rollbackCount} · Blocchi:{" "}
                  {report.metrics.safetyMetrics.blockedCount} · Revoche:{" "}
                  {report.metrics.safetyMetrics.revocationCount}
                </p>
              ) : (
                <p className="aura-evolution-muted">{report.metrics.safetyMetrics.note}</p>
              )}
            </div>

            {/* 5. Coerenza epistemica */}
            <div className="aura-evolution-dim-card">
              <div className="aura-evolution-dim-head">
                <strong>5. Coerenza epistemica</strong>
                <span className="aura-evolution-badge">
                  {report.metrics.epistemicCoherence.evaluable ? "Valutabile" : "Non valutabile"}
                </span>
              </div>
              {report.metrics.epistemicCoherence.evaluable ? (
                <p className="aura-evolution-dim-text">
                  Fatti osservati: {report.metrics.epistemicCoherence.observedFacts} ·
                  Interpretazioni prudenti:{" "}
                  {report.metrics.epistemicCoherence.prudentInterpretations} · Ipotesi da
                  verificare: {report.metrics.epistemicCoherence.hypothesesToVerify}
                </p>
              ) : (
                <p className="aura-evolution-muted">{report.metrics.epistemicCoherence.note}</p>
              )}
            </div>
          </div>

          {report.evaluationLimits.length > 0 && (
            <div className="aura-evolution-limits">
              <strong>Limiti dell&apos;analisi:</strong>
              <ul>
                {report.evaluationLimits.map((lim, idx) => (
                  <li key={idx}>{lim}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
