import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monitorCognitiveProcess } from "./cognitiveProcessMonitor";
import { evaluateUncertainty } from "./uncertaintyEngine";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

describe("Uncertainty Engine V1 (Phase 10.2)", () => {
  it("10.2.5 returns null reliabilityScore (no arbitrary percentage) when evidences are insufficient or only hypotheses", () => {
    const mon = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      explicitEvidences: [
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi 1",
          confidence: 0.9,
        },
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi 2",
          confidence: 0.9,
        },
        {
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          dataSource: "ExperienceAnalyzer",
          summary: "Ipotesi 3",
          confidence: 0.9,
        },
      ],
    });

    const unc = evaluateUncertainty({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      trace: mon.trace,
    });

    assert.equal(unc.allowed, true);
    assert.equal(unc.sufficiencyStatus, "insufficient");
    assert.equal(unc.verifiedObservationCount, 0);
    assert.equal(unc.unverifiedHypothesesCount, 3);
    assert.equal(unc.assessment.level, "insufficient_evidence");
    assert.equal(unc.assessment.reliabilityScore, null);
    assert.equal(unc.assessment.epistemicTag, "ipotesi_da_verificare");
    assert.equal(unc.assessment.needsClarification, true);
    assert.ok(unc.assessment.clarificationQuestions.length > 0);
  });

  it("10.2.6 detects partial information, missing inputs, and generates targeted clarification questions", () => {
    const mon = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      expectedInputs: ["energyLevel"],
      availableInputs: {},
      explicitEvidences: [
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "Task 1 completato",
          confidence: 0.85,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "Task 2 completato",
          confidence: 0.85,
        },
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: "Proposta accettata",
          confidence: 0.9,
        },
      ],
    });

    const unc = evaluateUncertainty({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      trace: mon.trace,
    });

    assert.equal(unc.allowed, true);
    assert.equal(unc.sufficiencyStatus, "partial");
    assert.equal(unc.missingInformationCount, 1);
    assert.equal(unc.assessment.needsClarification, true);
    assert.ok(
      unc.assessment.clarificationQuestions.some((q) => q.includes("energyLevel"))
    );
    assert.ok(
      unc.assessment.reliabilityScore !== null &&
        unc.assessment.reliabilityScore >= 0 &&
        unc.assessment.reliabilityScore <= 1
    );
  });

  it("10.2.7 returns sufficient status and low uncertainty with >= 3 clean observed evidences", () => {
    const mon = monitorCognitiveProcess({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      expectedInputs: ["goal"],
      availableInputs: { goal: "Focus" },
      explicitEvidences: [
        {
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          summary: "Feedback 1",
          confidence: 0.9,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          summary: "Task completato",
          confidence: 0.85,
        },
        {
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "CognitiveTimeline",
          summary: "Continuità verificata",
          confidence: 0.85,
        },
      ],
    });

    const traceBefore = JSON.stringify(mon.trace);

    const unc = evaluateUncertainty({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      usesLearningData: false,
      trace: mon.trace,
    });

    assert.equal(unc.allowed, true);
    assert.equal(unc.sufficiencyStatus, "sufficient");
    assert.equal(unc.assessment.level, "low");
    assert.equal(unc.assessment.needsClarification, false);
    assert.equal(unc.assessment.epistemicTag, "fatto_osservato");
    assert.ok(unc.assessment.reliabilityScore !== null && unc.assessment.reliabilityScore >= 0.7);
    assert.equal(JSON.stringify(mon.trace), traceBefore);
  });

  it("10.2.8 fails closed on crisis, consent OFF/revoked, and corrupted/unavailable storage", () => {
    const crisis = evaluateUncertainty({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(crisis.allowed, false);
    assert.equal(crisis.assessment.reliabilityScore, null);
    assert.equal(crisis.safetyDecision.blockedBy, "crisis");

    const consentOff = evaluateUncertainty({
      consentState: CONSENT_OFF,
      usesLearningData: true,
    });
    assert.equal(consentOff.allowed, false);
    assert.equal(consentOff.assessment.reliabilityScore, null);
    assert.equal(consentOff.safetyDecision.blockedBy, "consent");

    const corrupted = evaluateUncertainty({
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(corrupted.allowed, false);
    assert.equal(corrupted.safetyDecision.blockedBy, "corrupted_data");
  });
});
