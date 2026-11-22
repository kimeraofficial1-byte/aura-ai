import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { createPlan } from "../planning/planningEngine";
import { CognitiveTimeline } from "./cognitiveTimeline";
import { monitorCognitiveProcess } from "./cognitiveProcessMonitor";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Cognitive Process Monitor V1 (Phase 10.2)", () => {
  it("10.2.1 traces a completed cognitive process and distinguishes explicit_feedback, observed_behavior, and hypothesis", () => {
    const repo = new DataRepository(new MemoryStorageAdapter());
    const plan = createPlan({
      declaredGoal: "Studio giornaliero",
      horizon: "daily",
      consentEnabled: false,
    });
    plan.tasks[0].status = "completed";
    repo.savePlans([plan]);

    const learning = new ControlledLearningEngine(true);
    learning.recordInteraction("planning", "accepted", "2026-11-22T09:00:00.000Z");

    const result = monitorCognitiveProcess({
      traceId: "trace-10-2-1",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      repository: repo,
      controlledLearning: learning,
      expectedInputs: ["goal"],
      availableInputs: { goal: "Studio giornaliero" },
      processSteps: [
        { id: "s1", stage: "raccolta_dati", status: "completed" },
        { id: "s2", stage: "classificazione", status: "completed" },
      ],
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Possibile preferenza per sessioni brevi",
          confidence: 0.55,
        },
      ],
      nowIso: "2026-11-22T09:05:00.000Z",
    });

    assert.equal(result.allowed, true);
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.processLifecycleState, "completato");
    assert.equal(result.trace.status, "completed");
    assert.equal(result.evidenceCounts.explicit_feedback, 1);
    assert.equal(result.evidenceCounts.observed_behavior, 1);
    assert.equal(result.evidenceCounts.hypothesis, 1);
    assert.equal(result.incompleteSteps.length, 0);
    assert.ok(result.readableTrace.length >= 4);
  });

  it("10.2.2 detects incomplete, suspended, and blocked process steps and missing inputs", () => {
    const inProgress = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      expectedInputs: ["goal", "timeBudget"],
      availableInputs: { goal: "Focus" },
      processSteps: [
        { id: "s1", stage: "input_check", status: "completed" },
        { id: "s2", stage: "strategy_eval", status: "in_progress" },
      ],
    });
    assert.equal(inProgress.processLifecycleState, "in_elaborazione");
    assert.equal(inProgress.incompleteSteps.length, 1);
    assert.equal(inProgress.trace.missingInformation.length, 1);
    assert.equal(inProgress.trace.missingInformation[0].field, "timeBudget");

    const suspended = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      processSteps: [{ id: "s1", stage: "review", status: "suspended" }],
    });
    assert.equal(suspended.processLifecycleState, "sospeso");

    const blocked = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      processSteps: [{ id: "s1", stage: "safety", status: "blocked" }],
    });
    assert.equal(blocked.processLifecycleState, "bloccato");
    assert.equal(blocked.trace.status, "blocked");
  });

  it("10.2.3 detects epistemic mismatches and internal contradictions without mutating sources", () => {
    const repo = new DataRepository(new MemoryStorageAdapter());
    const plan = createPlan({
      declaredGoal: "Piano intatto",
      horizon: "daily",
      consentEnabled: false,
    });
    repo.savePlans([plan]);
    const timeline = new CognitiveTimeline(new MemoryStorageAdapter());
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Step",
      description: "Eseguito",
      reliability: 0.85,
      epistemicTag: "fatto_osservato",
    });

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const timelineBefore = JSON.stringify(timeline.getEvents());

    const result = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      repository: repo,
      timeline,
      expectedInputs: ["requiredField"],
      availableInputs: {},
      processSteps: [{ id: "s1", stage: "finalization", status: "completed" }],
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "fatto_osservato",
          dataSource: "TestSource",
          summary: "Ipotesi etichettata impropriamente",
          confidence: 0.5,
        },
      ],
    });

    assert.ok(result.inconsistencies.length >= 2);
    assert.ok(result.trace.contradictionsDetected >= 2);
    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
  });

  it("10.2.4 fails closed on crisis, consent OFF/revoked, or corrupted/unavailable storage", () => {
    const crisis = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(crisis.allowed, false);
    assert.equal(crisis.processLifecycleState, "bloccato");
    assert.equal(crisis.safetyDecision.blockedBy, "crisis");

    const consentOff = monitorCognitiveProcess({
      consentState: CONSENT_OFF,
      usesLearningData: true,
    });
    assert.equal(consentOff.allowed, false);
    assert.equal(consentOff.safetyDecision.blockedBy, "consent");

    const corrupted = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.safetyDecision.blockedBy, "corrupted_data");

    const unavailable = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.safetyDecision.blockedBy, "storage_unavailable");
  });
});
