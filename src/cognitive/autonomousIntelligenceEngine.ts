import type { GrowthGoal } from "../growth/types";
import type { AdaptiveMission, EnergyLevel } from "../missions/types";
import type { PersonalPlan } from "../planning/types";
import { runPredictiveAnalysis } from "../proactive/predictiveEngine";
import type {
  AlternativeStrategy,
  AutonomousCycleResult,
  AutonomousEngineInput,
  AutonomousSituation,
  EpistemicItem,
} from "./autonomousTypes";
import { evaluateCognitiveSafety } from "./cognitiveCoordinator";
import { buildContinuitySnapshot } from "./continuityEngine";

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function safeReadOperationalData(input: AutonomousEngineInput): {
  plans: PersonalPlan[];
  missions: AdaptiveMission[];
  growthGoals: GrowthGoal[];
  dependencyWarnings: EpistemicItem[];
} {
  const dependencyWarnings: EpistemicItem[] = [];
  let plans: PersonalPlan[] = input.plans ?? [];
  let missions: AdaptiveMission[] = input.missions ?? [];
  let growthGoals: GrowthGoal[] = input.growthGoals ?? [];

  if (input.repository) {
    try {
      if (!input.plans) plans = input.repository.getPlans();
      if (!input.missions) missions = input.repository.getMissions();
      if (!input.growthGoals) growthGoals = input.repository.getGrowthGoals();
    } catch {
      dependencyWarnings.push({
        id: "dep-warn-repository",
        label: "Accesso DataRepository non riuscito",
        detail: "Impossibile leggere i dati operativi dal repository; analisi limitata ai dati già forniti.",
        epistemicTag: "fatto_osservato",
        confidence: 1,
        dataSource: "AutonomousIntelligenceEngine · Dependency Guard",
        uncertaintyNote: "Dati operativi parziali o non disponibili per errore di lettura.",
      });
    }
  }

  return { plans, missions, growthGoals, dependencyWarnings };
}

/**
 * Situation & Need Synthesizer V1.
 * Combina in sola lettura DataRepository V2, CognitiveTimeline, ContinuityEngine,
 * Predictive Intelligence, Planning Engine, ControlledLearning V2 ed Emotional Intelligence
 * (solo se autorizzata). Non modifica alcun dato e non inventa informazioni.
 */
export function synthesizeAutonomousSituation(
  input: AutonomousEngineInput
): AutonomousSituation {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const { plans, missions, growthGoals, dependencyWarnings } = safeReadOperationalData(input);

  const activeGoals: EpistemicItem[] = [];
  const documentedProgress: EpistemicItem[] = [];
  const detectedDifficulties: EpistemicItem[] = [];
  const deadlinesAndDependencies: EpistemicItem[] = [];
  const potentialFutureNeeds: EpistemicItem[] = [];
  const missingData: EpistemicItem[] = [...dependencyWarnings];
  const uncertaintyFactors: EpistemicItem[] = [];

  // 1. Continuità cognitiva (riusando ContinuityEngine senza duplicazioni)
  let continuityEventsCount = 0;
  try {
    const continuity = buildContinuitySnapshot({
      plans,
      missions,
      growthGoals,
      consentEnabled: input.consentEnabled,
      crisisBlocked: input.crisisBlocked,
      availableMinutes: input.availableMinutes,
      energyLevel: input.energyLevel,
      nowIso,
      timeline: input.timeline,
      learningEngine: input.learningEngine,
    });
    continuityEventsCount = continuity.timelineEventsCount;

    for (const g of continuity.goalEvolution) {
      activeGoals.push({
        id: `goal-${g.goalId}`,
        label: g.title,
        detail: `Stato ${g.currentStatus}, avanzamento ${g.progressPercent}% (${g.trend.replace(/_/g, " ")}).`,
        epistemicTag: g.epistemicTag,
        confidence: clampConfidence(g.reliability),
        dataSource: g.dataSource,
        uncertaintyNote:
          g.progressPercent === 0
            ? "Nessuno step completato finora: impossibile stimare il ritmo reale."
            : "Basato sugli step registrati nel DataRepository.",
      });
    }

    for (const p of continuity.recentProgress) {
      documentedProgress.push({
        id: p.id,
        label: p.title,
        detail: p.detail,
        epistemicTag: p.epistemicTag,
        confidence: clampConfidence(p.reliability),
        dataSource: p.dataSource,
        uncertaintyNote: "Dato osservato localmente senza inferenze esterne.",
      });
    }

    for (const d of continuity.recurringDifficulties) {
      detectedDifficulties.push({
        id: d.id,
        label: d.label,
        detail: d.description,
        epistemicTag: d.epistemicTag,
        confidence: clampConfidence(d.reliability),
        dataSource: d.dataSource,
        uncertaintyNote: "Richiede conferma utente per distinguere un blocco reale da un cambio di priorità.",
      });
    }

    if (continuity.needsClarification && continuity.clarificationQuestion) {
      missingData.push({
        id: `missing-${missingData.length + 1}`,
        label: "Chiarimento o dato mancante",
        detail: continuity.clarificationQuestion,
        epistemicTag: "fatto_osservato",
        confidence: 1,
        dataSource: "ContinuityEngine",
        uncertaintyNote: "Assenza o ambiguità esplicita nei dati; nessun valore viene assunto o inventato.",
      });
    }

    for (const contra of continuity.contradictionsDetected) {
      uncertaintyFactors.push({
        id: `contradiction-${uncertaintyFactors.length + 1}`,
        label: "Possibile contraddizione",
        detail: contra,
        epistemicTag: "interpretazione_prudente",
        confidence: 0.7,
        dataSource: "ContinuityEngine",
        uncertaintyNote: "È opportuno chiarire con l'utente quale stato sia ancora valido.",
      });
    }
  } catch {
    uncertaintyFactors.push({
      id: "err-continuity",
      label: "ContinuityEngine non disponibile",
      detail: "Impossibile ricostruire la continuità cross-sessione in questo ciclo.",
      epistemicTag: "fatto_osservato",
      confidence: 1,
      dataSource: "AutonomousIntelligenceEngine · Dependency Guard",
      uncertaintyNote: "La sintesi prosegue solo sui dati direttamente leggibili.",
    });
  }

  // 2. Predictive Intelligence (scadenze, sovraccarichi, dipendenze)
  try {
    const predictive = runPredictiveAnalysis({
      plans,
      missions,
      growthGoals,
      consentEnabled: input.consentEnabled,
      crisisBlocked: input.crisisBlocked,
      nowIso,
    });

    if (predictive.insufficientData) {
      uncertaintyFactors.push({
        id: "pred-insufficient",
        label: "Dati predittivi insufficienti",
        detail: predictive.statusMessage,
        epistemicTag: "fatto_osservato",
        confidence: 0.9,
        dataSource: "PredictiveEngine",
        uncertaintyNote: "Nessuna previsione forzata in assenza di dati sufficienti.",
      });
    } else {
      for (const alert of predictive.alerts) {
        deadlinesAndDependencies.push({
          id: alert.id,
          label: alert.title,
          detail: alert.description,
          epistemicTag: alert.epistemicTag,
          confidence: clampConfidence(alert.confidence),
          dataSource: alert.dataSource,
          uncertaintyNote: "Segnale predittivo deterministico basato sui piani correnti, non una certezza.",
        });
      }
    }
  } catch {
    uncertaintyFactors.push({
      id: "err-predictive",
      label: "PredictiveEngine non disponibile",
      detail: "Analisi predittiva saltata per indisponibilità della dipendenza.",
      epistemicTag: "fatto_osservato",
      confidence: 1,
      dataSource: "AutonomousIntelligenceEngine · Dependency Guard",
      uncertaintyNote: "Scadenze e dipendenze potrebbero non essere complete.",
    });
  }

  // 3. Emotional Intelligence — SOLO se esplicitamente fornita e autorizzata
  let emotionalContextAuthorized = false;
  let emotionalSummary: EpistemicItem | undefined;
  if (input.authorizedEmotionalSignal) {
    emotionalContextAuthorized = true;
    const emo = input.authorizedEmotionalSignal;
    emotionalSummary = {
      id: "emo-authorized",
      label: `Stato emotivo dichiarato: ${emo.primaryEmotion}`,
      detail: `Intensità riportata ${emo.intensity}/10${emo.uncertain ? " (incertezza elevata)" : ""}.`,
      epistemicTag: emo.uncertain ? "ipotesi_da_verificare" : "fatto_osservato",
      confidence: emo.uncertain ? 0.55 : 0.85,
      dataSource: emo.dataSource,
      uncertaintyNote:
        "Riferimento non clinico basato solo sul segnale autorizzato; nessuna diagnosi.",
    };
  }

  // 4. Possibili bisogni futuri (solo se esistono dati reali)
  const hasOperationalData =
    plans.length > 0 || missions.length > 0 || growthGoals.length > 0 || continuityEventsCount > 0;

  if (hasOperationalData) {
    if (deadlinesAndDependencies.length > 0) {
      potentialFutureNeeds.push({
        id: "need-workload-rebalance",
        label: "Possibile bisogno di riequilibrio carico/scadenze",
        detail: `Rilevati ${deadlinesAndDependencies.length} segnali tra scadenze, sovraccarichi o dipendenze.`,
        epistemicTag: "interpretazione_prudente",
        confidence: 0.72,
        dataSource: "PredictiveEngine + Planning Engine",
        uncertaintyNote: "Ipotesi prudente: dipende dalla disponibilità reale dell'utente nei prossimi giorni.",
      });
    }
    if (detectedDifficulties.length > 0) {
      potentialFutureNeeds.push({
        id: "need-simplification",
        label: "Possibile bisogno di semplificazione dei passi",
        detail: `Sono presenti ${detectedDifficulties.length} difficoltà ricorrenti documentate.`,
        epistemicTag: "ipotesi_da_verificare",
        confidence: 0.65,
        dataSource: "ContinuityEngine + ControlledLearning V2",
        uncertaintyNote: "Da verificare con l'utente prima di qualsiasi riduzione di portata.",
      });
    }
    if (
      potentialFutureNeeds.length === 0 &&
      (plans.length > 0 || growthGoals.length > 0 || missions.length > 0)
    ) {
      potentialFutureNeeds.push({
        id: "need-steady-continuity",
        label: "Mantenimento continuità operativa",
        detail: "I dati attuali non mostrano blocchi critici; potrebbe essere utile consolidare il passo successivo.",
        epistemicTag: "ipotesi_da_verificare",
        confidence: 0.6,
        dataSource: "DataRepository V2",
        uncertaintyNote: "Valutazione preliminare basata esclusivamente sui dati locali correnti.",
      });
    }
  } else {
    uncertaintyFactors.push({
      id: "insufficient-operational-data",
      label: "Dati insufficienti",
      detail: "Non sono presenti piani, missioni, obiettivi o eventi sufficienti per formulare bisogni futuri.",
      epistemicTag: "fatto_osservato",
      confidence: 1,
      dataSource: "DataRepository V2 · CognitiveTimeline",
      uncertaintyNote: "Nessuna informazione viene inventata o stimata in assenza di dati.",
    });
  }

  const insufficientData = !hasOperationalData;
  const currentSituationSummary = insufficientData
    ? "Dati insufficienti: nessun piano, missione o obiettivo documentato per costruire una sintesi operativa."
    : `Situazione sintetizzata su ${plans.length} piani, ${missions.length} missioni e ${growthGoals.length} obiettivi (${
        input.consentEnabled ? "Memoria AI ON" : "Memoria AI OFF · dati operativi separati"
      }).`;

  return {
    generatedAt: nowIso,
    currentSituationSummary,
    activeGoals,
    documentedProgress,
    detectedDifficulties,
    deadlinesAndDependencies,
    potentialFutureNeeds,
    missingData,
    uncertaintyFactors,
    emotionalContextAuthorized,
    emotionalSummary,
    insufficientData,
    epistemicTag: insufficientData ? "fatto_osservato" : "interpretazione_prudente",
    confidence: insufficientData ? 1 : 0.75,
    dataSource: "DataRepository V2 · ContinuityEngine · PredictiveEngine",
    uncertaintyNote: insufficientData
      ? "Stato vuoto dichiarato esplicitamente."
      : "Sintesi locale prudente: ogni interpretazione va confermata dall'utente.",
  };
}

/**
 * Strategy & Consequence Evaluator V1.
 * Genera 2-3 strategie alternative confrontabili (STANDARD, LIGHT, DEFERRED)
 * solo quando i dati sono sufficienti. Non garantisce risultati e non modifica dati.
 */
export function evaluateAlternativeStrategies(
  situation: AutonomousSituation,
  input: AutonomousEngineInput
): AlternativeStrategy[] {
  if (situation.insufficientData) {
    return [];
  }

  const availableMinutes = input.availableMinutes ?? 25;
  const energyLevel: EnergyLevel = input.energyLevel ?? "media";
  const primaryGoalLabel =
    situation.activeGoals[0]?.label ??
    situation.deadlinesAndDependencies[0]?.label ??
    "Attività operative correnti";

  const hasDeadlines = situation.deadlinesAndDependencies.length > 0;
  const hasDifficulties = situation.detectedDifficulties.length > 0;
  const learningWeight = input.learningEngine?.getCategoryWeight("planning") ?? 1;

  const dependenciesList = situation.deadlinesAndDependencies
    .slice(0, 2)
    .map((d) => d.label);

  const strategies: AlternativeStrategy[] = [
    {
      id: "strategy-standard",
      category: "STANDARD",
      title: "Percorso Standard — Avanzamento strutturato",
      goal: `Proseguire in modo ordinato su "${primaryGoalLabel}".`,
      suggestedActions: [
        `Dedicare una sessione focalizzata di ${Math.min(availableMinutes, 30)} minuti all'attività prioritaria.`,
        "Verificare lo stato delle eventuali dipendenze prima di iniziare.",
      ],
      potentialBenefits: [
        "Mantiene allineamento con le scadenze correnti.",
        "Produce avanzamento misurabile sugli obiettivi attivi.",
      ],
      risks: [
        energyLevel === "bassa"
          ? "Potrebbe risultare impegnativo rispetto al livello di energia dichiarato (basso)."
          : "Richiede continuità di attenzione senza interruzioni.",
      ],
      effortRequired: energyLevel === "bassa" ? "alto" : "medio",
      impactOnOtherGoals:
        "Impatto neutro o positivo se resta entro il limite di tempo giornaliero.",
      dependencies: dependenciesList.length > 0 ? dependenciesList : ["Nessuna dipendenza bloccante rilevata."],
      reversibility: "reversibile",
      uncertaintyLevel: "media",
      epistemicTag: "interpretazione_prudente",
      confidence: clampConfidence(0.7 * Math.min(1.15, Math.max(0.75, learningWeight))),
      dataSource: "AutonomousIntelligenceEngine · Planning + Predictive",
      uncertaintyNote: "Esito non garantito: dipende dal tempo effettivo e da eventuali imprevisti.",
    },
    {
      id: "strategy-light",
      category: "LIGHT",
      title: "Percorso Leggero — Micro-passo a basso attrito",
      goal: `Mantenere slancio su "${primaryGoalLabel}" riducendo il carico.`,
      suggestedActions: [
        `Scegliere un singolo sotto-passo da ${Math.min(10, availableMinutes)} minuti.`,
        "Rimandare i dettagli secondari alla sessione successiva.",
      ],
      potentialBenefits: [
        "Riduce il rischio di sovraccarico o abbandono.",
        "Facile da completare anche con energia bassa o tempo ridotto.",
      ],
      risks: [
        hasDeadlines
          ? "Potrebbe non coprire interamente le scadenze imminenti rilevate."
          : "Avanzamento più graduale rispetto al percorso standard.",
      ],
      effortRequired: "basso",
      impactOnOtherGoals: "Libera margine per altri obiettivi o per il recupero.",
      dependencies: ["Nessuna dipendenza complessa richiesta."],
      reversibility: "reversibile",
      uncertaintyLevel: "bassa",
      epistemicTag: "ipotesi_da_verificare",
      confidence: clampConfidence(hasDifficulties ? 0.78 : 0.68),
      dataSource: "AutonomousIntelligenceEngine · Continuity + ControlledLearning",
      uncertaintyNote: "Ipotesi prudente: utile da verificare se il carico percepito è elevato.",
    },
  ];

  // Terza strategia (DEFERRED) inclusa quando esistono difficoltà, scadenze o energia bassa
  if (hasDeadlines || hasDifficulties || energyLevel === "bassa" || availableMinutes < 20) {
    strategies.push({
      id: "strategy-deferred",
      category: "DEFERRED",
      title: "Rinvio Controllato — Riprogrammazione consapevole",
      goal: `Posticipare temporaneamente "${primaryGoalLabel}" proteggendo le priorità critiche.`,
      suggestedActions: [
        "Scegliere una nuova finestra temporale realistica con l'utente.",
        "Annotare il motivo del rinvio per evitare accumuli silenziosi.",
      ],
      potentialBenefits: [
        "Evita sovraccarico immediato quando il contesto non è favorevole.",
        "Preserva chiarezza sulle priorità realmente sostenibili oggi.",
      ],
      risks: [
        hasDeadlines
          ? "Aumenta la pressione sulle scadenze già vicine se non riprogrammato presto."
          : "Può rallentare il ritmo di avanzamento se ripetuto più volte.",
      ],
      effortRequired: "basso",
      impactOnOtherGoals: "Consente di concentrare le risorse su attività più urgenti o sul riposo.",
      dependencies: dependenciesList.length > 0 ? dependenciesList : ["Conferma esplicita della nuova data."],
      reversibility: "reversibile",
      uncertaintyLevel: "media",
      epistemicTag: "ipotesi_da_verificare",
      confidence: 0.65,
      dataSource: "AutonomousIntelligenceEngine · Predictive + Continuity",
      uncertaintyNote: "Le conseguenze del rinvio sono stime prudenti e vanno valutate dall'utente.",
    });
  }

  return strategies;
}

/**
 * Ciclo principale Autonomous Cognitive Intelligence V1 (Fase 8.2).
 * - Safety Gate sempre prioritario.
 * - PASSIVE: solo sintesi locale, nessuna strategia proposta, nessuna esecuzione.
 * - ASSISTED: sintesi + confronto 2-3 strategie, nessuna esecuzione.
 * - USER-AUTHORIZED: in Fase 8.2 si comporta come ASSISTED, zero esecuzioni.
 */
export function runAutonomousCognitiveCycle(
  input: AutonomousEngineInput
): AutonomousCycleResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const learningExplanation =
    input.learningEngine?.getLearningExplanation() ??
    "Apprendimento controllato non attivo in questo ciclo: nessuna profilazione effettuata.";

  // 1. SAFETY GATE — priorità assoluta
  const safetyCheck = input.userTextForSafetyCheck
    ? evaluateCognitiveSafety(input.userTextForSafetyCheck)
    : { safe: true, crisisDetected: false, reply: undefined };

  if (input.crisisBlocked || !safetyCheck.safe || safetyCheck.crisisDetected) {
    const emptySafeSituation: AutonomousSituation = {
      generatedAt: nowIso,
      currentSituationSummary:
        "Ciclo autonomo interrotto immediatamente dal Safety System per priorità di sicurezza.",
      activeGoals: [],
      documentedProgress: [],
      detectedDifficulties: [],
      deadlinesAndDependencies: [],
      potentialFutureNeeds: [],
      missingData: [],
      uncertaintyFactors: [],
      emotionalContextAuthorized: false,
      insufficientData: true,
      epistemicTag: "fatto_osservato",
      confidence: 1,
      dataSource: "Safety System",
      uncertaintyNote: "Nessuna analisi proattiva o strategia viene generata durante una condizione di crisi.",
    };

    return {
      mode: input.mode,
      effectivePolicyMode: "PASSIVE",
      safetyBlocked: true,
      safetyReason:
        safetyCheck.reply ??
        "Condizione di crisi attiva: il Safety System blocca qualsiasi ciclo autonomo.",
      executedActionsCount: 0,
      executionBlockedReason: "Bloccato dal Safety System.",
      insufficientData: true,
      statusMessage: "Ciclo autonomo sospeso per priorità assoluta del Safety System.",
      situation: emptySafeSituation,
      strategies: [],
      learningExplanation,
      generatedAt: nowIso,
    };
  }

  // 2. SITUATION & NEED SYNTHESIZER
  const situation = synthesizeAutonomousSituation(input);

  // 3. AUTONOMY POLICY
  if (input.mode === "PASSIVE") {
    return {
      mode: "PASSIVE",
      effectivePolicyMode: "PASSIVE",
      safetyBlocked: false,
      executedActionsCount: 0,
      executionBlockedReason:
        "Modalità PASSIVE: consentita solo la sintesi locale, nessuna strategia o esecuzione.",
      insufficientData: situation.insufficientData,
      statusMessage: situation.insufficientData
        ? "Modalità PASSIVE: dati insufficienti per individuare bisogni futuri."
        : "Modalità PASSIVE: sintesi locale completata senza modifiche ai dati.",
      situation,
      strategies: [],
      learningExplanation,
      generatedAt: nowIso,
    };
  }

  const strategies = evaluateAlternativeStrategies(situation, input);

  if (input.mode === "USER-AUTHORIZED") {
    return {
      mode: "USER-AUTHORIZED",
      effectivePolicyMode: "ASSISTED",
      safetyBlocked: false,
      executedActionsCount: 0,
      executionBlockedReason:
        "Fase 8.2: la modalità USER-AUTHORIZED opera come ASSISTED. L'esecuzione controllata con permessi specifici e revocabili sarà introdotta nella Fase 8.3.",
      insufficientData: situation.insufficientData,
      statusMessage: situation.insufficientData
        ? "Dati insufficienti per generare strategie alternative confrontabili."
        : `Generate ${strategies.length} strategie alternative in modalità prudente (nessuna esecuzione automatica in Fase 8.2).`,
      situation,
      strategies,
      learningExplanation,
      generatedAt: nowIso,
    };
  }

  // ASSISTED
  return {
    mode: "ASSISTED",
    effectivePolicyMode: "ASSISTED",
    safetyBlocked: false,
    executedActionsCount: 0,
    executionBlockedReason:
      "Modalità ASSISTED: AURA confronta le strategie ma la decisione resta esclusivamente all'utente.",
    insufficientData: situation.insufficientData,
    statusMessage: situation.insufficientData
      ? "Modalità ASSISTED: dati insufficienti per generare strategie alternative."
      : `Modalità ASSISTED: confrontate ${strategies.length} strategie alternative senza modificare i dati.`,
    situation,
    strategies,
    learningExplanation,
    generatedAt: nowIso,
  };
}
