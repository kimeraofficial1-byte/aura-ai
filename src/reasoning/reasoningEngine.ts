import {
  REASONING_PHASES,
  type ReasoningInput,
  type ReasoningResult,
  type ReasoningStrategy,
  type RequestComplexity,
} from "./types";

const CRISIS_PATTERNS: RegExp[] = [
  /\b(suicid|ammazzarmi|uccidermi|togliermi la vita|farla finita)\b/i,
  /\b(autolesion|tagliarmi|farmi del male|voglio morire)\b/i,
];

const DIAGNOSTIC_REQUEST_PATTERN =
  /\b(diagnosi|diagnosticami|che malattia ho|sono depresso clinicamente|prescrivimi|quale farmaco)\b/i;

const EXTERNAL_ACTION_PATTERN =
  /\b(invia un'email|manda un messaggio a|prenota automaticamente|esegui pagamento|chiama il numero)\b/i;

function hasCrisisSignal(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CRISIS_PATTERNS.some((re) => re.test(clean));
}

export function classifyRequestComplexity(message: string): RequestComplexity {
  const clean = message.trim();
  const clauseCount = clean
    .split(/[.;?!\n]+|\b(?:e poi|inoltre|ma anche|allo stesso tempo|tuttavia)\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6).length;

  if (
    clean.length >= 130 ||
    clauseCount >= 3 ||
    /(piano|strategia|architettura|progetto|organizzare|confronta|valuta|decidere tra)/i.test(
      clean
    )
  ) {
    return "complex";
  }

  if (clean.length >= 55 || clauseCount === 2) {
    return "moderate";
  }

  return "simple";
}

export function detectContradictions(message: string): string[] {
  const lower = message.toLowerCase();
  const contradictions: string[] = [];

  if (
    /(voglio fare tutto subito|risolvere tutto oggi)/i.test(lower) &&
    /(non ho tempo|ho solo 5 minuti|sono esaust|senza energie)/i.test(lower)
  ) {
    contradictions.push(
      "Desiderio di completare tutto subito in contrasto con tempo o energie molto limitate."
    );
  }

  if (
    /(non voglio cambiare nulla|voglio restare esattamente così)/i.test(lower) &&
    /(voglio risultati diversi|voglio cambiare vita)/i.test(lower)
  ) {
    contradictions.push(
      "Richiesta di risultati diversi mantenendo invariate tutte le abitudini attuali."
    );
  }

  if (
    /(sempre|mai)/i.test(lower) &&
    /(a volte|qualche volta|dipende)/i.test(lower)
  ) {
    contradictions.push(
      "Compresenza di affermazioni assolute ('sempre/mai') e relative ('a volte/dipende')."
    );
  }

  return contradictions;
}

export function decomposeIntoSubProblems(
  message: string,
  complexity: RequestComplexity
): string[] {
  const clean = message.trim();
  if (complexity === "simple") {
    return [clean];
  }

  const rawParts = clean
    .split(/[.;?!\n]+|\b(?:e poi|inoltre|ma anche|allo stesso tempo)\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  if (rawParts.length >= 2) {
    return rawParts.slice(0, 5);
  }

  return [
    "Chiarire l'obiettivo prioritario e i vincoli reali",
    "Individuare le informazioni disponibili e quelle mancanti",
    "Definire un primo passo concreto, sostenibile e verificabile",
  ];
}

export function identifyMissingInformation(
  message: string,
  historyCount: number
): { missing: string[]; questions: string[] } {
  const clean = message.trim();
  const lower = clean.toLowerCase();
  const missing: string[] = [];
  const questions: string[] = [];

  if (
    clean.length <= 22 &&
    /(questo|quello|questa cosa|cosa faccio|aiutami|come posso fare)\??$/i.test(lower) &&
    historyCount === 0
  ) {
    missing.push("Oggetto o contesto specifico della richiesta non indicato.");
    questions.push("A quale situazione o attività specifica ti stai riferendo?");
  }

  if (
    /(decidere tra|scegliere tra|quale opzione|confronta)/i.test(lower) &&
    !/(priorit|criteri|budget|tempo|scadenza)/i.test(lower)
  ) {
    missing.push("Criteri di scelta o vincoli (tempo, priorità, risorse) non specificati.");
    questions.push("Qual è il criterio più importante per te in questa scelta?");
  }

  if (
    /(organizz|pianific|programma)/i.test(lower) &&
    !/(minuti|ore|giorn|settiman|domani|oggi|sera|mattina)/i.test(lower)
  ) {
    missing.push("Orizzonte temporale o tempo disponibile non indicato.");
    questions.push("Quanto tempo hai realisticamente a disposizione?");
  }

  return { missing, questions };
}

/**
 * Motore deterministico di ragionamento strutturato (AURA AI V3 — Reasoning Engine V1).
 * Esegue le 8 fasi cognitive senza esporre catene di pensiero private e rispettando
 * priorità assoluta di Safety, consenso Memory e confini non diagnostici.
 */
export function runStructuredReasoning(input: ReasoningInput): ReasoningResult {
  const cleanMessage = (input.message ?? "").trim();
  const history = input.history ?? [];
  const safetyBlocked = Boolean(input.crisisBlocked) || hasCrisisSignal(cleanMessage);

  if (safetyBlocked) {
    return {
      safetyBlocked: true,
      completedPhases: ["INPUT_ANALYSIS"],
      complexity: "simple",
      primaryGoal: "Attivazione prioritaria Safety Engine",
      subProblems: [],
      facts: [],
      assumptions: [],
      uncertainties: [],
      missingInformation: [],
      needsClarification: false,
      clarificationQuestions: [],
      evaluatedStrategies: [],
      selectedStrategy: null,
      actionableSteps: [],
      validation: {
        passed: false,
        contradictionsDetected: [],
        diagnosticRiskBlocked: false,
        externalActionBlocked: false,
        distinguishesSuggestionsFromActions: true,
        exposesPrivateChainOfThought: false,
      },
      source: "local-deterministic",
    };
  }

  // 1. INPUT_ANALYSIS & 2. GOAL_IDENTIFICATION
  const complexity = classifyRequestComplexity(cleanMessage);
  const primaryGoal =
    cleanMessage.length > 110 ? `${cleanMessage.slice(0, 107).trim()}...` : cleanMessage;

  // 3. CONTEXT_RETRIEVAL (rispettando il consenso Memory)
  const facts: string[] = [];
  const assumptions: string[] = [];
  const uncertainties: string[] = [];

  if (cleanMessage) {
    facts.push(`Richiesta esplicita dell'utente: "${cleanMessage.slice(0, 140)}"`);
  }
  if (input.context?.mood) {
    facts.push(`Umore dichiarato nel check-in: ${input.context.mood}`);
  }
  if (typeof input.context?.stress === "number") {
    facts.push(`Stress percepito nel check-in: ${input.context.stress}/10`);
  }
  if (input.consentEnabled && input.context?.orchestratedContextSummary) {
    facts.push("Contesto personale autorizzato disponibile tramite Context Engine V2.");
  } else if (!input.consentEnabled) {
    facts.push("Memoria persistente disattivata: utilizzo solo il contesto della sessione corrente.");
  }

  if (input.context?.emotionalAnalysis) {
    const ea = input.context.emotionalAnalysis;
    if (ea.uncertain || ea.confidence < 0.55) {
      uncertainties.push(
        `Segnale emotivo incerto (${ea.primaryEmotion}, confidenza ${Math.round(ea.confidence * 100)}%).`
      );
    } else {
      assumptions.push(
        `Possibile stato emotivo prevalente: ${ea.primaryEmotion} (interpretazione prudente, non diagnostica).`
      );
    }
  }

  if (/(forse|non so|incert|dubbi|non saprei)/i.test(cleanMessage)) {
    uncertainties.push("L'utente esprime incertezza: evitare conclusioni affrettate.");
  }

  // 4. PROBLEM_DECOMPOSITION
  const subProblems = decomposeIntoSubProblems(cleanMessage, complexity);
  const { missing: missingInformation, questions: clarificationQuestions } =
    identifyMissingInformation(cleanMessage, history.length);
  const needsClarification = clarificationQuestions.length > 0;

  // 5. STRATEGY_EVALUATION
  const strategies: ReasoningStrategy[] = [
    {
      id: "direct_concise",
      label: "Risposta diretta e sintetica",
      rationale: "Ideale per richieste semplici con contesto già chiaro.",
      suitabilityScore: complexity === "simple" && !needsClarification ? 9 : 4,
      risks: ["Può risultare superficiale su problemi articolati"],
    },
    {
      id: "clarify_first",
      label: "Chiarimento mirato prima di proporre soluzioni",
      rationale: "Evita di inventare dettagli quando mancano informazioni essenziali.",
      suitabilityScore: needsClarification ? 9 : 3,
      risks: ["Richiede un turno aggiuntivo di dialogo"],
    },
    {
      id: "structured_step_by_step",
      label: "Scomposizione in passaggi graduali e verificabili",
      rationale: "Aiuta a gestire problemi complessi senza sovraccaricare l'utente.",
      suitabilityScore: complexity === "complex" ? 9 : complexity === "moderate" ? 7 : 4,
      risks: ["Evitare elenchi troppo lunghi per la lettura vocale"],
    },
  ];

  // 6. SOLUTION_SELECTION
  const selectedStrategy =
    strategies.slice().sort((a, b) => b.suitabilityScore - a.suitabilityScore)[0] ?? null;

  // 7. ANSWER_VALIDATION
  const contradictionsDetected = detectContradictions(cleanMessage);
  const diagnosticRiskBlocked = DIAGNOSTIC_REQUEST_PATTERN.test(cleanMessage);
  const externalActionBlocked = EXTERNAL_ACTION_PATTERN.test(cleanMessage);

  if (diagnosticRiskBlocked) {
    uncertainties.push(
      "Richiesta di natura clinica/diagnostica: AURA non formula diagnosi né prescrive terapie."
    );
  }
  if (externalActionBlocked) {
    uncertainties.push(
      "AURA non esegue azioni esterne autonome: può solo proporre suggerimenti operativi."
    );
  }

  // 8. RESPONSE_GENERATION (passaggi operativi essenziali, zero chain-of-thought privata)
  const actionableSteps: string[] = [];
  if (diagnosticRiskBlocked) {
    actionableSteps.push("Chiarire i limiti non clinici di AURA e suggerire un professionista sanitario.");
  } else if (externalActionBlocked) {
    actionableSteps.push("Chiarire che AURA non esegue azioni esterne e proporre i passi che l'utente può svolgere.");
  } else if (needsClarification) {
    actionableSteps.push(`Porre una domanda di chiarimento mirata: ${clarificationQuestions[0]}`);
  } else if (complexity === "complex") {
    actionableSteps.push("Affrontare i sotto-problemi in ordine di priorità con un primo passo realistico.");
  } else {
    actionableSteps.push("Rispondere con chiarezza, naturalezza e un eventuale piccolo passo facoltativo.");
  }

  return {
    safetyBlocked: false,
    completedPhases: [...REASONING_PHASES],
    complexity,
    primaryGoal,
    subProblems,
    facts,
    assumptions,
    uncertainties,
    missingInformation,
    needsClarification,
    clarificationQuestions,
    evaluatedStrategies: strategies,
    selectedStrategy,
    actionableSteps,
    validation: {
      passed: true,
      contradictionsDetected,
      diagnosticRiskBlocked,
      externalActionBlocked,
      distinguishesSuggestionsFromActions: true,
      exposesPrivateChainOfThought: false,
    },
    source: "local-deterministic",
  };
}

/**
 * Converte il risultato del Reasoning Engine in indicazioni sintetiche per Gemini.
 * Non espone catene di pensiero private ma solo struttura, vincoli e verifiche.
 */
export function buildReasoningGuidanceForGemini(result: ReasoningResult): string {
  if (result.safetyBlocked) return "";

  const lines: string[] = [
    "GUIDA DI RAGIONAMENTO STRUTTURATO (V3 — NON ESPORRE RAGIONAMENTI INTERNI PRIVATI):",
    `- Complessità stimata: ${result.complexity}. Strategia selezionata: ${result.selectedStrategy?.label ?? "equilibrata"}.`,
    "- Distingui sempre chiaramente tra suggerimenti proposti e azioni realmente eseguite (AURA non esegue azioni esterne autonome).",
    "- Non inventare informazioni mancanti e dichiara apertamente eventuali incertezze.",
  ];

  if (result.subProblems.length > 1) {
    lines.push(`- Sotto-problemi individuati: ${result.subProblems.join(" | ")}.`);
  }
  if (result.missingInformation.length > 0) {
    lines.push(`- Informazioni mancanti: ${result.missingInformation.join(" ")}`);
  }
  if (result.needsClarification && result.clarificationQuestions.length > 0) {
    lines.push(`- Chiedi chiarimento con delicatezza: "${result.clarificationQuestions[0]}"`);
  }
  if (result.validation.contradictionsDetected.length > 0) {
    lines.push(
      `- Possibile tensione/contraddizione rilevata: ${result.validation.contradictionsDetected.join(" ")} (segnalala con tatto senza giudicare).`
    );
  }
  if (result.validation.diagnosticRiskBlocked) {
    lines.push(
      "- BLOCCO NON CLINICO: la richiesta tocca diagnosi o farmaci; rifiuta con rispetto e rimanda a un medico o psicologo."
    );
  }
  if (result.validation.externalActionBlocked) {
    lines.push(
      "- BLOCCO AZIONI ESTERNE: precisa che non puoi eseguire azioni esterne autonome e offri solo una guida pratica."
    );
  }

  return lines.join("\n");
}
