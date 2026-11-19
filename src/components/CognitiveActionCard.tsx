import { Check, ShieldAlert, X } from "lucide-react";
import type { PendingCognitiveAction } from "../cognitive/chatBridge";

interface CognitiveActionCardProps {
  action: PendingCognitiveAction;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CognitiveActionCard({
  action,
  busy = false,
  onConfirm,
  onCancel,
}: CognitiveActionCardProps) {
  return (
    <div
      className="panel"
      role="region"
      aria-label="Conferma azione operativa proposta"
      style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}
    >
      <div className="panel-head">
        <div>
          <span className="eyebrow">CONFERMA OPERATIVA · {action.intent}</span>
          <h3>Azione proposta in attesa di autorizzazione</h3>
        </div>
        <span className="panel-icon">
          <ShieldAlert size={18} />
        </span>
      </div>
      <p style={{ marginBottom: "0.5rem" }}>{action.description}</p>
      <p style={{ fontSize: "0.85rem", opacity: 0.8, marginBottom: "0.75rem" }}>
        Richiesta: &ldquo;{action.originalInput}&rdquo; · Engine:{" "}
        {action.engines.join(", ")}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="primary-btn"
          onClick={onConfirm}
          disabled={busy}
        >
          <Check size={15} /> Conferma ed esegui
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={onCancel}
          disabled={busy}
        >
          <X size={15} /> Annulla
        </button>
      </div>
    </div>
  );
}
