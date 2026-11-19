import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { AuthorizationLedger } from "./authorizationLedger";
import { CognitiveTimeline } from "./cognitiveTimeline";
import {
  analyzeExperience,
  MIN_OBSERVATIONS_FOR_PATTERN,
} from "./experienceAnalyzer";
import type { PersonalPlan, PlanTask, TaskPriority, TaskStatus } from "../planning/types";
import type { LearningConsentState } from "./selfLearningTypes";

function makeTask(
  id: string,
  title: string,
  status: TaskStatus,
  priority: TaskPriority
): PlanTask {
  return {
    id,
    title,
    description: title,
    status,
    priority,
    dueDate: "2026-11-25",
    estimatedMinutes: 20,
    uncertaintyNote: "Test fixture",
  } as unknown as PlanTask;
}

function makePlan(id: string, title: string, tasks: PlanTask[]): PersonalPlan {
  return {
    id,
    title,
    declaredGoal: title,
    status: "active",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-18T08:00:00.000Z",
    tasks,
  } as unknown as PersonalPlan;
}

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Experience Analyzer V1 (Phase 9.2)", () => {
  it("9.2.1 returns insufficientData when total observations are below minimum threshold of 3", () => {
    const learning = new ControlledLearningEngine(true);
    learning.recordInteraction("planning", "accepted");
    learning.recordInteraction("planning", "completed");

    const summary = analyzeExperience({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      controlledLearning: learning,
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    assert.equal(summary.allowed, true);
    assert.equal(summary.insufficientData, true);
    assert.equal(summary.totalObservations, 2);
    assert.equal(summary.minRequiredObservations, MIN_OBSERVATIONS_FOR_PATTERN);
    assert.equal(summary.patterns.length, 0);
    assert.equal(summary.epistemicTag, "ipotesi_da_verificare");
  });

  it("9.2.2 detects operational patterns with >= 3 valid observations and distinguishes explicit_feedback, observed_behavior, hypothesis", () => {
    const repo = new DataRepository(new MemoryStorageAdapter());
    repo.savePlans([
      makePlan("plan-1", "Piano Focus", [
        makeTask("t1", "Task 1", "completed", "media"),
        makeTask("t2", "Task 2", "completed", "media"),
        makeTask("t3", "Task 3", "completed", "alta"),
        makeTask("t4", "Task 4", "overdue", "media"),
        makeTask("t5", "Task 5", "paused", "bassa"),
        makeTask("t6", "Task 6", "overdue", "media"),
      ]),
    ]);

    const learning = new ControlledLearningEngine(true);
    learning.recordInteraction("planning", "accepted");
    learning.recordInteraction("planning", "completed");
    learning.recordInteraction("focus", "accepted");

    const summary = analyzeExperience({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      repository: repo,
      controlledLearning: learning,
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    assert.equal(summary.allowed, true);
    assert.equal(summary.insufficientData, false);
    assert.ok(summary.totalObservations >= 9);
    assert.ok(summary.evidenceBreakdown.explicit_feedback >= 3);
    assert.ok(summary.evidenceBreakdown.observed_behavior >= 6);
    assert.ok(summary.evidenceBreakdown.hypothesis >= 1);
    assert.ok(summary.patterns.some((p) => p.evidenceType === "explicit_feedback"));
    assert.ok(summary.patterns.some((p) => p.evidenceType === "observed_behavior"));
    assert.ok(summary.patterns.some((p) => p.evidenceType === "hypothesis"));
    assert.ok(summary.confidence >= 0 && summary.confidence <= 1);
    assert.ok(summary.uncertaintyNote.length > 0);
  });

  it("9.2.3 preserves source data integrity (strictly read-only across all 4 sources)", () => {
    const repo = new DataRepository(new MemoryStorageAdapter());
    repo.savePlans([
      makePlan("plan-ro", "Piano ReadOnly", [
        makeTask("t1", "A", "completed", "media"),
        makeTask("t2", "B", "completed", "media"),
        makeTask("t3", "C", "completed", "media"),
      ]),
    ]);
    const timeline = new CognitiveTimeline(new MemoryStorageAdapter());
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Checkpoint",
      description: "Completato",
      reliability: 0.9,
      epistemicTag: "fatto_osservato",
    });
    const learning = new ControlledLearningEngine(true);
    learning.recordInteraction("planning", "accepted");
    const ledger = new AuthorizationLedger(new MemoryStorageAdapter());

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const timelineBefore = JSON.stringify(timeline.getEvents());
    const learningBefore = JSON.stringify(learning.exportLearningData().interactions);
    const ledgerBefore = JSON.stringify(ledger.getAuditEvents());

    const summary = analyzeExperience({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      repository: repo,
      timeline,
      controlledLearning: learning,
      authorizationLedger: ledger,
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    assert.equal(summary.allowed, true);
    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
    assert.equal(JSON.stringify(learning.exportLearningData().interactions), learningBefore);
    assert.equal(JSON.stringify(ledger.getAuditEvents()), ledgerBefore);
  });

  it("9.2.4 blocks analysis when learningConsent is OFF even if AI Memory is ON", () => {
    const learning = new ControlledLearningEngine(true);
    learning.recordInteraction("planning", "accepted");
    learning.recordInteraction("planning", "accepted");
    learning.recordInteraction("planning", "accepted");

    const summary = analyzeExperience({
      consentState: CONSENT_OFF,
      controlledLearning: learning,
    });

    assert.equal(summary.allowed, false);
    assert.equal(summary.guardDecision.blockedBy, "consent");
    assert.equal(summary.patterns.length, 0);
  });

  it("9.2.5 blocks analysis during active crisis (Safety System priority)", () => {
    const summary = analyzeExperience({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });

    assert.equal(summary.allowed, false);
    assert.equal(summary.guardDecision.blockedBy, "crisis");
  });
});
