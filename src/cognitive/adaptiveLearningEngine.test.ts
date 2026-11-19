import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import {
  ADAPTIVE_LEARNING_STORAGE_KEY,
  AdaptiveLearningEngine,
  MAX_ADAPTIVE_WEIGHT,
  MIN_ADAPTIVE_WEIGHT,
} from "./adaptiveLearningEngine";
import type { LearningConsentState } from "./selfLearningTypes";

const CONSENT_ON_AI_MEMORY_OFF: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: false,
};

const CONSENT_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: true,
};

class UnavailableStorageAdapter implements StorageAdapter {
  readonly name = "unavailable";
  isAvailable(): boolean {
    return false;
  }
  getItem(): string | null {
    return null;
  }
  setItem(): void {
    throw new Error("Storage unavailable");
  }
  removeItem(): void {
    throw new Error("Storage unavailable");
  }
  keys(): string[] {
    return [];
  }
}

describe("Adaptive Learning Engine V1 (Phase 9.2)", () => {
  it("9.2.6 works with learningConsent ON and AI Memory OFF, using separate storage key", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    const res = engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "explicit_feedback",
      strategy: "LIGHT",
      duration: "short",
      detail: "concise",
      direction: "positive",
      dataSource: "ControlledLearningEngine",
      summary: "Utente preferisce carico leggero",
      uncertaintyNote: "Feedback esplicito locale",
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    assert.equal(res.allowed, true);
    assert.ok(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY) !== null);
    assert.equal(res.profile?.strategyWeights.LIGHT, 1.12);
    assert.equal(res.profile?.durationWeights.short, 1.12);
    assert.equal(res.profile?.detailWeights.concise, 1.12);
  });

  it("9.2.7 blocks reads and writes when learningConsent is OFF", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    const writeRes = engine.recordSignal(CONSENT_OFF, {
      evidenceType: "explicit_feedback",
      strategy: "STANDARD",
      direction: "positive",
      dataSource: "ControlledLearningEngine",
      summary: "Feedback bloccato",
      uncertaintyNote: "Consenso OFF",
    });
    assert.equal(writeRes.allowed, false);
    assert.equal(writeRes.guardDecision.blockedBy, "consent");

    const hints = engine.getAdaptationHints(CONSENT_OFF);
    assert.equal(hints.allowed, false);
    assert.equal(hints.guardDecision.blockedBy, "consent");

    const exported = engine.exportProfileJson(CONSENT_OFF);
    assert.equal(exported.allowed, false);
    assert.equal(exported.guardDecision.blockedBy, "consent");
  });

  it("9.2.8 never interprets silence or unverified hypotheses as preference", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    const silenceRes = engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "observed_behavior",
      isSilence: true,
      strategy: "DEFERRED",
      direction: "positive",
      dataSource: "ProactiveEngine",
      summary: "Nessuna risposta utente",
      uncertaintyNote: "Silenzio",
    });
    assert.equal(silenceRes.allowed, false);
    assert.equal(silenceRes.guardDecision.blockedBy, "silence");

    const hypothesisRes = engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "hypothesis",
      strategy: "LIGHT",
      direction: "positive",
      dataSource: "ExperienceAnalyzer",
      summary: "Ipotesi non confermata",
      uncertaintyNote: "Solo ipotesi",
    });
    assert.equal(hypothesisRes.allowed, false);
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), null);
  });

  it("9.2.9 clamps weights strictly within [0.5, 1.5] under repeated signals", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    for (let i = 0; i < 15; i += 1) {
      engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "LIGHT",
        direction: "positive",
        dataSource: "ControlledLearningEngine",
        summary: "Feedback positivo ripetuto",
        uncertaintyNote: "Test convergenza superiore",
        nowIso: "2026-11-19T10:00:00.000Z",
      });
      engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "DEFERRED",
        direction: "negative",
        dataSource: "ControlledLearningEngine",
        summary: "Feedback negativo ripetuto",
        uncertaintyNote: "Test convergenza inferiore",
        nowIso: "2026-11-19T10:00:00.000Z",
      });
    }

    const hints = engine.getAdaptationHints(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-19T10:05:00.000Z",
    });

    assert.equal(hints.allowed, true);
    assert.equal(hints.insufficientData, false);
    assert.equal(hints.strategyWeights.LIGHT, MAX_ADAPTIVE_WEIGHT);
    assert.equal(hints.strategyWeights.DEFERRED, MIN_ADAPTIVE_WEIGHT);
    assert.equal(hints.recommendedStrategy, "LIGHT");
  });

  it("9.2.10 applies controlled temporal decay toward baseline 1.0 over elapsed days", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage, 0.05);

    for (let i = 0; i < 4; i += 1) {
      engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
        evidenceType: "explicit_feedback",
        strategy: "LIGHT",
        direction: "positive",
        dataSource: "ControlledLearningEngine",
        summary: "Preferenza LIGHT",
        uncertaintyNote: "Test decadimento",
        nowIso: "2026-11-01T10:00:00.000Z",
      });
    }

    const immediate = engine.getAdaptationHints(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-01T10:01:00.000Z",
    });
    const after10Days = engine.getAdaptationHints(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-11T10:00:00.000Z",
    });

    assert.ok(immediate.strategyWeights.LIGHT > 1.4);
    assert.ok(after10Days.strategyWeights.LIGHT < immediate.strategyWeights.LIGHT);
    assert.ok(after10Days.strategyWeights.LIGHT >= 1.0);
  });

  it("9.2.11 exports JSON and supports confirmed reset even after consent revocation", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "explicit_feedback",
      strategy: "DEFERRED",
      direction: "positive",
      dataSource: "ControlledLearningEngine",
      summary: "Preferenza DEFERRED",
      uncertaintyNote: "Test export e reset",
      nowIso: "2026-11-19T10:00:00.000Z",
    });

    const exported = engine.exportProfileJson(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-19T10:05:00.000Z",
    });
    assert.equal(exported.allowed, true);
    assert.ok(exported.json);
    const parsed = JSON.parse(exported.json!);
    assert.equal(parsed.exportType, "aura_adaptive_learning");
    assert.equal(parsed.profile.strategyWeights.DEFERRED, 1.12);

    // Reset senza conferma esplicita -> bloccato
    const deniedReset = engine.resetProfile({
      learningConsent: false,
      aiMemoryConsent: false,
      revokedAt: "2026-11-19T10:10:00.000Z",
      explicitClearRequested: false,
    });
    assert.equal(deniedReset.allowed, false);
    assert.ok(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY) !== null);

    // Reset con conferma esplicita anche dopo revoca del consenso -> consentito
    const allowedReset = engine.resetProfile({
      learningConsent: false,
      aiMemoryConsent: false,
      revokedAt: "2026-11-19T10:10:00.000Z",
      explicitClearRequested: true,
    });
    assert.equal(allowedReset.allowed, true);
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), null);
  });

  it("9.2.12 fails closed on corrupted or unavailable storage without throwing", () => {
    const corruptedStorage = new MemoryStorageAdapter();
    corruptedStorage.setItem(ADAPTIVE_LEARNING_STORAGE_KEY, "{not-valid-json");
    const engineCorrupted = new AdaptiveLearningEngine(corruptedStorage);

    const hintsCorrupted = engineCorrupted.getAdaptationHints(CONSENT_ON_AI_MEMORY_OFF);
    assert.equal(hintsCorrupted.allowed, false);
    assert.equal(hintsCorrupted.guardDecision.blockedBy, "corrupted_data");

    const engineUnavailable = new AdaptiveLearningEngine(new UnavailableStorageAdapter());
    const hintsUnavailable = engineUnavailable.getAdaptationHints(CONSENT_ON_AI_MEMORY_OFF);
    assert.equal(hintsUnavailable.allowed, false);
    assert.equal(hintsUnavailable.guardDecision.blockedBy, "storage_unavailable");
  });

  it("9.2.13 blocks escalation attempts and sensitive content via Learning Safety Guard", () => {
    const storage = new MemoryStorageAdapter();
    const engine = new AdaptiveLearningEngine(storage);

    const escalationRes = engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "explicit_feedback",
      strategy: "STANDARD",
      direction: "positive",
      dataSource: "AuthorizationLedger",
      targetSubsystem: "whitelist",
      summary: "Auto-approve whitelist modification",
      uncertaintyNote: "Tentativo escalation",
    });
    assert.equal(escalationRes.allowed, false);
    assert.equal(escalationRes.guardDecision.blockedBy, "escalation");

    const sensitiveRes = engine.recordSignal(CONSENT_ON_AI_MEMORY_OFF, {
      evidenceType: "explicit_feedback",
      strategy: "LIGHT",
      direction: "positive",
      dataSource: "ControlledLearningEngine",
      summary: "Email utente test@example.com con diagnosi",
      uncertaintyNote: "Contenuto sensibile",
    });
    assert.equal(sensitiveRes.allowed, false);
    assert.equal(sensitiveRes.guardDecision.blockedBy, "sensitive_content");
  });
});
