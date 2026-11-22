import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTIVE_LEARNING_STORAGE_KEY,
  AdaptiveLearningEngine,
} from "../cognitive/adaptiveLearningEngine";
import { AuthorizationLedger } from "../cognitive/authorizationLedger";
import { CognitiveTimeline } from "../cognitive/cognitiveTimeline";
import {
  KNOWLEDGE_EVOLUTION_STORAGE_KEY,
  KnowledgeEvolutionStore,
} from "../cognitive/knowledgeEvolutionStore";
import type { MetaLearningProposal } from "../cognitive/metaLearningBridge";
import { DataRepository } from "../persistence/dataManagement";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import { createPlan } from "../planning/planningEngine";
import { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import { LEARNING_CONSENT_STORAGE_KEY } from "./CognitiveEvolutionDashboard";
import {
  buildInitialMetaDashboardState,
  buildMetaReportExportJson,
  executeManualMetaAnalysis,
  formatMetaReportAsText,
  formatReliabilityLabel,
  loadPersistedLearningConsentReadOnly,
  submitProposalToKnowledgeStoreOnly,
} from "./MetaCognitiveDashboard";

describe("MetaCognitiveDashboard V1 Controller & UI Helpers (Phase 10.5)", () => {
  it("10.5.1 starts idle with zero automatic analysis executed", () => {
    const initial = buildInitialMetaDashboardState(false);
    assert.equal(initial.status, "idle");
    assert.equal(initial.result, null);
    assert.equal(initial.lastUpdatedAt, null);
    assert.equal(initial.errorMessage, null);
    assert.equal(initial.learningConsentActive, false);
    assert.match(formatMetaReportAsText(initial), /Analisi non ancora eseguita/);
  });

  it("10.5.2 fails closed when learningConsent is OFF even if aiMemoryConsent is ON", () => {
    const storage = new MemoryStorageAdapter();
    storage.setItem(
      LEARNING_CONSENT_STORAGE_KEY,
      JSON.stringify({ learningConsent: false })
    );

    const persisted = loadPersistedLearningConsentReadOnly(storage);
    assert.equal(persisted.learningConsent, false);

    const state = executeManualMetaAnalysis({
      aiMemoryConsent: true,
      crisisBlocked: false,
      persistedConsent: persisted,
      repository: new DataRepository(storage),
      timeline: new CognitiveTimeline(storage),
      authorizationLedger: new AuthorizationLedger(storage),
      adaptiveLearning: new AdaptiveLearningEngine(storage),
      knowledgeStore: new KnowledgeEvolutionStore(storage),
      nowIso: "2026-11-22T12:00:00.000Z",
    });

    assert.equal(state.status, "blocked");
    assert.equal(state.learningConsentActive, false);
    assert.ok(state.result);
    assert.equal(state.result.allowed, false);
    assert.equal(state.result.safetyDecision.blockedBy, "consent");
  });

  it("10.5.3 handles insufficient data explicitly without inventing reliability or strategy winners", () => {
    const storage = new MemoryStorageAdapter();
    const state = executeManualMetaAnalysis({
      aiMemoryConsent: false,
      crisisBlocked: false,
      persistedConsent: { learningConsent: true },
      repository: new DataRepository(storage),
      timeline: new CognitiveTimeline(storage),
      controlledLearning: new ControlledLearningEngine(true),
      authorizationLedger: new AuthorizationLedger(storage),
      adaptiveLearning: new AdaptiveLearningEngine(storage),
      knowledgeStore: new KnowledgeEvolutionStore(storage),
      plans: [],
      missions: [],
      growthGoals: [],
      nowIso: "2026-11-22T12:10:00.000Z",
    });

    assert.equal(state.status, "insufficient_data");
    assert.ok(state.result);
    assert.equal(state.result.allowed, true);
    assert.equal(state.result.uncertaintyEvaluation.assessment.reliabilityScore, null);
    assert.equal(
      formatReliabilityLabel(
        state.result.uncertaintyEvaluation.assessment.reliabilityScore
      ),
      "Dati insufficienti"
    );
    assert.equal(state.result.strategyComparison.selectedStrategy, null);
  });

  it("10.5.4 produces full read-only report when local evidences exist without mutating stores", () => {
    const storage = new MemoryStorageAdapter();
    const repo = new DataRepository(storage);
    const plan = createPlan({
      declaredGoal: "Routine benessere",
      horizon: "daily",
      consentEnabled: false,
    });
    plan.tasks[0].status = "completed";
    repo.savePlans([plan]);

    const timeline = new CognitiveTimeline(storage);
    timeline.recordEvent({
      source: "planning",
      category: "progress",
      title: "Attività completata",
      description: "Sessione completata nei tempi",
      reliability: 0.9,
      epistemicTag: "fatto_osservato",
    });

    const controlled = new ControlledLearningEngine(true);
    controlled.recordInteraction("planning", "accepted", "2026-11-22T09:00:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T10:00:00.000Z");
    controlled.recordInteraction("planning", "completed", "2026-11-22T11:00:00.000Z");

    const adaptive = new AdaptiveLearningEngine(storage);
    const knowledgeStore = new KnowledgeEvolutionStore(storage);
    const ledger = new AuthorizationLedger(storage);

    const beforeAdaptiveRaw = storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY);
    const beforeKnowledgeRaw = storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY);
    const beforeRepoJson = JSON.stringify(repo.loadSnapshot());
    const beforeLedgerJson = JSON.stringify(ledger.getAuditEvents());

    const state = executeManualMetaAnalysis({
      aiMemoryConsent: false,
      crisisBlocked: false,
      persistedConsent: { learningConsent: true },
      declaredGoal: "Routine benessere",
      constraints: { energyLevel: "medium", timeBudgetMinutes: 30 },
      repository: repo,
      timeline,
      controlledLearning: controlled,
      authorizationLedger: ledger,
      adaptiveLearning: adaptive,
      knowledgeStore,
      plans: [plan],
      missions: [],
      growthGoals: [],
      nowIso: "2026-11-22T12:20:00.000Z",
    });

    assert.equal(state.status, "completed");
    assert.ok(state.result);
    assert.equal(state.result.allowed, true);
    assert.equal(state.result.readOnly, true);
    assert.equal(state.result.autoApplied, false);
    assert.ok(state.result.explanation.evidencesUsed.length > 0);
    assert.equal(storage.getItem(ADAPTIVE_LEARNING_STORAGE_KEY), beforeAdaptiveRaw);
    assert.equal(storage.getItem(KNOWLEDGE_EVOLUTION_STORAGE_KEY), beforeKnowledgeRaw);
    assert.equal(JSON.stringify(repo.loadSnapshot()), beforeRepoJson);
    assert.equal(JSON.stringify(ledger.getAuditEvents()), beforeLedgerJson);

    const exported = JSON.parse(buildMetaReportExportJson(state)) as {
      exportType: string;
      readOnly: boolean;
      advisoryOnly: boolean;
      report: { allowed: boolean };
    };
    assert.equal(exported.exportType, "aura_metacognitive_report");
    assert.equal(exported.readOnly, true);
    assert.equal(exported.advisoryOnly, true);
    assert.equal(exported.report.allowed, true);
  });

  it("10.5.5 registers proposals strictly as 'proposed' and never auto-approves", () => {
    const storage = new MemoryStorageAdapter();
    const knowledgeStore = new KnowledgeEvolutionStore(storage);
    const proposal: MetaLearningProposal = {
      id: "ml-prop-test-1",
      targetEngine: "KnowledgeEvolutionStore",
      status: "proposed",
      requiresExplicitUserApproval: true,
      userExplicitApproval: false,
      autoApplied: false,
      title: "Sessioni focalizzate da 20 min",
      rationale: "3 completamenti osservati",
      supportingDataSources: ["ExperienceAnalyzer"],
      supportingEvidence: ["3 task completati con durata 20 min"],
      epistemicTag: "fatto_osservato",
      confidence: 0.8,
      knowledgeProposalPayload: {
        title: "Sessioni focalizzate da 20 min",
        content: "Preferire blocchi da 20 minuti nelle attività giornaliere.",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
        confidence: 0.8,
        dataSource: "ExperienceAnalyzer",
        uncertaintyNote: "Richiede conferma esplicita utente.",
      },
    };

    const consent = { learningConsent: true, aiMemoryConsent: false };
    const res = submitProposalToKnowledgeStoreOnly(
      knowledgeStore,
      consent,
      proposal,
      false
    );

    assert.equal(res.allowed, true);
    assert.ok(res.data);
    assert.equal(res.data.status, "proposed");

    const listed = knowledgeStore.listEntries(consent);
    assert.equal(listed.allowed, true);
    assert.equal(listed.data?.length, 1);
    assert.equal(listed.data?.[0].status, "proposed");
  });

  it("10.5.6 blocks gracefully in fail-closed mode during crisisBlocked or throwing repository", () => {
    const crisisState = executeManualMetaAnalysis({
      aiMemoryConsent: true,
      crisisBlocked: true,
      persistedConsent: { learningConsent: true },
      nowIso: "2026-11-22T12:30:00.000Z",
    });

    assert.equal(crisisState.status, "blocked");
    assert.equal(crisisState.result?.safetyDecision.blockedBy, "crisis");

    const brokenPlans = null as unknown as [];
    const malformedRepo = {
      loadSnapshot() {
        throw new Error("boom");
      },
    } as unknown as DataRepository;

    const failState = executeManualMetaAnalysis({
      aiMemoryConsent: false,
      crisisBlocked: false,
      persistedConsent: { learningConsent: true },
      repository: malformedRepo,
      plans: brokenPlans,
      nowIso: "2026-11-22T12:31:00.000Z",
    });

    assert.equal(failState.status, "error");
    assert.ok(failState.errorMessage);
    assert.equal(failState.result, null);
  });
});
