import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorageAdapter } from "../persistence/storageAdapters";
import {
  AssociativeRetrievalEngine,
  classifyEpistemicCategory,
} from "./associativeRetrievalEngine";
import { ASSOCIATIVE_GRAPH_STORAGE_KEYS } from "./associativeTypes";
import { ExperienceGraphEngine } from "./experienceGraphEngine";
import type { LearningConsentState } from "./selfLearningTypes";

const NOW = "2026-11-23T10:00:00.000Z";

const ALL_ON: LearningConsentState = {
  learningConsent: true,
  aiMemoryConsent: true,
};

const ALL_OFF: LearningConsentState = {
  learningConsent: false,
  aiMemoryConsent: false,
};

function setupRichGraph() {
  const storage = new MemoryStorageAdapter();
  const graph = new ExperienceGraphEngine(storage);

  // N0 (seed, operational, fatto verificato)
  assert.equal(
    graph.upsertNode(
      {
        id: "n0-goal",
        kind: "goal",
        label: "Regolarita del sonno",
        summary: "Mantenere una routine serale serena per dormire meglio.",
        keywords: ["sonno", "routine", "serale"],
        consentScope: "operational",
        provenance: {
          sourceEngine: "GrowthEngine",
          sourceRecordId: "goal-sleep",
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
        },
        reliability: 0.95,
        validationStatus: "confirmed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  // N1 (1 hop da N0, operational, osservato)
  assert.equal(
    graph.upsertNode(
      {
        id: "n1-plan",
        kind: "plan",
        label: "Piano lettura serale",
        summary: "Leggere 15 minuti di libro cartaceo prima di riposare.",
        keywords: ["lettura", "libro", "sera"],
        consentScope: "operational",
        provenance: {
          sourceEngine: "PlanningEngine",
          sourceRecordId: "plan-read",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
        },
        reliability: 0.9,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  // N2 (2 hop da N0, operational, esperienza collegata con affidabilita 0.6)
  assert.equal(
    graph.upsertNode(
      {
        id: "n2-exp",
        kind: "experience_pattern",
        label: "Riduzione schermi prima del riposo",
        summary: "Diminuire la luce blu favorisce una transizione piu tranquilla.",
        keywords: ["schermi", "luce", "riposo"],
        consentScope: "operational",
        provenance: {
          sourceEngine: "ExperienceAnalyzer",
          sourceRecordId: "exp-screens",
          evidenceType: "observed_behavior",
          epistemicTag: "interpretazione_prudente",
        },
        reliability: 0.6,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  // N3 (3 hop da N0 -> deve essere bloccato dal limite MAX_TRAVERSAL_HOPS = 2)
  assert.equal(
    graph.upsertNode(
      {
        id: "n3-far",
        kind: "concept",
        label: "Concetto terzo hop lontano",
        summary: "Questo nodo al terzo hop non deve essere mai raggiunto.",
        consentScope: "operational",
        provenance: {
          sourceEngine: "ContinuityEngine",
          sourceRecordId: "c-far",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
        },
        reliability: 0.99,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  assert.equal(
    graph.upsertEdge(
      {
        sourceNodeId: "n0-goal",
        targetNodeId: "n1-plan",
        sourceScope: "operational",
        targetScope: "operational",
        relationType: "supports",
        direction: "directed",
        provenance: {
          createdByEngine: "ExperienceGraphEngine",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          supportingEvidenceIds: ["ev-1"],
          supportingNote: "Il piano serale sostiene l'obiettivo sul sonno.",
        },
        weight: 0.92,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  assert.equal(
    graph.upsertEdge(
      {
        sourceNodeId: "n1-plan",
        targetNodeId: "n2-exp",
        sourceScope: "operational",
        targetScope: "operational",
        relationType: "derived_from",
        direction: "directed",
        provenance: {
          createdByEngine: "ExperienceGraphEngine",
          evidenceType: "observed_behavior",
          epistemicTag: "interpretazione_prudente",
          supportingEvidenceIds: ["ev-2"],
          supportingNote: "Il piano deriva dall'esperienza sulla riduzione schermi.",
        },
        weight: 0.78,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  assert.equal(
    graph.upsertEdge(
      {
        sourceNodeId: "n2-exp",
        targetNodeId: "n3-far",
        sourceScope: "operational",
        targetScope: "operational",
        relationType: "related_to",
        direction: "directed",
        provenance: {
          createdByEngine: "ExperienceGraphEngine",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          supportingEvidenceIds: ["ev-3"],
          supportingNote: "Collegamento al terzo hop.",
        },
        weight: 0.95,
        validationStatus: "observed",
        nowIso: NOW,
      },
      ALL_ON
    ).allowed,
    true
  );

  return { storage, graph, retrieval: new AssociativeRetrievalEngine(graph) };
}

test("11.2.3.1 Recupero diretto, 1 hop, 2 hop e blocco assoluto del 3 hop", () => {
  const { retrieval } = setupRichGraph();

  // Recupero diretto tramite query testuale
  const direct = retrieval.retrieve({
    query: "regolarita del sonno",
    consentState: ALL_OFF,
    nowIso: NOW,
  });
  assert.equal(direct.allowed, true);
  assert.equal(direct.insufficientSignal, false);
  assert.equal(direct.effectiveMaxHops, 2);

  const ids = direct.items.map((item) => item.node.id);
  assert.deepEqual(ids, ["n0-goal", "n1-plan", "n2-exp"]);
  assert.equal(ids.includes("n3-far"), false);

  assert.equal(direct.items[0].hopDistance, 0);
  assert.equal(direct.items[1].hopDistance, 1);
  assert.equal(direct.items[2].hopDistance, 2);

  // Anche richiedendo maxHops: 5 viene imposto il blocco rigoroso a 2 hop
  const clamped = retrieval.retrieveByNode({
    nodeId: "n0-goal",
    consentState: ALL_OFF,
    maxHops: 5,
    nowIso: NOW,
  });
  assert.equal(clamped.effectiveMaxHops, 2);
  assert.equal(
    clamped.items.some((item) => item.node.id === "n3-far"),
    false
  );
});

test("11.2.3.2 Ranking deterministico, spiegazioni strutturate, provenienza e affidabilita conservativa", () => {
  const { retrieval } = setupRichGraph();

  const runA = retrieval.retrieve({
    query: "routine sonno",
    consentState: ALL_OFF,
    nowIso: NOW,
  });
  const runB = retrieval.retrieve({
    query: "routine sonno",
    consentState: ALL_OFF,
    nowIso: NOW,
  });

  // Pienamente deterministico e riproducibile
  assert.deepEqual(runA.items, runB.items);

  const explanations = retrieval.explainRetrieval(runA);
  assert.equal(explanations.length, 3);

  const expN2 = explanations.find((e) => e.nodeId === "n2-exp");
  assert.ok(expN2);
  assert.equal(expN2.seedNodeId, "n0-goal");
  assert.equal(expN2.seedNodeLabel, "Regolarita del sonno");
  assert.deepEqual(expN2.pathNodeIds, ["n0-goal", "n1-plan", "n2-exp"]);
  assert.deepEqual(expN2.relations, ["supports", "derived_from"]);
  assert.equal(expN2.hopDistance, 2);
  assert.equal(expN2.provenance.sourceEngine, "ExperienceAnalyzer");
  assert.equal(expN2.provenance.sourceRecordId, "exp-screens");
  assert.equal(expN2.epistemicTag, "interpretazione_prudente");
  assert.equal(expN2.epistemicCategory, "informazione_derivata");
  assert.ok(expN2.relevanceReason.includes("Regolarita del sonno"));
  // L'affidabilita lungo il path non supera mai il minimo (0.60 * 0.85 = 0.51 <= 0.60)
  assert.ok(expN2.reliability <= 0.6);
});

test("11.2.3.3 Distinzione epistemica completa e nessuna promozione di ipotesi ad alta pertinenza", () => {
  const storage = new MemoryStorageAdapter();
  const graph = new ExperienceGraphEngine(storage);
  const retrieval = new AssociativeRetrievalEngine(graph);

  // Fatto verificato
  graph.upsertNode(
    {
      id: "fact-1",
      kind: "goal",
      label: "Camminata mattutina attiva",
      summary: "Obiettivo di camminata mattutina confermato.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "confirmed",
      nowIso: NOW,
    },
    ALL_OFF
  );

  // Ipotesi ad altissima pertinenza testuale rispetto alla query
  graph.upsertNode(
    {
      id: "hyp-1",
      kind: "experience_pattern",
      label: "Ipotesi musica mattutina produttiva",
      summary: "Forse ascoltare musica leggera al mattino aiuta la concentrazione.",
      keywords: ["musica", "mattutina", "produttiva"],
      consentScope: "operational",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "hypothesis",
        epistemicTag: "ipotesi_da_verificare",
      },
      reliability: 0.9,
      validationStatus: "proposed",
      nowIso: NOW,
    },
    ALL_OFF
  );

  // Nodo osservato collegato all'ipotesi: il percorso non promuove l'ipotesi
  graph.upsertNode(
    {
      id: "obs-1",
      kind: "timeline_event",
      label: "Sessione calma osservata",
      summary: "Sessione svolta con ritmo regolare.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "ContinuityEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.92,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_OFF
  );

  graph.upsertEdge(
    {
      sourceNodeId: "hyp-1",
      targetNodeId: "obs-1",
      sourceScope: "operational",
      targetScope: "operational",
      relationType: "related_to",
      direction: "directed",
      provenance: {
        createdByEngine: "ExperienceGraphEngine",
        evidenceType: "hypothesis",
        epistemicTag: "ipotesi_da_verificare",
        supportingEvidenceIds: ["e-hyp"],
        supportingNote: "Associazione ipotetica da verificare.",
      },
      weight: 0.85,
      validationStatus: "hypothesized",
      nowIso: NOW,
    },
    ALL_OFF
  );

  const res = retrieval.retrieve({
    query: "ipotesi musica mattutina produttiva",
    consentState: ALL_OFF,
    nowIso: NOW,
  });

  const hypItem = res.items.find((i) => i.node.id === "hyp-1");
  assert.ok(hypItem);
  assert.ok(hypItem.scoreBreakdown.contextualRelevance >= 0.85);
  assert.equal(hypItem.pathEpistemicTag, "ipotesi_da_verificare");
  assert.equal(hypItem.epistemicCategory, "ipotesi_da_verificare");
  assert.equal(hypItem.node.provenance.epistemicTag, "ipotesi_da_verificare");

  // Verifica classificazione di tutte e 5 le categorie
  assert.equal(
    classifyEpistemicCategory(
      {
        id: "c1",
        canonicalKey: "c1",
        kind: "goal",
        label: "x",
        summary: "y",
        keywords: [],
        consentScope: "operational",
        provenance: {
          sourceEngine: "GrowthEngine",
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
        },
        reliability: 0.9,
        validationStatus: "confirmed",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        observedAt: NOW,
      },
      "fatto_osservato",
      0
    ),
    "fatto_verificato"
  );
  assert.equal(
    classifyEpistemicCategory(
      {
        id: "c2",
        canonicalKey: "c2",
        kind: "timeline_event",
        label: "x",
        summary: "y",
        keywords: [],
        consentScope: "operational",
        provenance: {
          sourceEngine: "ContinuityEngine",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
        },
        reliability: 0.9,
        validationStatus: "observed",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        observedAt: NOW,
      },
      "fatto_osservato",
      0
    ),
    "informazione_osservata"
  );

  // includeHypotheses: false esclude ipotesi
  const noHyp = retrieval.retrieve({
    query: "musica mattutina",
    consentState: ALL_OFF,
    includeHypotheses: false,
    nowIso: NOW,
  });
  assert.equal(noHyp.items.some((i) => i.node.id === "hyp-1"), false);
});

test("11.2.3.4 Isolamento partizioni, consensi indipendenti e blocco immediato su revoca", () => {
  const storage = new MemoryStorageAdapter();
  const graph = new ExperienceGraphEngine(storage);
  const retrieval = new AssociativeRetrievalEngine(graph);

  graph.upsertNode(
    {
      id: "op-focus",
      kind: "goal",
      label: "Concentrazione pomeridiana",
      summary: "Sessioni brevi di lavoro concentrato.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "confirmed",
      nowIso: NOW,
    },
    ALL_ON
  );

  graph.upsertNode(
    {
      id: "ai-focus-pref",
      kind: "preference",
      label: "Concentrazione con ambiente silenzioso",
      summary: "Preferenza personale per stanze tranquille nel pomeriggio.",
      consentScope: "ai_memory",
      provenance: {
        sourceEngine: "AuraMemoryStore",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "confirmed",
      nowIso: NOW,
    },
    ALL_ON
  );

  graph.upsertNode(
    {
      id: "learn-focus-pat",
      kind: "experience_pattern",
      label: "Concentrazione migliore dopo pausa breve",
      summary: "Pattern appreso sul rendimento dopo pause di 5 minuti.",
      consentScope: "learning",
      provenance: {
        sourceEngine: "ExperienceAnalyzer",
        evidenceType: "observed_behavior",
        epistemicTag: "interpretazione_prudente",
      },
      reliability: 0.78,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_ON
  );

  graph.upsertNode(
    {
      id: "eph-focus-now",
      kind: "session_signal",
      label: "Segnale concentrazione sessione",
      summary: "Segnale effimero solo in RAM.",
      consentScope: "session_ephemeral",
      provenance: {
        sourceEngine: "SessionTracker",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.8,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_ON
  );

  // Collegamento precedentemente creato operational -> ai_memory e operational -> learning
  graph.upsertEdge(
    {
      sourceNodeId: "op-focus",
      targetNodeId: "ai-focus-pref",
      sourceScope: "operational",
      targetScope: "ai_memory",
      relationType: "supports",
      direction: "directed",
      provenance: {
        createdByEngine: "ExperienceGraphEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
        supportingEvidenceIds: ["ev-ai"],
        supportingNote: "Collegamento con preferenza AI memory.",
      },
      weight: 0.88,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_ON
  );

  graph.upsertEdge(
    {
      sourceNodeId: "op-focus",
      targetNodeId: "learn-focus-pat",
      sourceScope: "operational",
      targetScope: "learning",
      relationType: "derived_from",
      direction: "directed",
      provenance: {
        createdByEngine: "ExperienceGraphEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "interpretazione_prudente",
        supportingEvidenceIds: ["ev-learn"],
        supportingNote: "Collegamento con pattern di apprendimento.",
      },
      weight: 0.82,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_ON
  );

  // Solo learning ON, ai_memory OFF -> ai-focus-pref bloccato e zero archi ai_memory esposti
  const onlyLearning = retrieval.retrieve({
    query: "concentrazione",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    nowIso: NOW,
  });
  assert.equal(onlyLearning.allowed, true);
  assert.ok(onlyLearning.excludedScopes.includes("ai_memory"));
  assert.equal(
    onlyLearning.items.some((i) => i.node.id === "ai-focus-pref"),
    false
  );
  assert.equal(
    onlyLearning.items.some((i) => i.node.id === "learn-focus-pat"),
    true
  );

  // Solo ai_memory ON, learning OFF -> learn-focus-pat bloccato
  const onlyAiMem = retrieval.retrieve({
    query: "concentrazione",
    consentState: { learningConsent: false, aiMemoryConsent: true },
    nowIso: NOW,
  });
  assert.equal(onlyAiMem.allowed, true);
  assert.ok(onlyAiMem.excludedScopes.includes("learning"));
  assert.equal(
    onlyAiMem.items.some((i) => i.node.id === "learn-focus-pat"),
    false
  );
  assert.equal(
    onlyAiMem.items.some((i) => i.node.id === "ai-focus-pref"),
    true
  );

  // Revoca completa (entrambi OFF): nemmeno partendo dal seed op-focus emergono nodi o archi revocati
  const afterRevocation = retrieval.retrieveByNode({
    nodeId: "op-focus",
    consentState: {
      learningConsent: false,
      aiMemoryConsent: false,
      revokedAt: NOW,
    },
    nowIso: NOW,
  });
  assert.deepEqual(
    afterRevocation.items.map((i) => i.node.id),
    ["op-focus"]
  );
  assert.equal(afterRevocation.edges.length, 0);
  assert.ok(afterRevocation.excludedScopes.includes("ai_memory"));
  assert.ok(afterRevocation.excludedScopes.includes("learning"));

  // Richiesta esclusiva su scope non autorizzato -> fail-closed
  const deniedAiOnly = retrieval.retrieve({
    query: "concentrazione",
    consentState: { learningConsent: true, aiMemoryConsent: false },
    allowedScopes: ["ai_memory"],
    nowIso: NOW,
  });
  assert.equal(deniedAiOnly.allowed, false);
  assert.equal(deniedAiOnly.failClosed, true);
  assert.equal(deniedAiOnly.nodes.length, 0);
});

test("11.2.3.5 Esclusione nodi revoked, expired, superseded e gestione conservativa nodi conflicted", () => {
  const storage = new MemoryStorageAdapter();
  const graph = new ExperienceGraphEngine(storage);
  const retrieval = new AssociativeRetrievalEngine(graph);

  graph.upsertNode(
    {
      id: "clean-1",
      kind: "goal",
      label: "Idratazione costante",
      summary: "Bere acqua regolarmente durante la giornata.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "confirmed",
      nowIso: NOW,
    },
    ALL_OFF
  );

  graph.upsertNode(
    {
      id: "conf-1",
      kind: "preference",
      label: "Idratazione con te caldo",
      summary: "Preferenza per bevande calde, in conflitto con altra nota.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "explicit_feedback",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "confirmed",
      nowIso: NOW,
    },
    ALL_OFF
  );
  graph.markNodeConflicted(
    {
      nodeId: "conf-1",
      scope: "operational",
      conflictingNodeIds: ["clean-1"],
      note: "Preferenza in fase di chiarimento.",
    },
    ALL_OFF,
    { nowIso: NOW }
  );

  graph.upsertNode(
    {
      id: "rev-1",
      kind: "goal",
      label: "Idratazione revocata",
      summary: "Voce non piu valida.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "revoked",
      nowIso: NOW,
    },
    ALL_OFF
  );

  graph.upsertNode(
    {
      id: "exp-1",
      kind: "goal",
      label: "Idratazione scaduta",
      summary: "Promemoria temporaneo ormai scaduto.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "observed",
      expiresAt: "2026-11-01T00:00:00.000Z",
      nowIso: NOW,
    },
    ALL_OFF
  );

  graph.upsertNode(
    {
      id: "old-1",
      kind: "preference",
      label: "Idratazione obsoleta vecchia",
      summary: "Vecchia abitudine sostituita.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "GrowthEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_OFF
  );
  graph.markNodeSuperseded(
    {
      nodeId: "old-1",
      scope: "operational",
      supersededByNodeId: "clean-1",
    },
    ALL_OFF,
    { nowIso: NOW }
  );

  const res = retrieval.retrieve({
    query: "idratazione",
    consentState: ALL_OFF,
    nowIso: NOW,
  });

  const ids = res.items.map((i) => i.node.id);
  assert.equal(ids.includes("rev-1"), false);
  assert.equal(ids.includes("exp-1"), false);
  assert.equal(ids.includes("old-1"), false);
  assert.deepEqual(ids, ["clean-1", "conf-1"]);

  const cleanItem = res.items.find((i) => i.node.id === "clean-1")!;
  const confItem = res.items.find((i) => i.node.id === "conf-1")!;
  assert.equal(confItem.epistemicCategory, "informazione_conflittuale");
  assert.ok(confItem.pathExplanation.toLowerCase().includes("conflitt"));
  assert.ok(cleanItem.scoreBreakdown.finalScore > confItem.scoreBreakdown.finalScore);
});

test("11.2.3.6 RetrieveRelatedExperiences, fail-closed su crisi/dati corrotti, READ-ONLY e zero rete", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("Network forbidden");
  }) as typeof fetch;

  try {
    const { storage, graph, retrieval } = setupRichGraph();
    const beforeOpRaw = storage.getItem(ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational);
    const beforeAuditLen = graph.getAuditLog().length;

    const expRes = retrieval.retrieveRelatedExperiences({
      query: "lettura libro",
      consentState: ALL_OFF,
      nowIso: NOW,
    });
    assert.equal(expRes.allowed, true);
    assert.ok(expRes.items.some((i) => i.node.id === "n1-plan"));
    assert.ok(expRes.items.some((i) => i.node.id === "n2-exp"));

    // Verifica READ-ONLY assoluta durante il recupero
    assert.equal(
      storage.getItem(ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational),
      beforeOpRaw
    );
    assert.equal(graph.getAuditLog().length, beforeAuditLen);

    // Fail-closed in caso di crisi (flag o testo)
    const crisisByFlag = retrieval.retrieve({
      query: "lettura",
      consentState: ALL_ON,
      crisisBlocked: true,
      nowIso: NOW,
    });
    assert.equal(crisisByFlag.allowed, false);
    assert.equal(crisisByFlag.safetyBlocked, true);
    assert.equal(crisisByFlag.failClosed, true);
    assert.equal(crisisByFlag.nodes.length, 0);

    const crisisByText = retrieval.retrieve({
      query: "Non ce la faccio piu voglio farla finita",
      consentState: ALL_ON,
      nowIso: NOW,
    });
    assert.equal(crisisByText.allowed, false);
    assert.equal(crisisByText.safetyBlocked, true);
    assert.equal(crisisByText.nodes.length, 0);

    // Segnale insufficiente
    const emptyQuery = retrieval.retrieve({
      query: "   ",
      consentState: ALL_OFF,
      nowIso: NOW,
    });
    assert.equal(emptyQuery.allowed, true);
    assert.equal(emptyQuery.insufficientSignal, true);
    assert.equal(emptyQuery.nodes.length, 0);

    // Protezione fail-closed su partizione corrotta
    storage.setItem(ASSOCIATIVE_GRAPH_STORAGE_KEYS.operational, "{CORRUPTED");
    const corruptRes = retrieval.retrieve({
      query: "lettura",
      consentState: ALL_ON,
      nowIso: NOW,
    });
    assert.equal(corruptRes.allowed, false);
    assert.equal(corruptRes.failClosed, true);
    assert.equal(corruptRes.blockedBy, "corrupted_data");
    assert.equal(corruptRes.nodes.length, 0);

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("11.2.3.7 validateRetrievalContext, rankResults diretto, session_ephemeral RAM e filtro relationTypes", () => {
  const storage = new MemoryStorageAdapter();
  const graph = new ExperienceGraphEngine(storage);
  const retrieval = new AssociativeRetrievalEngine(graph);

  // Nodi in session_ephemeral (RAM) e operational
  graph.upsertNode(
    {
      id: "eph-seed",
      kind: "session_signal",
      label: "Stato energetico sessione",
      summary: "Segnale di energia bassa in questa sessione.",
      consentScope: "session_ephemeral",
      provenance: {
        sourceEngine: "SessionTracker",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.85,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_OFF
  );
  graph.upsertNode(
    {
      id: "op-target",
      kind: "mission",
      label: "Micro-pausa 5 minuti",
      summary: "Breve pausa di recupero consigliata.",
      consentScope: "operational",
      provenance: {
        sourceEngine: "MissionsEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
      },
      reliability: 0.9,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_OFF
  );
  graph.upsertEdge(
    {
      sourceNodeId: "eph-seed",
      targetNodeId: "op-target",
      sourceScope: "session_ephemeral",
      targetScope: "operational",
      relationType: "supports",
      direction: "directed",
      provenance: {
        createdByEngine: "ExperienceGraphEngine",
        evidenceType: "observed_behavior",
        epistemicTag: "fatto_osservato",
        supportingEvidenceIds: ["s1"],
        supportingNote: "La micro-pausa aiuta quando l'energia e bassa.",
      },
      weight: 0.88,
      validationStatus: "observed",
      nowIso: NOW,
    },
    ALL_OFF
  );

  // validateRetrievalContext
  const validCtx = retrieval.validateRetrievalContext({
    query: "energia",
    consentState: ALL_OFF,
    maxHops: 10,
    nowIso: NOW,
  });
  assert.equal(validCtx.allowed, true);
  assert.equal(validCtx.effectiveMaxHops, 2);
  assert.ok(validCtx.excludedScopes.includes("ai_memory"));
  assert.ok(validCtx.excludedScopes.includes("learning"));

  const clinicalCtx = retrieval.validateRetrievalContext({
    query: "diagnosi di disturbo bipolare",
    consentState: ALL_ON,
    nowIso: NOW,
  });
  assert.equal(clinicalCtx.allowed, false);
  assert.equal(clinicalCtx.safetyBlocked, true);
  assert.equal(clinicalCtx.blockedBy, "clinical_or_pii_content");

  const malformedCtx = retrieval.validateRetrievalContext({
    query: "energia",
    consentState: null as unknown as LearningConsentState,
    nowIso: NOW,
  });
  assert.equal(malformedCtx.allowed, false);
  assert.equal(malformedCtx.failClosed, true);

  // Retrieval RAM-only partendo dal seed session_ephemeral + filtro relationTypes
  const ramRes = retrieval.retrieveByNode({
    nodeId: "eph-seed",
    consentState: ALL_OFF,
    relationTypes: ["supports"],
    nowIso: NOW,
  });
  assert.equal(ramRes.allowed, true);
  assert.deepEqual(
    ramRes.items.map((i) => i.node.id),
    ["eph-seed", "op-target"]
  );
  // Verifica che session_ephemeral non venga esportata nello storage persistente
  assert.equal(storage.keys().includes("session_ephemeral"), false);

  // rankResults diretto e deterministico
  const ranked = retrieval.rankResults(
    [
      {
        node: ramRes.items[1].node,
        seedNodeId: "eph-seed",
        hopDistance: 1,
        pathNodeIds: ["eph-seed", "op-target"],
        pathEdgeIds: [ramRes.edges[0].id],
        relations: ["supports"],
        pathEpistemicTag: "fatto_osservato",
        pathReliability: 0.85,
        directQueryMatchScore: 0.8,
      },
      {
        node: ramRes.items[0].node,
        seedNodeId: "eph-seed",
        hopDistance: 0,
        pathNodeIds: ["eph-seed"],
        pathEdgeIds: [],
        relations: [],
        pathEpistemicTag: "fatto_osservato",
        pathReliability: 0.85,
        directQueryMatchScore: 1,
      },
    ],
    { query: "energia sessione", nowIso: NOW }
  );
  assert.equal(ranked[0].node.id, "eph-seed");
  assert.ok(ranked[0].scoreBreakdown.finalScore >= ranked[1].scoreBreakdown.finalScore);
});

