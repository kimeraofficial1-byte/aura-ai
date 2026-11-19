import { isSafeForLongTermMemory, normalizeText, redactSensitiveTokens } from "../memory/privacyFilter";
import type { ChatHistoryItem } from "../types/aura";
import { buildEmpathyStrategy } from "./empathy";
import {
  EMOTION_CATEGORIES,
  type EmotionCategory,
  type EmotionalAnalysis,
} from "./types";

const LOW_CONFIDENCE_THRESHOLD = 0.55;

const CATEGORY_MAP = new Map<string, EmotionCategory>(
  EMOTION_CATEGORIES.map((cat) => [normalizeText(cat), cat])
);

export function normalizeEmotionCategory(value: unknown): EmotionCategory | null {
  if (typeof value !== "string") return null;
  const norm = normalizeText(value);
  return CATEGORY_MAP.get(norm) ?? null;
}

interface EmotionRule {
  category: Exclude<EmotionCategory, "Neutro" | "Incerto">;
  strong: RegExp[];
  moderate: RegExp[];
  baseIntensity: number;
}

const EMOTION_RULES: EmotionRule[] = [
  {
    category: "Gioia",
    strong: [
      /\b(felicissim[oaie]|euforic[oa]|al settimo cielo|entusiasta|meraviglios[oa]|bellissima notizia|gioia immensa|mi sento benissimo|che splendida giornata)\b/i,
    ],
    moderate: [
      /\b(felice|felicita|content[oaie]|gioi[ao]|gioios[oa]|allegri?a|soddisfatt[oaie]|entusiasmo|gratitudine|grato|grata|che bello|sorrido|orgoglios[oa]|mi fa piacere|sono proprio content[oa])\b/i,
    ],
    baseIntensity: 6,
  },
  {
    category: "Serenità",
    strong: [
      /\b(molto seren[oa]|profondamente calm[oa]|in totale pace|davvero rilassat[oa]|grande equilibrio|piena quiete)\b/i,
    ],
    moderate: [
      /\b(seren[oaie]|serenita|tranquill[oaie]|calm[oaie]|rilassat[oaie]|distes[oa]|in pace|equilibrio|leggerezza|quiete|armonia|respiro bene|mi sento leggero|mi sento leggera)\b/i,
    ],
    baseIntensity: 4,
  },
  {
    category: "Tristezza",
    strong: [
      /\b(molto triste|a pezzi emotivamente|piango|non smetto di piangere|cuore pesante|profondo sconforto|vuoto dentro|disperat[oa]|mi si stringe il cuore)\b/i,
    ],
    moderate: [
      /\b(triste|tristezza|giu di morale|mi sento giu|malinconia|malinconic[oa]|abbattut[oa]|piangere|lacrime|delus[oa]|sconforto|scoraggiat[oa]|mi manca|svogliat[oa]|non ho voglia di fare nulla|mi sento vuoto|mi sento vuota)\b/i,
    ],
    baseIntensity: 6,
  },
  {
    category: "Ansia",
    strong: [
      /\b(attacco di panico|panico|ansia forte|molta ansia|tachicardia|nodo alla gola|non riesco a respirare bene|sopraffatt[oa] dall ansia|oppress[oa]|cuore a mille)\b/i,
    ],
    moderate: [
      /\b(ansia|ansios[oaie]|agitat[oaie]|agitazione|preoccupat[oaie]|preoccupazione|in tensione|tes[oa]|sotto pressione|nodo allo stomaco|affanno|non riesco a staccare|rimugino|mi pesa tutto)\b/i,
    ],
    baseIntensity: 7,
  },
  {
    category: "Rabbia",
    strong: [
      /\b(furios[oa]|arrabbiatissim[oa]|incazzat[oa]|fuori di me|sto per esplodere|rabbia cieca|odio tutto|mi bolle il sangue)\b/i,
    ],
    moderate: [
      /\b(arrabbiat[oaie]|rabbia|nervos[oaie]|irritat[oaie]|collera|non sopporto|ingiustizia|litigato|litigio|scattato|infastidit[oa]|che rabbia|mi fa impazzire)\b/i,
    ],
    baseIntensity: 7,
  },
  {
    category: "Paura",
    strong: [
      /\b(terrorizzat[oa]|paralizzat[oa] dalla paura|molta paura|terrore|spaventatissim[oa]|mi tremano le mani dalla paura)\b/i,
    ],
    moderate: [
      /\b(paura|spaventat[oaie]|timore|temo|mi spaventa|ho paura|spavento|minaccia|angoscia per il futuro|non mi sento al sicuro)\b/i,
    ],
    baseIntensity: 7,
  },
  {
    category: "Frustrazione",
    strong: [
      /\b(completamente bloccato|esasperat[oa]|non ne posso piu di provare|sbatto contro un muro|tutto gira storto|gira tutto storto)\b/i,
    ],
    moderate: [
      /\b(frustrat[oaie]|frustrazione|bloccat[oa]|impotente|non ci riesco|non funziona mai|stuf[oa]|demoralizzat[oa]|ostacoli|inutile provarci|non cambia mai nulla)\b/i,
    ],
    baseIntensity: 6,
  },
  {
    category: "Solitudine",
    strong: [
      /\b(completamente sol[oa]|nessuno al mondo mi capisce|profonda solitudine|totalmente isolat[oa]|abbandonat[oa] da tutti)\b/i,
    ],
    moderate: [
      /\b(mi sento sol[oa]|sono sol[oa]|solitudine|isolat[oa]|abbandonat[oa]|nessuno mi capisce|nessuno mi ascolta|incompres[oa]|senza nessuno|distante da tutti|nessuno mi cerca)\b/i,
    ],
    baseIntensity: 6,
  },
  {
    category: "Confusione",
    strong: [
      /\b(completamente confus[oa]|non capisco piu niente|testa nel caos|totalmente disorientat[oa])\b/i,
    ],
    moderate: [
      /\b(confus[oaie]|confusione|disorientat[oa]|spaesat[oa]|non capisco|non so cosa fare|non ho le idee chiare|testa annebbiata|indecis[oa]|dubbio|perso nei pensieri|persa nei pensieri|non so che pesci prendere)\b/i,
    ],
    baseIntensity: 5,
  },
  {
    category: "Stanchezza",
    strong: [
      /\b(esaust[oa]|sfinit[oa]|completamente scaric[oa]|non ho dormito per niente|a pezzi fisicamente|senza piu energie|non ce la faccio piu con la fatica)\b/i,
    ],
    moderate: [
      /\b(stanc[oaie]|stanchezza|spossat[oa]|scaric[oa]|sonno|non ho dormito|insonnia|fatica|affaticat[oa]|senza energie|stremat[oa]|logorat[oa]|ho bisogno di dormire)\b/i,
    ],
    baseIntensity: 6,
  },
];

const UNCERTAINTY_PATTERNS: RegExp[] = [
  /\b(non so come mi sento|non saprei come sto|non lo so neanche io|boh|mah|forse si forse no|un po tutto e un po niente|non saprei dirlo|misto strano)\b/i,
];

const NEUTRAL_FACTUAL_PATTERNS: RegExp[] = [
  /^(ciao|salve|buongiorno|buonasera|ok|va bene|grazie|tutto normale|giornata normale|giornata ordinaria|nulla di particolare)[.!?\s]*$/i,
  /\b(ho fatto la spesa|ho lavorato al computer|giornata tranquilla e ordinaria|vorrei chiedere un informazione|come funziona aura)\b/i,
];

const STRESS_SIGNAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(lavoro|ufficio|riunione|scadenza|colleghi|capo|progetto|esami|studio)\b/i, label: "carico lavorativo o di studio" },
  { pattern: /\b(non dormo|insonnia|sonno|sveglio di notte|notte in bianco|riposato male)\b/i, label: "qualità del sonno o riposo ridotto" },
  { pattern: /\b(fretta|urgenza|scadenze|troppi impegni|non ho tempo|corsa)\b/i, label: "pressione temporale" },
  { pattern: /\b(tachicardia|nodo alla gola|nodo allo stomaco|mal di testa|spalle tese|tensione fisica|respiro corto)\b/i, label: "tensione corporea percepita" },
  { pattern: /\b(rimugino|troppi pensieri|non riesco a staccare|testa piena|sovraccaric[oa])\b/i, label: "sovraccarico mentale" },
];

const INTENSIFIER_PATTERN = /\b(molto|tantissimo|davvero|estremamente|troppo|sempre|completamente|totalmente|proprio)\b/i;

function extractMatchedCue(originalText: string, pattern: RegExp): string | null {
  const normalized = normalizeText(originalText);
  const match = normalized.match(pattern);
  if (!match?.[0]) return null;
  const safe = redactSensitiveTokens(match[0]).trim();
  if (!safe || !isSafeForLongTermMemory(safe)) return null;
  return safe.slice(0, 60);
}

function extractStressSignals(originalText: string, checkInStress?: number): string[] {
  const normalized = normalizeText(originalText);
  const signals: string[] = [];
  for (const rule of STRESS_SIGNAL_PATTERNS) {
    if (rule.pattern.test(normalized)) {
      signals.push(rule.label);
    }
  }
  if (typeof checkInStress === "number" && checkInStress >= 7 && signals.length === 0) {
    signals.push("stress elevato al check-in recente");
  }
  return Array.from(new Set(signals)).slice(0, 4);
}

export function analyzeEmotionDeterministic(
  message: string,
  options?: {
    mood?: string;
    stress?: number;
    history?: ChatHistoryItem[];
    nowIso?: string;
  }
): EmotionalAnalysis {
  const analyzedAt = options?.nowIso ?? new Date().toISOString();
  const normalized = normalizeText(message);
  const stressSignals = extractStressSignals(message, options?.stress);

  const scored: Array<{
    category: Exclude<EmotionCategory, "Neutro" | "Incerto">;
    score: number;
    baseIntensity: number;
    cues: string[];
  }> = [];

  for (const rule of EMOTION_RULES) {
    let score = 0;
    const cues: string[] = [];
    for (const p of rule.strong) {
      if (p.test(normalized)) {
        score += 3;
        const cue = extractMatchedCue(message, p);
        if (cue) cues.push(cue);
      }
    }
    for (const p of rule.moderate) {
      if (p.test(normalized)) {
        score += 1.6;
        const cue = extractMatchedCue(message, p);
        if (cue) cues.push(cue);
      }
    }
    if (score > 0) {
      scored.push({
        category: rule.category,
        score,
        baseIntensity: rule.baseIntensity,
        cues: Array.from(new Set(cues)),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const hasExplicitUncertainty = UNCERTAINTY_PATTERNS.some((p) => p.test(normalized));
  const hasNeutralPhrase = NEUTRAL_FACTUAL_PATTERNS.some((p) => p.test(normalized));
  const hasExclamation = message.includes("!");
  const hasIntensifier = INTENSIFIER_PATTERN.test(normalized);
  const words = normalized.split(/\s+/).filter(Boolean);

  let primaryEmotion: EmotionCategory;
  let secondaryEmotions: EmotionCategory[] = [];
  let intensity = 2;
  let confidence = 0.5;
  let evidence: string[] = [];

  if (hasExplicitUncertainty && scored.length === 0) {
    primaryEmotion = "Incerto";
    intensity = 4;
    confidence = 0.35;
    const cue = extractMatchedCue(message, UNCERTAINTY_PATTERNS[0]);
    if (cue) evidence.push(cue);
  } else if (scored.length === 0) {
    if (hasNeutralPhrase || words.length >= 4) {
      primaryEmotion = "Neutro";
      intensity = typeof options?.stress === "number" && options.stress >= 7 ? 4 : 2;
      confidence = hasNeutralPhrase ? 0.78 : 0.62;
      if (words.length > 0 && words.length <= 6) {
        const safeSnippet = redactSensitiveTokens(message).trim().slice(0, 60);
        if (safeSnippet && isSafeForLongTermMemory(safeSnippet)) evidence.push(safeSnippet);
      }
    } else {
      primaryEmotion = "Incerto";
      intensity = 3;
      confidence = 0.32;
    }
  } else {
    const top = scored[0];
    const hasAmbiguousWeakConflict =
      hasExplicitUncertainty ||
      (scored.length >= 2 &&
        top.score < 2 &&
        Math.abs(top.score - scored[1].score) < 0.2 &&
        hasPositiveCategory(top.category) !== hasPositiveCategory(scored[1].category));

    if (hasAmbiguousWeakConflict) {
      primaryEmotion = "Incerto";
      secondaryEmotions = scored.slice(0, 2).map((s) => s.category);
      intensity = 5;
      confidence = 0.42;
    } else {
      primaryEmotion = top.category;
      secondaryEmotions = scored
        .slice(1, 4)
        .filter((s) => s.score >= 1.5 && s.category !== primaryEmotion)
        .map((s) => s.category);

      let calcIntensity = top.baseIntensity;
      if (top.score >= 3) calcIntensity += 2;
      if (hasIntensifier) calcIntensity += 1;
      if (hasExclamation) calcIntensity += 1;
      if (secondaryEmotions.length >= 2) calcIntensity += 1;
      if (typeof options?.stress === "number" && options.stress >= 8 && !hasPositiveCategory(primaryEmotion)) {
        calcIntensity = Math.max(calcIntensity, 7);
      }
      intensity = Math.max(1, Math.min(10, Math.round(calcIntensity)));

      let calcConfidence = 0.56 + Math.min(0.36, top.score * 0.11);
      if (hasExplicitUncertainty) calcConfidence -= 0.22;
      if (scored.length >= 2 && hasPositiveCategory(top.category) !== hasPositiveCategory(scored[1].category)) {
        calcConfidence -= 0.12;
      }
      confidence = Math.max(0.25, Math.min(0.95, Number(calcConfidence.toFixed(2))));
    }

    evidence = scored
      .flatMap((s) => s.cues)
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .slice(0, 4);
  }

  const uncertain =
    primaryEmotion === "Incerto" || confidence < LOW_CONFIDENCE_THRESHOLD;

  const empathyStrategy = buildEmpathyStrategy({
    primaryEmotion,
    intensity,
    uncertain,
    stressSignals,
  });

  return {
    primaryEmotion,
    secondaryEmotions,
    intensity,
    confidence,
    uncertain,
    evidence,
    stressSignals,
    empathyStrategy,
    analyzedAt,
    source: "heuristic",
  };
}

function hasPositiveCategory(category: EmotionCategory): boolean {
  return category === "Gioia" || category === "Serenità";
}

function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseAndValidateEmotionalAnalysisJson(
  raw: unknown,
  options?: {
    sourceText?: string;
    nowIso?: string;
    source?: EmotionalAnalysis["source"];
  }
): { ok: true; data: EmotionalAnalysis } | { ok: false; error: string } {
  let obj: unknown = raw;

  if (typeof raw === "string") {
    const cleaned = stripJsonCodeFence(raw);
    if (!cleaned) {
      return { ok: false, error: "Risposta JSON vuota." };
    }
    try {
      obj = JSON.parse(cleaned);
    } catch {
      return { ok: false, error: "JSON malformato nell'analisi emotiva." };
    }
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "Lo schema dell'analisi emotiva deve essere un oggetto JSON." };
  }

  const record = obj as Record<string, unknown>;
  const primaryEmotion = normalizeEmotionCategory(record.primaryEmotion);
  if (!primaryEmotion) {
    return {
      ok: false,
      error: "Categoria primaryEmotion mancante o non valida.",
    };
  }

  if (typeof record.intensity !== "number" || !Number.isFinite(record.intensity)) {
    return { ok: false, error: "Campo intensity mancante o non numerico." };
  }
  const intensity = Math.max(0, Math.min(10, Math.round(record.intensity)));

  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) {
    return { ok: false, error: "Campo confidence mancante o non numerico." };
  }
  const confidence = Math.max(0, Math.min(1, Number(record.confidence.toFixed(2))));

  const secondaryEmotions: EmotionCategory[] = [];
  if (record.secondaryEmotions !== undefined) {
    if (!Array.isArray(record.secondaryEmotions)) {
      return { ok: false, error: "Campo secondaryEmotions deve essere un array." };
    }
    for (const item of record.secondaryEmotions) {
      const cat = normalizeEmotionCategory(item);
      if (
        cat &&
        cat !== primaryEmotion &&
        cat !== "Neutro" &&
        cat !== "Incerto" &&
        !secondaryEmotions.includes(cat)
      ) {
        secondaryEmotions.push(cat);
      }
      if (secondaryEmotions.length >= 3) break;
    }
  }

  const normalizedSource = options?.sourceText ? normalizeText(options.sourceText) : null;

  const evidence: string[] = [];
  if (record.evidence !== undefined) {
    if (!Array.isArray(record.evidence)) {
      return { ok: false, error: "Campo evidence deve essere un array." };
    }
    for (const item of record.evidence) {
      if (typeof item !== "string") continue;
      const clean = redactSensitiveTokens(item).trim().slice(0, 120);
      if (!clean || !isSafeForLongTermMemory(clean)) continue;
      if (normalizedSource) {
        const cleanNorm = normalizeText(clean);
        // Evita allucinazioni di frasi inesistenti se fornito il testo sorgente
        const tokens = cleanNorm.split(/\s+/).filter((w) => w.length >= 3);
        const presentInSource =
          cleanNorm.length > 0 &&
          (normalizedSource.includes(cleanNorm) ||
            tokens.some((tok) => normalizedSource.includes(tok)));
        if (!presentInSource) continue;
      }
      if (!evidence.includes(clean)) {
        evidence.push(clean);
      }
      if (evidence.length >= 4) break;
    }
  }

  const stressSignals: string[] = [];
  if (record.stressSignals !== undefined) {
    if (!Array.isArray(record.stressSignals)) {
      return { ok: false, error: "Campo stressSignals deve essere un array." };
    }
    for (const item of record.stressSignals) {
      if (typeof item !== "string") continue;
      const clean = redactSensitiveTokens(item).trim().slice(0, 80);
      if (!clean || !isSafeForLongTermMemory(clean)) continue;
      if (!stressSignals.includes(clean)) {
        stressSignals.push(clean);
      }
      if (stressSignals.length >= 4) break;
    }
  }

  const uncertain =
    primaryEmotion === "Incerto" ||
    confidence < LOW_CONFIDENCE_THRESHOLD ||
    record.uncertain === true;

  const empathyStrategy = buildEmpathyStrategy({
    primaryEmotion,
    intensity,
    uncertain,
    stressSignals,
  });

  return {
    ok: true,
    data: {
      primaryEmotion,
      secondaryEmotions,
      intensity,
      confidence,
      uncertain,
      evidence,
      stressSignals,
      empathyStrategy,
      analyzedAt: options?.nowIso ?? new Date().toISOString(),
      source: options?.source ?? "gemini-json",
    },
  };
}
