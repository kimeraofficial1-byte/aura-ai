import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRISIS_EMERGENCY_REPLY,
  evaluatePreModelSafety,
  validateChatRequest,
} from "./safety";
import {
  buildAuraSystemInstruction,
  buildGeminiContents,
  mapGeminiError,
} from "./auraAgent";
import { runStructuredReasoning } from "../src/reasoning/reasoningEngine";

test("evaluatePreModelSafety detects crisis keywords and preserves emergency guidance", () => {
  const res1 = evaluatePreModelSafety("Non voglio più vivere, voglio farla finita");
  assert.equal(res1.crisisDetected, true);
  assert.equal(res1.reason, "self_harm_or_suicide_risk");
  assert.equal(res1.reply, CRISIS_EMERGENCY_REPLY);
  assert.match(res1.reply ?? "", /112/);

  const res2 = evaluatePreModelSafety("Penso all'autolesionismo ultimamente");
  assert.equal(res2.crisisDetected, true);
});

test("evaluatePreModelSafety allows normal emotional distress messages through to Gemini", () => {
  const res = evaluatePreModelSafety(
    "Oggi mi sento molto ansioso e stanco per il lavoro, come posso rilassarmi?"
  );
  assert.equal(res.crisisDetected, false);
  assert.equal(res.reply, undefined);
});

test("validateChatRequest enforces non-empty message and sanitizes history and context", () => {
  const invalid = validateChatRequest({ message: "   " });
  assert.equal(invalid.ok, false);

  const valid = validateChatRequest({
    message: "  Mi sento teso  ",
    history: [
      { role: "assistant", text: "Ciao!" },
      { role: "user", text: "Giornata difficile" },
      { role: "invalid" as unknown as "user", text: "ignored" },
    ],
    context: {
      mood: "Teso",
      stress: 14,
      completedMissions: 1,
      totalMissions: 3,
      memorySummary: "Ricorrente stress lavorativo serale.",
    },
  });

  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.data.message, "Mi sento teso");
    assert.equal(valid.data.history?.length, 2);
    assert.equal(valid.data.context?.stress, 10);
    assert.equal(valid.data.context?.mood, "Teso");
    assert.equal(
      valid.data.context?.memorySummary,
      "Ricorrente stress lavorativo serale."
    );
  }
});

test("buildGeminiContents starts with user turn, avoids duplicating last message, and alternates cleanly", () => {
  const contents = buildGeminiContents("Come faccio a calmarmi?", [
    { role: "assistant", text: "Buongiorno. Sono AURA." },
    { role: "user", text: "Ho molta ansia oggi" },
    { role: "assistant", text: "Ti ascolto, vuoi parlarne?" },
  ]);

  assert.equal(contents.length, 3);
  assert.equal(contents[0].role, "user");
  assert.equal(contents[0].parts?.[0]?.text, "Ho molta ansia oggi");
  assert.equal(contents[1].role, "model");
  assert.equal(contents[2].role, "user");
  assert.equal(contents[2].parts?.[0]?.text, "Come faccio a calmarmi?");

  const deduped = buildGeminiContents("Stesso messaggio", [
    { role: "user", text: "Stesso messaggio" },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].parts?.[0]?.text, "Stesso messaggio");
});

test("buildAuraSystemInstruction includes non-diagnostic guardrails and user context", () => {
  const instruction = buildAuraSystemInstruction({
    mood: "Teso",
    stress: 8,
    completedMissions: 1,
    totalMissions: 3,
    memorySummary: "Apprezza esercizi di respirazione.",
  });

  assert.match(instruction, /Non formulare mai diagnosi mediche/i);
  assert.match(instruction, /Umore dichiarato.*"Teso"/);
  assert.match(instruction, /8\/10/);
  assert.match(instruction, /Apprezza esercizi di respirazione/);
});

test("mapGeminiError maps auth, quota, model-not-found, and timeout errors cleanly", () => {
  const timeoutErr = new Error("Gemini request timed out");
  timeoutErr.name = "AuraTimeoutError";
  assert.equal(mapGeminiError(timeoutErr).code, "TIMEOUT");
  assert.equal(mapGeminiError(timeoutErr).status, 504);

  assert.equal(
    mapGeminiError(Object.assign(new Error("API_KEY_INVALID"), { status: 400 })).code,
    "INVALID_API_KEY"
  );
  assert.equal(
    mapGeminiError(Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 })).code,
    "RATE_LIMIT"
  );
  assert.equal(
    mapGeminiError(Object.assign(new Error("NOT_FOUND"), { status: 404 })).code,
    "MODEL_NOT_FOUND"
  );
});

test("server/auraAgent.ts forces fail-closed consentEnabled: false and never deduces consent from context summaries", () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const agentSource = readFileSync(path.join(currentDir, "auraAgent.ts"), "utf8");

  const reasoningCallMatch = agentSource.match(
    /runStructuredReasoning\(\{[\s\S]*?\}\);/
  );
  assert.ok(
    reasoningCallMatch,
    "Expected runStructuredReasoning call in server/auraAgent.ts"
  );
  assert.match(reasoningCallMatch[0], /\bconsentEnabled:\s*false\b/);
  assert.doesNotMatch(
    reasoningCallMatch[0],
    /Boolean\(context\?\.memorySummary|context\?\.orchestratedContextSummary/
  );

  const reasoning = runStructuredReasoning({
    message: "Mi sento sopraffatto dal lavoro oggi",
    context: {
      mood: "Teso",
      stress: 8,
      memorySummary: "Ricordo testuale presente nel payload.",
      orchestratedContextSummary: "CONTESTO ORCHESTRATO PRESENTE NEL PAYLOAD.",
    },
    consentEnabled: false,
  });

  assert.ok(
    reasoning.facts.includes(
      "Memoria persistente disattivata: utilizzo solo il contesto della sessione corrente."
    )
  );
  assert.ok(
    !reasoning.facts.includes(
      "Contesto personale autorizzato disponibile tramite Context Engine V2."
    )
  );
});

test("buildAuraSystemInstruction continues forwarding conversational context and reasoning guidance without payload consent deduction", () => {
  const orchestratedText =
    "CONTESTO PERSONALE AUTORIZZATO (test 11.2.4): preferisce pause brevi di respirazione.";
  const withOrchestrated = buildAuraSystemInstruction(
    {
      mood: "Affaticato",
      stress: 7,
      memorySummary: "Fallback summary non prioritario",
      orchestratedContextSummary: orchestratedText,
    },
    "Aiutami a fare una pausa breve di 5 minuti",
    [{ role: "user", text: "Ciao AURA" }]
  );

  assert.match(withOrchestrated, /CONTESTO PERSONALE AUTORIZZATO \(test 11\.2\.4\)/);
  assert.match(withOrchestrated, /GUIDA DI RAGIONAMENTO STRUTTURATO/);

  const withMemoryOnly = buildAuraSystemInstruction(
    {
      mood: "Calmo",
      stress: 3,
      memorySummary: "Preferisce camminate pomeridiane.",
    },
    "Come posso organizzare la serata?"
  );

  assert.match(withMemoryOnly, /MEMORIA VERIFICATA/);
  assert.match(withMemoryOnly, /Preferisce camminate pomeridiane/);
  assert.match(withMemoryOnly, /GUIDA DI RAGIONAMENTO STRUTTURATO/);

  const req = validateChatRequest({
    message: "Ciao AURA",
    context: {
      mood: "Sereno",
      stress: 2,
      orchestratedContextSummary: orchestratedText,
    },
  });
  assert.equal(req.ok, true);
  if (req.ok) {
    assert.equal(req.data.context?.orchestratedContextSummary, orchestratedText);
    assert.equal("consentEnabled" in (req.data.context ?? {}), false);
  }
});

