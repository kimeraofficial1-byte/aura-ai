import assert from "node:assert/strict";
import test from "node:test";
import { buildAuraSystemInstruction } from "../../server/auraAgent";
import type { ChatHistoryItem } from "../types/aura";
import { ProgressiveSpeechBuffer } from "../voice/progressiveSpeechBuffer";
import type {
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
} from "../voice/types";
import { AuraVoiceEngine } from "../voice/voiceEngine";
import {
  analyzeConversationState,
  buildNaturalPersonalityInstruction,
  detectConversationMode,
  detectResponseDepth,
  detectTopicShift,
  extractRecentAssistantOpeners,
} from "./conversationEngine";

class MockUtterance implements SpeechSynthesisUtteranceLike {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  constructor(text = "") {
    this.text = text;
  }
}

test("1. Avoids repetitive openings by extracting recent assistant openers", () => {
  const history: ChatHistoryItem[] = [
    { role: "user", text: "Oggi sono molto stanco." },
    { role: "assistant", text: "Capisco perfettamente come ti senti. Vuoi parlarne?" },
    { role: "user", text: "Ho lavorato troppo." },
    { role: "assistant", text: "Certo, lavorare tante ore pesa molto." },
  ];

  const openers = extractRecentAssistantOpeners(history, 3);
  assert.ok(openers.includes("Certo"));
  assert.ok(openers.includes("Capisco perfettamente come ti senti"));

  const prompt = buildNaturalPersonalityInstruction({
    message: "Sì, vorrei staccare un po'.",
    history,
  });
  assert.match(prompt, /Evita di iniziare la risposta ripetendo queste aperture recenti/i);
  assert.match(prompt, /Capisco perfettamente/);
});

test("2. Maintains consistent, non-human, non-manipulative personality across turns", () => {
  const turns = [
    "Ciao AURA, come va?",
    "Mi sento un po' sotto pressione oggi.",
    "Aiutami a organizzare il pomeriggio.",
    "Spiegami come strutturare l'architettura del mio progetto.",
  ];

  for (const msg of turns) {
    const prompt = buildNaturalPersonalityInstruction({ message: msg });
    assert.match(prompt, /Non fingere mai di essere umana/i);
    assert.match(prompt, /non creare dipendenza emotiva/i);
    assert.match(prompt, /italiano naturale/i);
  }
});

test("3. Adapts response length between concise and in-depth based on user request", () => {
  assert.equal(detectResponseDepth("Rispondimi in breve, grazie", "informal"), "concise");
  assert.equal(
    detectResponseDepth("Spiegami nel dettaglio come funziona il respiro lento", "practical_request"),
    "in_depth"
  );

  const concisePrompt = buildNaturalPersonalityInstruction({
    message: "Dammi un consiglio veloce in breve",
  });
  assert.match(concisePrompt, /concisa e diretta/i);

  const deepPrompt = buildNaturalPersonalityInstruction({
    message: "Spiegami passo passo come pianificare il mio progetto",
  });
  assert.match(deepPrompt, /chiara e approfondita/i);
});

test("4. Preserves conversation continuity when prior context is available", () => {
  const history: ChatHistoryItem[] = [
    { role: "user", text: "Sto preparando una presentazione per lavoro." },
    { role: "assistant", text: "Su quale parte ti stai concentrando adesso?" },
  ];

  const analysis = analyzeConversationState({
    message: "Sulla presentazione iniziale, vorrei renderla più chiara.",
    history,
  });
  assert.equal(analysis.hasPriorContext, true);
  assert.equal(analysis.topicShiftDetected, false);

  const prompt = buildNaturalPersonalityInstruction({
    message: "Sulla presentazione iniziale, vorrei renderla più chiara.",
    history,
  });
  assert.match(prompt, /mantieni il filo con i messaggi precedenti/i);
});

test("5. Detects explicit and implicit topic shifts cleanly", () => {
  const history: ChatHistoryItem[] = [
    { role: "user", text: "Oggi ho dormito poco e mi sento affaticato." },
    { role: "assistant", text: "La mancanza di riposo si fa sentire." },
  ];

  assert.equal(
    detectTopicShift("Cambiamo argomento, vorrei organizzare la spesa settimanale.", history),
    true
  );
  assert.equal(
    detectTopicShift("Vorrei progettare un database scalabile per la mia app.", history),
    true
  );

  const prompt = buildNaturalPersonalityInstruction({
    message: "Cambiamo argomento, parliamo del mio progetto.",
    history,
  });
  assert.match(prompt, /cambiato argomento/i);
});

test("6. Handles uncertainty without rushed conclusions and asks clarification when context is missing", () => {
  assert.equal(
    detectConversationMode("Non so bene cosa scegliere, ho dubbi."),
    "uncertain"
  );

  const uncertainPrompt = buildNaturalPersonalityInstruction({
    message: "Non so se cambiare lavoro, sono indeciso.",
  });
  assert.match(uncertainPrompt, /evita conclusioni affrettate/i);

  const vagueAnalysis = analyzeConversationState({
    message: "Cosa ne pensi?",
    history: [],
  });
  assert.equal(vagueAnalysis.needsClarification, true);
});

test("7. Integrates single-source text+voice personality into buildAuraSystemInstruction without duplication", () => {
  const instruction = buildAuraSystemInstruction(
    { mood: "Sereno", stress: 3 },
    "Ciao AURA, raccontami un esercizio semplice.",
    []
  );

  assert.match(instruction, /PERSONALITÀ CONVERSAZIONALE DI AURA \(TESTO E VOCE COERENTI\)/);
  assert.match(instruction, /sintesi vocale progressiva/i);
  assert.match(instruction, /CONFINI CLINICI RIGOROSI/);
  // Ensure no duplicate personality section
  const occurrences = instruction.split("PERSONALITÀ CONVERSAZIONALE DI AURA").length - 1;
  assert.equal(occurrences, 1);
});

test("8. Natural AURA response is fully compatible with ProgressiveSpeechBuffer", () => {
  const buffer = new ProgressiveSpeechBuffer();
  const naturalReply =
    "Quando la giornata sembra troppo piena, fermarsi anche solo due minuti può fare differenza. Se vuoi, possiamo provare insieme tre respiri lenti, senza alcuna fretta.";

  const ready = buffer.pushAccumulated(naturalReply.slice(0, 92));
  assert.equal(ready.length, 1);
  const rest = buffer.flushFinal(naturalReply);
  assert.equal([...ready, ...rest].join(" "), naturalReply);
});

test("9. Natural AURA progressive playback remains compatible with immediate voice interruption", () => {
  let cancelCount = 0;
  const spoken: MockUtterance[] = [];
  const mockSynth: SpeechSynthesisLike = {
    getVoices: () => [{ name: "Google italiano", lang: "it-IT", default: true }],
    speak: (u) => {
      spoken.push(u as MockUtterance);
      u.onstart?.();
    },
    cancel: () => {
      cancelCount += 1;
    },
    pause: () => {},
    resume: () => {},
  };

  const engine = new AuraVoiceEngine({
    synthesis: mockSynth,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  engine.startProgressiveResponse();
  engine.pushProgressiveAccumulatedText(
    "Prendiamoci un momento per fare chiarezza insieme. Dimmi pure da quale aspetto preferisci iniziare oggi. "
  );
  assert.equal(spoken.length, 1);
  assert.equal(engine.getPendingSpeechQueueLength(), 1);

  const snap = engine.interruptAura();
  assert.equal(snap.state, "INTERRUPTED");
  assert.ok(cancelCount >= 1);
  assert.equal(engine.getPendingSpeechQueueLength(), 0);
});
