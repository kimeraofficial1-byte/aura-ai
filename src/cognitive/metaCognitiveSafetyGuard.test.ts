import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { AuthorizationLedger } from "./authorizationLedger";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type { LearningConsentState, LearningPayload } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

function makeValidPayload(overrides: Partial<LearningPayload> = {}): LearningPayload {
  return {
    stage: "analysis",
    evidenceType: "observed_behavior",
    epistemicTag: "interpretazione_prudente",
    confidence: 0.7,
    dataSource: "ExperienceAnalyzer",
    timestamp: "2026-11-19T12:00:00.000Z",
    uncertaintyNote: "Analisi consultiva locale.",
    summary: "Verifica coerenza strategie operative.",
    ...overrides,
  };
}

describe("Meta-Cognitive Safety Guard V1 (Phase 10.1)", () => {
  it("10.1.1 blocks analysis when crisis is active (flag or crisis text)", () => {
    const byFlag = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      crisisBlocked: true,
    });
    assert.equal(byFlag.allowed, false);
    assert.equal(byFlag.failClosed, true);
    assert.equal(byFlag.blockedBy, "crisis");

    const byText = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      userTextForSafetyCheck: "Non ce la faccio piu, voglio farla finita",
    });
    assert.equal(byText.allowed, false);
    assert.equal(byText.blockedBy, "crisis");
  });

  it("10.1.2 blocks meta-cognitive analysis on learning data when learningConsent is OFF", () => {
    const res = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_OFF,
      usesLearningData: true,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.failClosed, true);
    assert.equal(res.blockedBy, "consent");
  });

  it("10.1.3 blocks immediately when learningConsent has been revoked", () => {
    const res = evaluateMetaCognitiveSafety({
      operation: "compare_strategies",
      consentState: {
        learningConsent: false,
        aiMemoryConsent: true,
        revokedAt: "2026-11-19T12:10:00.000Z",
      },
      usesLearningData: true,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.blockedBy, "consent");
    assert.ok(res.reason.toLowerCase().includes("revocato"));
  });

  it("10.1.4 blocks escalation attempts and unauthorized operations", () => {
    const escalationPayload = evaluateMetaCognitiveSafety({
      operation: "detect_errors",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      payload: makeValidPayload({
        targetSubsystem: "AuthorizationLedger",
        summary: "Auto-approve whitelist modification in Safety System",
      }),
    });
    assert.equal(escalationPayload.allowed, false);
    assert.equal(escalationPayload.blockedBy, "escalation");

    const invalidOp = evaluateMetaCognitiveSafety({
      operation: "mutate_code" as never,
      consentState: CONSENT_ON_AI_MEMORY_OFF,
    });
    assert.equal(invalidOp.allowed, false);
    assert.equal(invalidOp.blockedBy, "escalation");
  });

  it("10.1.5 fails closed on corrupted storage", () => {
    const res = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      corruptedDataDetected: true,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.failClosed, true);
    assert.equal(res.blockedBy, "corrupted_data");
  });

  it("10.1.6 fails closed on unavailable storage", () => {
    const res = evaluateMetaCognitiveSafety({
      operation: "explain",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      storageAvailable: false,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.failClosed, true);
    assert.equal(res.blockedBy, "storage_unavailable");
  });

  it("10.1.7 rejects invalid or sensitive payloads via sanitizeLearningPayload", () => {
    const invalidConfidence = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      payload: makeValidPayload({ confidence: 1.8 }),
    });
    assert.equal(invalidConfidence.allowed, false);
    assert.equal(invalidConfidence.blockedBy, "invalid_payload");

    const sensitive = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      payload: makeValidPayload({
        summary: "Contatto utente mario@example.com con diagnosi",
      }),
    });
    assert.equal(sensitive.allowed, false);
    assert.equal(sensitive.blockedBy, "sensitive_content");
  });

  it("10.1.8 allows read-only advisory access under valid consent and safe conditions", () => {
    const res = evaluateMetaCognitiveSafety({
      operation: "analyze",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      payload: makeValidPayload(),
    });
    assert.equal(res.allowed, true);
    assert.equal(res.failClosed, false);
    assert.equal(res.advisoryOnly, true);
    assert.equal(res.readOnly, true);
    assert.ok(res.sanitizedPayload);
  });

  it("10.1.9 never writes to protected stores (AuraMemoryStore / AuthorizationLedger)", () => {
    const storage = new MemoryStorageAdapter();
    storage.setItem("aura_memory_v1", "untouched");
    const ledger = new AuthorizationLedger(storage);
    const eventsBefore = JSON.stringify(ledger.getAuditEvents());

    const res = evaluateMetaCognitiveSafety({
      operation: "explain",
      consentState: CONSENT_ON_AI_MEMORY_OFF,
      payload: makeValidPayload(),
    });

    assert.equal(res.allowed, true);
    assert.equal(storage.getItem("aura_memory_v1"), "untouched");
    assert.equal(JSON.stringify(ledger.getAuditEvents()), eventsBefore);
  });
});
