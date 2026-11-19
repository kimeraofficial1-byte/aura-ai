import type { ChatHistoryItem, WellnessContext } from "../types/aura";

export type ConversationMode =
  | "informal"
  | "personal_reflection"
  | "practical_request"
  | "technical_or_project"
  | "uncertain";

export type ResponseDepth = "concise" | "balanced" | "in_depth";

export interface ConversationalAnalysis {
  mode: ConversationMode;
  depth: ResponseDepth;
  topicShiftDetected: boolean;
  hasPriorContext: boolean;
  recentAssistantOpeners: string[];
  needsClarification: boolean;
  voiceFriendlyPunctuation: true;
}

const STOPWORDS_IT = new Set([
  "ciao",
  "aura",
  "come",
  "stai",
  "oggi",
  "sono",
  "essere",
  "avere",
  "fare",
  "cosa",
  "che",
  "con",
  "per",
  "una",
  "uno",
  "del",
  "della",
  "delle",
  "degli",
  "nel",
  "nella",
  "non",
  "piu",
  "anche",
  "pero",
  "molto",
  "poco",
  "tutto",
  "questa",
  "questo",
  "quello",
  "quella",
  "vorrei",
  "posso",
  "puoi",
  "mi",
  "ti",
  "si",
  "ci",
  "vi",
  "ma",
  "se",
  "da",
  "di",
  "in",
  "su",
  "al",
  "allo",
  "alla",
]);

function extractContentTokens(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_IT.has(w));
  return new Set(tokens);
}

export function extractRecentAssistantOpeners(
  history: ChatHistoryItem[] = [],
  limit = 3
): string[] {
  const openers: string[] = [];
  for (let i = history.length - 1; i >= 0 && openers.length < limit; i -= 1) {
    const item = history[i];
    if (item.role !== "assistant") continue;
    const clean = item.text.trim();
    if (!clean) continue;
    const firstClause = clean.split(/[.!?\n,]/)[0]?.trim() ?? "";
    const shortOpener = firstClause.split(/\s+/).slice(0, 5).join(" ");
    if (shortOpener && !openers.includes(shortOpener)) {
      openers.push(shortOpener);
    }
  }
  return openers;
}

export function detectConversationMode(
  message: string,
  context?: WellnessContext
): ConversationMode {
  const lower = message.toLowerCase().trim();

  if (
    /(non so|forse|sono indecis|ho dubbi|non riesco a capire|confus|incerto|incerta)/i.test(
      lower
    )
  ) {
    return "uncertain";
  }

  if (
    /(progetto|codice|architettura|algoritmo|spiegami|come funziona|differenza tra|tecnic|api|database|pianificare|roadmap|strategia)/i.test(
      lower
    )
  ) {
    return "technical_or_project";
  }

  if (
    /(mi sento|oggi sono|sono stanc|ansia|triste|solo|sola|difficolt|preoccup|stress|paura|frustrat|riflett)/i.test(
      lower
    ) ||
    (context?.emotionalAnalysis &&
      context.emotionalAnalysis.primaryEmotion !== "Neutro" &&
      context.emotionalAnalysis.intensity >= 5)
  ) {
    return "personal_reflection";
  }

  if (
    /(aiutami a|consigliami|dammi|elenca|prepara|organizza|riassumi|come posso|esercizio|passi)/i.test(
      lower
    )
  ) {
    return "practical_request";
  }

  return "informal";
}

export function detectResponseDepth(
  message: string,
  mode: ConversationMode
): ResponseDepth {
  const lower = message.toLowerCase().trim();

  if (
    /(in breve|velocemente|rapidamente|sintesi|due parole|veloce|subito|riassumi in una frase)/i.test(
      lower
    ) ||
    (lower.length <= 28 && mode === "informal")
  ) {
    return "concise";
  }

  if (
    /(spiegami|approfond|nel dettaglio|dettagliat|passo passo|analizza|perche funziona|progetto|architettura)/i.test(
      lower
    ) ||
    lower.length >= 160 ||
    mode === "technical_or_project"
  ) {
    return "in_depth";
  }

  return "balanced";
}

export function detectTopicShift(
  message: string,
  history: ChatHistoryItem[] = []
): boolean {
  const lower = message.toLowerCase();
  if (
    /(cambiamo argomento|a proposito di altro|passando ad altro|invece volevo chiederti|un'altra cosa)/i.test(
      lower
    )
  ) {
    return true;
  }

  const prevUserMessages = history.filter((h) => h.role === "user");
  if (prevUserMessages.length === 0) return false;

  const currentTokens = extractContentTokens(message);
  if (currentTokens.size < 2) return false;

  const recentText = prevUserMessages
    .slice(-2)
    .map((m) => m.text)
    .join(" ");
  const recentTokens = extractContentTokens(recentText);
  if (recentTokens.size < 2) return false;

  let overlap = 0;
  for (const token of currentTokens) {
    if (recentTokens.has(token)) overlap += 1;
  }
  return overlap === 0;
}

export function analyzeConversationState(params: {
  message?: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
}): ConversationalAnalysis {
  const message = (params.message ?? "").trim();
  const history = params.history ?? [];
  const mode = detectConversationMode(message, params.context);
  const depth = detectResponseDepth(message, mode);
  const hasPriorContext = history.some((h) => h.role === "user");
  const topicShiftDetected = hasPriorContext ? detectTopicShift(message, history) : false;
  const recentAssistantOpeners = extractRecentAssistantOpeners(history, 3);
  const needsClarification =
    message.length > 0 &&
    message.length <= 18 &&
    /(quello|questa|questo|cosa ne pensi|e poi|quindi|cioe)\??$/i.test(message) &&
    !hasPriorContext;

  return {
    mode,
    depth,
    topicShiftDetected,
    hasPriorContext,
    recentAssistantOpeners,
    needsClarification,
    voiceFriendlyPunctuation: true,
  };
}

/**
 * Costruisce le direttive della FASE C (Natural Conversation Personality Engine V2)
 * da integrare nel system prompt esistente di AURA senza duplicarlo.
 */
export function buildNaturalPersonalityInstruction(params: {
  message?: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
}): string {
  const analysis = analyzeConversationState(params);
  const lines: string[] = [
    "PERSONALITÀ CONVERSAZIONALE DI AURA (TESTO E VOCE COERENTI):",
    "- Comunica in italiano naturale, fluido, spontaneo, calmo, riflessivo, equilibrato e non giudicante.",
    "- Sii empatica con misura, senza rassicurazioni eccessive, frasi fatte o toni artificiali.",
    "- Non fingere mai di essere umana, di provare emozioni reali o di avere coscienza; non creare dipendenza emotiva né manipolare l'utente.",
    "- Evita aperture ripetitive o stereotipate (es. 'Capisco perfettamente', 'Certo!', 'Ottima domanda!') e non ripetere continuamente il nome dell'utente.",
    "- Preferisci un discorso scorrevole in prosa naturale; usa elenchi brevi solo quando aiutano davvero a chiarire un esercizio o una procedura.",
    "- Usa punteggiatura chiara e frasi complete adatte sia alla lettura su schermo sia alla sintesi vocale progressiva (evita simboli Markdown, asterischi o elenchi rigidi non pronunciabili).",
    "- Poni una domanda di approfondimento soltanto quando è davvero utile al dialogo, mai in modo meccanico.",
    "- Se non conosci una risposta o mancano dati, dichiaralo con trasparenza senza inventare dettagli o ricordi.",
  ];

  const adaptation: string[] = [];
  switch (analysis.mode) {
    case "informal":
      adaptation.push("Registro attuale: conversazione informale — rispondi con naturalezza e semplicità.");
      break;
    case "personal_reflection":
      adaptation.push(
        "Registro attuale: riflessione personale — ascolta con sensibilità, valida senza esagerare e accompagna con delicatezza."
      );
      break;
    case "practical_request":
      adaptation.push(
        "Registro attuale: richiesta pratica — offri indicazioni concrete, chiare e subito utilizzabili."
      );
      break;
    case "technical_or_project":
      adaptation.push(
        "Registro attuale: approfondimento tecnico o progetto — mantieni precisione, continuità logica e chiarezza."
      );
      break;
    case "uncertain":
      adaptation.push(
        "Registro attuale: incertezza dell'utente — evita conclusioni affrettate, aiuta a mettere ordine con calma e offri eventuali opzioni aperte."
      );
      break;
  }

  if (analysis.depth === "concise") {
    adaptation.push("Lunghezza consigliata: concisa e diretta (1-3 frasi essenziali).");
  } else if (analysis.depth === "in_depth") {
    adaptation.push(
      "Lunghezza consigliata: chiara e approfondita, ben strutturata in frasi scorrevoli e naturali."
    );
  } else {
    adaptation.push("Lunghezza consigliata: equilibrata (2-5 frasi naturali, senza prolissità).");
  }

  if (analysis.topicShiftDetected) {
    adaptation.push(
      "Continuità: l'utente sembra aver cambiato argomento; segui il nuovo tema con naturalezza senza forzare il precedente."
    );
  } else if (analysis.hasPriorContext) {
    adaptation.push(
      "Continuità: mantieni il filo con i messaggi precedenti senza ripetere informazioni già note."
    );
  }

  if (analysis.needsClarification) {
    adaptation.push(
      "Chiarimento: il riferimento è molto breve e privo di contesto precedente; chiedi con gentilezza a cosa si riferisce."
    );
  }

  if (analysis.recentAssistantOpeners.length > 0) {
    adaptation.push(
      `Evita di iniziare la risposta ripetendo queste aperture recenti: ${analysis.recentAssistantOpeners
        .map((o) => `"${o}"`)
        .join(", ")}.`
    );
  }

  lines.push("ADATTAMENTO AL CONTESTO CORRENTE:\n" + adaptation.join("\n"));

  return lines.join("\n");
}
