import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { AdaptiveLearningEngine } from "./adaptiveLearningEngine";
import { AuthorizationLedger } from "./authorizationLedger";
import {
  calculateEvaluationMetrics,
  runCognitiveSelfEvaluation,
} from "./cognitiveSelfEvaluation";
import { CognitiveTimeline } from "./cognitiveTimeline";
import type { ExperienceSummary } from "./experienceAnalyzer";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Cognitive Self-Evaluation V1 (Phase 9.3)", () => {
  it("9.3.1 computes expected metrics on a known dataset", () => {
    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted");
    controlled.recordInteraction("planning", "completed");
    controlled.recordInteraction("planning", "completed");
    controlled.recordInteraction("focus", "rejected");

    const adaptive = new AdaptiveLearningEngine(new MemoryStorageAdapter());
    for (let i = 0; i < 4; i += 1) {
      adaptive.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "LIGHT",
        direction: "positive",
        dataSource: "ControlledLearningEngine",
        summary: "Preferenza LIGHT",
        uncertaintyNote: "Test dataset noto",
        nowIso: "2026-11-19T10:00:00.000Z",
      });
    }

    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      controlledLearning: controlled,
      adaptiveLearning: adaptive,
      durationSamples: [
        { estimatedMinutes: 20, actualMinutes: 22 },
        { estimatedMinutes: 30, actualMinutes: 28 },
        { estimatedMinutes: 40, actualMinutes: 42 },
      ],
      nowIso: "2026-11-19T10:05:00.000Z",
    });

    assert.equal(report.allowed, true);
    assert.equal(report.status, "completed");
    assert.equal(report.metrics.suggestionUtility.evaluable, true);
    assert.equal(report.metrics.suggestionUtility.totalValidObservations, 4);
    assert.equal(report.metrics.suggestionUtility.positiveRatio, 0.75);
    assert.equal(report.metrics.operationalAccuracy.evaluable, true);
    assert.equal(report.metrics.operationalAccuracy.meanAbsoluteErrorMinutes, 2);
    assert.equal(report.metrics.strategyQuality.evaluable, true);
    assert.equal(report.metrics.strategyQuality.recommendedStrategy, "LIGHT");
    assert.ok(report.documentedStrengths.length >= 2);
  });

  it("9.3.2 handles division by zero safely without NaN or Infinity", () => {
    const controlled = new ControlledLearningEngine(true);
    const ledger = new AuthorizationLedger(new MemoryStorageAdapter());

    const metrics = calculateEvaluationMetrics({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      controlledLearning: controlled,
      authorizationLedger: ledger,
      durationSamples: [{ estimatedMinutes: 0, actualMinutes: 10 }],
    });

    assert.equal(metrics.suggestionUtility.positiveRatio, null);
    assert.equal(metrics.operationalAccuracy.meanAbsoluteErrorMinutes, null);
    assert.equal(metrics.safetyMetrics.rollbackRate, null);
  });

  it("9.3.3 handles empty dataset gracefully with status insufficient_data", () => {
    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    assert.equal(report.allowed, true);
    assert.equal(report.status, "insufficient_data");
    assert.equal(report.insufficientDataDimensions.length, 5);
    assert.equal(report.metrics.suggestionUtility.positiveRatio, null);
  });

  it("9.3.4 does not generate percentages when observations are below threshold (< 3)", () => {
    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted");
    controlled.recordInteraction("planning", "completed");

    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      controlledLearning: controlled,
      durationSamples: [
        { estimatedMinutes: 20, actualMinutes: 25 },
        { estimatedMinutes: 30, actualMinutes: 35 },
      ],
    });

    assert.equal(report.metrics.suggestionUtility.evaluable, false);
    assert.equal(report.metrics.suggestionUtility.positiveRatio, null);
    assert.equal(report.metrics.operationalAccuracy.evaluable, false);
    assert.equal(report.metrics.operationalAccuracy.reliability, null);
  });

  it("9.3.5 keeps confidence strictly within [0, 1]", () => {
    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      durationSamples: [
        { estimatedMinutes: 10, actualMinutes: 500 },
        { estimatedMinutes: 10, actualMinutes: 500 },
        { estimatedMinutes: 10, actualMinutes: 500 },
      ],
    });

    assert.ok(report.confidence >= 0 && report.confidence <= 1);
    assert.ok(
      (report.metrics.operationalAccuracy.reliability ?? 0) >= 0 &&
        (report.metrics.operationalAccuracy.reliability ?? 0) <= 1
    );
  });

  it("9.3.6 distinguishes observed facts, prudent interpretations, and hypotheses", () => {
    const timeline = new CognitiveTimeline(new MemoryStorageAdapter());
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Fatto",
      description: "Task completato",
      reliability: 0.9,
      epistemicTag: "fatto_osservato",
    });
    timeline.recordEvent({
      source: "proactive",
      category: "progress",
      title: "Interpretazione",
      description: "Ritmo pomeridiano",
      reliability: 0.7,
      epistemicTag: "interpretazione_prudente",
    });

    const expSummary: ExperienceSummary = {
      allowed: true,
      insufficientData: false,
      totalObservations: 4,
      minRequiredObservations: 3,
      analyzedAt: "2026-11-19T10:00:00.000Z",
      dataSource: "DataRepository",
      epistemicTag: "interpretazione_prudente",
      confidence: 0.6,
      uncertaintyNote: "Test",
      evidenceBreakdown: { explicit_feedback: 0, observed_behavior: 3, hypothesis: 1 },
      patterns: [
        {
          id: "p1",
          title: "Ipotesi",
          description: "Possibile sovraccarico",
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          confidence: 0.5,
          observationCount: 3,
          dataSource: "DataRepository",
          uncertaintyNote: "Da verificare",
        },
      ],
      guardDecision: {
        allowed: true,
        failClosed: false,
        reason: "ok",
        auditEvent: {
          id: "a1",
          timestamp: "2026-11-19T10:00:00.000Z",
          operation: "read",
          allowed: true,
          reason: "ok",
        },
      },
    };

    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      timeline,
      experienceSummary: expSummary,
    });

    assert.equal(report.metrics.epistemicCoherence.observedFacts, 1);
    assert.equal(report.metrics.epistemicCoherence.prudentInterpretations, 1);
    assert.equal(report.metrics.epistemicCoherence.hypothesesToVerify, 1);
  });

  it("9.3.7 correlates rollbacks, blocks, and revocations from AuthorizationLedger (read-only)", () => {
    const ledger = new AuthorizationLedger(new MemoryStorageAdapter());
    // Trigger authorization_rejected (missing explicit confirmation)
    ledger.grantAuthorization({
      actionType: "complete_plan_task",
      resourceType: "plan_task",
      resourceId: "p1:t1",
      scope: "single_task",
      expiresAt: "2026-11-20T10:00:00.000Z",
      maxUses: 1,
      userExplicitlyConfirmed: false,
      reason: "Test blocco",
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      authorizationLedger: ledger,
    });

    assert.equal(report.metrics.safetyMetrics.evaluable, true);
    assert.equal(report.metrics.safetyMetrics.blockedCount, 1);
    assert.ok(report.improvementAreas.some((a) => a.includes("blocchi: 1")));
  });

  it("9.3.8 computes estimate accuracy only when comparable duration samples exist", () => {
    const withoutSamples = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
    });
    assert.equal(withoutSamples.metrics.operationalAccuracy.evaluable, false);
    assert.equal(withoutSamples.metrics.operationalAccuracy.meanAbsoluteErrorMinutes, null);
  });

  it("9.3.9 never modifies any source data (strictly read-only)", () => {
    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted");
    controlled.recordInteraction("planning", "completed");
    controlled.recordInteraction("planning", "completed");

    const timeline = new CognitiveTimeline(new MemoryStorageAdapter());
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "T1",
      description: "Desc",
      reliability: 0.8,
      epistemicTag: "fatto_osservato",
    });

    const ledger = new AuthorizationLedger(new MemoryStorageAdapter());

    const controlledBefore = JSON.stringify(controlled.exportLearningData().interactions);
    const timelineBefore = JSON.stringify(timeline.getEvents());
    const ledgerBefore = JSON.stringify(ledger.getAuditEvents());

    runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      controlledLearning: controlled,
      timeline,
      authorizationLedger: ledger,
    });

    assert.equal(JSON.stringify(controlled.exportLearningData().interactions), controlledBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
    assert.equal(JSON.stringify(ledger.getAuditEvents()), ledgerBefore);
  });

  it("9.3.10 blocks self-evaluation when learningConsent is OFF", () => {
    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_OFF,
    });
    assert.equal(report.allowed, false);
    assert.equal(report.status, "blocked");
    assert.equal(report.guardDecision.blockedBy, "consent");
  });

  it("9.3.11 blocks self-evaluation during active crisis", () => {
    const report = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(report.allowed, false);
    assert.equal(report.status, "blocked");
    assert.equal(report.guardDecision.blockedBy, "crisis");
  });

  it("9.3.12 fails closed on unavailable or corrupted storage", () => {
    const unavailable = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.guardDecision.blockedBy, "storage_unavailable");

    const corrupted = runCognitiveSelfEvaluation({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.guardDecision.blockedBy, "corrupted_data");
  });
});
