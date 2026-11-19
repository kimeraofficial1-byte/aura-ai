export const EMOTION_CATEGORIES = [
  "Gioia",
  "Serenità",
  "Tristezza",
  "Ansia",
  "Rabbia",
  "Paura",
  "Frustrazione",
  "Solitudine",
  "Confusione",
  "Stanchezza",
  "Neutro",
  "Incerto",
] as const;

export type EmotionCategory = (typeof EMOTION_CATEGORIES)[number];

export type EmpathyPacing = "slow-grounding" | "gentle-warm" | "clear-structured" | "light-open";

export interface EmpathyStrategy {
  tone: string;
  activeListeningFocus: string;
  questionStyle: string;
  pacing: EmpathyPacing;
  suggestedExercise: string | null;
}

export interface EmotionalAnalysis {
  primaryEmotion: EmotionCategory;
  secondaryEmotions: EmotionCategory[];
  /** Intensità percepita su scala 0-10 */
  intensity: number;
  /** Confidenza della rilevazione su scala 0-1 */
  confidence: number;
  /** Vero se la confidenza è bassa (< 0.55) o se l'emozione prevalente è Incerto */
  uncertain: boolean;
  /** Brevi elementi testuali effettivamente presenti nel messaggio */
  evidence: string[];
  /** Segnali di stress o sovraccarico non clinici */
  stressSignals: string[];
  /** Strategia di risposta empatica per Gemini */
  empathyStrategy: EmpathyStrategy;
  analyzedAt: string;
  source: "heuristic" | "gemini-json" | "hybrid";
}

export interface EmotionalTrendEntry {
  id: string;
  date: string;
  primaryEmotion: EmotionCategory;
  secondaryEmotions: EmotionCategory[];
  intensity: number;
  confidence: number;
  uncertain: boolean;
  stressSignals: string[];
  source: "chat" | "checkin";
}
