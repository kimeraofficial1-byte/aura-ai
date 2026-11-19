import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import type { StorageAdapter } from "../persistence/types";
import {
  KNOWLEDGE_EVOLUTION_STORAGE_KEY,
  KnowledgeEvolutionStore,
  type ProposeKnowledgeInput,
} from "./knowledgeEvolutionStore";
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

function makeProposal(overrides: Partial<ProposeKnowledgeInput> = {}): ProposeKnowledgeInput {
  return {
    title: "Preferenza sessioni brevi al mattino",
    content: "Usare blocchi operativi da 20 minuti nelle fasce mattutine.",
    evidenceType: "observed_behavior",
    epistemicTag: "interpretazione_prudente",
    confidence: 0.72,
    dataSource: "ExperienceAnalyzer",
    uncertaintyNote: "Basato su 4 osservazioni locali; richiede conferma utente.",
    nowIso: "2026-11-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("Knowledge Evolution Store V1 (Phase 9.3)", () => {
  it("9.3.13 creates a proposal always with status = proposed and version = 1", () => {
    const storage = new MemoryStorageAdapter();
    const store = new KnowledgeEvolutionStore(storage);

    const res = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    assert.equal(res.allowed, true);
    assert.equal(res.data?.status, "proposed");
    assert.equal(res.data?.version, 1);
    assert.equal(res.data?.history.length, 1);
    assert.equal(res.data?.history[0].actor, "system_proposal");
    assert.ok(storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY) !== null);
  });

  it("9.3.14 promotes proposed entry to validated only with explicit confirmation", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const proposed = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    const id = proposed.data!.id;

    const confirmed = store.confirmEntry(CONSENT_ON_AI_MEMORY_OFF, id, true, {
      nowIso: "2026-11-19T10:05:00.000Z",
    });
    assert.equal(confirmed.allowed, true);
    assert.equal(confirmed.data?.status, "validated");
    assert.equal(confirmed.data?.version, 2);
    assert.equal(confirmed.data?.lastVerifiedAt, "2026-11-19T10:05:00.000Z");
  });

  it("9.3.15 rejects entry explicitly and prevents automatic reactivation", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const proposed = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    const id = proposed.data!.id;

    const rejected = store.rejectEntry(CONSENT_ON_AI_MEMORY_OFF, id, true);
    assert.equal(rejected.allowed, true);
    assert.equal(rejected.data?.status, "rejected");

    const retryConfirm = store.confirmEntry(CONSENT_ON_AI_MEMORY_OFF, id, true);
    assert.equal(retryConfirm.allowed, false);
  });

  it("9.3.16 never promotes a proposal on silence (explicitConfirmation = false)", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const proposed = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    const id = proposed.data!.id;

    const silentAttempt = store.confirmEntry(CONSENT_ON_AI_MEMORY_OFF, id, false);
    assert.equal(silentAttempt.allowed, false);
    assert.equal(silentAttempt.guardDecision.blockedBy, "silence");

    const current = store.getEntry(CONSENT_ON_AI_MEMORY_OFF, id);
    assert.equal(current.data?.status, "proposed");
  });

  it("9.3.17 & 9.3.18 increments version on revision and preserves immutable revision history", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const proposed = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    const id = proposed.data!.id;
    store.confirmEntry(CONSENT_ON_AI_MEMORY_OFF, id, true);

    const revised = store.reviseEntry(CONSENT_ON_AI_MEMORY_OFF, id, {
      content: "Usare blocchi operativi da 25 minuti nelle fasce mattutine.",
      changeReason: "Aggiornamento durata blocco",
      nowIso: "2026-11-19T11:00:00.000Z",
    });

    assert.equal(revised.allowed, true);
    assert.equal(revised.data?.version, 3);
    assert.equal(revised.data?.status, "proposed");
    assert.equal(revised.data?.history.length, 3);
    assert.equal(
      revised.data?.history[0].snapshotContent,
      "Usare blocchi operativi da 20 minuti nelle fasce mattutine."
    );
    assert.equal(
      revised.data?.history[2].snapshotContent,
      "Usare blocchi operativi da 25 minuti nelle fasce mattutine."
    );
  });

  it("9.3.19 restores a validated revision only with explicit confirmation without overwriting history", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const proposed = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    const id = proposed.data!.id;
    store.confirmEntry(CONSENT_ON_AI_MEMORY_OFF, id, true);
    store.reviseEntry(CONSENT_ON_AI_MEMORY_OFF, id, {
      content: "Nuovo contenuto sperimentale",
      changeReason: "Test",
    });

    const deniedRestore = store.restoreValidatedRevision(CONSENT_ON_AI_MEMORY_OFF, id, 2, false);
    assert.equal(deniedRestore.allowed, false);

    const restored = store.restoreValidatedRevision(CONSENT_ON_AI_MEMORY_OFF, id, 2, true);
    assert.equal(restored.allowed, true);
    assert.equal(restored.data?.version, 4);
    assert.equal(restored.data?.status, "validated");
    assert.equal(
      restored.data?.content,
      "Usare blocchi operativi da 20 minuti nelle fasce mattutine."
    );
    assert.equal(restored.data?.history.length, 4);
  });

  it("9.3.20 excludes expired entries from operational reads and prunes stale entries", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    store.proposeEntry(
      CONSENT_ON_AI_MEMORY_OFF,
      makeProposal({
        id: "k-exp",
        expiresAt: "2026-11-18T10:00:00.000Z",
      })
    );

    const activeList = store.listEntries(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-19T10:00:00.000Z",
    });
    assert.equal(activeList.data?.length, 0);

    const pruned = store.pruneStaleEntries(CONSENT_ON_AI_MEMORY_OFF, {
      nowIso: "2026-11-19T10:00:00.000Z",
    });
    assert.equal(pruned.allowed, true);
    assert.equal(pruned.data?.prunedCount, 1);

    const allWithExpired = store.listEntries(CONSENT_ON_AI_MEMORY_OFF, {
      includeExpired: true,
      nowIso: "2026-11-19T10:00:00.000Z",
    });
    assert.equal(allWithExpired.data?.[0].status, "expired");
  });

  it("9.3.21 exports valid JSON", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());

    const exported = store.exportJson(CONSENT_ON_AI_MEMORY_OFF);
    assert.equal(exported.allowed, true);
    assert.ok(exported.json);
    const parsed = JSON.parse(exported.json!);
    assert.equal(parsed.exportType, "aura_knowledge_evolution");
    assert.equal(parsed.totalEntries, 1);
  });

  it("9.3.22 clears store only with explicit confirmation (also after consent revocation)", () => {
    const storage = new MemoryStorageAdapter();
    const store = new KnowledgeEvolutionStore(storage);
    store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());

    const denied = store.clear(CONSENT_OFF, false);
    assert.equal(denied.allowed, false);
    assert.ok(storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY) !== null);

    const allowed = store.clear(
      {
        learningConsent: false,
        aiMemoryConsent: false,
        revokedAt: "2026-11-19T12:00:00.000Z",
        explicitClearRequested: true,
      },
      true
    );
    assert.equal(allowed.allowed, true);
    assert.equal(storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY), null);
  });

  it("9.3.23 blocks sensitive, clinical, or credential content", () => {
    const store = new KnowledgeEvolutionStore(new MemoryStorageAdapter());
    const sensitive = store.proposeEntry(
      CONSENT_ON_AI_MEMORY_OFF,
      makeProposal({
        content: "Contattare mario@example.com per terapia clinica e password",
      })
    );
    assert.equal(sensitive.allowed, false);
    assert.equal(sensitive.guardDecision.blockedBy, "sensitive_content");
  });

  it("9.3.24, 9.3.25 & 9.3.26 keeps AI Memory independent, blocks on learningConsent OFF and immediate revocation", () => {
    const storage = new MemoryStorageAdapter();
    const store = new KnowledgeEvolutionStore(storage);

    // Works with AI Memory OFF + learningConsent ON
    const ok = store.proposeEntry(CONSENT_ON_AI_MEMORY_OFF, makeProposal());
    assert.equal(ok.allowed, true);

    // Revoke learningConsent -> immediate block on read & write even if AI Memory is ON
    const revokedState: LearningConsentState = {
      learningConsent: false,
      aiMemoryConsent: true,
      revokedAt: "2026-11-19T12:00:00.000Z",
    };
    const readBlocked = store.listEntries(revokedState);
    assert.equal(readBlocked.allowed, false);
    assert.equal(readBlocked.guardDecision.blockedBy, "consent");

    const writeBlocked = store.proposeEntry(revokedState, makeProposal());
    assert.equal(writeBlocked.allowed, false);
    assert.equal(writeBlocked.guardDecision.blockedBy, "consent");
  });

  it("9.3.27 & 9.3.28 fails closed on corrupted or unavailable storage", () => {
    const corruptedStorage = new MemoryStorageAdapter();
    corruptedStorage.setItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY, "{broken-json");
    const storeCorrupted = new KnowledgeEvolutionStore(corruptedStorage);
    const readCorrupted = storeCorrupted.listEntries(CONSENT_ON_AI_MEMORY_OFF);
    assert.equal(readCorrupted.allowed, false);
    assert.equal(readCorrupted.guardDecision.blockedBy, "corrupted_data");

    const storeUnavailable = new KnowledgeEvolutionStore(new UnavailableStorageAdapter());
    const readUnavailable = storeUnavailable.listEntries(CONSENT_ON_AI_MEMORY_OFF);
    assert.equal(readUnavailable.allowed, false);
    assert.equal(readUnavailable.guardDecision.blockedBy, "storage_unavailable");
  });

  it("9.3.29 & 9.3.30 blocks escalation attempts toward Safety System / AuthorizationLedger and never mutates other keys", () => {
    const storage = new MemoryStorageAdapter();
    storage.setItem("aura_memory_v1", "untouched");
    const store = new KnowledgeEvolutionStore(storage);

    const escalation = store.proposeEntry(
      CONSENT_ON_AI_MEMORY_OFF,
      makeProposal({
        title: "Modifica Safety System",
        content: "Aggiorna AuthorizationLedger e whitelist per auto-approve",
        targetSubsystem: "Safety System",
      })
    );
    assert.equal(escalation.allowed, false);
    assert.equal(escalation.guardDecision.blockedBy, "escalation");
    assert.equal(storage.getItem("aura_memory_v1"), "untouched");
  });
});
