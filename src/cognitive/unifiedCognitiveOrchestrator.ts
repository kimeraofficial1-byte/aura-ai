import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import { DataRepository } from "../persistence/dataManagement";
import type { PersonalPlan } from "../planning/types";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { runPredictiveAnalysis } from "../proactive/predictiveEngine";
import { analyzeProactiveOpportunities } from "../proactive/proactiveEngine";
import type {
  LearningAction,
  ProactiveMode,
  ProactiveOpportunityV2,
} from "../proactive/types";
import {
  classifyCognitiveIntent,
  CognitiveCoordinator,
  evaluateCognitiveSafety,
} from "./cognitiveCoordinator";
import type {
  CognitiveIntent,
  CognitiveRequest,
  CognitiveResult,
} from "./types";

const PROACTIVE_ANALYSIS_REGEX =
  /\b(analisi proattiva|anticipa|rischi|difficolt[aà]|sovraccaric\w*|scadenze imminenti|dipendenze bloccate)\b/i;
const PROACTIVE_SUGGESTION_REGEX =
  /\b(proponi|suggeriscimi|prossimo passo|opportunit[aà]|iniziativa|micro-?azione|alternativa pi[uù] semplice)\b/i;

export interface UnifiedProactiveContextInput {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  availableMinutes?: number;
  energyLevel?: EnergyLevel;
  stressLevel?: number;
  consentEnabled: boolean;
  crisisBlocked?: boolean;
  nowIso?: string;
  previousOpportunities?: ProactiveOpportunityV2[];
  learningEngine?: ControlledLearningEngine;
  activeTopic?: string;
}

export interface UnifiedProactiveAnalysisResult {
  safetyBlocked: boolean;
  insufficientData: boolean;
  statusMessage: string;
  generatedAt: string;
  opportunities: ProactiveOpportunityV2[];
  skippedDuplicates: number;
  learningExplanation: string;
}

export function classifyUnifiedIntent(input: string): CognitiveIntent {
  const clean = input.trim();
  if (PROACTIVE_ANALYSIS_REGEX.test(clean)) {
    return "PROACTIVE_ANALYSIS";
  }
  if (PROACTIVE_SUGGESTION_REGEX.test(clean)) {
    return "PROACTIVE_SUGGESTION";
  }
  return classifyCognitiveIntent(clean).intent;
}

function addHours(iso: string, hours: number): string {
  const ms = Date.parse(iso);
  return new Date((Number.isNaN(ms) ? Date.now() : ms) + hours * 3600_000).toISOString();
}

/**
 * Cognitive Opportunity Ranking V1.
 * Ordina le proposte considerando urgenza reale, importanza, impatto, tempo,
 * energia dichiarata, stress, dipendenze, Controlled Learning V2 e pertinenza.
 * Applica deduplicazione, raffreddamento temporale (cooldown), scadenza e sospensione.
 */
export function rankCognitiveOpportunities(
  candidates: ProactiveOpportunityV2[],
  options: {
    nowIso: string;
    availableMinutes: number;
    energyLevel: EnergyLevel;
    stressLevel: number;
    previousOpportunities?: ProactiveOpportunityV2[];
    learningEngine?: ControlledLearningEngine;
    activeTopic?: string;
  }
): { ranked: ProactiveOpportunityV2[]; skippedDuplicates: number } {
  const nowMs = Date.parse(options.nowIso) || Date.now();
  const prevByKey = new Map<string, ProactiveOpportunityV2>();
  for (const prev of options.previousOpportunities ?? []) {
    prevByKey.set(prev.dedupeKey, prev);
  }

  const seenKeys = new Set<string>();
  const filtered: ProactiveOpportunityV2[] = [];
  let skippedDuplicates = 0;

  for (const item of candidates) {
    // 1. Deduplicazione nel batch corrente
    if (seenKeys.has(item.dedupeKey)) {
      skippedDuplicates += 1;
      continue;
    }

    // 2. Scadenza
    if (item.expiresAt && Date.parse(item.expiresAt) <= nowMs) {
      skippedDuplicates += 1;
      continue;
    }

    // 3. Controllo cronologia precedente: accettati, sospesi, rifiutati, completati o in cooldown
    const prev = prevByKey.get(item.dedupeKey);
    if (prev) {
      if (
        prev.status === "accepted" ||
        prev.status === "suspended" ||
        prev.status === "rejected" ||
        prev.status === "completed"
      ) {
        skippedDuplicates += 1;
        continue;
      }
      if (prev.cooldownUntil && Date.parse(prev.cooldownUntil) > nowMs) {
        skippedDuplicates += 1;
        continue;
      }
    }

    seenKeys.add(item.dedupeKey);

    // 4. Calcolo punteggio multi-fattore deterministico
    let score =
      item.priority === "alta" ? 75 : item.priority === "media" ? 50 : 30;

    // Urgenza scadenza reale
    if (item.deadline) {
      const hoursLeft = (Date.parse(item.deadline) - nowMs) / 3600_000;
      if (hoursLeft <= 48) score += 20;
      else if (hoursLeft <= 120) score += 10;
    }

    // Adattamento a tempo disponibile
    if (item.estimatedMinutes <= options.availableMinutes) {
      score += 10;
    } else {
      score -= 12;
    }

    // Adattamento a energia e stress dichiarati (senza profilazione psicologica)
    if (options.energyLevel === "bassa" || options.stressLevel >= 7) {
      if (item.estimatedMinutes <= 10) score += 12;
      else if (item.estimatedMinutes > 25) score -= 15;
    } else if (options.energyLevel === "buona" && item.category === "opportunity") {
      score += 6;
    }

    // Pertinenza rispetto al contesto attuale
    if (
      options.activeTopic &&
      `${item.title} ${item.description}`
        .toLowerCase()
        .includes(options.activeTopic.trim().toLowerCase())
    ) {
      score += 8;
    }

    // Peso Controlled Learning V2 (solo se attivo)
    const weight = options.learningEngine
      ? options.learningEngine.getCategoryWeight(item.category)
      : 1.0;
    score = Math.round(score * weight * 10) / 10;

    filtered.push({ ...item, rankScore: score });
  }

  filtered.sort((a, b) => b.rankScore - a.rankScore);
  return { ranked: filtered, skippedDuplicates };
}

/**
 * Proactive Intelligence V2:
 * Estende Proactive V1.1 individuando Opportunità, Difficoltà e Iniziative
 * esclusivamente da dati realmente disponibili, con distinzione epistemica rigorosa.
 */
export function generateProactiveOpportunitiesV2(
  input: UnifiedProactiveContextInput
): UnifiedProactiveAnalysisResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const learningExplanation = input.learningEngine
    ? input.learningEngine.getLearningExplanation()
    : "Apprendimento controllato non configurato.";

  if (input.crisisBlocked) {
    return {
      safetyBlocked: true,
      insufficientData: false,
      statusMessage:
        "Analisi proattiva sospesa dal Safety Engine: priorità assoluta al supporto immediato.",
      generatedAt: nowIso,
      opportunities: [],
      skippedDuplicates: 0,
      learningExplanation,
    };
  }

  const hasData =
    input.plans.length > 0 ||
    input.missions.length > 0 ||
    input.growthGoals.length > 0;

  if (!hasData) {
    return {
      safetyBlocked: false,
      insufficientData: true,
      statusMessage:
        "Dati operativi insufficienti per formulare proposte proattive affidabili. Aggiungi un piano, una missione o un obiettivo quando lo desideri.",
      generatedAt: nowIso,
      opportunities: [],
      skippedDuplicates: 0,
      learningExplanation,
    };
  }

  const availableMinutes = input.availableMinutes ?? 20;
  const energyLevel: EnergyLevel = input.energyLevel ?? "media";
  const stressLevel = input.stressLevel ?? 5;
  const candidates: ProactiveOpportunityV2[] = [];

  // 1. Riutilizzo Proactive V1.1 (suggerimenti base) e Predictive V1.1 (rischi/scadenze/dipendenze/sovraccarico)
  const v11Proactive = analyzeProactiveOpportunities({
    plans: input.plans,
    missions: input.missions,
    growthGoals: input.growthGoals,
    consentEnabled: input.consentEnabled,
    crisisBlocked: false,
    nowIso,
  });

  const v11Predictive = runPredictiveAnalysis({
    plans: input.plans,
    missions: input.missions,
    growthGoals: input.growthGoals,
    consentEnabled: input.consentEnabled,
    crisisBlocked: false,
    nowIso,
  });

  for (const alert of v11Predictive.alerts) {
    const isOverload = alert.category === "overload";
    const isDeadline = alert.category === "deadline";
    const isDep = alert.category === "dependency";

    candidates.push({
      id: `v2-diff-${alert.id}`,
      dedupeKey: `diff:${alert.category}:${alert.title.toLowerCase()}`,
      title: alert.title,
      description: alert.description,
      rationale: isOverload
        ? "Il carico stimato supera il tempo disponibile dichiarato; una riorganizzazione proposta può ridurre la pressione."
        : isDep
        ? "Un'attività bloccata da dipendenza può rallentare il resto del piano."
        : "Scadenza o rallentamento rilevato sui dati operativi correnti.",
      dataSource: alert.dataSource,
      category: "difficulty",
      epistemicTag: alert.epistemicTag,
      priority: alert.riskLevel,
      confidence: alert.confidence,
      deadline: isDeadline ? addHours(nowIso, 48) : undefined,
      estimatedMinutes: isOverload ? 10 : 15,
      expectedBenefits: isOverload
        ? "Riduce il sovraccarico e rende sostenibile il piano senza modifiche automatiche."
        : "Previene ritardi e mantiene il piano sotto controllo.",
      possibleLimits:
        "Richiede la tua conferma esplicita prima di applicare qualsiasi modifica al piano.",
      status: "proposed",
      requiresConfirmationForMutation: true,
      rankScore: 0,
      generatedAt: nowIso,
      expiresAt: addHours(nowIso, 48),
    });
  }

  for (const sug of v11Proactive.suggestions) {
    candidates.push({
      id: `v2-init-${sug.id}`,
      dedupeKey: `init:${sug.dedupeKey}`,
      title: sug.title,
      description: sug.description,
      rationale: sug.rationale,
      dataSource: sug.dataSource,
      category: "initiative",
      epistemicTag: sug.epistemicTag,
      priority: sug.priority,
      confidence: sug.confidence,
      estimatedMinutes: sug.estimatedMinutes ?? 10,
      expectedBenefits: sug.proposedAction,
      possibleLimits: "Proposta facoltativa: nessuna azione viene eseguita senza il tuo consenso.",
      status: "proposed",
      requiresConfirmationForMutation: false,
      rankScore: 0,
      generatedAt: nowIso,
      expiresAt: addHours(nowIso, 24),
    });
  }

  // 2. Caso 3: Rifiuti ripetuti di missioni -> alternativa più semplice
  const rejectedMissionCount =
    input.learningEngine?.getRejectedCount("missions") ?? 0;
  if (rejectedMissionCount >= 2) {
    candidates.push({
      id: `v2-simpler-mission-${Date.parse(nowIso)}`,
      dedupeKey: "initiative:simpler-mission-alternative",
      title: "Proposta di alternativa più semplice (5 minuti)",
      description:
        "Hai rifiutato o sospeso più volte missioni recenti: potremmo sostituirle con un micro-passo da 5 minuti.",
      rationale:
        "Evita di riproporre attività che non risultano adatte al momento attuale.",
      dataSource: "Controlled Learning V2 (decisioni esplicite sulle missioni)",
      category: "initiative",
      epistemicTag: "interpretazione_prudente",
      priority: "media",
      confidence: 0.72,
      estimatedMinutes: 5,
      expectedBenefits: "Abbassa la soglia di avvio mantenendo continuità sostenibile.",
      possibleLimits: "È un'ipotesi basata sui rifiuti recenti: puoi ignorarla o sospenderla.",
      status: "proposed",
      requiresConfirmationForMutation: false,
      rankScore: 0,
      generatedAt: nowIso,
      expiresAt: addHours(nowIso, 24),
    });
  }

  // 3. Caso 4: Obiettivo completato -> riconoscimento progresso + passo successivo pertinente
  const completedGoals = input.growthGoals.filter((g) => g.status === "completato");
  if (completedGoals.length > 0) {
    const latestCompleted = completedGoals[completedGoals.length - 1];
    candidates.push({
      id: `v2-next-step-${latestCompleted.id}`,
      dedupeKey: `opportunity:completed-goal:${latestCompleted.id}`,
      title: `Progresso completato: "${latestCompleted.title}"`,
      description:
        "Hai completato questo obiettivo di crescita. Se lo desideri, puoi consolidarlo o definire un piccolo passo successivo.",
      rationale: "Riconoscimento basato sullo stato 'completato' registrato in DataRepository.",
      dataSource: `DataRepository · Personal Growth (${latestCompleted.title})`,
      category: "opportunity",
      epistemicTag: "fatto_osservato",
      priority: "bassa",
      confidence: 0.9,
      estimatedMinutes: 10,
      expectedBenefits: "Aiuta a consolidare il risultato raggiunto senza aggiungere pressione.",
      possibleLimits: "Proposta puramente opzionale; nessun nuovo obiettivo viene creato automaticamente.",
      status: "proposed",
      requiresConfirmationForMutation: true,
      rankScore: 0,
      generatedAt: nowIso,
      expiresAt: addHours(nowIso, 72),
    });
  }

  const { ranked, skippedDuplicates } = rankCognitiveOpportunities(candidates, {
    nowIso,
    availableMinutes,
    energyLevel,
    stressLevel,
    previousOpportunities: input.previousOpportunities,
    learningEngine: input.learningEngine,
    activeTopic: input.activeTopic,
  });

  return {
    safetyBlocked: false,
    insufficientData: false,
    statusMessage:
      ranked.length > 0
        ? `Individuate ${ranked.length} proposte ordinate per priorità reale.`
        : "Nessuna nuova proposta prioritaria in questo momento.",
    generatedAt: nowIso,
    opportunities: ranked,
    skippedDuplicates,
    learningExplanation,
  };
}

/**
 * Unified Cognitive Orchestrator V1.
 * Estende in modo compatibile CognitiveCoordinator V1 integrando Proactive Intelligence V2,
 * Cognitive Opportunity Ranking e Controlled Learning V2 senza creare un secondo coordinatore.
 */
export class UnifiedCognitiveOrchestrator {
  private readonly coordinator: CognitiveCoordinator;
  private readonly repository: DataRepository;
  private readonly learningEngine: ControlledLearningEngine;
  private proactiveMode: ProactiveMode;

  constructor(options?: {
    coordinator?: CognitiveCoordinator;
    repository?: DataRepository;
    learningEngine?: ControlledLearningEngine;
    proactiveMode?: ProactiveMode;
  }) {
    this.repository = options?.repository ?? new DataRepository();
    this.learningEngine = options?.learningEngine ?? new ControlledLearningEngine(true);
    this.coordinator =
      options?.coordinator ??
      new CognitiveCoordinator({
        repository: this.repository,
        learningEngine: this.learningEngine,
      });
    this.proactiveMode = options?.proactiveMode ?? "PASSIVE";
  }

  getProactiveMode(): ProactiveMode {
    return this.proactiveMode;
  }

  setProactiveMode(mode: ProactiveMode): void {
    this.proactiveMode = mode;
  }

  getLearningEngine(): ControlledLearningEngine {
    return this.learningEngine;
  }

  applyOpportunityDecision(
    opportunity: ProactiveOpportunityV2,
    action: LearningAction,
    nowIso: string = new Date().toISOString()
  ): ProactiveOpportunityV2 {
    this.learningEngine.recordInteraction(opportunity.category, action, nowIso);
    const cooldownUntil =
      action === "snoozed"
        ? addHours(nowIso, 6)
        : action === "rejected" || action === "suspended"
        ? addHours(nowIso, 72)
        : undefined;

    return {
      ...opportunity,
      status: action,
      cooldownUntil,
    };
  }

  async orchestrate(
    request: CognitiveRequest & {
      availableMinutes?: number;
      energyLevel?: EnergyLevel;
      previousOpportunities?: ProactiveOpportunityV2[];
    }
  ): Promise<{
    intent: CognitiveIntent;
    cognitiveResult?: CognitiveResult;
    proactiveResult?: UnifiedProactiveAnalysisResult;
  }> {
    // 1. Safety gate sempre prioritario
    const safety = evaluateCognitiveSafety(request.input, request.crisisBlocked);
    if (!safety.safe || safety.crisisDetected) {
      const blocked = await this.coordinator.execute(request);
      return { intent: "CHAT", cognitiveResult: blocked };
    }

    const intent = classifyUnifiedIntent(request.input);

    if (intent === "PROACTIVE_ANALYSIS" || intent === "PROACTIVE_SUGGESTION") {
      const repo = request.storage
        ? new DataRepository(request.storage)
        : this.repository;
      const snap = repo.loadSnapshot();
      const proactiveResult = generateProactiveOpportunitiesV2({
        plans: snap.plans,
        missions: snap.missions,
        growthGoals: snap.growthGoals,
        availableMinutes: request.availableMinutes,
        energyLevel: request.energyLevel,
        stressLevel: request.sessionContext?.recentStress,
        consentEnabled: request.consentEnabled,
        crisisBlocked: false,
        previousOpportunities: request.previousOpportunities,
        learningEngine: this.learningEngine,
        activeTopic: request.input,
      });
      return { intent, proactiveResult };
    }

    // Delegazione diretta al CognitiveCoordinator V1 esistente (zero duplicazione)
    const cognitiveResult = await this.coordinator.execute(request);
    return { intent: cognitiveResult.intent, cognitiveResult };
  }
}
