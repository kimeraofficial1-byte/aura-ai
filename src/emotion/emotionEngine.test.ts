import test from "node:test";
import assert from "node:assert/strict";
import { buildAuraSystemInstruction } from "../../server/auraAgent";
import { analyzeMessageEmotion } from "../../server/emotionEngine";
import { evaluatePreModelSafety, validateChatRequest } from "../../server/safety";
import { AuraMemoryStore, MEMORY_STORAGE_KEYS } from "../memory/storage";
import type { StorageDriver } from "../memory/types";
import {
  analyzeEmotionDeterministic,
  parseAndValidateEmotionalAnalysisJson,
} from "./analyzer";
import {
  buildEmotionalTrendSummaryForGemini,
  buildEmpathyGuidanceForGemini,
} from "./empathy";
import { EMOTION_CATEGORIES, type EmotionCategory, type EmotionalTrendEntry } from "./types";

function createMemoryDriver(): StorageDriver & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

test("detects all 12 emotion categories accurately in Italian", () => {
  assert.equal(EMOTION_CATEGORIES.length, 12);

  const cases: Array<{ input: string; expected: EmotionCategory }> = [
    { input: "Sono davvero felice e entusiasta per questa bellissima notizia!", expected: "Gioia" },
    { input: "Oggi mi sento sereno, calmo e in pace con me stesso.", expected: "Serenità" },
    { input: "Mi sento molto triste e abbattuto, ho una forte malinconia.", expected: "Tristezza" },
    { input: "Ho molta ansia, mi sento agitato e ho un nodo allo stomaco.", expected: "Ansia" },
    { input: "Sono furioso e arrabbiato dopo quel litigio ingiusto!", expected: "Rabbia" },
    { input: "Ho tanta paura e sono spaventato per quello che succederà.", expected: "Paura" },
    { input: "Sono frustrato e bloccato, ci provo ma gira tutto storto.", expected: "Frustrazione" },
    { input: "Mi sento così solo, isolato e incompreso da tutti.", expected: "Solitudine" },
    { input: "Sono confuso e disorientato, non so cosa fare né cosa decidere.", expected: "Confusione" },
    { input: "Sono esausto e sfinito, non ho dormito e non ho più energie.", expected: "Stanchezza" },
    { input: "Buongiorno, oggi ho lavorato al computer e ho fatto la spesa.", expected: "Neutro" },
    { input: "Boh, non so proprio come mi sento oggi, mah.", expected: "Incerto" },
  ];

  for (const item of cases) {
    const result = analyzeEmotionDeterministic(item.input);
    assert.equal(
      result.primaryEmotion,
      item.expected,
      `Expected ${item.expected} for "${item.input}", got ${result.primaryEmotion}`
    );
    assert.ok(result.intensity >= 0 && result.intensity <= 10);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
  }
});

test("handles ambiguous and neutral messages with prudent confidence and uncertainty flags", () => {
  const ambiguous = analyzeEmotionDeterministic("Mah... un po' tutto e un po' niente, non saprei dirlo.");
  assert.equal(ambiguous.primaryEmotion, "Incerto");
  assert.equal(ambiguous.uncertain, true);
  assert.ok(ambiguous.confidence < 0.55);

  const shortVague = analyzeEmotionDeterministic("mah");
  assert.equal(shortVague.primaryEmotion, "Incerto");
  assert.equal(shortVague.uncertain, true);

  const neutral = analyzeEmotionDeterministic("Tutto normale oggi, giornata ordinaria in ufficio.");
  assert.equal(neutral.primaryEmotion, "Neutro");
  assert.equal(neutral.uncertain, false);
});

test("extracts multiple simultaneous emotions, textual evidence, and stress signals", () => {
  const result = analyzeEmotionDeterministic(
    "Ho molta ansia per la scadenza al lavoro, sono anche esausto perché non dormo e un po' frustrato."
  );

  assert.equal(result.primaryEmotion, "Ansia");
  assert.ok(result.secondaryEmotions.includes("Stanchezza"));
  assert.ok(result.secondaryEmotions.includes("Frustrazione"));
  assert.ok(result.evidence.length > 0);
  assert.ok(result.stressSignals.includes("carico lavorativo o di studio"));
  assert.ok(result.stressSignals.includes("qualità del sonno o riposo ridotto"));
});

test("rejects malformed JSON and invalid emotional analysis schemas cleanly", () => {
  assert.equal(parseAndValidateEmotionalAnalysisJson("").ok, false);
  assert.equal(parseAndValidateEmotionalAnalysisJson("{bad json").ok, false);
  assert.equal(parseAndValidateEmotionalAnalysisJson("[]").ok, false);
  assert.equal(
    parseAndValidateEmotionalAnalysisJson(
      JSON.stringify({
        primaryEmotion: "DepressioneClinica", // non consentita
        intensity: 7,
        confidence: 0.8,
      })
    ).ok,
    false
  );
  assert.equal(
    parseAndValidateEmotionalAnalysisJson(
      JSON.stringify({
        primaryEmotion: "Ansia",
        intensity: "alta",
        confidence: 0.8,
      })
    ).ok,
    false
  );
  assert.equal(
    parseAndValidateEmotionalAnalysisJson(
      JSON.stringify({
        primaryEmotion: "Ansia",
        secondaryEmotions: "Stanchezza", // deve essere array
        intensity: 6,
        confidence: 0.8,
      })
    ).ok,
    false
  );

  // JSON valido con markdown fence + filtro di evidence inventate
  const validFenced = parseAndValidateEmotionalAnalysisJson(
    "```json\n" +
      JSON.stringify({
        primaryEmotion: "serenita",
        secondaryEmotions: ["Gioia", "serenita", "Invalida"],
        intensity: 14,
        confidence: 0.84,
        uncertain: false,
        evidence: ["mi sento sereno", "frase inventata dal nulla"],
        stressSignals: [],
      }) +
      "\n```",
    { sourceText: "Oggi mi sento sereno dopo una passeggiata" }
  );
  assert.equal(validFenced.ok, true);
  if (validFenced.ok) {
    assert.equal(validFenced.data.primaryEmotion, "Serenità");
    assert.deepEqual(validFenced.data.secondaryEmotions, ["Gioia"]);
    assert.equal(validFenced.data.intensity, 10);
    assert.deepEqual(validFenced.data.evidence, ["mi sento sereno"]);
  }
});

test("marks low-confidence results as uncertain and adapts Empathy Engine guidance", () => {
  const parsed = parseAndValidateEmotionalAnalysisJson({
    primaryEmotion: "Tristezza",
    secondaryEmotions: [],
    intensity: 4,
    confidence: 0.38,
    uncertain: false,
    evidence: [],
    stressSignals: [],
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.uncertain, true);
    const guidance = buildEmpathyGuidanceForGemini(parsed.data);
    assert.match(guidance, /REGOLA DI PRUDENZA PER INCERTEZZA/);
    assert.match(guidance, /Non affermare con sicurezza/);
  }
});

test("crisis messages always trigger pre-model safety and are blocked by emotion analyzer", async () => {
  const crisisMsg = "Non voglio più vivere, voglio farla finita stasera";
  const safety = evaluatePreModelSafety(crisisMsg);
  assert.equal(safety.crisisDetected, true);
  assert.match(safety.reply ?? "", /112/);

  const engineResult = await analyzeMessageEmotion({
    message: crisisMsg,
    useGeminiClassifier: false,
  });
  assert.equal(engineResult.crisisBlocked, true);
  assert.equal(engineResult.analysis, null);
});

test("emotional trend storage respects memory consent off vs on and deletes on revocation", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);

  const sampleEntry: EmotionalTrendEntry = {
    id: "t1",
    date: "2026-11-15T10:00:00Z",
    primaryEmotion: "Ansia",
    secondaryEmotions: ["Stanchezza"],
    intensity: 7,
    confidence: 0.85,
    uncertain: false,
    stressSignals: ["carico lavorativo o di studio"],
    source: "chat",
  };

  // Senza consenso -> nessun salvataggio e nessun summary a Gemini
  assert.deepEqual(store.saveEmotionalTrend(sampleEntry), []);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.emotionalTrends), null);
  assert.equal(
    buildEmotionalTrendSummaryForGemini({ consentEnabled: false, trends: [sampleEntry] }),
    undefined
  );

  // Con consenso -> salva, ripristina, esporta e genera summary per Gemini
  store.setConsent(true);
  const saved = store.saveEmotionalTrend(sampleEntry, {
    rawText: "Ho molta ansia per il lavoro",
    crisisDetected: false,
  });
  assert.equal(saved.length, 1);

  const reloaded = new AuraMemoryStore(driver);
  assert.equal(reloaded.getEmotionalTrends().length, 1);
  assert.equal(reloaded.exportBundle().emotionalTrends.length, 1);

  const summary = buildEmotionalTrendSummaryForGemini({
    consentEnabled: true,
    trends: reloaded.getEmotionalTrends(),
  });
  assert.match(summary ?? "", /Ansia \(7\/10\)/);

  // Revoca consenso -> cancella tutto
  reloaded.setConsent(false);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.emotionalTrends), null);
  assert.equal(reloaded.getEmotionalTrends().length, 0);
});

test("blocks saving sensitive crisis, clinical diagnosis, or medication messages to emotional trends even with consent enabled", () => {
  const driver = createMemoryDriver();
  const store = new AuraMemoryStore(driver);
  store.setConsent(true);

  const entry: EmotionalTrendEntry = {
    id: "t-sensitive",
    date: "2026-11-15T10:15:00Z",
    primaryEmotion: "Tristezza",
    secondaryEmotions: [],
    intensity: 8,
    confidence: 0.8,
    uncertain: false,
    stressSignals: [],
    source: "chat",
  };

  store.saveEmotionalTrend(entry, {
    rawText: "Non voglio più vivere",
    crisisDetected: true,
  });
  store.saveEmotionalTrend(entry, {
    rawText: "Ho una diagnosi di disturbo bipolare e prendo Xanax",
    crisisDetected: false,
  });

  assert.equal(store.getEmotionalTrends().length, 0);
  assert.equal(driver.getItem(MEMORY_STORAGE_KEYS.emotionalTrends), null);
});

test("integrates Empathy Engine and trend context cleanly with Gemini system instructions and request validation", async () => {
  const emotion = await analyzeMessageEmotion({
    message: "Mi sento sopraffatto dall'ansia prima della riunione",
    context: { mood: "Teso", stress: 8 },
    useGeminiClassifier: false,
  });

  assert.equal(emotion.crisisBlocked, false);
  assert.ok(emotion.analysis);

  const instruction = buildAuraSystemInstruction({
    mood: "Teso",
    stress: 8,
    emotionalAnalysis: emotion.analysis!,
    emotionalTrendSummary: "Andamento emotivo recente: Ansia (7/10).",
  });

  assert.match(instruction, /EMPATHY ENGINE/);
  assert.match(instruction, /Emozione prevalente ipotizzata: Ansia/);
  assert.match(instruction, /Andamento emotivo recente: Ansia/);
  assert.match(instruction, /Non formulare mai diagnosi mediche/);

  const validated = validateChatRequest({
    message: "Mi sento teso",
    context: {
      emotionalTrendSummary: "  Andamento emotivo recente: Ansia (7/10).  ",
    },
  });
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(
      validated.data.context?.emotionalTrendSummary,
      "Andamento emotivo recente: Ansia (7/10)."
    );
  }
});
