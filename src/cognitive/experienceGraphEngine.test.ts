import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import {
  ASSOCIATIVE_GRAPH_STORAGE_KEYS,
  ASSOCIATIVE_LIMITS,
  type CreateAssociativeEdgeInput,
  type CreateMemoryNodeInput,
} from "./associativeTypes";
import { ExperienceGraphEngine } from "./experienceGraphEngine";
import type { LearningConsentState } from "./selfLearningTypes";

const NOW = "2026-11-22T11:00:00.000Z";

const ALL_ON: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: true,
};

const ALL_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: false,
};

function makeNode(
  overrides: Partial<CreateMemoryNodeInput> = {}
): CreateMemoryNodeInput {
  return {
    kind: "goal",
    label: "Camminata quotidiana",
    summary: "Fare 20 minuti di camminata leggera al mattino.",
    consentScope: "operational",
    provenance: {
      sourceEngine: "GrowthEngine",
      sourceRecordId: overrides.id ?? undefined,
      evidenceType: "observed_behavior",
      epistemicTag: "fatto_osservato",
    },
    reliability: 0.9,
    validationStatus: "observed",
    nowIso: NOW,
    ...overrides,
  };
}

function makeEdge(
  sourceNodeId: string,
  targetNodeId: string,
  overrides: Partial<CreateAssociativeEdgeInput> = {}
): CreateAssociativeEdgeInput {
  return {
    sourceNodeId,
    targetNodeId,
    sourceScope: "operational",
    targetScope: "operational",
    relationType: "supports",
    direction: "directed",
    provenance: {
      createdByEngine: "ExperienceGraphEngine",
      evidenceType: "observed_behavior",
      epistemicTag: "fatto_osservato",
      supportingEvidenceIds: ["ev-1"],
      supportingNote: "Collegamento supportato da osservazione locale.",
    },
    weight: 0.85,
    validationStatus: "observed",
    nowIso: NOW,
    ...overrides,
  };
}

test("11.2.2.1 Partizioni fisiche separate e session_ephemeral esclusivamente in RAM", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  const op = engine.upsertNode(makeNode({ id: "op-1", consentScope: "operational" }), ALL_OFF);
  const mem = engine.upsertNode(
    makeNode({
      id: "mem-1",
      label: "Preferenza lettura serale",
      consentScope: "ai_memory",
    }),
    ALL_ON
  );
  const learn = engine.upsertNode(
    makeNode({
      id: "learn-1",
      kind: "experience_pattern",
      label: "Pattern micro-pause",
      consentScope: "learning",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "observed_behavior",
        epistemicTag: "interpretazione_prudente",
      },
    }),
    ALL_ON
  );
  const eph = engine.upsertNode(
    makeNode({
      id: "eph-1",
      kind: "session_signal",
      label: "Contesto sessione corrente",
      consentScope: "session_ephemeral",
    }),
    ALL_OFF
  );

  assert.equal(op.allowed, true);
  assert.equal(mem.allowed, true);
  assert.equal(learn.allowed, true);
  assert.equal(eph.allowed, true);

  const keys = storage.keys().sort();
  assert.deepEqual(
    keys,
    [
      ASSOCIATIVE_GRAPH_STORAGE_KEYS.learning,
      ASSOCIATIVE_GRAPH_STORAGE_KEYS.aiMemory,
      ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational,
    ].sort()
  );

  // session_ephemeral vive solo in RAM: una nuova istanza sullo stesso storage non lo contiene
  const reloadedEngine = new ExperienceGraphEngine(storage);
  const exported = reloadedEngine.exportAuthorizedGraph(ALL_ON, {
    scopes: ["operational", "ai_memory", "learning", "session_ephemeral"],
    nowIso: NOW,
  });
  assert.equal(exported.totalNodes, 3);
  assert.ok(exported.excludedScopes.includes("session_ephemeral"));
});

test("11.2.2.2 Deduplicazione deterministica e idempotenza su nodi e archi", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  const first = engine.upsertNode(makeNode({ id: "n1" }), ALL_OFF);
  assert.equal(first.created, true);
  assert.equal(first.node?.version, 1);

  const dup = engine.upsertNode(makeNode({ id: "n1" }), ALL_OFF);
  assert.equal(dup.allowed, true);
  assert.equal(dup.created, false);
  assert.equal(dup.updated, false);
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.node?.version, 1);

  const updated = engine.upsertNode(
    makeNode({
      id: "n1",
      summary: "Fare 25 minuti di camminata leggera al mattino.",
    }),
    ALL_OFF
  );
  assert.equal(updated.updated, true);
  assert.equal(updated.node?.version, 2);

  engine.upsertNode(makeNode({ id: "n2", label: "Energia mattutina" }), ALL_OFF);

  const e1 = engine.upsertEdge(
    makeEdge("n1", "n2", { relationType: "related_to", direction: "bidirectional" }),
    ALL_OFF
  );
  assert.equal(e1.created, true);

  // Ordine inverso su arco bidirezionale simmetrico -> deduplicato in modo idempotente
  const e2 = engine.upsertEdge(
    makeEdge("n2", "n1", { relationType: "related_to", direction: "bidirectional" }),
    ALL_OFF
  );
  assert.equal(e2.allowed, true);
  assert.equal(e2.created, false);
  assert.equal(e2.deduplicated, true);
  assert.equal(e2.edge?.id, e1.edge?.id);
});

test("11.2.2.3 Limiti massimi nodi per scope e archi per nodo e partizione", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  // Riempi fino a MAX_NODES_PER_SCOPE (200)
  for (let i = 0; i < ASSOCIATIVE_LIMITS.MAX_NODES_PER_SCOPE; i += 1) {
    const res = engine.upsertNode(
      makeNode({
        id: `cap-node-${i}`,
        label: `Obiettivo operativo codice-${String(i).padStart(4, "0")}`,
      }),
      ALL_OFF
    );
    assert.equal(res.allowed, true, res.reason);
  }

  // 201esimo nodo bloccato
  const overNode = engine.upsertNode(
    makeNode({
      id: "cap-node-overflow",
      label: "Obiettivo extra oltre limite",
    }),
    ALL_OFF
  );
  assert.equal(overNode.allowed, false);
  assert.equal(overNode.failClosed, true);

  // Ma aggiornamento idempotente di un nodo esistente resta consentito
  const idem = engine.upsertNode(
    makeNode({
      id: "cap-node-0",
      label: "Obiettivo operativo codice-0000",
    }),
    ALL_OFF
  );
  assert.equal(idem.allowed, true);
  assert.equal(idem.deduplicated, true);

  // MAX_EDGES_PER_NODE (24): collega cap-node-0 a 24 nodi distinti
  for (let i = 1; i <= ASSOCIATIVE_LIMITS.MAX_EDGES_PER_NODE; i += 1) {
    const edgeRes = engine.upsertEdge(
      makeEdge("cap-node-0", `cap-node-${i}`),
      ALL_OFF
    );
    assert.equal(edgeRes.allowed, true);
  }

  const overDegree = engine.upsertEdge(
    makeEdge("cap-node-0", `cap-node-${ASSOCIATIVE_LIMITS.MAX_EDGES_PER_NODE + 1}`),
    ALL_OFF
  );
  assert.equal(overDegree.allowed, false);

  // MAX_EDGES_PER_SCOPE (400): usa nodi distinti (<=24 per nodo) fino a 400 archi in una nuova istanza
  const edgeScopeStorage = new MemoryStorageAdapter();
  const edgeScopeEngine = new ExperienceGraphEngine(edgeScopeStorage);
  for (let i = 0; i < 60; i += 1) {
    assert.equal(
      edgeScopeEngine.upsertNode(
        makeNode({ id: `e-node-${i}`, label: `Nodo grafo codice-${String(i).padStart(3, "0")}` }),
        ALL_OFF
      ).allowed,
      true
    );
  }
  let createdEdges = 0;
  for (let i = 0; i < 60 && createdEdges < ASSOCIATIVE_LIMITS.MAX_EDGES_PER_SCOPE; i += 1) {
    for (let j = i + 1; j < 60 && createdEdges < ASSOCIATIVE_LIMITS.MAX_EDGES_PER_SCOPE; j += 1) {
      if (j - i > 8) continue; // max ~16 archi per nodo (<24)
      const res = edgeScopeEngine.upsertEdge(
        makeEdge(`e-node-${i}`, `e-node-${j}`),
        ALL_OFF
      );
      if (res.allowed && res.created) createdEdges += 1;
    }
  }
  assert.equal(createdEdges, ASSOCIATIVE_LIMITS.MAX_EDGES_PER_SCOPE);

  const overScopeEdges = edgeScopeEngine.upsertEdge(
    makeEdge("e-node-50", "e-node-59"),
    ALL_OFF
  );
  assert.equal(overScopeEdges.allowed, false);
});

test("11.2.2.4 Prevenzione cicli diretti e traversal massimo di 2 hop con propagazione epistemica", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  for (const id of ["n0", "n1", "n2", "n3"]) {
    engine.upsertNode(
      makeNode({
        id,
        label: `Nodo ${id}`,
        reliability: id === "n2" ? 0.55 : 0.9,
        provenance: {
          sourceEngine: "ContinuityEngine",
          evidenceType: id === "n2" ? "hypothesis" : "observed_behavior",
          epistemicTag: id === "n2" ? "ipotesi_da_verificare" : "fatto_osservato",
        },
        validationStatus: id === "n2" ? "proposed" : "observed",
      }),
      ALL_OFF
    );
  }

  assert.equal(engine.upsertEdge(makeEdge("n0", "n1"), ALL_OFF).allowed, true);
  assert.equal(
    engine.upsertEdge(
      makeEdge("n1", "n2", {
        provenance: {
          createdByEngine: "ExperienceGraphEngine",
          evidenceType: "hypothesis",
          epistemicTag: "ipotesi_da_verificare",
          supportingEvidenceIds: ["hyp-1"],
          supportingNote: "Possibile collegamento da verificare.",
        },
        weight: 0.6,
        validationStatus: "hypothesized",
      }),
      ALL_OFF
    ).allowed,
    true
  );
  assert.equal(engine.upsertEdge(makeEdge("n2", "n3"), ALL_OFF).allowed, true);

  // Ciclo n2 -> n0 bloccato
  const cycleRes = engine.upsertEdge(makeEdge("n2", "n0"), ALL_OFF);
  assert.equal(cycleRes.allowed, false);
  assert.equal(cycleRes.blockedBy, "cycle_or_depth_exceeded");

  // Anche se maxHops richiesto e 5, effettivo e bloccato a 2 hop -> n3 escluso
  const search = engine.findConnectedPaths(
    { seedNodeIds: ["n0"], maxHops: 5 },
    ALL_OFF,
    { nowIso: NOW }
  );
  assert.equal(search.allowed, true);
  assert.equal(search.effectiveMaxHops, 2);
  const foundIds = search.nodes.map((n) => n.id);
  assert.deepEqual(foundIds, ["n0", "n1", "n2"]);
  assert.equal(foundIds.includes("n3"), false);

  const pathToN2 = search.paths.find((p) => p.targetNode.id === "n2");
  assert.ok(pathToN2);
  assert.equal(pathToN2.hopDistance, 2);
  assert.equal(pathToN2.pathEpistemicTag, "ipotesi_da_verificare");
  assert.equal(pathToN2.pathReliability, 0.55);
});

test("11.2.2.5 Gestione conflitti, nodi obsoleti (superseded) e divieto promozione epistemica", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  engine.upsertNode(
    makeNode({
      id: "pref-old",
      kind: "preference",
      label: "Preferenza studio serale",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "hypothesis",
        epistemicTag: "ipotesi_da_verificare",
      },
      validationStatus: "proposed",
    }),
    ALL_OFF
  );
  engine.upsertNode(
    makeNode({
      id: "pref-new",
      kind: "preference",
      label: "Preferenza studio mattutino",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      validationStatus: "confirmed",
    }),
    ALL_OFF
  );

  // Tentativo di promuovere pref-old da ipotesi a fatto senza explicit_feedback -> bloccato
  const promoteAttempt = engine.upsertNode(
    makeNode({
      id: "pref-old",
      kind: "preference",
      label: "Preferenza studio serale",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      validationStatus: "observed",
    }),
    ALL_OFF
  );
  assert.equal(promoteAttempt.allowed, false);
  assert.equal(promoteAttempt.blockedBy, "hypothesis_promotion_forbidden");

  const conflicted = engine.markNodeConflicted(
    {
      nodeId: "pref-old",
      scope: "operational",
      conflictingNodeIds: ["pref-new"],
      note: "In conflitto con la nuova preferenza mattutina.",
    },
    ALL_OFF,
    { nowIso: NOW }
  );
  assert.equal(conflicted.allowed, true);
  assert.equal(conflicted.node?.validationStatus, "conflicted");
  assert.deepEqual(conflicted.node?.conflictWithNodeIds, ["pref-new"]);

  const superseded = engine.markNodeSuperseded(
    {
      nodeId: "pref-old",
      scope: "operational",
      supersededByNodeId: "pref-new",
      note: "Sostituita dalla preferenza confermata.",
    },
    ALL_OFF,
    { nowIso: NOW }
  );
  assert.equal(superseded.allowed, true);
  assert.equal(superseded.node?.validationStatus, "superseded");
  assert.equal(superseded.node?.supersededByNodeId, "pref-new");

  // Ciclo di sostituzione reciproca bloccato
  const reverseSupersede = engine.markNodeSuperseded(
    {
      nodeId: "pref-new",
      scope: "operational",
      supersededByNodeId: "pref-old",
    },
    ALL_OFF,
    { nowIso: NOW }
  );
  assert.equal(reverseSupersede.allowed, false);
  assert.equal(reverseSupersede.blockedBy, "cycle_or_depth_exceeded");

  // Di default findConnectedPaths esclude i nodi superseded
  const activeSearch = engine.findConnectedPaths(
    { seedNodeIds: ["pref-old", "pref-new"] },
    ALL_OFF,
    { nowIso: NOW }
  );
  assert.deepEqual(
    activeSearch.nodes.map((n) => n.id),
    ["pref-new"]
  );
});

test("11.2.2.6 Sincronizzazione idempotente da fonti operative e isolamento assoluto dei consensi", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  const syncPayload = {
    growthGoals: [
      {
        id: "g-1",
        title: "Costanza nel sonno",
        description: "Routine serale calma prima delle 23:00.",
        status: "attivo" as const,
        steps: [{ id: "s1", title: "Spegni schermi 20 min prima", done: true }],
        createdAt: NOW,
        updatedAt: NOW,
        history: [],
      },
    ],
    plans: [
      {
        id: "p-1",
        title: "Piano serale sostenibile",
        declaredGoal: "Costanza nel sonno",
        desiredOutcome: "Riposo più regolare",
        horizon: "weekly" as const,
        status: "active" as const,
        createdAt: NOW,
        updatedAt: NOW,
        targetDate: "2026-11-29",
        constraints: [],
        dailyMinutesLimit: 20,
        uncertainties: [],
        tasks: [
          {
            id: "t-1",
            title: "Lettura leggera 10 minuti",
            description: "Prima di dormire",
            priority: "media" as const,
            status: "pending" as const,
            dueDate: "2026-11-23",
            estimatedMinutes: 10,
            uncertaintyNote: "",
            dependencies: [],
            resources: [],
            subtasks: [],
            alternatives: [],
            horizonBucket: "oggi" as const,
          },
        ],
        revisions: [],
        reasoningSummary: "Piano locale.",
        progressPercent: 20,
        source: "local" as const,
        sessionOnly: false,
      },
    ],
    missions: [
      {
        id: "m-1",
        title: "Respirazione serale",
        description: "5 minuti di respiro lento",
        category: "Respirazione e rilassamento" as const,
        estimatedMinutes: 5,
        durationLabel: "5 min",
        effortLevel: "basso" as const,
        goal: "Costanza nel sonno",
        instructions: ["Respira lentamente"],
        createdAt: NOW,
        status: "accettata" as const,
        source: "local-adaptive" as const,
      },
    ],
    timelineEvents: [
      {
        id: "tl-1",
        date: NOW,
        source: "ContinuityEngine",
        category: "progress" as const,
        title: "Primo passo completato",
        description: "Completato il primo passo della routine.",
        epistemicTag: "fatto_osservato" as const,
        reliability: 0.9,
        entityId: "g-1",
      },
    ],
    nowIso: NOW,
  };

  const firstSync = engine.syncFromOperationalSources(syncPayload, ALL_OFF);
  assert.equal(firstSync.allowed, true);
  assert.equal(firstSync.nodesCreated, 5); // goal + plan + task + mission + timeline
  assert.equal(firstSync.edgesCreated, 4); // plan->goal, task->plan, mission->goal, timeline->goal

  // Seconda sincronizzazione identica -> 100% idempotente
  const secondSync = engine.syncFromOperationalSources(syncPayload, ALL_OFF);
  assert.equal(secondSync.allowed, true);
  assert.equal(secondSync.nodesCreated, 0);
  assert.equal(secondSync.nodesUpdated, 0);
  assert.equal(secondSync.nodesDeduplicated, 5);
  assert.equal(secondSync.edgesCreated, 0);
  assert.equal(secondSync.edgesDeduplicated, 4);
});

test("11.2.2.7 Revoca completa AI Memory (nodi, archi cross-scope, RAM e riferimenti) ed export selettivo", () => {
  const storage = new MemoryStorageAdapter();
  const engine = new ExperienceGraphEngine(storage);

  engine.upsertNode(makeNode({ id: "op-goal", consentScope: "operational" }), ALL_ON);
  engine.upsertNode(
    makeNode({
      id: "ai-mem-node",
      label: "Ricordo preferenza musica calma",
      consentScope: "ai_memory",
    }),
    ALL_ON
  );
  engine.upsertNode(
    makeNode({
      id: "learn-node",
      kind: "experience_pattern",
      label: "Pattern energia pomeridiana",
      consentScope: "learning",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "observed_behavior",
        epistemicTag: "interpretazione_prudente",
      },
    }),
    ALL_ON
  );
  engine.upsertNode(
    makeNode({
      id: "eph-node",
      kind: "session_signal",
      label: "Focus corrente",
      consentScope: "session_ephemeral",
    }),
    ALL_ON
  );

  // Arco cross-scope operational -> ai_memory (salvato nella partizione ai_memory)
  const crossEdge = engine.upsertEdge(
    makeEdge("op-goal", "ai-mem-node", {
      sourceScope: "operational",
      targetScope: "ai_memory",
    }),
    ALL_ON
  );
  assert.equal(crossEdge.allowed, true);
  assert.equal(crossEdge.edge?.storageScope, "ai_memory");

  // Arco RAM session_ephemeral -> ai_memory
  const ephEdge = engine.upsertEdge(
    makeEdge("eph-node", "ai-mem-node", {
      sourceScope: "session_ephemeral",
      targetScope: "ai_memory",
    }),
    ALL_ON
  );
  assert.equal(ephEdge.allowed, true);
  assert.equal(ephEdge.edge?.storageScope, "session_ephemeral");

  // Riferimento di conflitto su op-goal verso ai-mem-node
  engine.markNodeConflicted(
    {
      nodeId: "op-goal",
      scope: "operational",
      conflictingNodeIds: ["ai-mem-node"],
      conflictingScope: "ai_memory",
    },
    ALL_ON
  );

  // Export con solo learning ON e aiMemory OFF esclude ai_memory
  const partialExport = engine.exportAuthorizedGraph({
    learningConsent: true,
    aiMemoryConsent: false,
  });
  assert.equal(partialExport.allowed, true);
  assert.deepEqual(partialExport.includedScopes.sort(), ["learning", "operational"]);
  assert.ok(partialExport.excludedScopes.includes("ai_memory"));

  // clearScope su ai_memory senza conferma esplicita bloccato
  const deniedClear = engine.clearScope("ai_memory", {
    learningConsent: false,
    aiMemoryConsent: false,
    explicitClearRequested: false,
  });
  assert.equal(deniedClear.allowed, false);

  // Revoca + cancellazione completa ai_memory
  const cleared = engine.clearScope("ai_memory", {
    learningConsent: false,
    aiMemoryConsent: false,
    revokedAt: NOW,
    explicitClearRequested: true,
  });
  assert.equal(cleared.allowed, true);
  assert.equal(cleared.cleared, true);
  assert.equal(storage.getItem(ASSOCIATIVE_GRAPH_STORAGE_KEYS.aiMemory), null);

  // Verifica nessuna traccia residua in export, path search o conflictWithNodeIds di op-goal
  const afterExport = engine.exportAuthorizedGraph(ALL_ON);
  assert.equal(afterExport.partitions.ai_memory?.nodes.length ?? 0, 0);
  const opGoal = afterExport.partitions.operational?.nodes.find((n) => n.id === "op-goal");
  assert.ok(opGoal);
  assert.equal(opGoal.conflictWithNodeIds, undefined);

  const ephSearch = engine.findConnectedPaths(
    { seedNodeIds: ["eph-node"], allowedScopes: ["session_ephemeral", "ai_memory"] },
    ALL_ON
  );
  assert.equal(ephSearch.edges.length, 0);
  assert.deepEqual(
    ephSearch.nodes.map((n) => n.id),
    ["eph-node"]
  );
});

test("11.2.2.8 Fail-closed su partizione corrotta, crisi, audit mutazioni e zero chiamate di rete", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Network call forbidden");
  }) as typeof fetch;

  try {
    const storage = new MemoryStorageAdapter();
    storage.setItem(ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational, "{JSON_CORROTTO");
    const engine = new ExperienceGraphEngine(storage);

    const failWrite = engine.upsertNode(makeNode({ id: "x1" }), ALL_ON);
    assert.equal(failWrite.allowed, false);
    assert.equal(failWrite.failClosed, true);
    assert.equal(failWrite.blockedBy, "corrupted_data");

    const failSearch = engine.findConnectedPaths({ seedNodeIds: ["x1"] }, ALL_ON);
    assert.equal(failSearch.allowed, false);
    assert.equal(failSearch.blockedBy, "corrupted_data");

    const failExport = engine.exportAuthorizedGraph(ALL_ON);
    assert.equal(failExport.allowed, false);
    assert.equal(failExport.blockedBy, "corrupted_data");

    // Ripristino esplicito consentito con explicitClearRequested
    const recover = engine.clearScope("operational", {
      ...ALL_OFF,
      explicitClearRequested: true,
    });
    assert.equal(recover.allowed, true);

    const crisisBlock = engine.upsertNode(
      makeNode({ id: "x2" }),
      ALL_ON,
      { crisisBlocked: true }
    );
    assert.equal(crisisBlock.allowed, false);
    assert.equal(crisisBlock.blockedBy, "crisis");

    const audit = engine.getAuditLog();
    assert.ok(audit.length >= 3);
    assert.ok(audit.some((entry) => entry.operation === "clear" && entry.allowed));
    assert.ok(audit.some((entry) => entry.blockedBy === "crisis"));
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
