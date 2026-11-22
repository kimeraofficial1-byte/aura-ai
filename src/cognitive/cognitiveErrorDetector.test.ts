import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { AuthorizationLedger } from "./authorizationLedger";
import { detectCognitiveErrors } from "./cognitiveErrorDetector";
import { CognitiveTimeline } from "./cognitiveTimeline";
import type { CognitiveErrorFinding } from "./metaCognitiveTypes";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Cognitive Error Detection Engine V1 (Phase 10.3)", () => {
  it("10.3.6 detects internal contradictions and goal-strategy mismatches without auto-correcting", () => {
    const res = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      declaredGoal: "Completare progetto complesso",
      proposedStrategy: "STANDARD",
      constraints: {
        energyLevel: "low",
        timeBudgetMinutes: 15,
        overloadDetected: true,
      },
      expectedInputs: ["priorityRank"],
      availableInputs: {},
      processSteps: [{ id: "s1", stage: "finalizzazione", status: "completed" }],
      explicitEvidences: [
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: 'Scelta esplicita "accepted" su pianificazione',
          confidence: 0.9,
        },
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: 'Scelta esplicita "rejected" su pianificazione',
          confidence: 0.9,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "Sessione registrata",
          confidence: 0.85,
        },
      ],
      nowIso: "2026-11-22T10:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.advisoryOnly, true);
    assert.equal(res.readOnly, true);
    assert.equal(res.autoApplied, false);
    assert.equal(res.requiresHumanReview, true);

    assert.ok(
      res.findings.some(
        (f) =>
          f.category === "internal_contradiction" &&
          f.errorSubtype === "information_contradiction"
      )
    );
    assert.ok(
      res.findings.some(
        (f) =>
          f.category === "internal_contradiction" &&
          f.errorSubtype === "goal_strategy_mismatch" &&
          f.severity === "high"
      )
    );
    assert.ok(
      res.findings.some(
        (f) => f.errorSubtype === "human_verification_required"
      )
    );

    for (const finding of res.findings) {
      const compat: CognitiveErrorFinding = finding;
      assert.equal(compat.autoApplied, false);
      assert.equal(finding.advisoryOnly, true);
      assert.ok(finding.severityRationale.length > 0);
      assert.ok(finding.evidenceSource.length > 0);
      assert.ok(finding.advisoryCorrection.length > 0);
    }
  });

  it("10.3.7 detects hypotheses presented as facts and epistemic classification errors", () => {
    const res = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      proposedConclusion: "L'utente preferisce sempre sessioni lunghe",
      conclusionMarkedAsFact: true,
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "fatto_osservato",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi classificata impropriamente come fatto",
          confidence: 0.65,
        },
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ControlledLearningEngine",
          summary: "Feedback diretto etichettato come ipotesi",
          confidence: 0.9,
        },
      ],
      nowIso: "2026-11-22T10:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.autoApplied, false);

    const hypAsFact = res.findings.filter(
      (f) =>
        f.category === "epistemic_mismatch" &&
        f.errorSubtype === "hypothesis_as_fact"
    );
    assert.ok(hypAsFact.length >= 2);
    assert.ok(hypAsFact.every((f) => f.severity === "high"));

    const epistemicErr = res.findings.find(
      (f) => f.errorSubtype === "epistemic_classification_error"
    );
    assert.ok(epistemicErr);
    assert.equal(epistemicErr.severity, "medium");
  });

  it("10.3.8 detects unsupported conclusions, missing/stale info, and returns null confidence when evidences are insufficient", () => {
    const res = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      proposedConclusion: "Ridurre il carico settimanale è sicuramente ottimale",
      expectedInputs: ["energyLevel", "timeBudget"],
      availableInputs: {},
      staleThresholdDays: 14,
      explicitEvidences: [
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "CognitiveTimeline",
          summary: "Vecchia osservazione di ottobre",
          confidence: 0.8,
          timestamp: "2026-10-01T10:00:00.000Z",
        },
      ],
      nowIso: "2026-11-22T10:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.confidence, null);
    assert.equal(res.epistemicTag, "ipotesi_da_verificare");

    const unsupported = res.findings.find(
      (f) => f.errorSubtype === "unsupported_conclusion"
    );
    const missing = res.findings.find((f) => f.id === "err-missing-information");
    const stale = res.findings.find((f) => f.id === "err-stale-evidences");

    assert.ok(unsupported);
    assert.ok(missing);
    assert.ok(stale);
    assert.equal(missing.severity, "high");
    assert.equal(stale.severity, "high");

    for (const finding of res.findings) {
      assert.equal(finding.confidence, null);
      assert.equal(finding.autoApplied, false);
      assert.ok(finding.clarificationQuestion && finding.clarificationQuestion.length > 0);
    }
  });

  it("10.3.9 detects recurring operational errors in read-only mode without mutating sources", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Piano protetto",
      horizon: "daily",
      consentEnabled: false,
    });
    repo.savePlans([plan]);

    const timeline = new CognitiveTimeline(storage);
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Evento",
      description: "Osservato",
      reliability: 0.85,
      epistemicTag: "fatto_osservato",
    });

    const ledger = new AuthorizationLedger(storage);
    for (let i = 0; i < 2; i += 1) {
      ledger.grantAuthorization({
        actionType: "complete_plan_task",
        resourceType: "plan_task",
        resourceId: `${plan.id}:${plan.tasks[0].id}`,
        scope: "single_task",
        expiresAt: "2026-11-23T10:00:00.000Z",
        maxUses: 1,
        userExplicitlyConfirmed: false,
        reason: `Tentativo non confermato #${i + 1}`,
        nowIso: "2026-11-22T09:00:00.000Z",
      });
    }

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "rejected", "2026-11-22T08:00:00.000Z");
    controlled.recordInteraction("planning", "rejected", "2026-11-22T08:05:00.000Z");
    controlled.recordInteraction("planning", "rejected", "2026-11-22T08:10:00.000Z");

    const repoBefore = JSON.stringify(repo.loadSnapshot());
    const timelineBefore = JSON.stringify(timeline.getEvents());
    const ledgerBefore = JSON.stringify(ledger.getAuditEvents());
    const stripExportedAt = (d: ReturnType<ControlledLearningEngine["exportLearningData"]>) => ({
      enabled: d.enabled,
      totalInteractions: d.totalInteractions,
      categoryWeights: d.categoryWeights,
      interactions: d.interactions,
    });
    const controlledBefore = JSON.stringify(
      stripExportedAt(controlled.exportLearningData())
    );

    const res = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      repository: repo,
      timeline,
      authorizationLedger: ledger,
      controlledLearning: controlled,
      nowIso: "2026-11-22T10:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.equal(res.autoApplied, false);
    assert.ok(
      res.findings.some(
        (f) =>
          f.category === "recurring_error" &&
          f.evidenceSource === "AuthorizationLedger"
      )
    );
    assert.ok(
      res.findings.some(
        (f) =>
          f.category === "recurring_error" &&
          f.evidenceSource === "ControlledLearningEngine"
      )
    );

    assert.equal(JSON.stringify(repo.loadSnapshot()), repoBefore);
    assert.equal(JSON.stringify(timeline.getEvents()), timelineBefore);
    assert.equal(JSON.stringify(ledger.getAuditEvents()), ledgerBefore);
    assert.equal(
      JSON.stringify(stripExportedAt(controlled.exportLearningData())),
      controlledBefore
    );
  });

  it("10.3.10 fails closed on crisis, revoked/OFF learning consent, unavailable or corrupted storage", () => {
    const crisis = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(crisis.allowed, false);
    assert.equal(crisis.autoApplied, false);
    assert.equal(crisis.confidence, null);
    assert.equal(crisis.safetyDecision.blockedBy, "crisis");

    const consentOff = detectCognitiveErrors({
      consentState: CONSENT_OFF,
      usesLearningData: true,
    });
    assert.equal(consentOff.allowed, false);
    assert.equal(consentOff.safetyDecision.blockedBy, "consent");

    const corrupted = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.safetyDecision.blockedBy, "corrupted_data");

    const unavailable = detectCognitiveErrors({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(unavailable.safetyDecision.blockedBy, "storage_unavailable");
  });
});
