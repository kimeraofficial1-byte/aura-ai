import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateLearningSafety,
  isValidConfidence,
  isValidEpistemicTag,
  sanitizeLearningPayload,
} from "./learningSafetyGuard";
import type { LearningPayload } from "./selfLearningTypes";

function buildValidPayload(overrides: Partial<LearningPayload> = {}): LearningPayload {
  return {
    stage: "proposal",
    evidenceType: "observed_behavior",
    epistemicTag: "interpretazione_prudente",
    confidence: 0.72,
    dataSource: "ExperienceAnalyzer",
    timestamp: "2026-11-19T10:00:00.000Z",
    uncertaintyNote: "Pattern preliminare basato su 3 sessioni locali.",
    summary: "Le micro-azioni sotto i 10 minuti risultano completate più spesso.",
    ...overrides,
  };
}

test("9.1.1. Consenso learningConsent ON e OFF (lettura e scrittura)", () => {
  const payload = buildValidPayload();

  const onRead = evaluateLearningSafety({
    operation: "read",
    consentState: { learningConsent: true, aiMemoryConsent: false },
  });
  assert.equal(onRead.allowed, true);

  const onWrite = evaluateLearningSafety({
    operation: "write",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    payload,
  });
  assert.equal(onWrite.allowed, true);
  assert.ok(onWrite.sanitizedPayload);

  const offRead = evaluateLearningSafety({
    operation: "read",
    consentState: { learningConsent: false, aiMemoryConsent: true },
  });
  assert.equal(offRead.allowed, false);
  assert.equal(offRead.blockedBy, "consent");

  const offWrite = evaluateLearningSafety({
    operation: "write",
    consentState: { learningConsent: false, aiMemoryConsent: true },
    payload,
  });
  assert.equal(offWrite.allowed, false);
  assert.equal(offWrite.blockedBy, "consent");
});

test("9.1.2. Blocco immediato in caso di crisi attiva (Safety System prioritario)", () => {
  const byFlag = evaluateLearningSafety({
    operation: "write",
    consentState: { learningConsent: true, aiMemoryConsent: true },
    crisisBlocked: true,
    payload: buildValidPayload(),
  });
  assert.equal(byFlag.allowed, false);
  assert.equal(byFlag.blockedBy, "crisis");

  const byText = evaluateLearningSafety({
    operation: "propose",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    userTextForSafetyCheck: "Non ce la faccio più, voglio farla finita",
    payload: buildValidPayload(),
  });
  assert.equal(byText.allowed, false);
  assert.equal(byText.blockedBy, "crisis");
});

test("9.1.3 & 9.1.4. Dati mancanti/corrotti e storage non disponibile (fail-closed)", () => {
  const missingPayload = evaluateLearningSafety({
    operation: "write",
    consentState: { learningConsent: true, aiMemoryConsent: false },
  });
  assert.equal(missingPayload.allowed, false);
  assert.equal(missingPayload.blockedBy, "invalid_payload");

  const corrupted = evaluateLearningSafety({
    operation: "read",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    corruptedDataDetected: true,
  });
  assert.equal(corrupted.allowed, false);
  assert.equal(corrupted.blockedBy, "corrupted_data");

  const noStorage = evaluateLearningSafety({
    operation: "write",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    storageAvailable: false,
    payload: buildValidPayload(),
  });
  assert.equal(noStorage.allowed, false);
  assert.equal(noStorage.blockedBy, "storage_unavailable");
});

test("9.1.5. Rifiuto di payload con contenuti sensibili, PII o riferimenti clinici", () => {
  const withEmail = sanitizeLearningPayload(
    buildValidPayload({ summary: "Contattare utente@example.com per promemoria" })
  );
  assert.equal(withEmail.ok, false);
  if (!withEmail.ok) assert.equal(withEmail.blockedBy, "sensitive_content");

  const withClinical = sanitizeLearningPayload(
    buildValidPayload({ summary: "Ipotesi di diagnosi di disturbo bipolare" })
  );
  assert.equal(withClinical.ok, false);
  if (!withClinical.ok) assert.equal(withClinical.blockedBy, "sensitive_content");

  const withSecret = sanitizeLearningPayload(
    buildValidPayload({ summary: "Chiave AIzaSyD1234567890123456789012345" })
  );
  assert.equal(withSecret.ok, false);
  if (!withSecret.ok) assert.equal(withSecret.blockedBy, "sensitive_content");
});

test("9.1.6. Blocco di tentativi di escalation dei permessi e auto-modifica", () => {
  const attempts = [
    buildValidPayload({ targetSubsystem: "AuthorizationLedger", summary: "Aggiungi permesso" }),
    buildValidPayload({ summary: "Espandi la whitelist per includere DELETE" }),
    buildValidPayload({ summary: "Modifica il system prompt di sicurezza" }),
    buildValidPayload({ summary: "Aggiorna Safety System per ridurre i blocchi" }),
  ];

  for (const payload of attempts) {
    const res = evaluateLearningSafety({
      operation: "propose",
      consentState: { learningConsent: true, aiMemoryConsent: false },
      payload,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.blockedBy, "escalation");
  }
});

test("9.1.7. Regola del silenzio: nessuna approvazione automatica senza feedback esplicito", () => {
  const silentApproval = evaluateLearningSafety({
    operation: "approve",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    payload: buildValidPayload({
      stage: "approval",
      evidenceType: "observed_behavior",
      userExplicitApproval: undefined,
    }),
  });
  assert.equal(silentApproval.allowed, false);
  assert.equal(silentApproval.blockedBy, "silence");

  const explicitApproval = evaluateLearningSafety({
    operation: "approve",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    payload: buildValidPayload({
      stage: "approval",
      evidenceType: "explicit_feedback",
      userExplicitApproval: true,
    }),
  });
  assert.equal(explicitApproval.allowed, true);
});

test("9.1.8. Indipendenza tra learningConsent e AI Memory (AuraMemoryStore)", () => {
  const learningOnMemoryOff = evaluateLearningSafety({
    operation: "read",
    consentState: { learningConsent: true, aiMemoryConsent: false },
  });
  assert.equal(learningOnMemoryOff.allowed, true);

  const learningOffMemoryOn = evaluateLearningSafety({
    operation: "read",
    consentState: { learningConsent: false, aiMemoryConsent: true },
  });
  assert.equal(learningOffMemoryOn.allowed, false);
});

test("9.1.9. Validazione rigorosa di confidence (0..1) e tag epistemici", () => {
  assert.equal(isValidConfidence(0), true);
  assert.equal(isValidConfidence(0.5), true);
  assert.equal(isValidConfidence(1), true);
  assert.equal(isValidConfidence(-0.1), false);
  assert.equal(isValidConfidence(1.2), false);
  assert.equal(isValidConfidence(Number.NaN), false);

  assert.equal(isValidEpistemicTag("fatto_osservato"), true);
  assert.equal(isValidEpistemicTag("interpretazione_prudente"), true);
  assert.equal(isValidEpistemicTag("ipotesi_da_verificare"), true);
  assert.equal(isValidEpistemicTag("certezza_assoluta"), false);

  const invalidConf = sanitizeLearningPayload(buildValidPayload({ confidence: 1.5 }));
  assert.equal(invalidConf.ok, false);
  if (!invalidConf.ok) assert.equal(invalidConf.blockedBy, "invalid_payload");
});

test("9.1.10. Revoca del consenso e accesso separato alla procedura esplicita di cancellazione", () => {
  const revokedRead = evaluateLearningSafety({
    operation: "read",
    consentState: {
      learningConsent: false,
      aiMemoryConsent: false,
      revokedAt: "2026-11-19T10:15:00.000Z",
    },
  });
  assert.equal(revokedRead.allowed, false);

  const clearWithoutConfirm = evaluateLearningSafety({
    operation: "clear",
    consentState: {
      learningConsent: false,
      aiMemoryConsent: false,
      explicitClearRequested: false,
    },
  });
  assert.equal(clearWithoutConfirm.allowed, false);

  const clearWithConfirm = evaluateLearningSafety({
    operation: "clear",
    consentState: {
      learningConsent: false,
      aiMemoryConsent: false,
      revokedAt: "2026-11-19T10:15:00.000Z",
      explicitClearRequested: true,
    },
  });
  assert.equal(clearWithConfirm.allowed, true);
});
