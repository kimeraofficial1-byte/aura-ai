import type { EmotionCategory, EmotionalAnalysis } from "../emotion/types";
import {
  isSafeForLongTermMemory,
  normalizeText,
  redactSensitiveTokens,
} from "../memory/privacyFilter";
import {
  MISSION_CATEGORIES,
  type AdaptiveMission,
  type EnergyLevel,
  type MissionCategory,
  type MissionEffort,
  type MissionGenerationContext,
  type MissionGenerationResult,
  type MissionStatus,
} from "./types";

interface MissionTemplate {
  key: string;
  title: string;
  description: string;
  category: MissionCategory;
  estimatedMinutes: number;
  effortLevel: MissionEffort;
  goal: string;
  instructions: string[];
  emotionAffinities?: EmotionCategory[];
  neutralSafe?: boolean;
}

const CATEGORY_NORMALIZED_MAP = new Map<string, MissionCategory>(
  MISSION_CATEGORIES.map((c) => [normalizeText(c), c])
);

export function normalizeMissionCategory(value: unknown): MissionCategory | null {
  if (typeof value !== "string") return null;
  return CATEGORY_NORMALIZED_MAP.get(normalizeText(value)) ?? null;
}

export function formatDurationLabel(minutes: number): string {
  const clamped = Math.max(1, Math.min(60, Math.round(minutes)));
  return clamped === 1 ? "1 minuto" : `${clamped} minuti`;
}

export const MISSION_CATALOG: MissionTemplate[] = [
  {
    key: "respiro-4-6",
    title: "Respiro lento 4-6",
    description:
      "Un breve esercizio di respirazione guidata per allentare la tensione fisica e mentale.",
    category: "Respirazione e rilassamento",
    estimatedMinutes: 3,
    effortLevel: "basso",
    goal: "Ritrovare un ritmo calmo e ridurre la sensazione di urgenza",
    instructions: [
      "Appoggia comodamente i piedi a terra e rilassa le spalle.",
      "Inspira dal naso contando lentamente fino a 4.",
      "Espira dalla bocca contando fino a 6 per 5 cicli.",
    ],
    emotionAffinities: ["Ansia", "Paura", "Rabbia", "Stanchezza"],
    neutralSafe: true,
  },
  {
    key: "pausa-sensoriale",
    title: "Pausa di disconnessione breve",
    description:
      "Stacca lo sguardo dagli schermi per concedere alla mente un momento di respiro senza stimoli.",
    category: "Pausa e recupero",
    estimatedMinutes: 4,
    effortLevel: "basso",
    goal: "Recuperare un po' di lucidità senza chiedere prestazioni",
    instructions: [
      "Allontana il telefono o chiudi le schede non urgenti per 4 minuti.",
      "Bevi un bicchiere d'acqua con calma.",
      "Guarda un punto lontano o chiudi gli occhi per qualche respiro.",
    ],
    emotionAffinities: ["Stanchezza", "Frustrazione", "Ansia", "Serenità"],
    neutralSafe: true,
  },
  {
    key: "mindfulness-3-3-3",
    title: "Ancoraggio al presente 3-3-3",
    description:
      "Osserva l'ambiente intorno a te per riportare l'attenzione dal flusso dei pensieri al momento attuale.",
    category: "Mindfulness",
    estimatedMinutes: 3,
    effortLevel: "basso",
    goal: "Calmare il rimuginio con un gesto semplice e concreto",
    instructions: [
      "Nota 3 oggetti intorno a te e osservane un dettaglio.",
      "Ascolta 3 suoni presenti nella stanza o fuori.",
      "Muovi dolcemente 3 parti del corpo (mani, spalle, caviglie).",
    ],
    emotionAffinities: ["Ansia", "Confusione", "Paura", "Neutro"],
    neutralSafe: true,
  },
  {
    key: "movimento-stretching",
    title: "Scioglimento dolce di collo e spalle",
    description:
      "Movimenti lenti e accessibili per liberare la rigidità accumulata nella postura.",
    category: "Movimento leggero",
    estimatedMinutes: 5,
    effortLevel: "basso",
    goal: "Alleggerire la tensione corporea in modo sicuro",
    instructions: [
      "Ruota lentamente le spalle indietro per 5 volte.",
      "Inclina con delicatezza la testa da un lato e poi dall'altro senza forzare.",
      "Fai un passo o alzati per sgranchire le gambe per un minuto.",
    ],
    emotionAffinities: ["Rabbia", "Frustrazione", "Stanchezza", "Ansia"],
  },
  {
    key: "movimento-passeggiata",
    title: "Camminata consapevole breve",
    description:
      "Una passeggiata a passo comodo, all'aperto o in casa, senza guardare l'orologio.",
    category: "Movimento leggero",
    estimatedMinutes: 12,
    effortLevel: "medio",
    goal: "Cambiare scenario e scaricare l'energia in eccesso",
    instructions: [
      "Scegli un percorso familiare e sicuro.",
      "Cammina a un ritmo naturale senza obiettivi di distanza.",
      "Nota colori o luci intorno a te lungo il tragitto.",
    ],
    emotionAffinities: ["Rabbia", "Frustrazione", "Gioia", "Serenità"],
  },
  {
    key: "gratitudine-dettaglio",
    title: "Un piccolo momento che ha funzionato",
    description:
      "Annota un solo dettaglio positivo o neutro di oggi, anche minimo, senza forzare ottimismo.",
    category: "Gratitudine",
    estimatedMinutes: 4,
    effortLevel: "basso",
    goal: "Allenare lo sguardo a riconoscere anche i piccoli appigli quotidiani",
    instructions: [
      "Pensa a un gesto gentile, un caffè caldo o un momento tranquillo di oggi.",
      "Scrivilo in una riga o ripetilo mentalmente.",
    ],
    emotionAffinities: ["Gioia", "Serenità", "Tristezza", "Solitudine"],
  },
  {
    key: "creativita-schizzo",
    title: "Esprimiti su carta libera",
    description:
      "Usa parole sparse, colori o linee su un foglio per dare forma a un pensiero senza giudicarne il risultato.",
    category: "Creatività",
    estimatedMinutes: 10,
    effortLevel: "medio",
    goal: "Esplorare un'idea o un'emozione fuori dagli schemi logici",
    instructions: [
      "Prendi un foglio bianco e una penna o matita.",
      "Scrivi tre parole o disegna forme libere per 5-10 minuti.",
      "Non cercare estetica né perfezione.",
    ],
    emotionAffinities: ["Gioia", "Serenità", "Tristezza", "Confusione"],
  },
  {
    key: "organizzazione-unica-priorita",
    title: "Scegli una sola priorità reale",
    description:
      "Riduci il rumore mentale selezionando un solo piccolo impegno fattibile per le prossime ore.",
    category: "Organizzazione quotidiana",
    estimatedMinutes: 5,
    effortLevel: "basso",
    goal: "Portare ordine pratico quando tutto sembra urgente",
    instructions: [
      "Scrivi 2 o 3 cose che hai in testa.",
      "Scegline una sola che sia realistica oggi.",
      "Rimanda o alleggerisci il resto senza sensi di colpa.",
    ],
    emotionAffinities: ["Confusione", "Frustrazione", "Ansia", "Neutro"],
    neutralSafe: true,
  },
  {
    key: "connessione-messaggio",
    title: "Un messaggio leggero a una persona fidata",
    description:
      "Invia un saluto breve a qualcuno con cui ti senti al sicuro, senza obbligo di spiegare tutto.",
    category: "Connessione sociale",
    estimatedMinutes: 5,
    effortLevel: "medio",
    goal: "Coltivare un contatto umano semplice e non impegnativo",
    instructions: [
      "Pensa a una persona con cui ti fa piacere avere un contatto sereno.",
      "Invia un messaggio breve (es. 'Ciao, come va oggi?').",
    ],
    emotionAffinities: ["Solitudine", "Tristezza", "Gioia"],
  },
  {
    key: "riflessione-scarico",
    title: "Pagina di chiarezza interiore",
    description:
      "Scrivi per qualche minuto quello che occupa più spazio nella tua mente, poi chiudi il quaderno.",
    category: "Riflessione personale",
    estimatedMinutes: 10,
    effortLevel: "medio",
    goal: "Dare parole chiare a ciò che senti per alleggerire il carico mentale",
    instructions: [
      "Trova un angolo tranquillo per 10 minuti.",
      "Completa la frase: 'In questo momento la cosa che vorrei capire meglio è...'.",
      "Rileggi con gentilezza, come parleresti a un amico.",
    ],
    emotionAffinities: ["Confusione", "Tristezza", "Serenità"],
  },
  {
    key: "piccolo-obiettivo-acqua",
    title: "Un micro-passo di cura concreta",
    description:
      "Scegli un gesto quotidiano semplicissimo (bere acqua, aprire la finestra, sistemare la scrivania per 3 minuti).",
    category: "Piccoli obiettivi quotidiani",
    estimatedMinutes: 3,
    effortLevel: "basso",
    goal: "Sostenere il ritmo quotidiano con un gesto alla portata di adesso",
    instructions: [
      "Scegli un micro-gesto che puoi finire in 3 minuti.",
      "Eseguilo con calma e riconosci di aver fatto spazio per te.",
    ],
    emotionAffinities: ["Neutro", "Stanchezza", "Frustrazione", "Incerto"],
    neutralSafe: true,
  },
  {
    key: "mindfulness-approfondita",
    title: "Pratica di ascolto profondo e gratitudine",
    description:
      "Una sessione guidata più ampia per integrare respiro, presenza corporea e intenzioni per i prossimi giorni.",
    category: "Mindfulness",
    estimatedMinutes: 15,
    effortLevel: "alto",
    goal: "Consolidare continuità ed equilibrio nelle proprie abitudini di benessere",
    instructions: [
      "Siediti in posizione comoda per 15 minuti senza interruzioni.",
      "Dedica 5 minuti al respiro lento e 5 minuti all'osservazione delle sensazioni fisiche.",
      "Chiudi annotando un'intenzione gentile per la settimana.",
    ],
    emotionAffinities: ["Serenità", "Gioia"],
  },
];

function computeAllowedEfforts(params: {
  energyLevel: EnergyLevel;
  availableMinutes: number;
  recentStress?: number;
  completedCount: number;
}): MissionEffort[] {
  const { energyLevel, availableMinutes, recentStress = 5, completedCount } = params;

  // Bassa energia o stress elevato o tempo brevissimo -> solo basso impegno
  if (energyLevel === "bassa" || recentStress >= 7 || availableMinutes <= 5) {
    return ["basso"];
  }

  // Complessità crescente solo quando appropriato (almeno 2 missioni completate, buona energia, stress contenuto, >= 15 min)
  if (
    energyLevel === "buona" &&
    recentStress <= 4 &&
    availableMinutes >= 15 &&
    completedCount >= 2
  ) {
    return ["basso", "medio", "alto"];
  }

  return ["basso", "medio"];
}

function getEmotionPreferredCategories(
  analysis?: EmotionalAnalysis | null
): MissionCategory[] {
  if (!analysis || analysis.uncertain || analysis.primaryEmotion === "Incerto") {
    return ["Pausa e recupero", "Mindfulness", "Piccoli obiettivi quotidiani", "Organizzazione quotidiana"];
  }

  switch (analysis.primaryEmotion) {
    case "Ansia":
    case "Paura":
      return ["Respirazione e rilassamento", "Mindfulness", "Pausa e recupero"];
    case "Stanchezza":
      return ["Pausa e recupero", "Respirazione e rilassamento", "Piccoli obiettivi quotidiani"];
    case "Rabbia":
    case "Frustrazione":
      return ["Movimento leggero", "Pausa e recupero", "Organizzazione quotidiana"];
    case "Tristezza":
    case "Solitudine":
      return ["Connessione sociale", "Gratitudine", "Pausa e recupero", "Riflessione personale"];
    case "Confusione":
      return ["Organizzazione quotidiana", "Riflessione personale", "Mindfulness"];
    case "Gioia":
    case "Serenità":
      return ["Gratitudine", "Creatività", "Movimento leggero", "Mindfulness"];
    case "Neutro":
    default:
      return ["Piccoli obiettivi quotidiani", "Mindfulness", "Organizzazione quotidiana"];
  }
}

function buildAdaptationNote(params: {
  energyLevel: EnergyLevel;
  availableMinutes: number;
  matchedGoal?: string;
  uncertainEmotion: boolean;
  effortLevel: MissionEffort;
}): string {
  const notes: string[] = [];
  if (params.energyLevel === "bassa") {
    notes.push("impegno leggero adatto a energie basse");
  }
  if (params.availableMinutes <= 6) {
    notes.push(`attività breve entro ${params.availableMinutes} min`);
  }
  if (params.uncertainEmotion) {
    notes.push("proposta neutra e facoltativa");
  }
  if (params.matchedGoal) {
    notes.push("collegata al tuo obiettivo dichiarato");
  }
  if (params.effortLevel === "alto") {
    notes.push("livello graduale avanzato");
  }
  if (notes.length === 0) {
    return "Calibrata sul tuo ritmo attuale senza pressioni.";
  }
  const joined = notes.join(" · ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

function findMatchingGoal(template: MissionTemplate, safeGoals: string[]): string | undefined {
  if (safeGoals.length === 0) return undefined;
  const templateWords = normalizeText(`${template.title} ${template.description} ${template.category}`);
  for (const goal of safeGoals) {
    const tokens = normalizeText(goal)
      .split(/\s+/)
      .filter((t) => t.length >= 4);
    if (tokens.some((tok) => templateWords.includes(tok))) {
      return goal;
    }
  }
  return safeGoals[0];
}

export function createAdaptiveMissionId(prefix = "mis"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function generateAdaptiveMissionsLocal(
  ctx: MissionGenerationContext,
  count = 3,
  nowIso = new Date().toISOString()
): MissionGenerationResult {
  const completedCount = ctx.existingMissions.filter(
    (m) => m.status === "completata"
  ).length;

  const rejectedOrCancelledTitles = new Set(
    ctx.existingMissions
      .filter((m) => m.status === "rifiutata" || m.status === "annullata")
      .map((m) => normalizeText(m.title))
  );

  const activeTitles = new Set(
    ctx.existingMissions
      .filter((m) => m.status === "proposta" || m.status === "accettata")
      .map((m) => normalizeText(m.title))
  );

  const allowedEfforts = computeAllowedEfforts({
    energyLevel: ctx.energyLevel,
    availableMinutes: ctx.availableMinutes,
    recentStress: ctx.recentStress,
    completedCount,
  });

  const safeGoals = ctx.goals
    .map((g) => redactSensitiveTokens(g).trim())
    .filter((g) => g.length > 0 && isSafeForLongTermMemory(g));

  const safePrefs = ctx.preferences
    .map((p) => redactSensitiveTokens(p).trim())
    .filter((p) => p.length > 0 && isSafeForLongTermMemory(p));

  const uncertainEmotion =
    Boolean(ctx.emotionalAnalysis?.uncertain) ||
    ctx.emotionalAnalysis?.primaryEmotion === "Incerto";

  const preferredCategories = getEmotionPreferredCategories(ctx.emotionalAnalysis);

  const candidates = MISSION_CATALOG.filter((tpl) => {
    if (rejectedOrCancelledTitles.has(normalizeText(tpl.title))) return false;
    if (activeTitles.has(normalizeText(tpl.title))) return false;
    return true;
  });

  // Se tutte fossero state rifiutate in passato, evita almeno quelle attive ora
  const pool =
    candidates.length > 0
      ? candidates
      : MISSION_CATALOG.filter((tpl) => !activeTitles.has(normalizeText(tpl.title)));

  const scored = pool.map((tpl) => {
    let score = 0;

    if (allowedEfforts.includes(tpl.effortLevel)) {
      score += 4;
    } else {
      score -= 6;
    }

    if (tpl.estimatedMinutes <= ctx.availableMinutes) {
      score += 4;
    } else {
      score -= 5;
    }

    if (uncertainEmotion) {
      if (tpl.neutralSafe) score += 3;
    } else if (
      ctx.emotionalAnalysis?.primaryEmotion &&
      tpl.emotionAffinities?.includes(ctx.emotionalAnalysis.primaryEmotion)
    ) {
      score += 3;
    }

    const catIdx = preferredCategories.indexOf(tpl.category);
    if (catIdx !== -1) {
      score += 3 - catIdx * 0.5;
    }

    const combinedText = normalizeText(`${tpl.title} ${tpl.description} ${tpl.category}`);
    for (const goal of safeGoals) {
      const tokens = normalizeText(goal)
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (tokens.some((tok) => combinedText.includes(tok))) {
        score += 3.5;
      }
    }

    for (const pref of safePrefs) {
      const tokens = normalizeText(pref)
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (tokens.some((tok) => combinedText.includes(tok))) {
        score += 2.5;
      }
    }

    if (ctx.focusNote?.trim()) {
      const tokens = normalizeText(ctx.focusNote)
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      if (tokens.some((tok) => combinedText.includes(tok))) {
        score += 2.5;
      }
    }

    // Preferisci gradualmente complessità più alta solo quando consentito
    if (allowedEfforts.includes("alto") && tpl.effortLevel === "alto") {
      score += 2;
    }

    return { tpl, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: AdaptiveMission[] = [];
  const usedCategories = new Set<MissionCategory>();

  for (const { tpl } of scored) {
    if (selected.length >= count) break;
    // Diversifica le categorie quando possibile
    if (usedCategories.has(tpl.category) && scored.length > count + 1) continue;
    usedCategories.add(tpl.category);

    const adaptedMinutes =
      tpl.estimatedMinutes > ctx.availableMinutes
        ? Math.max(2, ctx.availableMinutes)
        : tpl.estimatedMinutes;

    const adaptedEffort: MissionEffort = allowedEfforts.includes(tpl.effortLevel)
      ? tpl.effortLevel
      : allowedEfforts[allowedEfforts.length - 1];

    const matchedGoal = findMatchingGoal(tpl, safeGoals);

    selected.push({
      id: createAdaptiveMissionId(),
      title: tpl.title,
      description: tpl.description,
      category: tpl.category,
      estimatedMinutes: adaptedMinutes,
      durationLabel: formatDurationLabel(adaptedMinutes),
      effortLevel: adaptedEffort,
      goal: matchedGoal ? `${tpl.goal} · (${matchedGoal})` : tpl.goal,
      instructions: tpl.instructions,
      createdAt: nowIso,
      status: "proposta",
      source: "local-adaptive",
      adaptationNote: buildAdaptationNote({
        energyLevel: ctx.energyLevel,
        availableMinutes: ctx.availableMinutes,
        matchedGoal,
        uncertainEmotion,
        effortLevel: adaptedEffort,
      }),
    });
  }

  return {
    missions: selected,
    source: "local-adaptive",
    askUserPreference: uncertainEmotion,
    preferencePrompt: uncertainEmotion
      ? "Il contesto emotivo è sfumato o incerto: ho scelto proposte neutre e facoltative. Preferisci un'attività di recupero, movimento o organizzazione?"
      : undefined,
    fallbackUsed: false,
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parseAndValidateMissionsJson(
  raw: unknown,
  options?: {
    maxMinutes?: number;
    energyLevel?: EnergyLevel;
    nowIso?: string;
    source?: AdaptiveMission["source"];
  }
): { ok: true; missions: AdaptiveMission[] } | { ok: false; error: string } {
  let parsed: unknown = raw;

  if (typeof raw === "string") {
    const cleaned = stripJsonFence(raw);
    if (!cleaned) {
      return { ok: false, error: "Risposta JSON vuota." };
    }
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { ok: false, error: "JSON delle missioni malformato." };
    }
  }

  const rawList: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { missions?: unknown }).missions)
      ? (parsed as { missions: unknown[] }).missions
      : null;

  if (!rawList || rawList.length === 0) {
    return { ok: false, error: "Lista missioni mancante o vuota." };
  }

  const nowIso = options?.nowIso ?? new Date().toISOString();
  const validated: AdaptiveMission[] = [];

  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;

    const title = typeof rec.title === "string" ? redactSensitiveTokens(rec.title).trim().slice(0, 90) : "";
    const description =
      typeof rec.description === "string"
        ? redactSensitiveTokens(rec.description).trim().slice(0, 260)
        : "";
    const category = normalizeMissionCategory(rec.category);
    const goal = typeof rec.goal === "string" ? redactSensitiveTokens(rec.goal).trim().slice(0, 140) : "";

    if (!title || !description || !category || !goal) continue;
    if (
      !isSafeForLongTermMemory(title) ||
      !isSafeForLongTermMemory(description) ||
      !isSafeForLongTermMemory(goal)
    ) {
      continue;
    }

    const rawMinutes =
      typeof rec.estimatedMinutes === "number" && Number.isFinite(rec.estimatedMinutes)
        ? Math.round(rec.estimatedMinutes)
        : 5;
    const maxCap = options?.maxMinutes ? Math.max(2, options.maxMinutes) : 45;
    const estimatedMinutes = Math.max(1, Math.min(maxCap, rawMinutes));

    let effortLevel: MissionEffort =
      rec.effortLevel === "basso" || rec.effortLevel === "medio" || rec.effortLevel === "alto"
        ? rec.effortLevel
        : "basso";

    if (options?.energyLevel === "bassa") {
      effortLevel = "basso";
    }

    const rawInstructions = Array.isArray(rec.instructions) ? rec.instructions : [];
    const instructions = rawInstructions
      .filter((s): s is string => typeof s === "string")
      .map((s) => redactSensitiveTokens(s).trim().slice(0, 140))
      .filter((s) => s.length >= 4 && isSafeForLongTermMemory(s))
      .slice(0, 5);

    if (instructions.length === 0) continue;

    const adaptationNote =
      typeof rec.adaptationNote === "string" && isSafeForLongTermMemory(rec.adaptationNote)
        ? redactSensitiveTokens(rec.adaptationNote).trim().slice(0, 140)
        : undefined;

    validated.push({
      id: createAdaptiveMissionId("gem"),
      title,
      description,
      category,
      estimatedMinutes,
      durationLabel: formatDurationLabel(estimatedMinutes),
      effortLevel,
      goal,
      instructions,
      createdAt: nowIso,
      status: "proposta",
      source: options?.source ?? "gemini-json",
      adaptationNote,
    });

    if (validated.length >= 4) break;
  }

  if (validated.length === 0) {
    return { ok: false, error: "Nessuna missione valida conforme allo schema." };
  }

  return { ok: true, missions: validated };
}

export function transitionMissionStatus(
  mission: AdaptiveMission,
  nextStatus: MissionStatus,
  nowIso = new Date().toISOString()
): AdaptiveMission {
  return {
    ...mission,
    status: nextStatus,
    updatedAt: nowIso,
  };
}

export function updateMissionDetails(
  mission: AdaptiveMission,
  patch: {
    title?: string;
    description?: string;
    estimatedMinutes?: number;
    goal?: string;
  },
  nowIso = new Date().toISOString()
): AdaptiveMission {
  const nextTitle =
    patch.title !== undefined && patch.title.trim() && isSafeForLongTermMemory(patch.title)
      ? redactSensitiveTokens(patch.title).trim().slice(0, 90)
      : mission.title;
  const nextDescription =
    patch.description !== undefined &&
    patch.description.trim() &&
    isSafeForLongTermMemory(patch.description)
      ? redactSensitiveTokens(patch.description).trim().slice(0, 260)
      : mission.description;
  const nextMinutes =
    typeof patch.estimatedMinutes === "number" && Number.isFinite(patch.estimatedMinutes)
      ? Math.max(1, Math.min(60, Math.round(patch.estimatedMinutes)))
      : mission.estimatedMinutes;
  const nextGoal =
    patch.goal !== undefined && patch.goal.trim() && isSafeForLongTermMemory(patch.goal)
      ? redactSensitiveTokens(patch.goal).trim().slice(0, 140)
      : mission.goal;

  return {
    ...mission,
    title: nextTitle,
    description: nextDescription,
    estimatedMinutes: nextMinutes,
    durationLabel: formatDurationLabel(nextMinutes),
    goal: nextGoal,
    updatedAt: nowIso,
  };
}
