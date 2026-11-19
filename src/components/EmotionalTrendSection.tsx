import { Activity, AlertTriangle, Clock } from "lucide-react";
import type { EmotionalTrendEntry } from "../emotion/types";
import { getEmotionToneClass } from "./EmotionIndicator";

interface EmotionalTrendSectionProps {
  trends: EmotionalTrendEntry[];
  consent: boolean;
}

function formatTrendDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function EmotionalTrendSection({ trends, consent }: EmotionalTrendSectionProps) {
  const chartItems = trends.slice(-12);
  const recentHistory = [...trends].reverse().slice(0, 8);

  return (
    <div className="panel progress-panel emotional-trend-panel" data-testid="emotional-trend-panel">
      <div className="panel-head">
        <div>
          <span className="eyebrow">EMOTIONAL TREND</span>
          <h2>Andamento emotivo nel tempo</h2>
        </div>
        <span className="panel-icon">
          <Activity size={19} />
        </span>
      </div>

      {trends.length === 0 ? (
        <p className="trend-empty-state">
          Nessuna rilevazione emotiva registrata finora. Scrivi in Conversazione o salva un
          check-in per osservare l'andamento delle tue emozioni e della loro intensità.
        </p>
      ) : (
        <>
          <div className="chart-placeholder trend-chart">
            <div className="chart-y">
              <span>10</span>
              <span>5</span>
              <span>0</span>
            </div>
            <div className="chart-area">
              <div className="chart-grid">
                <i />
                <i />
                <i />
              </div>
              <div className="chart-bars">
                {chartItems.map((item) => {
                  const tone = getEmotionToneClass(item.primaryEmotion);
                  const confPct = Math.round(item.confidence * 100);
                  const shortLabel = item.primaryEmotion.slice(0, 5);
                  return (
                    <div
                      key={item.id}
                      className="chart-bar-wrap trend-bar-wrap"
                      title={`${item.primaryEmotion} · Intensità ${item.intensity}/10 · Confidenza ${confPct}% (${formatTrendDate(item.date)})`}
                    >
                      <i
                        className={`trend-bar ${tone}`}
                        style={{ height: `${Math.max(8, item.intensity * 10)}%` }}
                      />
                      <span>{shortLabel}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="trend-history-block">
            <div className="trend-history-head">
              <Clock size={13} />
              <span>STORICO RECENTE ({trends.length})</span>
            </div>
            <ul className="trend-history-list" data-testid="emotional-trend-history">
              {recentHistory.map((entry) => {
                const tone = getEmotionToneClass(entry.primaryEmotion);
                const confPct = Math.round(entry.confidence * 100);
                return (
                  <li key={entry.id} className="trend-history-item">
                    <div className="trend-item-main">
                      <strong className={`trend-emotion ${tone}`}>{entry.primaryEmotion}</strong>
                      {entry.secondaryEmotions.length > 0 && (
                        <span className="trend-secondary">
                          + {entry.secondaryEmotions.join(", ")}
                        </span>
                      )}
                      {entry.uncertain && (
                        <span className="trend-uncertain-tag">
                          <AlertTriangle size={11} /> Incerto
                        </span>
                      )}
                    </div>
                    <div className="trend-item-meta">
                      <span>Intensità {entry.intensity}/10</span>
                      <span>Conf. {confPct}%</span>
                      <span>{entry.source === "checkin" ? "Check-in" : "Chat"}</span>
                      <span>{formatTrendDate(entry.date)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      <p className="chart-note">
        {consent
          ? "Memoria attiva: l'andamento emotivo non sensibile viene salvato localmente in questo browser. Messaggi di crisi o clinici non vengono mai salvati."
          : "Memoria disattivata: l'andamento resta visibile solo durante la sessione corrente e non viene conservato."}
      </p>
    </div>
  );
}
