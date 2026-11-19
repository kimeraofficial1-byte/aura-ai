import { AlertTriangle, Sparkles } from "lucide-react";
import type { EmotionCategory, EmotionalAnalysis } from "../emotion/types";

interface EmotionIndicatorProps {
  analysis: EmotionalAnalysis;
}

export function getEmotionToneClass(emotion: EmotionCategory): string {
  switch (emotion) {
    case "Gioia":
    case "Serenità":
      return "mint";
    case "Ansia":
    case "Paura":
    case "Rabbia":
      return "rose";
    case "Tristezza":
    case "Frustrazione":
    case "Solitudine":
    case "Stanchezza":
    case "Confusione":
    case "Incerto":
      return "amber";
    case "Neutro":
    default:
      return "cyan";
  }
}

export function EmotionIndicator({ analysis }: EmotionIndicatorProps) {
  const confidencePct = Math.round(analysis.confidence * 100);
  const toneClass = getEmotionToneClass(analysis.primaryEmotion);

  return (
    <div
      className={`emotion-indicator ${analysis.uncertain ? "is-uncertain" : ""}`}
      data-testid="emotion-indicator"
      role="status"
      aria-live="polite"
    >
      <div className="emotion-indicator-main">
        <div className="emotion-indicator-title">
          <Sparkles size={14} />
          <span className="emotion-kicker">ANALISI EMOTIVA</span>
          <strong className={`emotion-primary ${toneClass}`} data-testid="emotion-primary">
            {analysis.primaryEmotion}
          </strong>
          {analysis.secondaryEmotions.length > 0 && (
            <span className="emotion-secondary">
              · Secondarie: {analysis.secondaryEmotions.join(", ")}
            </span>
          )}
        </div>

        <div className="emotion-metrics-inline">
          <div className="emotion-metric-item">
            <span>Intensità</span>
            <strong data-testid="emotion-intensity">{analysis.intensity}/10</strong>
            <div className="emotion-intensity-bar" aria-hidden="true">
              <i
                className={toneClass}
                style={{ width: `${Math.max(6, analysis.intensity * 10)}%` }}
              />
            </div>
          </div>

          <div className="emotion-metric-item">
            <span>Confidenza</span>
            <strong data-testid="emotion-confidence">{confidencePct}%</strong>
          </div>
        </div>
      </div>

      {analysis.uncertain && (
        <div className="emotion-uncertain-alert" data-testid="emotion-uncertain-alert">
          <AlertTriangle size={14} />
          <span>
            Lettura emotiva incerta (confidenza {confidencePct}%): il messaggio è sfumato o
            ambivalente, AURA verifica con tatto senza assumere conclusioni.
          </span>
        </div>
      )}

      {analysis.stressSignals.length > 0 && (
        <div className="emotion-signals-row">
          <span>Segnali di carico:</span> {analysis.stressSignals.join(" · ")}
        </div>
      )}
    </div>
  );
}
