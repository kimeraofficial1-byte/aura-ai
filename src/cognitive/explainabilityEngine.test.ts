import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { CognitiveTimeline } from "./cognitiveTimeline";
import { generateCognitiveExplanation } from "./explainabilityEngine";
import type { DecisionExplanation } from "./metaCognitiveTypes";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Explainability Engine V1 (Phase 10.4)", () => {
  it("10.4.1 builds a complete 12-point structured explanation with recommended strategy and verifiable evidences", () => {
    const res = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      evaluationId: "eval-10-4-1",
      declaredGoal: "Completare sessione di studio",
      constraints: {
        energyLevel: "low",
        timeBudgetMinutes: 15,
      },
      expectedInputs: ["goal"],
      availableInputs: { goal: "Completare sessione di studio" },
      explicitEvidences: [
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: "Proposta precedente accettata",
          confidence: 0.9,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "2 task completati nel piano",
          confidence: 0.85,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "interpretazione_prudente",
          dataSource: "CognitiveTimeline",
          summary: "Ritmo pomeridiano ridotto",
          confidence: 0.75,
        },
      ],
      nowIso: "2026-11-22T11:00:00.000Z",
    });

    const compat: DecisionExplanation = res;
    assert.equal(res.allowed, true);
    assert.equal(res.advisoryOnly, true);
    assert.equal(res.readOnly, true);
    assert.equal(res.autoApplied, false);
    assert.equal(res.insufficientData, false);
    assert.equal(res.evaluationId, "eval-10-4-1");
    assert.equal(res.evaluationTimestamp, "2026-11-22T11:00:00.000Z");
    assert.equal(res.analyzedGoal, "Completare sessione di studio");
    assert.equal(res.recommendedStrategy, "LIGHT");
    assert.equal(res.strategiesCompared.length, 3);
    assert.equal(compat.evidencesUsed.length, 3);
    assert.equal(compat.discardedAlternatives.length, 2);
    assert.ok(compat.summary.includes("LIGHT"));
    assert.ok(compat.whyChosen.includes("LIGHT"));
    assert.ok(compat.uncertaintiesAndLimits.length >= 2);
  });

  it("10.4.2 accurately distinguishes facts, observations, and hypotheses without promoting hypotheses to facts", () => {
    const res = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Verifica equilibrio carico",
      explicitEvidences: [
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: "Conferma esplicita mattina",
          confidence: 0.9,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "interpretazione_prudente",
          dataSource: "CognitiveTimeline",
          summary: "Osservato completamento più lento",
          confidence: 0.7,
        },
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Possibile stanchezza serale",
          confidence: 0.55,
        },
      ],
    });

    assert.equal(res.allowed, true);
    assert.equal(res.epistemicDistinction.counts.facts, 1);
    assert.equal(res.epistemicDistinction.counts.observations, 1);
    assert.equal(res.epistemicDistinction.counts.hypotheses, 1);
    assert.ok(
      res.epistemicDistinction.facts.every(
        (f) => !f.includes("Possibile stanchezza serale")
      )
    );
    assert.ok(
      res.epistemicDistinction.hypotheses.some((h) =>
        h.includes("Possibile stanchezza serale")
      )
    );
  });

  it("10.4.3 handles missing information and explains when no strategy can be reliably recommended", () => {
    const res = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Pianificare giornata",
      expectedInputs: ["energyLevel", "timeBudget"],
      availableInputs: {},
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi iniziale non confermata",
          confidence: 0.5,
        },
      ],
    });

    assert.equal(res.allowed, true);
    assert.equal(res.insufficientData, true);
    assert.equal(res.recommendedStrategy, null);
    assert.equal(res.reliabilityScore, null);
    assert.equal(res.uncertaintyLevel, "insufficient_evidence");
    assert.equal(res.missingInformation.length, 2);
    assert.ok(res.summary.toLowerCase().includes("dati insufficienti"));
    assert.ok(res.whyChosen.toLowerCase().includes("nessuna strategia consigliata"));
    assert.ok(res.clarificationQuestions.length > 0);
  });

  it("10.4.4 reports detected contradictions and epistemic errors in the explanation", () => {
    const res = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Focus pomeridiano",
      proposedStrategy: "STANDARD",
      constraints: {
        energyLevel: "low",
        overloadDetected: true,
      },
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "fatto_osservato",
          dataSource: "TestSource",
          summary: "Ipotesi trattata come fatto",
          confidence: 0.6,
        },
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: 'Scelta "accepted"',
          confidence: 0.9,
        },
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: 'Scelta "rejected"',
          confidence: 0.9,
        },
      ],
    });

    assert.equal(res.allowed, true);
    assert.ok(res.detectedErrorsAndContradictions.length >= 2);
    assert.ok(
      res.detectedErrorsAndContradictions.every((e) => e.autoApplied === false)
    );
    assert.ok(
      res.detectedErrorsAndContradictions.some(
        (e) => e.errorSubtype === "hypothesis_as_fact"
      )
    );
    assert.ok(
      res.detectedErrorsAndContradictions.some(
        (e) => e.errorSubtype === "goal_strategy_mismatch"
      )
    );
  });

  it("10.4.5 keeps source stores immutable and fails closed on safety/consent violations", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Piano immutabile",
      horizon: "daily",
      consentEnabled: false,
    });
    repo.savePlans([plan]);

    const timeline = new CognitiveTimeline(storage);
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Step",
      description: "Completato",
      reliability: 0.9,
      epistemicTag: "fatto_osservato",
    });

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted", "2026-11-22T09:00:00.000Z");

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const timelineBefore = JSON.stringify(timeline.getEvents());
    const interactionsBefore = JSON.stringify(
      controlled.exportLearningData().interactions
    );

    const okRes = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      declaredGoal: "Piano immutabile",
      repository: repo,
      timeline,
      controlledLearning: controlled,
      nowIso: "2026-11-22T11:30:00.000Z",
    });

    assert.equal(okRes.allowed, true);
    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
    assert.equal(
      JSON.stringify(controlled.exportLearningData().interactions),
      interactionsBefore
    );

    const blockedCrisis = generateCognitiveExplanation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(blockedCrisis.allowed, false);
    assert.equal(blockedCrisis.safetyDecision.blockedBy, "crisis");

    const blockedConsent = generateCognitiveExplanation({
      consentState: CONSENT_OFF,
      usesLearningData: true,
    });
    assert.equal(blockedConsent.allowed, false);
    assert.equal(blockedConsent.safetyDecision.blockedBy, "consent");
  });
});
