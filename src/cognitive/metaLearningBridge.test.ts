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
import { AuthorizationLedger } from "./authorizationLedger";
import { CognitiveTimeline } from "./cognitiveTimeline";
import {
  KNOWLEDGE_EVOLUTION_STORAGE_KEY,
  KnowledgeEvolutionStore,
} from "./knowledgeEvolutionStore";
import { runMetaLearningBridge } from "./metaLearningBridge";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF_AI_MEMORY_ON: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Meta-Learning Bridge V1 (Phase 10.4)", () => {
  it("10.4.6 integrates all Phase 9 and Phase 10 modules in read-only mode with grounded proposals", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Routine tecnica",
      horizon: "daily",
      consentEnabled: false,
    });
    plan.tasks[0].status = "completed";
    repo.savePlans([plan]);

    const timeline = new CognitiveTimeline(storage);
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Sessione completata",
      description: "Task completato nei tempi",
      reliability: 0.85,
      epistemicTag: "fatto_osservato",
    });

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted", "2026-11-22T08:00:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T09:00:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T10:00:00.000Z");

    const adaptive = new AdaptiveLearningEngine(storage);
    for (let i = 0; i < 3; i += 1) {
      adaptive.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "STANDARD",
        direction: "positive",
        dataSource: "user",
        summary: `Scelta STANDARD #${i + 1}`,
        uncertaintyNote: "Feedback diretto",
        nowIso: "2026-11-22T10:05:00.000Z",
      });
    }

    const knowledgeStore = new KnowledgeEvolutionStore(storage);
    knowledgeStore.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, {
      id: "k-prop-1",
      title: "Preferenza mattina",
      content: "Sessioni brevi al mattino",
      evidenceType: "observed_behavior",
      epistemicTag: "interpretazione_prudente",
      confidence: 0.7,
      dataSource: "CognitiveTimeline",
      uncertaintyNote: "In attesa di conferma",
      nowIso: "2026-11-22T10:10:00.000Z",
    });

    const ledger = new AuthorizationLedger(storage);

    const result = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      declaredGoal: "Routine tecnica",
      constraints: {
        energyLevel: "low",
        timeBudgetMinutes: 15,
      },
      repository: repo,
      timeline,
      controlledLearning: controlled,
      authorizationLedger: ledger,
      adaptiveLearning: adaptive,
      knowledgeStore,
      durationSamples: [
        { estimatedMinutes: 20, actualMinutes: 35 },
        { estimatedMinutes: 25, actualMinutes: 40 },
        { estimatedMinutes: 30, actualMinutes: 45 },
      ],
      nowIso: "2026-11-22T11:00:00.000Z",
    });

    assert.equal(result.allowed, true);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.autoApplied, false);
    assert.equal(result.learningConsentActive, true);
    assert.equal(result.aiMemoryConsentIndependent, true);

    for (const mod of [
      "ExperienceAnalyzer",
      "AdaptiveLearningEngine",
      "KnowledgeEvolutionStore",
      "CognitiveSelfEvaluation",
      "CognitiveProcessMonitor",
      "UncertaintyEngine",
      "StrategyComparisonEngine",
      "CognitiveErrorDetector",
      "ExplainabilityEngine",
    ]) {
      assert.ok(result.connectedModules.includes(mod), `Missing ${mod}`);
    }

    assert.ok(result.improvementSuggestions.length >= 2);
    assert.ok(result.proposals.length >= 2);
    for (const p of result.proposals) {
      assert.equal(p.status, "proposed");
      assert.equal(p.requiresExplicitUserApproval, true);
      assert.equal(p.userExplicitApproval, false);
      assert.equal(p.autoApplied, false);
      assert.ok(p.supportingDataSources.length > 0);
      assert.ok(p.supportingEvidence.length > 0);
    }
  });

  it("10.4.7 handles modules with insufficient data cleanly without inventing metrics", () => {
    const adaptive = new AdaptiveLearningEngine(new MemoryStorageAdapter());
    const knowledgeStore = new KnowledgeEvolutionStore(new MemoryStorageAdapter());

    const result = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      declaredGoal: "Obiettivo esplorativo",
      adaptiveLearning: adaptive,
      knowledgeStore,
      expectedInputs: ["energyLevel"],
      availableInputs: {},
      nowIso: "2026-11-22T11:00:00.000Z",
    });

    assert.equal(result.allowed, true);
    assert.equal(result.confidence, null);
    assert.equal(result.epistemicTag, "ipotesi_da_verificare");
    assert.equal(result.informationGaps.length, 1);
    assert.ok(result.insufficientDataDimensions.length >= 1);
    assert.equal(result.strategyComparison.selectedStrategy, null);
  });

  it("10.4.8 enforces learningConsent strictly while remaining independent from aiMemoryConsent", () => {
    const storage = new MemoryStorageAdapter();
    storage.setItem("aura_memory_v1", "preserved_ai_memory");
    const adaptive = new AdaptiveLearningEngine(storage);
    const knowledgeStore = new KnowledgeEvolutionStore(storage);

    const allowedWithAiMemoryOff = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      adaptiveLearning: adaptive,
      knowledgeStore,
    });
    assert.equal(allowedWithAiMemoryOff.allowed, true);
    assert.equal(allowedWithAiMemoryOff.learningConsentActive, true);

    const blockedWithLearningOff = runMetaLearningBridge({
      consentState: CONSENT_OFF_AI_MEMORY_ON,
      adaptiveLearning: adaptive,
      knowledgeStore,
    });
    assert.equal(blockedWithLearningOff.allowed, false);
    assert.equal(blockedWithLearningOff.learningConsentActive, false);
    assert.equal(blockedWithLearningOff.safetyDecision.blockedBy, "consent");

    const blockedRevoked = runMetaLearningBridge({
      consentState: {
        learningConsent: false,
        aiMemoryConsent: true,
        revokedAt: "2026-11-22T10:50:00.000Z",
      },
      adaptiveLearning: adaptive,
      knowledgeStore,
    });
    assert.equal(blockedRevoked.allowed, false);
    assert.equal(blockedRevoked.safetyDecision.blockedBy, "consent");
    assert.equal(storage.getItem("aura_memory_v1"), "preserved_ai_memory");
  });

  it("10.4.9 never mutates connected stores, never auto-confirms knowledge, and never alters adaptive weights", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Piano protetto",
      horizon: "daily",
      consentEnabled: false,
    });
    repo.savePlans([plan]);

    const adaptive = new AdaptiveLearningEngine(storage);
    for (let i = 0; i < 3; i += 1) {
      adaptive.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "STANDARD",
        direction: "positive",
        dataSource: "user",
        summary: `Feedback #${i + 1}`,
        uncertaintyNote: "Test",
        nowIso: "2026-11-22T09:00:00.000Z",
      });
    }

    const knowledgeStore = new KnowledgeEvolutionStore(storage);
    knowledgeStore.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, {
      id: "k-only-proposed",
      title: "Ipotesi in attesa",
      content: "Deve restare proposed",
      evidenceType: "observed_behavior",
      epistemicTag: "interpretazione_prudente",
      confidence: 0.7,
      dataSource: "DataRepository",
      uncertaintyNote: "Non confermata",
      nowIso: "2026-11-22T09:05:00.000Z",
    });

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted", "2026-11-22T09:10:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T09:15:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T09:20:00.000Z");

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const adaptiveBefore = storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY);
    const knowledgeBefore = storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY);

    const res = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      declaredGoal: "Piano protetto",
      constraints: { energyLevel: "low", overloadDetected: true },
      repository: repo,
      controlledLearning: controlled,
      adaptiveLearning: adaptive,
      knowledgeStore,
      nowIso: "2026-11-22T11:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.autoApplied, false);
    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), adaptiveBefore);
    assert.equal(storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY), knowledgeBefore);

    const storedEntries = knowledgeStore.listEntries(CONSENT_ON_AI_MEMORY_OFF).data ?? [];
    assert.equal(storedEntries.length, 1);
    assert.equal(storedEntries[0].status, "proposed");
  });

  it("10.4.10 fails closed on crisis, unavailable storage, and corrupted knowledge/adaptive data", () => {
    const crisis = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(crisis.allowed, false);
    assert.equal(crisis.safetyDecision.blockedBy, "crisis");
    assert.equal(crisis.proposals.length, 0);

    const unavailable = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.safetyDecision.blockedBy, "storage_unavailable");

    const corruptedStorage = new MemoryStorageAdapter();
    corruptedStorage.setItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY, "{corrupted-json");
    const corruptedKnowledgeStore = new KnowledgeEvolutionStore(corruptedStorage);

    const corrupted = runMetaLearningBridge({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      knowledgeStore: corruptedKnowledgeStore,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.safetyDecision.blockedBy, "corrupted_data");
  });
});
