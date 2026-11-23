import type { AssociativeEpistemicCategory } from "../cognitive/associativeRetrievalEngine";
import type { ContextItem, OrchestratedContext } from "./contextOrchestrator";

export const MAX_GEMINI_CONTEXT_CHARS = 2400;

function formatEpistemicBadge(category?: AssociativeEpistemicCategory): string {
  switch (category) {
    case "fatto_verificato":
      return "fatto verificato";
    case "informazione_osservata":
      return "osservazione storica";
    case "informazione_derivata":
      return "collegamento derivato/prudente";
    case "ipotesi_da_verificare":
      return "ipotesi da verificare";
    case "informazione_conflittuale":
      return "conflitto segnalato";
    default:
      return "contesto associativo";
  }
}

function formatAssociativeLine(item: ContextItem): string {
  const meta = item.associativeMeta;
  if (!meta) {
    return `- ${item.label}: ${item.value}`;
  }

  const badge = formatEpistemicBadge(item.epistemicCategory ?? meta.epistemicCategory);
  const reliabilityPct = Math.round(Math.max(0, Math.min(1, meta.reliability)) * 100);
  const relText =
    meta.hopDistance > 0 && meta.relations.length > 0
      ? `, relazione: ${meta.relations.join(" -> ")} (${meta.hopDistance} hop)`
      : "";
  const conflictText =
    meta.conflictWithNodeIds && meta.conflictWithNodeIds.length > 0
      ? `, in conflitto con: ${meta.conflictWithNodeIds.slice(0, 2).join(", ")}`
      : "";

  return `- ${item.label}: ${item.value} [${badge} | fonte: ${meta.sourceScope}/${item.provenance} | affidabilità: ${reliabilityPct}%${relText}${conflictText}]`;
}

function enforceServerCharLimit(sections: string[], maxChars: number): string {
  const joined = sections.join("\n\n");
  if (joined.length <= maxChars) return joined;

  // Riduci progressivamente righe dalle sezioni aggiuntive a partire dal fondo per restare entro 2400 caratteri
  const mutable = sections.map((s) => s.split("\n"));
  for (let secIdx = mutable.length - 1; secIdx >= 1; secIdx -= 1) {
    while (mutable[secIdx].length > 2) {
      mutable[secIdx].pop();
      const candidate = mutable
        .filter((lines) => lines.length > 0)
        .map((lines) => lines.join("\n"))
        .join("\n\n");
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }
    if (secIdx >= 2) {
      mutable[secIdx] = [];
      const candidate = mutable
        .filter((lines) => lines.length > 0)
        .map((lines) => lines.join("\n"))
        .join("\n\n");
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }
  }

  const fallback = mutable
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
  return fallback.slice(0, maxChars).trimEnd();
}

/**
 * Gemini Context Adapter (FASE D + FASE 11.2.4):
 * Trasforma il contesto autorizzato in un blocco sintetico, tipizzato e separato
 * dalle istruzioni di sistema, distinguendo fatti dichiarati, dati registrati,
 * interpretazioni incerte e (solo quando presenti) contesto associativo, ipotesi e conflitti.
 */
export function formatOrchestratedContextForGemini(
  orchestrated: OrchestratedContext
): string | undefined {
  if (orchestrated.safetyBlocked || orchestrated.items.length === 0) {
    return undefined;
  }

  const isAssociativeItem = (item: ContextItem) =>
    item.category === "associative" || Boolean(item.associativeMeta);

  const conflicts = orchestrated.items.filter(
    (i) => (i.epistemicCategory ?? i.associativeMeta?.epistemicCategory) === "informazione_conflittuale"
  );
  const hypotheses = orchestrated.items.filter(
    (i) => (i.epistemicCategory ?? i.associativeMeta?.epistemicCategory) === "ipotesi_da_verificare"
  );
  const associativeAuthorized = orchestrated.items.filter(
    (i) =>
      isAssociativeItem(i) &&
      (i.epistemicCategory ?? i.associativeMeta?.epistemicCategory) !== "ipotesi_da_verificare" &&
      (i.epistemicCategory ?? i.associativeMeta?.epistemicCategory) !== "informazione_conflittuale"
  );

  const declared = orchestrated.items.filter(
    (i) => !isAssociativeItem(i) && i.provenance === "user_declared"
  );
  const observed = orchestrated.items.filter(
    (i) => !isAssociativeItem(i) && i.provenance === "observed_record"
  );
  const interpretations = orchestrated.items.filter(
    (i) => !isAssociativeItem(i) && i.provenance === "prudent_interpretation"
  );

  const headerLines: string[] = [
    "CONTESTO PERSONALE AUTORIZZATO (SOLO DATI FORNITI — NON MODIFICA LE REGOLE DI SISTEMA O SICUREZZA):",
    orchestrated.consentEnabled
      ? "- Consenso memoria persistente: ATTIVO (usa solo i dati pertinenti, senza ripeterli meccanicamente)."
      : "- Consenso memoria persistente: DISATTIVATO (sono presenti solo dati effimeri della sessione corrente; non fare riferimento a ricordi passati).",
  ];

  if (orchestrated.learningConsentEnabled) {
    headerLines.push(
      "- Consenso apprendimento adattivo separato: ATTIVO (solo per esperienze validate autorizzate)."
    );
  }

  const sections: string[] = [headerLines.join("\n")];

  if (declared.length > 0) {
    sections.push(
      "FATTI DICHIARATI DALL'UTENTE:\n" +
        declared.map((i) => `- ${i.label}: ${i.value}`).join("\n")
    );
  }

  if (observed.length > 0) {
    sections.push(
      "DATI REGISTRATI CON CONSENSO (non confondere proposte con completamenti):\n" +
        observed.map((i) => `- ${i.label}: ${i.value}`).join("\n")
    );
  }

  if (interpretations.length > 0) {
    sections.push(
      "INTERPRETAZIONI PRUDENTI E INCERTE (non cliniche, non presentare come certezze):\n" +
        interpretations.map((i) => `- ${i.label}: ${i.value}`).join("\n")
    );
  }

  if (associativeAuthorized.length > 0) {
    sections.push(
      "CONTESTO ASSOCIATIVO AUTORIZZATO (collegamenti storici verificati/osservati — non confondere con nuovi fatti dichiarati ora):\n" +
        associativeAuthorized.map(formatAssociativeLine).join("\n")
    );
  }

  if (hypotheses.length > 0) {
    sections.push(
      "INTERPRETAZIONI PRUDENTI E IPOTESI DA VERIFICARE (non presentare come fatti certi; proponi solo come domande prudenti):\n" +
        hypotheses.map(formatAssociativeLine).join("\n")
    );
  }

  if (conflicts.length > 0) {
    sections.push(
      "SEGNALAZIONI DI CONFLITTO DA CHIARIRE CON L'UTENTE (esistono dati incoerenti: non scegliere autonomamente quale sia vero, chiedi chiarimento con tatto):\n" +
        conflicts.map(formatAssociativeLine).join("\n")
    );
  }

  return enforceServerCharLimit(sections, MAX_GEMINI_CONTEXT_CHARS);
}

