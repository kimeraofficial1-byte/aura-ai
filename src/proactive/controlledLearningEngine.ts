import type {
  ControlledLearningExport,
  LearningAction,
  LearningInteraction,
} from "./types";

const ACTION_DELTAS: Record<LearningAction, number> = {
  completed: 0.15,
  accepted: 0.1,
  snoozed: -0.04,
  suspended: -0.12,
  rejected: -0.15,
};

function clampWeight(value: number): number {
  return Math.max(0.5, Math.min(1.5, Math.round(value * 100) / 100));
}

/**
 * Controlled Learning Engine V1.1.
 * Apprende esclusivamente dalle interazioni sui suggerimenti (accepted, rejected, snoozed, completed)
 * per migliorare l'ordinamento delle proposte future.
 * - Non modifica mai i dati originali.
 * - Non crea profili psicologici.
 * - Non invia dati a Gemini.
 * - Può essere disattivato, esportato e cancellato completamente.
 */
export class ControlledLearningEngine {
  private enabled: boolean;
  private interactions: LearningInteraction[] = [];
  private categoryWeights: Record<string, number> = {};

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  recordInteraction(
    category: string,
    action: LearningAction,
    timestamp: string = new Date().toISOString()
  ): void {
    if (!this.enabled) return;
    const cleanCat = category.trim().toLowerCase() || "general";
    this.interactions.unshift({ category: cleanCat, action, timestamp });
    if (this.interactions.length > 200) {
      this.interactions.length = 200;
    }
    const current = this.categoryWeights[cleanCat] ?? 1.0;
    this.categoryWeights[cleanCat] = clampWeight(current + ACTION_DELTAS[action]);
  }

  getCategoryWeight(category: string): number {
    if (!this.enabled) return 1.0;
    return this.categoryWeights[category.trim().toLowerCase()] ?? 1.0;
  }

  getInteractionCount(): number {
    return this.interactions.length;
  }

  exportLearningData(): ControlledLearningExport {
    return {
      exportedAt: new Date().toISOString(),
      enabled: this.enabled,
      totalInteractions: this.interactions.length,
      categoryWeights: { ...this.categoryWeights },
      interactions: [...this.interactions],
    };
  }

  exportLearningJson(): string {
    return JSON.stringify(this.exportLearningData(), null, 2);
  }

  getRejectedCount(category: string): number {
    const cleanCat = category.trim().toLowerCase();
    return this.interactions.filter(
      (i) => i.category === cleanCat && (i.action === "rejected" || i.action === "suspended")
    ).length;
  }

  getLearningExplanation(): string {
    if (!this.enabled) {
      return "Apprendimento controllato disattivato: nessuna decisione sui suggerimenti viene registrata o utilizzata per modificare le priorità.";
    }
    return `Apprendimento controllato attivo (${this.interactions.length} decisioni registrate): adatta solo l'ordinamento dei suggerimenti proattivi in base alle tue scelte esplicite (accetta, rifiuta, rimanda, sospendi, completa). Separato dalla Memoria AI, senza profilazione psicologica e senza invio a Gemini.`;
  }

  clearLearningData(): void {
    this.interactions = [];
    this.categoryWeights = {};
  }
}
