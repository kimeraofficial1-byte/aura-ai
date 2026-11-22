import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateProactiveOpportunitiesV2,
  rankCognitiveOpportunities,
} from "../cognitive/unifiedCognitiveOrchestrator";
import { applySingleOpportunityDecision } from "../components/UnifiedProactivePanel";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "./controlledLearningEngine";
import {
  isValidProactiveMode,
  loadPersistedProactiveMode,
  PROACTIVE_MODE_STORAGE_KEY,
  ProactiveScheduler,
  savePersistedProactiveMode,
} from "./proactiveScheduler";
import type { ProactiveOpportunityV2 } from "./types";

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("Bug Fix Regression — Autonomy Mode Selection & ACCETTO Action", () => {
  it("BF.1 persists PASSIVE, ASSISTED, and USER-AUTHORIZED modes across reload without granting permissions", () => {
    const storage = createMemoryStorage();
    assert.equal(loadPersistedProactiveMode(storage), "PASSIVE");

    for (const mode of ["PASSIVE", "ASSISTED", "USER-AUTHORIZED"] as const) {
      assert.equal(isValidProactiveMode(mode), true);
      assert.equal(savePersistedProactiveMode(mode, storage), true);
      assert.equal(storage.getItem(PROACTIVE_MODE_STORAGE_KEY), mode);
      assert.equal(loadPersistedProactiveMode(storage), mode);

      const scheduler = new ProactiveScheduler({ mode });
      assert.equal(scheduler.getConfig().mode, mode);
      assert.equal(scheduler.getConfig().notificationsAuthorized, false);
      assert.equal(scheduler.canSendNotification(), false);
    }

    // Corrupted storage fails closed to PASSIVE
    storage.setItem(PROACTIVE_MODE_STORAGE_KEY, "UNSAFE_MODE");
    assert.equal(loadPersistedProactiveMode(storage), "PASSIVE");
  });

  it("BF.2 advances immediately after ACCETTO, prevents re-proposing accepted item, and never auto-executes", () => {
    const nowIso = "2026-11-22T09:00:00.000Z";
    const plan = createPlan({
      declaredGoal: "Completare modulo test",
      horizon: "daily",
      consentEnabled: false,
    });
    const planBefore = JSON.stringify(plan);

    const learning = new ControlledLearningEngine(true);
    const initial = generateProactiveOpportunitiesV2({
      plans: [plan],
      missions: [],
      growthGoals: [],
      consentEnabled: false,
      nowIso,
      learningEngine: learning,
    });
    assert.ok(initial.opportunities.length > 0);
    const target = initial.opportunities[0];

    const recordedKeys = new Set<string>();
    const firstAccept = applySingleOpportunityDecision({
      decisions: [],
      item: target,
      action: "accepted",
      learningEngine: learning,
      recordedKeys,
      nowMs: Date.parse(nowIso),
    });

    assert.equal(firstAccept.recorded, true);
    assert.equal(firstAccept.updatedItem.status, "accepted");
    assert.equal(learning.getInteractionCount(), 1);

    // Second click on same dedupeKey + action must NOT record duplicate
    const duplicateAccept = applySingleOpportunityDecision({
      decisions: firstAccept.nextDecisions,
      item: target,
      action: "accepted",
      learningEngine: learning,
      recordedKeys,
      nowMs: Date.parse(nowIso) + 500,
    });
    assert.equal(duplicateAccept.recorded, false);
    assert.equal(learning.getInteractionCount(), 1);

    // Accepted proposal is NOT re-proposed as an active 'proposed' item
    const nextAnalysis = generateProactiveOpportunitiesV2({
      plans: [plan],
      missions: [],
      growthGoals: [],
      consentEnabled: false,
      nowIso,
      previousOpportunities: firstAccept.nextDecisions,
      learningEngine: learning,
    });
    assert.equal(
      nextAnalysis.opportunities.some((o) => o.dedupeKey === target.dedupeKey),
      false
    );

    // No automatic execution or mutation on plans
    assert.equal(JSON.stringify(plan), planBefore);
  });

  it("BF.3 preserves rejected, snoozed, and suspended decision behavior without regression", () => {
    const nowIso = "2026-11-22T09:00:00.000Z";
    const nowMs = Date.parse(nowIso);
    const learning = new ControlledLearningEngine(true);

    const makeOpp = (id: string, key: string): ProactiveOpportunityV2 => ({
      id,
      dedupeKey: key,
      title: `Titolo ${id}`,
      description: "Descrizione test",
      rationale: "Motivo test",
      dataSource: "DataRepository",
      category: "initiative",
      epistemicTag: "fatto_osservato",
      priority: "media",
      confidence: 0.8,
      estimatedMinutes: 10,
      expectedBenefits: "Beneficio",
      possibleLimits: "Limite",
      status: "proposed",
      requiresConfirmationForMutation: false,
      rankScore: 50,
      generatedAt: nowIso,
    });

    const oppRej = makeOpp("o-rej", "k:rej");
    const oppSnz = makeOpp("o-snz", "k:snz");
    const oppSus = makeOpp("o-sus", "k:sus");
    const oppOpen = makeOpp("o-open", "k:open");

    const r1 = applySingleOpportunityDecision({
      decisions: [],
      item: oppRej,
      action: "rejected",
      learningEngine: learning,
      nowMs,
    });
    const r2 = applySingleOpportunityDecision({
      decisions: r1.nextDecisions,
      item: oppSnz,
      action: "snoozed",
      learningEngine: learning,
      nowMs,
    });
    const r3 = applySingleOpportunityDecision({
      decisions: r2.nextDecisions,
      item: oppSus,
      action: "suspended",
      learningEngine: learning,
      nowMs,
    });

    assert.equal(r1.updatedItem.status, "rejected");
    assert.ok(r1.updatedItem.cooldownUntil);
    assert.equal(r2.updatedItem.status, "snoozed");
    assert.ok(r2.updatedItem.cooldownUntil);
    assert.equal(r3.updatedItem.status, "suspended");
    assert.equal(learning.getInteractionCount(), 3);

    const ranked = rankCognitiveOpportunities([oppRej, oppSnz, oppSus, oppOpen], {
      nowIso,
      availableMinutes: 20,
      energyLevel: "media",
      stressLevel: 5,
      previousOpportunities: r3.nextDecisions,
      learningEngine: learning,
    });

    assert.deepEqual(
      ranked.ranked.map((o) => o.dedupeKey),
      ["k:open"]
    );
    assert.equal(ranked.skippedDuplicates, 3);
  });
});
