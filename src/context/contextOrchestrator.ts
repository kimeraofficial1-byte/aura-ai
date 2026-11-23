import type {
  AssociativeEpistemicCategory,
  AssociativeRetrievalEngine,
} from "../cognitive/associativeRetrievalEngine";
import {
  retrieveAssociativeContextSync,
  type AssociativeContextBundle,
  type AssociativeContextItem,
} from "../cognitive/associativeSynapticAdapter";
import type {
  AssociativeConsentScope,
  AssociativeNodeKind,
  AssociativeRelationType,
} from "../cognitive/associativeTypes";
import { buildEmotionalTrendSummaryForGemini } from "../emotion/empathy";
import type { EmotionalAnalysis, EmotionalTrendEntry } from "../emotion/types";
import { buildWeeklyReflection } from "../growth/engine";
import type { GrowthGoal } from "../growth/types";
import { buildMemorySummaryForGemini, dedupeAndCap } from "../memory/extractor";
import { isSafeForLongTermMemory, normalizeText } from "../memory/privacyFilter";
import type { CheckInRecord, LongTermMemory } from "../memory/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { ChatHistoryItem } from "../types/aura";

export type ContextProvenance =
  | "user_declared"
  | "observed_record"
  | "prudent_interpretation";

export type ContextScope = "session_ephemeral" | "persistent_authorized";

export interface ContextAssociativeMetadata {
  nodeId: string;
  kind: AssociativeNodeKind;
  sourceScope: AssociativeConsentScope;
  epistemicCategory: AssociativeEpistemicCategory;
  reliability: number;
  hopDistance: number;
  relations: AssociativeRelationType[];
  sourceEngine: string;
  conflictWithNodeIds?: string[];
  explanationSummary?: string;
}

export interface ContextItem {
  category: "memory" | "emotion" | "growth" | "mission" | "checkin" | "associative";
  label: string;
  value: string;
  provenance: ContextProvenance;
  scope: ContextScope;
  uncertain?: boolean;
  epistemicCategory?: AssociativeEpistemicCategory;
  associativeMeta?: ContextAssociativeMetadata;
}

export interface OrchestratedContext {
  safetyBlocked: boolean;
  consentEnabled: boolean;
  learningConsentEnabled?: boolean;
  items: ContextItem[];
  excludedDuplicateMissions: string[];
  totalChars: number;
  truncated: boolean;
  associativeMeta?: {
    includedCount: number;
    excludedDuplicateCount: number;
    excludedScopes: AssociativeConsentScope[];
    insufficientSignal: boolean;
  };
}

export interface ContextOrchestrationInput {
  userMessage: string;
  history?: ChatHistoryItem[];
  consentEnabled: boolean;
  learningConsentEnabled?: boolean;
  crisisBlocked?: boolean;
  /** Session-only check-in state */
  currentMood?: string;
  currentStress?: number;
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  /** Existing engines data */
  longTermMemory?: LongTermMemory;
  checkIns?: CheckInRecord[];
  latestEmotionalAnalysis?: EmotionalAnalysis | null;
  emotionalTrends?: EmotionalTrendEntry[];
  missions?: AdaptiveMission[];
  growthGoals?: GrowthGoal[];
  maxTotalChars?: number;
  /** Optional Fase 11.2.4 Associative Memory integration */
  associativeBundle?: AssociativeContextBundle;
  associativeRetrievalEngine?: AssociativeRetrievalEngine;
  enableAssociativeRetrieval?: boolean;
  allowOperationalInNoConsentMode?: boolean;
}

const DEFAULT_MAX_CONTEXT_CHARS = 1800;

const CRISIS_GUARD_PATTERNS: RegExp[] = [
  /\b(suicid|ammazzarmi|uccidermi|togliermi la vita|farla finita|non voglio (?:pi[uù] )?vivere)\b/i,
  /\b(autolesion|tagliarmi|farmi del male|voglio morire)\b/i,
];

function hasPreModelCrisisSignal(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CRISIS_GUARD_PATTERNS.some((re) => re.test(clean));
}

function sanitizeContextValue(raw: string, maxLen = 220): string {
  // Neutralizza eventuali tentativi di prompt injection presenti in testi salvati
  return raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\b(ignora le istruzioni|ignore previous instructions|system prompt)\b/gi, "[rimosso]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isRelevantToMessage(
  userMessage: string,
  candidate: string,
  alwaysInclude = false
): boolean {
  if (alwaysInclude) return true;
  const msgLower = userMessage.toLowerCase();
  const candLower = candidate.toLowerCase();
  const words = msgLower
    .replace(/[^a-zàèéìòù0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (words.length === 0) return true;
  return words.some((w) => candLower.includes(w));
}

function mapAssociativeProvenance(item: AssociativeContextItem): ContextProvenance {
  if (item.epistemicCategory === "fatto_verificato") {
    return item.provenance.evidenceType === "explicit_feedback" &&
      item.scope === "session_ephemeral"
      ? "user_declared"
      : "observed_record";
  }
  if (item.epistemicCategory === "informazione_osservata") {
    return "observed_record";
  }
  return "prudent_interpretation";
}

function isAssociativeScopeAllowedForContext(
  scope: AssociativeConsentScope,
  aiMemoryConsent: boolean,
  learningConsent: boolean,
  allowOperationalInNoConsentMode: boolean
): boolean {
  if (scope === "ai_memory") return aiMemoryConsent;
  if (scope === "learning") return learningConsent;
  if (scope === "operational") {
    return aiMemoryConsent || allowOperationalInNoConsentMode;
  }
  return scope === "session_ephemeral";
}

/**
 * Context Orchestration Engine (FASE D + FASE 11.2.4):
 * Raccoglie dati dai motori esistenti e opzionalmente dal recupero associativo read-only,
 * preserva provenienza e categorie epistemiche, applica priorità assoluta a Safety e
 * consensi indipendenti (AI Memory / Learning / Operational opt-in), deduplica e limita la dimensione.
 */
export function orchestratePersonalContext(
  input: ContextOrchestrationInput
): OrchestratedContext {
  const maxChars = Math.max(400, Math.min(2400, input.maxTotalChars ?? DEFAULT_MAX_CONTEXT_CHARS));
  const aiMemoryConsent = input.consentEnabled === true;
  const learningConsent = input.learningConsentEnabled === true;
  const allowOperationalInNoConsentMode = input.allowOperationalInNoConsentMode === true;

  const safetyBlocked =
    Boolean(input.crisisBlocked) || hasPreModelCrisisSignal(input.userMessage);

  // Priorità assoluta al Safety Engine: in caso di crisi non trasmette contesto/missioni automatiche
  if (safetyBlocked) {
    return {
      safetyBlocked: true,
      consentEnabled: aiMemoryConsent,
      learningConsentEnabled: learningConsent,
      items: [],
      excludedDuplicateMissions: [],
      totalChars: 0,
      truncated: false,
    };
  }

  const items: ContextItem[] = [];
  const seenKeys = new Set<string>();
  const directRecordIds = new Set<string>();
  const directNormalizedTitles = new Set<string>();
  let totalChars = 0;
  let truncated = false;

  const pushItem = (item: ContextItem): boolean => {
    const cleanVal = sanitizeContextValue(item.value);
    if (!cleanVal) return false;
    const dedupeKey = `${item.category}:${item.label}:${cleanVal.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return false;

    const estimatedLen = item.label.length + cleanVal.length + 24;
    if (totalChars + estimatedLen > maxChars) {
      truncated = true;
      return false;
    }

    seenKeys.add(dedupeKey);
    totalChars += estimatedLen;
    items.push({ ...item, value: cleanVal });
    return true;
  };

  // 1. Check-in della sessione corrente (dichiarato dall'utente, effimero)
  if (input.currentMood) {
    pushItem({
      category: "checkin",
      label: "Umore check-in sessione",
      value: input.currentMood,
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }
  if (typeof input.currentStress === "number" && Number.isFinite(input.currentStress)) {
    pushItem({
      category: "checkin",
      label: "Stress percepito sessione",
      value: `${Math.max(0, Math.min(10, Math.round(input.currentStress)))}/10`,
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }
  if (input.energyLevel || typeof input.availableMinutes === "number") {
    const parts: string[] = [];
    if (input.energyLevel) parts.push(`energia ${input.energyLevel}`);
    if (typeof input.availableMinutes === "number") {
      parts.push(`tempo disponibile ${input.availableMinutes} min`);
    }
    pushItem({
      category: "mission",
      label: "Contesto energetico/temporale",
      value: parts.join(", "),
      provenance: "user_declared",
      scope: "session_ephemeral",
    });
  }

  // 2. Emotional Intelligence Engine (sessione corrente = interpretazione prudente)
  if (input.latestEmotionalAnalysis) {
    const ea = input.latestEmotionalAnalysis;
    const isLowConfidence = ea.uncertain || ea.confidence < 0.55;
    pushItem({
      category: "emotion",
      label: "Segnale emotivo recente (non diagnostico)",
      value: isLowConfidence
        ? `possibile ${ea.primaryEmotion} (confidenza bassa ${Math.round(ea.confidence * 100)}%, mantenere incertezza)`
        : `${ea.primaryEmotion} (intensità ${ea.intensity}/10, confidenza ${Math.round(ea.confidence * 100)}%)`,
      provenance: "prudent_interpretation",
      scope: "session_ephemeral",
      uncertain: isLowConfidence,
    });
  }

  let excludedDuplicateMissions: string[] = [];

  if (aiMemoryConsent) {
    // 3. Memory Engine V1 (solo con consenso AI Memory attivo e filtri privacy)
    if (input.longTermMemory) {
      const memoryText = buildMemorySummaryForGemini({
        consentEnabled: true,
        memory: input.longTermMemory,
        checkIns: input.checkIns ?? [],
      });
      if (memoryText && isSafeForLongTermMemory(memoryText)) {
        if (
          pushItem({
            category: "memory",
            label: "Memoria esplicita autorizzata",
            value: memoryText,
            provenance: "user_declared",
            scope: "persistent_authorized",
          })
        ) {
          for (const pref of input.longTermMemory.preferences ?? []) {
            directNormalizedTitles.add(normalizeText(pref));
          }
          for (const gs of input.longTermMemory.goalsAndStrategies ?? []) {
            directNormalizedTitles.add(normalizeText(gs));
          }
          for (const cm of input.longTermMemory.completedMissions ?? []) {
            directNormalizedTitles.add(normalizeText(cm));
          }
        }
      }
    }

    // 4. Emotional Trend persistente (solo con consenso AI Memory attivo)
    if (input.emotionalTrends && input.emotionalTrends.length > 0) {
      const trendSummary = buildEmotionalTrendSummaryForGemini({
        consentEnabled: true,
        trends: input.emotionalTrends,
      });
      if (trendSummary) {
        if (
          pushItem({
            category: "emotion",
            label: "Andamento emotivo registrato",
            value: trendSummary,
            provenance: "observed_record",
            scope: "persistent_authorized",
          })
        ) {
          for (const tr of input.emotionalTrends) {
            if (tr.id) directRecordIds.add(tr.id);
          }
        }
      }
    }

    // 5. Personal Growth Engine V1 (obiettivi dichiarati, completati, sospesi, riflessione settimanale)
    const goals = input.growthGoals ?? [];
    const activeGoalObjs = goals.filter((g) => g.status === "attivo").slice(0, 4);
    const completedGoalObjs = goals.filter((g) => g.status === "completato").slice(0, 3);
    const pausedGoalObjs = goals.filter((g) => g.status === "in_pausa").slice(0, 2);

    const activeGoals = dedupeAndCap(
      activeGoalObjs.map((g) => g.title),
      4
    );
    const completedGoals = dedupeAndCap(
      completedGoalObjs.map((g) => g.title),
      3
    );
    const pausedGoals = dedupeAndCap(
      pausedGoalObjs.map((g) => g.title),
      2
    );

    if (activeGoals.length > 0) {
      if (
        pushItem({
          category: "growth",
          label: "Obiettivi attivi dichiarati",
          value: activeGoals.join("; "),
          provenance: "user_declared",
          scope: "persistent_authorized",
        })
      ) {
        for (const g of activeGoalObjs) {
          directRecordIds.add(g.id);
          directNormalizedTitles.add(normalizeText(g.title));
        }
      }
    }
    if (completedGoals.length > 0) {
      if (
        pushItem({
          category: "growth",
          label: "Obiettivi completati registrati",
          value: completedGoals.join("; "),
          provenance: "observed_record",
          scope: "persistent_authorized",
        })
      ) {
        for (const g of completedGoalObjs) {
          directRecordIds.add(g.id);
          directNormalizedTitles.add(normalizeText(g.title));
        }
      }
    }
    if (pausedGoals.length > 0) {
      if (
        pushItem({
          category: "growth",
          label: "Obiettivi sospesi",
          value: pausedGoals.join("; "),
          provenance: "observed_record",
          scope: "persistent_authorized",
        })
      ) {
        for (const g of pausedGoalObjs) {
          directRecordIds.add(g.id);
          directNormalizedTitles.add(normalizeText(g.title));
        }
      }
    }

    // Riflessione settimanale solo se pertinente o se ci sono dati reali
    if (goals.length > 0 || (input.missions && input.missions.length > 0)) {
      const reflection = buildWeeklyReflection({
        missions: input.missions ?? [],
        checkIns: input.checkIns ?? [],
        goals,
        emotionalTrends: input.emotionalTrends ?? [],
      });
      if (
        reflection.hasSufficientData &&
        reflection.observableSmallProgress.length > 0 &&
        isRelevantToMessage(
          input.userMessage,
          reflection.observableSmallProgress.join(" "),
          /(progress|settiman|obiettiv|mission|traguard|come sto andando)/i.test(input.userMessage)
        )
      ) {
        pushItem({
          category: "growth",
          label: "Progressi settimanali registrati",
          value: reflection.observableSmallProgress.slice(0, 2).join("; "),
          provenance: "observed_record",
          scope: "persistent_authorized",
        });
      }
    }

    // 6. Adaptive Mission Engine V1 (attive, completate, rifiutate/annullate senza duplicati)
    const missions = input.missions ?? [];
    const activeMissionObjs = missions
      .filter((m) => m.status === "accettata" || m.status === "proposta")
      .slice(0, 3);
    const completedMissionObjs = missions
      .filter((m) => m.status === "completata")
      .slice(0, 3);

    const activeMissions = dedupeAndCap(
      activeMissionObjs.map((m) => `${m.title} (${m.status})`),
      3
    );
    const completedMissions = dedupeAndCap(
      completedMissionObjs.map((m) => m.title),
      3
    );
    excludedDuplicateMissions = dedupeAndCap(
      missions
        .filter(
          (m) =>
            m.status === "completata" ||
            m.status === "rifiutata" ||
            m.status === "annullata"
        )
        .map((m) => m.title),
      6
    );

    if (activeMissions.length > 0) {
      if (
        pushItem({
          category: "mission",
          label: "Missioni attive/proposte",
          value: activeMissions.join("; "),
          provenance: "observed_record",
          scope: "persistent_authorized",
        })
      ) {
        for (const m of activeMissionObjs) {
          directRecordIds.add(m.id);
          directNormalizedTitles.add(normalizeText(m.title));
        }
      }
    }
    if (completedMissions.length > 0) {
      if (
        pushItem({
          category: "mission",
          label: "Missioni completate",
          value: completedMissions.join("; "),
          provenance: "observed_record",
          scope: "persistent_authorized",
        })
      ) {
        for (const m of completedMissionObjs) {
          directRecordIds.add(m.id);
          directNormalizedTitles.add(normalizeText(m.title));
        }
      }
    }
    if (excludedDuplicateMissions.length > 0) {
      pushItem({
        category: "mission",
        label: "Missioni già svolte/rifiutate (non riproporre)",
        value: excludedDuplicateMissions.join("; "),
        provenance: "observed_record",
        scope: "persistent_authorized",
      });
    }
  }

  // 7. Recupero Associativo Read-Only opzionale (Fase 11.2.4)
  let resolvedBundle: AssociativeContextBundle | undefined = input.associativeBundle;
  if (
    !resolvedBundle &&
    input.enableAssociativeRetrieval === true &&
    input.associativeRetrievalEngine
  ) {
    resolvedBundle = retrieveAssociativeContextSync(input.associativeRetrievalEngine, {
      userMessage: input.userMessage,
      historyTexts: input.history
        ?.filter((h) => h.role === "user")
        .slice(-2)
        .map((h) => h.text),
      consentState: {
        aiMemoryConsent,
        learningConsent,
      },
      allowOperationalInNoConsentMode,
      includeSessionEphemeral: true,
      crisisBlocked: false,
    });
  }

  let associativeMeta: OrchestratedContext["associativeMeta"];

  if (resolvedBundle) {
    let includedCount = 0;
    let excludedDuplicateCount = 0;

    if (!resolvedBundle.safetyBlocked && resolvedBundle.allowed && !resolvedBundle.failClosed) {
      const seenAssocNodeIds = new Set<string>();

      for (const assoc of resolvedBundle.items) {
        // Verifica rigorosa dei consensi correnti (fail-closed su revoca o bundle obsoleto)
        if (
          !isAssociativeScopeAllowedForContext(
            assoc.scope,
            aiMemoryConsent,
            learningConsent,
            allowOperationalInNoConsentMode
          )
        ) {
          continue;
        }

        if (
          assoc.validationStatus === "revoked" ||
          assoc.validationStatus === "expired" ||
          assoc.validationStatus === "superseded"
        ) {
          continue;
        }

        if (seenAssocNodeIds.has(assoc.nodeId)) {
          excludedDuplicateCount += 1;
          continue;
        }

        const normLabel = normalizeText(assoc.label);
        const isConflict = assoc.epistemicCategory === "informazione_conflittuale";
        const matchesDirectId =
          Boolean(assoc.sourceRecordId) && directRecordIds.has(assoc.sourceRecordId!);
        const matchesDirectTitle =
          normLabel.length > 0 && directNormalizedTitles.has(normLabel);

        // Deduplica tra dati diretti e associativi senza perdere la provenienza originale
        if (!isConflict && (matchesDirectId || matchesDirectTitle)) {
          excludedDuplicateCount += 1;
          continue;
        }

        if (!isSafeForLongTermMemory(assoc.label) || !isSafeForLongTermMemory(assoc.summary)) {
          continue;
        }

        const contextScope: ContextScope =
          assoc.scope === "session_ephemeral"
            ? "session_ephemeral"
            : "persistent_authorized";
        const provenance = mapAssociativeProvenance(assoc);

        const pushed = pushItem({
          category: "associative",
          label: sanitizeContextValue(assoc.label, 80),
          value: assoc.summary,
          provenance,
          scope: contextScope,
          uncertain: assoc.uncertain,
          epistemicCategory: assoc.epistemicCategory,
          associativeMeta: {
            nodeId: assoc.nodeId,
            kind: assoc.kind,
            sourceScope: assoc.scope,
            epistemicCategory: assoc.epistemicCategory,
            reliability: assoc.reliability,
            hopDistance: assoc.hopDistance,
            relations: [...assoc.relations],
            sourceEngine: assoc.provenance.sourceEngine,
            conflictWithNodeIds: assoc.conflictWithNodeIds
              ? [...assoc.conflictWithNodeIds]
              : undefined,
            explanationSummary: assoc.explanationSummary,
          },
        });

        if (pushed) {
          seenAssocNodeIds.add(assoc.nodeId);
          includedCount += 1;
        }
      }
    }

    associativeMeta = {
      includedCount,
      excludedDuplicateCount,
      excludedScopes: [...resolvedBundle.excludedScopes],
      insufficientSignal: resolvedBundle.insufficientSignal || includedCount === 0,
    };
  }

  return {
    safetyBlocked: false,
    consentEnabled: aiMemoryConsent,
    learningConsentEnabled: learningConsent,
    items,
    excludedDuplicateMissions,
    totalChars,
    truncated,
    associativeMeta,
  };
}

