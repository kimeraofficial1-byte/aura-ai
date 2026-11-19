import { isSafeForLongTermMemory, redactSensitiveTokens } from "../memory/privacyFilter";
import type {
  EmotionCategory,
  EmotionalAnalysis,
  EmotionalTrendEntry,
  EmpathyStrategy,
} from "./types";

export function buildEmpathyStrategy(params: {
  primaryEmotion: EmotionCategory;
  intensity: number;
  uncertain: boolean;
  stressSignals: string[];
}): EmpathyStrategy {
  const { primaryEmotion, intensity, uncertain, stressSignals } = params;
  const highIntensity = intensity >= 7;

  if (uncertain || primaryEmotion === "Incerto") {
    return {
      tone: "delicato, esplorativo e privo di supposizioni",
      activeListeningFocus:
        "Accogliere il fatto che ciò che l'utente prova possa essere sfumato o difficile da definire",
      questionStyle: "una domanda aperta e leggera che lasci totale libertà di chiarire",
      pacing: "gentle-warm",
      suggestedExercise: null,
    };
  }

  switch (primaryEmotion) {
    case "Ansia":
      return {
        tone: "calmo, rassicurante e ancorato al presente",
        activeListeningFocus: "Riconoscere la tensione e ridurre il senso di urgenza",
        questionStyle: "una domanda semplice su cosa pesa di più in questo preciso momento",
        pacing: "slow-grounding",
        suggestedExercise: highIntensity
          ? "respirazione lenta 4-6 o grounding sensoriale 3-3-3"
          : "breve pausa di respiro lento se gradita",
      };
    case "Paura":
      return {
        tone: "stabile, protettivo e non allarmistico",
        activeListeningFocus: "Validare il timore aiutando a distinguere ciò che è controllabile ora",
        questionStyle: "una domanda gentile su cosa potrebbe dare un piccolo senso di sicurezza adesso",
        pacing: "slow-grounding",
        suggestedExercise: highIntensity
          ? "ancoraggio ai piedi a terra e respiro lento"
          : "un piccolo passo concreto e sicuro",
      };
    case "Rabbia":
      return {
        tone: "rispettoso, equilibrato e non giudicante",
        activeListeningFocus: "Dare spazio alla tensione senza minimizzare né alimentare lo scontro",
        questionStyle: "una domanda breve su cosa ha superato il limite per l'utente",
        pacing: "slow-grounding",
        suggestedExercise: highIntensity
          ? "pausa fisica breve prima di rispondere o agire"
          : "mettere a fuoco il bisogno rimasto inascoltato",
      };
    case "Frustrazione":
      return {
        tone: "pratico, empatico e alleggerente",
        activeListeningFocus: "Riconoscere lo sforzo ripetuto e il peso degli ostacoli",
        questionStyle: "una domanda mirata a individuare un solo nodo da alleggerire",
        pacing: "clear-structured",
        suggestedExercise: "scomporre la difficoltà in un micro-passo realistico o prendersi una tregua",
      };
    case "Tristezza":
      return {
        tone: "caldo, accogliente e senza fretta di risolvere",
        activeListeningFocus: "Restare vicino all'emozione evitando ottimismo forzato",
        questionStyle: "una domanda delicata che inviti a condividere solo quanto si sente",
        pacing: "gentle-warm",
        suggestedExercise: highIntensity
          ? "gesto gentile di cura di sé senza pretese di produttività"
          : null,
      };
    case "Solitudine":
      return {
        tone: "presente, caldo e autenticamente vicino",
        activeListeningFocus: "Far percepire ascolto sincero senza banalizzare la distanza emotiva",
        questionStyle: "una domanda aperta su cosa renderebbe più leggera la giornata oggi",
        pacing: "gentle-warm",
        suggestedExercise: "individuare un piccolo contatto sicuro o un momento di ascolto",
      };
    case "Confusione":
      return {
        tone: "chiaro, ordinato e rassicurante",
        activeListeningFocus: "Aiutare a mettere ordine un pensiero alla volta senza forzare decisioni",
        questionStyle: "una domanda che isoli il punto più importante da chiarire per primo",
        pacing: "clear-structured",
        suggestedExercise: "scrivere in una frase il dubbio principale per alleggerire la mente",
      };
    case "Stanchezza":
      return {
        tone: "morbido, essenziale e poco impegnativo",
        activeListeningFocus: "Legittimare il bisogno di recupero senza chiedere prestazioni",
        questionStyle: "una domanda breve e a basso sforzo cognitivo",
        pacing: "slow-grounding",
        suggestedExercise:
          stressSignals.length > 0
            ? "micro-pausa di 2 minuti lontano dagli schermi"
            : "concedersi una breve pausa senza obiettivi",
      };
    case "Gioia":
      return {
        tone: "partecipe, luminoso e genuino",
        activeListeningFocus: "Valorizzare il momento positivo e ciò che ha contribuito a crearlo",
        questionStyle: "una domanda che aiuti a riconoscere cosa nutre questo benessere",
        pacing: "light-open",
        suggestedExercise: null,
      };
    case "Serenità":
      return {
        tone: "disteso, armonico e rispettoso della quiete",
        activeListeningFocus: "Sostenere il senso di equilibrio presente senza introdurre problemi",
        questionStyle: "una domanda leggera su come custodire questo ritmo",
        pacing: "light-open",
        suggestedExercise: null,
      };
    case "Neutro":
    default:
      return {
        tone: "accogliente, naturale e aperto",
        activeListeningFocus: "Rispondere con chiarezza e disponibilità senza proiettare emozioni non espresse",
        questionStyle: "una domanda semplice per capire come AURA può essere utile oggi",
        pacing: "light-open",
        suggestedExercise: null,
      };
  }
}

export function buildEmpathyGuidanceForGemini(analysis: EmotionalAnalysis): string {
  const secondaryText =
    analysis.secondaryEmotions.length > 0
      ? analysis.secondaryEmotions.join(", ")
      : "nessuna significativa";

  const evidenceText =
    analysis.evidence.length > 0
      ? analysis.evidence.map((e) => `"${e}"`).join(", ")
      : "nessun indizio verbale esplicito";

  const stressText =
    analysis.stressSignals.length > 0
      ? analysis.stressSignals.join(", ")
      : "nessuno rilevato";

  const lines = [
    "EMPATHY ENGINE (ANALISI EMOTIVA PRUDENTE E NON CLINICA):",
    `- Emozione prevalente ipotizzata: ${analysis.primaryEmotion} (intensità ${analysis.intensity}/10, confidenza ${Math.round(analysis.confidence * 100)}%).`,
    `- Emozioni secondarie possibili: ${secondaryText}.`,
    `- Stato di incertezza: ${analysis.uncertain ? "SÌ (confidenza bassa o segnale sfumato)" : "NO"}.`,
    `- Elementi testuali osservati: ${evidenceText}.`,
    `- Segnali di stress/carico: ${stressText}.`,
    `- Tono consigliato: ${analysis.empathyStrategy.tone}.`,
    `- Focus di ascolto attivo: ${analysis.empathyStrategy.activeListeningFocus}.`,
    `- Stile di domanda: ${analysis.empathyStrategy.questionStyle}.`,
  ];

  if (analysis.empathyStrategy.suggestedExercise) {
    lines.push(
      `- Suggerimento proporzionato (solo se opportuno, mai imposto): ${analysis.empathyStrategy.suggestedExercise}.`
    );
  }

  if (analysis.uncertain) {
    lines.push(
      "- REGOLA DI PRUDENZA PER INCERTEZZA: Non affermare con sicurezza quale emozione prova l'utente; usa formule ipotetiche ('mi sembra di cogliere...', 'potresti sentire...') e chiedi con delicatezza come descriverebbe il proprio stato."
    );
  } else {
    lines.push(
      "- REGOLA DI PRUDENZA: Presenta la lettura emotiva con tatto e in forma ipotetica, mai come etichetta clinica o diagnosi, e non inventare emozioni o fatti non presenti nel messaggio."
    );
  }

  return lines.join("\n");
}

export function buildEmotionalTrendSummaryForGemini(params: {
  consentEnabled: boolean;
  trends: EmotionalTrendEntry[];
}): string | undefined {
  if (!params.consentEnabled || params.trends.length === 0) {
    return undefined;
  }

  const safeTrends = params.trends
    .filter((t) =>
      t.stressSignals.every((s) => isSafeForLongTermMemory(s))
    )
    .slice(-5);

  if (safeTrends.length === 0) return undefined;

  const avgIntensity =
    Math.round(
      (safeTrends.reduce((sum, item) => sum + item.intensity, 0) / safeTrends.length) * 10
    ) / 10;

  const recentLabels = safeTrends
    .map((t) => `${t.primaryEmotion} (${t.intensity}/10${t.uncertain ? ", incerto" : ""})`)
    .join(" -> ");

  const rawSummary = `Andamento emotivo recente (${safeTrends.length} rilevazioni consensuali): ${recentLabels}. Intensità media recente: ${avgIntensity}/10.`;
  return redactSensitiveTokens(rawSummary).slice(0, 480);
}
