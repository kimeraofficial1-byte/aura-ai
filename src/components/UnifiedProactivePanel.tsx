import { useMemo, useRef, useState } from "react";
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

export const UNIFIED_DECISIONS_STORAGE_KEY = "aura_unified_proactive_decisions_v1";

export function loadPersistedUnifiedDecisions(): ProactiveOpportunityV2[] {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return [];
    const raw = window.sessionStorage.getItem(UNIFIED_DECISIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is ProactiveOpportunityV2 =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof item.dedupeKey === "string" &&
            typeof item.status === "string"
        )
      : [];
  } catch {
    return [];
  }
}

export function savePersistedUnifiedDecisions(decisions: ProactiveOpportunityV2[]): void {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(
        UNIFIED_DECISIONS_STORAGE_KEY,
        JSON.stringify(decisions.slice(0, 60))
      );
    }
  } catch {
    // Fail-safe: nessun blocco se sessionStorage non è disponibile
  }
}

/**
 * Applica una decisione esplicita in modo idempotente:
 * evita registrazioni duplicate in ControlledLearningEngine e non esegue mai piani/attività.
 */
export function applySingleOpportunityDecision(params: {
  decisions: ProactiveOpportunityV2[];
  item: ProactiveOpportunityV2;
  action: LearningAction;
  learningEngine: ControlledLearningEngine;
  recordedKeys?: Set<string>;
  nowMs?: number;
}): {
  recorded: boolean;
  nextDecisions: ProactiveOpportunityV2[];
  updatedItem: ProactiveOpportunityV2;
} {
  const {
    decisions,
    item,
    action,
    learningEngine,
    recordedKeys,
    nowMs = Date.now(),
  } = params;
  const actionKey = `${item.dedupeKey}::${action}`;
  const existing = decisions.find((d) => d.dedupeKey === item.dedupeKey);
  if (recordedKeys?.has(actionKey) || existing?.status === action) {
    return {
      recorded: false,
      nextDecisions: decisions,
      updatedItem: existing ?? item,
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  learningEngine.recordInteraction(item.category, action, nowIso);
  recordedKeys?.add(actionKey);

  const updatedItem: ProactiveOpportunityV2 = {
    ...item,
    status: action,
    cooldownUntil:
      action === "snoozed"
        ? new Date(nowMs + 6 * 3600_000).toISOString()
        : action === "rejected" || action === "suspended"
          ? new Date(nowMs + 72 * 3600_000).toISOString()
          : undefined,
  };

  const nextDecisions = [
    updatedItem,
    ...decisions.filter((d) => d.dedupeKey !== item.dedupeKey),
  ];

  return {
    recorded: true,
    nextDecisions,
    updatedItem,
  };
}

interface UnifiedProactivePanelProps {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  availableMinutes: number;
  energyLevel: EnergyLevel;
  consent: boolean;
  crisisBlocked: boolean;
  learningEngine: ControlledLearningEngine;
  onDecisionRecorded?: () => void;
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
  onDecisionRecorded,
}: UnifiedProactivePanelProps) {
  const [decisions, setDecisions] = useState<ProactiveOpportunityV2[]>(() =>
    loadPersistedUnifiedDecisions()
  );
  const recordedKeysRef = useRef<Set<string>>(
    new Set(decisions.map((d) => `${d.dedupeKey}::${d.status}`))
  );
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

  const acceptedInSession = decisions.filter((d) => d.status === "accepted");

  function recordDecision(item: ProactiveOpportunityV2, action: LearningAction) {
    setDecisions((prev) => {
      const outcome = applySingleOpportunityDecision({
        decisions: prev,
        item,
        action,
        learningEngine,
        recordedKeys: recordedKeysRef.current,
      });
      if (!outcome.recorded) {
        return prev;
      }
      savePersistedUnifiedDecisions(outcome.nextDecisions);
      return outcome.nextDecisions;
    });

    setPendingConfirm(null);
    if (expandedId === item.id) {
      setExpandedId(null);
    }
    onDecisionRecorded?.();

    const labels: Record<LearningAction, string> = {
      accepted:
        "Proposta accettata e registrata una sola volta (nessuna esecuzione automatica di piani o attività).",
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
        <p
          role="status"
          style={{ marginBottom: "0.75rem", fontSize: "0.86rem", opacity: 0.95, color: "#83dcb9" }}
        >
          {feedbackNotice}
        </p>
      )}

      {analysis.opportunities.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {analysis.opportunities.slice(0, 4).map((item) => {
            const isPendingHere = pendingConfirm?.id === item.id;
            return (
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

                {isPendingHere && pendingConfirm && (
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
                      Accettare &ldquo;{pendingConfirm.title}&rdquo;? Nessuna modifica operativa o esecuzione automatica viene applicata.
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
            );
          })}
        </div>
      )}

      {acceptedInSession.length > 0 && (
        <div className="aura-accepted-list" aria-label="Proposte accettate in sessione">
          <strong>
            Proposte accettate ({acceptedInSession.length}) — nessuna esecuzione automatica
          </strong>
          {acceptedInSession.map((acceptedItem) => (
            <div key={acceptedItem.dedupeKey} className="aura-accepted-row">
              <span>{acceptedItem.title}</span>
              <span className="aura-accepted-badge">Accettata</span>
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
