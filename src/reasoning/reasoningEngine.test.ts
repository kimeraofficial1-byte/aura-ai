import assert from "node:assert/strict";
import test from "node:test";
import { buildAuraSystemInstruction } from "../../server/auraAgent";
import { executeServerReasoning } from "../../server/reasoningEngine";
import {
  buildReasoningGuidanceForGemini,
  runStructuredReasoning,
} from "./reasoningEngine";
import { REASONING_PHASES } from "./types";

test("1. Simple request completes all 8 phases and selects direct concise strategy without exposing private CoT", () => {
  const res = runStructuredReasoning({
    message: "Ciao AURA, come stai oggi?",
    consentEnabled: false,
  });

  assert.equal(res.safetyBlocked, false);
  assert.deepEqual(res.completedPhases, [...REASONING_PHASES]);
  assert.equal(res.complexity, "simple");
  assert.equal(res.selectedStrategy?.id, "direct_concise");
  assert.equal(res.validation.exposesPrivateChainOfThought, false);
  assert.equal(res.validation.distinguishesSuggestionsFromActions, true);
});

test("2. Complex problem selects structured step-by-step strategy", () => {
  const res = runStructuredReasoning({
    message:
      "Voglio organizzare il mio progetto di studio nelle prossime 3 settimane, bilanciare il lavoro quotidiano e inoltre mantenere 20 minuti di pausa ogni sera.",
    consentEnabled: false,
  });

  assert.equal(res.complexity, "complex");
  assert.equal(res.selectedStrategy?.id, "structured_step_by_step");
  assert.ok(res.actionableSteps.length >= 1);
});

test("3. Goal decomposition splits multi-part request into clear sub-problems", () => {
  const res = runStructuredReasoning({
    message:
      "Vorrei dormire meglio la sera. Inoltre devo ridurre lo stress al lavoro e poi trovare tempo per camminare.",
    consentEnabled: false,
  });

  assert.ok(res.subProblems.length >= 3);
  assert.ok(res.subProblems.some((s) => /dormire/i.test(s)));
  assert.ok(res.subProblems.some((s) => /stress/i.test(s)));
});

test("4. Missing information triggers needsClarification and targeted question", () => {
  const res = runStructuredReasoning({
    message: "Aiutami a decidere tra due offerte di lavoro.",
    history: [],
    consentEnabled: false,
  });

  assert.equal(res.needsClarification, true);
  assert.ok(res.missingInformation.length >= 1);
  assert.ok(res.clarificationQuestions.length >= 1);
});

test("5. Detects contradictions in user request cleanly", () => {
  const res = runStructuredReasoning({
    message: "Voglio fare tutto subito oggi ma ho solo 5 minuti e sono esausto.",
    consentEnabled: false,
  });

  assert.ok(res.validation.contradictionsDetected.length >= 1);
  const guidance = buildReasoningGuidanceForGemini(res);
  assert.match(guidance, /tensione\/contraddizione/i);
});

test("6. Explicitly tracks uncertainty from ambiguous text and low-confidence emotion", () => {
  const res = runStructuredReasoning({
    message: "Non so bene cosa fare, forse dovrei cambiare approccio ma ho dubbi.",
    consentEnabled: false,
    context: {
      emotionalAnalysis: {
        primaryEmotion: "Incerto",
        secondaryEmotions: [],
        intensity: 3,
        confidence: 0.4,
        uncertain: true,
        evidence: ["non so"],
        stressSignals: [],
        empathyStrategy: {
          tone: "aperto",
          activeListeningFocus: "ascolto",
          questionStyle: "delicata",
          pacing: "gentle-warm",
          suggestedExercise: null,
        },
        analyzedAt: "2026-11-17T12:00:00.000Z",
        source: "heuristic",
      },
    },
  });

  assert.ok(res.uncertainties.length >= 2);
});

test("7. Server Reasoning Engine falls back to local deterministic plan on Gemini generation error", async () => {
  const out = await executeServerReasoning({
    message:
      "Voglio pianificare una strategia settimanale per organizzare lavoro, studio e riposo in modo sostenibile.",
    useGemini: true,
    consentEnabled: false,
    geminiCaller: async () => {
      throw new Error("Simulated Gemini 503 error");
    },
  });

  assert.equal(out.usedFallback, true);
  assert.equal(out.fallbackReason, "gemini_error");
  assert.equal(out.result.source, "local-deterministic");
  assert.ok(out.guidanceForGemini.length > 0);
});

test("8. Server Reasoning Engine falls back cleanly on timeout", async () => {
  const out = await executeServerReasoning({
    message:
      "Aiutami a strutturare un piano complesso per bilanciare lavoro, salute e progetti personali.",
    useGemini: true,
    timeoutMs: 30,
    consentEnabled: false,
    geminiCaller: (_prompt, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });

  assert.equal(out.usedFallback, true);
  assert.equal(out.fallbackReason, "timeout");
  assert.equal(out.result.source, "local-deterministic");
});

test("9. Respects memory consent and blocks clinical diagnosis / autonomous external actions", () => {
  const offRes = runStructuredReasoning({
    message: "Diagnosticami che malattia ho e invia un'email al mio capo.",
    consentEnabled: false,
  });

  assert.ok(offRes.facts.some((f) => /Memoria persistente disattivata/i.test(f)));
  assert.equal(offRes.validation.diagnosticRiskBlocked, true);
  assert.equal(offRes.validation.externalActionBlocked, true);

  const guidance = buildReasoningGuidanceForGemini(offRes);
  assert.match(guidance, /BLOCCO NON CLINICO/);
  assert.match(guidance, /BLOCCO AZIONI ESTERNE/);
});

test("10. Safety Engine has absolute priority and buildAuraSystemInstruction integrates V3 reasoning cleanly", async () => {
  const blocked = await executeServerReasoning({
    message: "Voglio farla finita, non ce la faccio più.",
    useGemini: true,
    consentEnabled: true,
  });

  assert.equal(blocked.result.safetyBlocked, true);
  assert.equal(blocked.fallbackReason, "safety_blocked");
  assert.equal(blocked.guidanceForGemini, "");

  const systemPrompt = buildAuraSystemInstruction(
    { mood: "Sereno", stress: 3 },
    "Aiutami a organizzare il mio progetto di studio e inoltre trovare tempo per camminare.",
    []
  );
  assert.match(systemPrompt, /GUIDA DI RAGIONAMENTO STRUTTURATO \(V3/);
  assert.match(systemPrompt, /PERSONALITÀ CONVERSAZIONALE DI AURA/);
  assert.match(systemPrompt, /CONFINI CLINICI RIGOROSI/);
});
