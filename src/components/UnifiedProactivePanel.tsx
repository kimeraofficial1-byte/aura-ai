import { useMemo, useState } from "react";
import {
  Check,
  Clock,
  Info,
  PauseCircle,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import {
  generateProactiveOpportunitiesV2,
} from "../cognitive/unifiedCognitiveOrchestrator";
import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type {
  EpistemicTag,
  LearningAction,
  ProactiveOpportunityV2,
} from "../proactive/types";

interface UnifiedProactivePanelProps {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  availableMinutes: number;
  energyLevel: EnergyLevel;
  consent: boolean;
  crisisBlocked: boolean;
  learningEngine: ControlledLearningEngine;
}

function formatEpistemicBadge(tag: EpistemicTag): string {
  if (tag === "fatto_osservato") return "FATTO OSSERVATO";
  if (tag === "interpretazione_prudente") return "INTERPRETAZIONE PRUDENTE";
  return "IPOTESI DA VERIFICARE";
}

export function UnifiedProactivePanel({
  plans,
  missions,
  growthGoals,
  availableMinutes,
  energyLevel,
  consent,
  crisisBlocked,
  learningEngine,
}: UnifiedProactivePanelProps) {
  const [decisions, setDecisions] = useState<ProactiveOpportunityV2[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ProactiveOpportunityV2 | null>(null);
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);

  const analysis = useMemo(
    () =>
      generateProactiveOpportunitiesV2({
        plans,
        missions,
        growthGoals,
        availableMinutes,
        energyLevel,
        consentEnabled: consent,
        crisisBlocked,
        previousOpportunities: decisions,
        learningEngine,
      }),
    [
      plans,
      missions,
      growthGoals,
      availableMinutes,
      energyLevel,
      consent,
      crisisBlocked,
      decisions,
      learningEngine,
    ]
  );

  function recordDecision(item: ProactiveOpportunityV2, action: LearningAction) {
    const nowIso = new Date().toISOString();
    learningEngine.recordInteraction(item.category, action, nowIso);
    const updated: ProactiveOpportunityV2 = {
      ...item,
      status: action,
      cooldownUntil:
        action === "snoozed"
          ? new Date(Date.now() + 6 * 3600_000).toISOString()
          : action === "rejected" || action === "suspended"
          ? new Date(Date.now() + 72 * 3600_000).toISOString()
          : undefined,
    };
    setDecisions((prev) => [updated, ...prev.filter((d) => d.dedupeKey !== item.dedupeKey)]);
    setPendingConfirm(null);
    const labels: Record<LearningAction, string> = {
      accepted: "Proposta accettata (nessuna modifica automatica non confermata).",
      rejected: "Proposta rifiutata: non verrà riproposta nel breve periodo.",
      snoozed: "Proposta rimandata di 6 ore.",
      suspended: "Proposta sospesa.",
      completed: "Proposta segnata come completata.",
    };
    setFeedbackNotice(labels[action]);
  }

  function handleAcceptClick(item: ProactiveOpportunityV2) {
    if (item.requiresConfirmationForMutation) {
      setPendingConfirm(item);
      return;
    }
    recordDecision(item, "accepted");
  }

  return (
    <div className="panel" aria-label="Iniziative cognitive proattive V2">
      <div className="panel-head">
        <div>
          <span className="eyebrow">UNIFIED COGNITIVE INTELLIGENCE V1</span>
          <h2>Iniziative e opportunità prioritarie</h2>
        </div>
        <span className="panel-icon">
          <Sparkles size={18} />
        </span>
      </div>

      <p style={{ marginBottom: "0.75rem", fontSize: "0.92rem" }}>
        {analysis.statusMessage}
      </p>

      {feedbackNotice && (
        <p style={{ marginBottom: "0.75rem", fontSize: "0.86rem", opacity: 0.9 }}>
          {feedbackNotice}
        </p>
      )}

      {pendingConfirm && (
        <div
          className="safety-box"
          role="region"
          aria-label="Conferma esplicita proposta proattiva"
          style={{ marginBottom: "0.75rem", flexDirection: "column", alignItems: "flex-start", gap: "0.5rem" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            <ShieldAlert size={16} />
            <strong>Conferma esplicita richiesta</strong>
          </div>
          <span style={{ fontSize: "0.88rem" }}>
            Accettare &ldquo;{pendingConfirm.title}&rdquo;? Nessuna modifica operativa viene applicata senza la tua conferma esplicita.
          </span>
          <div className="aura-action-group">
            <button
              type="button"
              className="aura-action-button aura-action-button--accept"
              onClick={() => recordDecision(pendingConfirm, "accepted")}
            >
              <Check size={15} /> Conferma
            </button>
            <button
              type="button"
              className="aura-action-button aura-action-button--suspend"
              onClick={() => setPendingConfirm(null)}
            >
              <X size={15} /> Annulla
            </button>
          </div>
        </div>
      )}

      {analysis.opportunities.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {analysis.opportunities.slice(0, 4).map((item) => (
            <div
              key={item.id}
              style={{
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "12px",
                padding: "0.85rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.35rem" }}>
                <strong>{item.title}</strong>
                <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>
                  {formatEpistemicBadge(item.epistemicTag)} · Confidenza {Math.round(item.confidence * 100)}%
                </span>
              </div>
              <p style={{ fontSize: "0.88rem", marginBottom: "0.4rem" }}>{item.description}</p>
              <p style={{ fontSize: "0.8rem", opacity: 0.8, marginBottom: "0.6rem" }}>
                Motivo: {item.rationale} · Durata stimata: {item.estimatedMinutes} min · Origine: {item.dataSource}
              </p>

              {expandedId === item.id && (
                <div style={{ fontSize: "0.82rem", opacity: 0.9, marginBottom: "0.6rem", padding: "0.5rem", background: "rgba(255,255,255,0.03)", borderRadius: "8px" }}>
                  <div><strong>Benefici attesi:</strong> {item.expectedBenefits}</div>
                  <div><strong>Possibili limiti:</strong> {item.possibleLimits}</div>
                </div>
              )}

              <div className="aura-action-group">
                <button
                  type="button"
                  className="aura-action-button aura-action-button--accept"
                  onClick={() => handleAcceptClick(item)}
                >
                  <Check size={15} /> Accetta
                </button>
                <button
                  type="button"
                  className="aura-action-button aura-action-button--reject"
                  onClick={() => recordDecision(item, "rejected")}
                >
                  <X size={15} /> Rifiuta
                </button>
                <button
                  type="button"
                  className="aura-action-button aura-action-button--snooze"
                  onClick={() => recordDecision(item, "snoozed")}
                >
                  <Clock size={15} /> Rimanda
                </button>
                <button
                  type="button"
                  className="aura-action-button aura-action-button--details"
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                >
                  <Info size={15} /> Approfondisci
                </button>
                <button
                  type="button"
                  className="aura-action-button aura-action-button--suspend"
                  onClick={() => recordDecision(item, "suspended")}
                >
                  <PauseCircle size={15} /> Sospendi
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", opacity: 0.78 }}>
        {analysis.learningExplanation}
      </p>
    </div>
  );
}
