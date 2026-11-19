import type { ControlledLearningEngine } from "./controlledLearningEngine";
import { analyzeProactiveOpportunities } from "./proactiveEngine";
import type {
  ProactiveAnalysisInput,
  ProactiveSuggestion,
  SuggestionPriority,
} from "./types";

const PRIORITY_BASE_SCORE: Record<SuggestionPriority, number> = {
  alta: 3,
  media: 2,
  bassa: 1,
};

function extractCategoryFromDedupeKey(dedupeKey: string): string {
  const idx = dedupeKey.indexOf(":");
  return idx > 0 ? dedupeKey.slice(0, idx) : "general";
}

/**
 * Contextual Suggestion Engine V1.1.
 * Utilizza i suggerimenti reali del Proactive Engine V1 e li ordina per pertinenza
 * usando i pesi del Controlled Learning Engine, senza mai modificare piani o dati originali.
 */
export function generateContextualSuggestions(
  input: ProactiveAnalysisInput,
  learningEngine?: ControlledLearningEngine
): ProactiveSuggestion[] {
  const analysis = analyzeProactiveOpportunities(input);
  if (analysis.safetyBlocked || analysis.suggestions.length === 0) {
    return [];
  }

  if (!learningEngine || !learningEngine.isEnabled()) {
    return analysis.suggestions;
  }

  return [...analysis.suggestions].sort((a, b) => {
    const catA = extractCategoryFromDedupeKey(a.dedupeKey);
    const catB = extractCategoryFromDedupeKey(b.dedupeKey);
    const scoreA =
      PRIORITY_BASE_SCORE[a.priority] * a.confidence * learningEngine.getCategoryWeight(catA);
    const scoreB =
      PRIORITY_BASE_SCORE[b.priority] * b.confidence * learningEngine.getCategoryWeight(catB);
    return scoreB - scoreA;
  });
}
