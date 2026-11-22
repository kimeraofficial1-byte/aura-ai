import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import {
  ADAPTIVE_LEARNING_STORAGE_KEY,
  AdaptiveLearningEngine,
} from "./adaptiveLearningEngine";
import { CognitiveTimeline } from "./cognitiveTimeline";
import type { StrategyComparisonResult } from "./metaCognitiveTypes";
import type { LearningConsentState } from "./selfLearningTypes";
import { compareCognitiveStrategies } from "./strategyComparisonEngine";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Strategy Comparison Engine V1 (Phase 10.3)", () => {
  it("10.3.1 compares STANDARD, LIGHT, and DEFERRED with verifiable rationale and no invented weights", () => {
    const result = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Completare la revisione settimanale",
      constraints: {
        energyLevel: "high",
        timeBudgetMinutes: 60,
        overloadDetected: false,
      },
      availableResources: ["Checklist settimanale", "60 minuti liberi"],
      expectedInputs: ["goal"],
      availableInputs: { goal: "Completare la revisione settimanale" },
      processSteps: [{ id: "s1", stage: "analisi", status: "completed" }],
      explicitEvidences: [
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: "Proposta accettata",
          confidence: 0.9,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "2 task completati oggi",
          confidence: 0.85,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "CognitiveTimeline",
          summary: "Sessione completata senza interruzioni",
          confidence: 0.85,
        },
      ],
      nowIso: "2026-11-22T10:00:00.000Z",
    });

    const compat: StrategyComparisonResult = result;
    assert.equal(result.allowed, true);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.autoApplied, false);
    assert.equal(result.insufficientData, false);
    assert.equal(compat.selectedStrategy, "STANDARD");
    assert.equal(compat.options.length, 3);
    assert.deepEqual(
      compat.options.map((o) => o.strategy),
      ["STANDARD", "LIGHT", "DEFERRED"]
    );
    // Nessun peso adattivo inventato quando non esiste un profilo reale
    for (const opt of result.options) {
      assert.equal(opt.accuracyScore, null);
      assert.ok(opt.advantages.length > 0);
      assert.ok(opt.disadvantages.length > 0);
      assert.ok(opt.tradeoffs.length > 0);
    }
    assert.equal(compat.discardedAlternatives.length, 2);
    assert.equal(compat.epistemicTag, "fatto_osservato");
    assert.ok(compat.confidence !== null && compat.confidence >= 0.7);
  });

  it("10.3.2 adapts advisory recommendation to declared constraints and goals (LIGHT and DEFERRED)", () => {
    const cleanEvidences = [
      {
        evidenceType: "explicit_feedback" as const,
        epistemicTag: "fatto_osservato" as const,
        dataSource: "ControlledLearningEngine",
        summary: "Feedback 1",
        confidence: 0.85,
      },
      {
        evidenceType: "observed_behavior" as const,
        epistemicTag: "fatto_osservato" as const,
        dataSource: "DataRepository",
        summary: "Task 1 completato",
        confidence: 0.85,
      },
      {
        evidenceType: "observed_behavior" as const,
        epistemicTag: "fatto_osservato" as const,
        dataSource: "CognitiveTimeline",
        summary: "Continuità registrata",
        confidence: 0.8,
      },
    ];

    const tightConstraintRes = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Studio modulo tecnico",
      constraints: {
        energyLevel: "low",
        timeBudgetMinutes: 15,
      },
      explicitEvidences: cleanEvidences,
    });

    assert.equal(tightConstraintRes.allowed, true);
    assert.equal(tightConstraintRes.selectedStrategy, "LIGHT");
    assert.ok(
      tightConstraintRes.discardedAlternatives.some((d) =>
        d.startsWith("STANDARD:")
      )
    );

    const overloadBlockedRes = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Riorganizzazione completa",
      constraints: {
        overloadDetected: true,
      },
      expectedInputs: ["energyLevel"],
      availableInputs: {},
      processSteps: [{ id: "s1", stage: "verifica", status: "blocked" }],
      explicitEvidences: cleanEvidences,
    });

    assert.equal(overloadBlockedRes.allowed, true);
    assert.equal(overloadBlockedRes.selectedStrategy, "DEFERRED");
  });

  it("10.3.3 signals insufficient data and avoids recommending a strategy when evidences are insufficient or only hypotheses", () => {
    const onlyHypotheses = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Migliorare concentrazione",
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Possibile stanchezza serale",
          confidence: 0.8,
        },
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Possibile preferenza sessioni brevi",
          confidence: 0.75,
        },
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Possibile calo nel pomeriggio",
          confidence: 0.7,
        },
      ],
    });

    assert.equal(onlyHypotheses.allowed, true);
    assert.equal(onlyHypotheses.insufficientData, true);
    assert.equal(onlyHypotheses.selectedStrategy, null);
    assert.equal(onlyHypotheses.confidence, null);
    assert.equal(onlyHypotheses.epistemicTag, "ipotesi_da_verificare");
    assert.equal(onlyHypotheses.epistemicBreakdown.factsCount, 0);
    assert.equal(onlyHypotheses.epistemicBreakdown.hypothesesCount, 3);
    for (const opt of onlyHypotheses.options) {
      assert.equal(opt.accuracyScore, null);
    }
    assert.ok(onlyHypotheses.selectionRationale.includes("ipotesi"));
  });

  it("10.3.4 distinguishes facts, observations, and hypotheses without mutating source stores or auto-applying strategies", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Obiettivo invariato",
      horizon: "daily",
      consentEnabled: false,
    });
    plan.tasks[0].status = "completed";
    repo.savePlans([plan]);

    const timeline = new CognitiveTimeline(storage);
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Progresso",
      description: "Step completato",
      reliability: 0.8,
      epistemicTag: "interpretazione_prudente",
    });

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted", "2026-11-22T08:00:00.000Z");

    const adaptive = new AdaptiveLearningEngine(storage);
    for (let i = 0; i < 3; i += 1) {
      adaptive.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "LIGHT",
        direction: "positive",
        dataSource: "user",
        summary: `Scelta LIGHT #${i + 1}`,
        uncertaintyNote: "Feedback diretto",
        nowIso: "2026-11-22T08:10:00.000Z",
      });
    }

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const timelineBefore = JSON.stringify(timeline.getEvents());
    const stripExportedAt = (d: ReturnType<ControlledLearningEngine["exportLearningData"]>) => ({
      enabled: d.enabled,
      totalInteractions: d.totalInteractions,
      categoryWeights: d.categoryWeights,
      interactions: d.interactions,
    });
    const controlledBefore = JSON.stringify(
      stripExportedAt(controlled.exportLearningData())
    );
    const adaptiveBefore = storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY);

    const res = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      declaredGoal: "Obiettivo invariato",
      repository: repo,
      timeline,
      controlledLearning: controlled,
      adaptiveLearning: adaptive,
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi prudente su carico pomeridiano",
          confidence: 0.6,
        },
      ],
      nowIso: "2026-11-22T09:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.advisoryOnly, true);
    assert.equal(res.autoApplied, false);
    assert.ok(res.epistemicBreakdown.factsCount >= 2);
    assert.ok(res.epistemicBreakdown.observationsCount >= 1);
    assert.equal(res.epistemicBreakdown.hypothesesCount, 1);
    assert.equal(res.epistemicTag, "interpretazione_prudente");
    // Con profilo adattivo reale popolato (>=3 segnali), accuracyScore è calcolato dai pesi reali senza inventarli
    assert.ok(res.options.every((o) => o.accuracyScore !== null));

    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
    assert.equal(
      JSON.stringify(stripExportedAt(controlled.exportLearningData())),
      controlledBefore
    );
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), adaptiveBefore);
  });

  it("10.3.5 fails closed on crisis, revoked/OFF learning consent, unavailable or corrupted storage", () => {
    const crisis = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(crisis.allowed, false);
    assert.equal(crisis.selectedStrategy, null);
    assert.equal(crisis.confidence, null);
    assert.equal(crisis.safetyDecision.blockedBy, "crisis");

    const revoked = compareCognitiveStrategies({
      consentState: {
        ...CONSENT_OFF,
        revokedAt: "2026-11-22T09:00:00.000Z",
      },
      usesLearningData: true,
    });
    assert.equal(revoked.allowed, false);
    assert.equal(revoked.safetyDecision.blockedBy, "consent");

    const corrupted = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.safetyDecision.blockedBy, "corrupted_data");

    const unavailable = compareCognitiveStrategies({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.safetyDecision.blockedBy, "storage_unavailable");
  });
});
