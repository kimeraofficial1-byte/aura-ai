import assert from "node:assert/strict";
import test from "node:test";
import { ProgressiveSpeechBuffer } from "./progressiveSpeechBuffer";
import type {
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
  SpeechSynthesisVoiceLike,
  VoiceErrorInfo,
} from "./types";
import { AuraVoiceEngine } from "./voiceEngine";

class MockUtterance implements SpeechSynthesisUtteranceLike {
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoiceLike | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;

  constructor(text = "") {
    this.text = text;
  }
}

function createQueueMockSynthesis(options?: {
  autoComplete?: boolean;
  initialVoices?: SpeechSynthesisVoiceLike[];
  failFirstUtterance?: boolean;
}) {
  const spoken: MockUtterance[] = [];
  let cancelCount = 0;
  let voices: SpeechSynthesisVoiceLike[] = options?.initialVoices ?? [
    { name: "Google italiano", lang: "it-IT", default: true },
  ];
  let voicesChangedCb: (() => void) | null = null;
  let failedOnce = false;

  const synthesis: SpeechSynthesisLike = {
    getVoices: () => voices,
    speak: (u) => {
      const utt = u as MockUtterance;
      spoken.push(utt);
      utt.onstart?.();
      if (options?.failFirstUtterance && !failedOnce) {
        failedOnce = true;
        utt.onerror?.({ error: "synthesis-failed" });
        return;
      }
      if (options?.autoComplete) {
        utt.onend?.();
      }
    },
    cancel: () => {
      cancelCount += 1;
    },
    pause: () => {},
    resume: () => {},
    addEventListener: (type, listener) => {
      if (type === "voiceschanged") voicesChangedCb = listener;
    },
    removeEventListener: () => {},
  };

  return {
    synthesis,
    spoken,
    getCancelCount: () => cancelCount,
    setVoices: (next: SpeechSynthesisVoiceLike[]) => {
      voices = next;
      voicesChangedCb?.();
    },
  };
}

test("1. Multi-chunk SSE reception emits first complete sentence before stream finishes", () => {
  const buffer = new ProgressiveSpeechBuffer();

  const c1 = buffer.pushAccumulated("Ciao, ti ascolto con ");
  assert.deepEqual(c1, []);

  const c2 = buffer.pushAccumulated("Ciao, ti ascolto con molta attenzione. ");
  assert.deepEqual(c2, ["Ciao, ti ascolto con molta attenzione."]);

  const c3 = buffer.pushAccumulated(
    "Ciao, ti ascolto con molta attenzione. Come ti senti in questo momento? "
  );
  assert.deepEqual(c3, ["Come ti senti in questo momento?"]);

  const final = buffer.flushFinal(
    "Ciao, ti ascolto con molta attenzione. Come ti senti in questo momento? Prenditi il tuo tempo!"
  );
  assert.deepEqual(final, ["Prenditi il tuo tempo!"]);
});

test("2. Respects minimum buffer size to avoid fragmented short utterances", () => {
  const buffer = new ProgressiveSpeechBuffer({ minSentenceChars: 24 });

  const c1 = buffer.pushChunk("Ok. ");
  assert.deepEqual(c1, []); // Too short on its own

  const c2 = buffer.pushChunk("Respiriamo insieme con calma per un momento. ");
  assert.deepEqual(c2, ["Ok. Respiriamo insieme con calma per un momento."]);
});

test("3. Splits long sentences naturally on commas and keeps Android-safe chunk lengths", () => {
  const buffer = new ProgressiveSpeechBuffer({
    minSentenceChars: 24,
    commaSplitThresholdChars: 90,
    maxChunkChars: 140,
  });

  const longText =
    "Quando la giornata diventa pesante e i pensieri si accumulano velocemente, puoi fermarti un minuto, appoggiare bene i piedi a terra, e fare tre respiri lenti.";

  const ready = buffer.pushAccumulated(longText);
  const rest = buffer.flushFinal(longText);
  const all = [...ready, ...rest];

  assert.ok(all.length >= 2);
  for (const seg of all) {
    assert.ok(seg.length <= 140, `Segment exceeded Android safe length: ${seg.length}`);
  }
  assert.equal(all.join(" "), longText);
});

test("4. Zero duplication and zero text loss across repeated accumulated SSE updates", () => {
  const buffer = new ProgressiveSpeechBuffer();
  const full =
    "Capisco che oggi sia stata una giornata impegnativa. Non devi risolvere tutto subito! Vuoi provare una breve pausa di respiro insieme?";

  const steps = [
    full.slice(0, 15),
    full.slice(0, 15), // duplicate SSE update
    full.slice(0, 52),
    full.slice(0, 88),
    full.slice(0, 88), // duplicate SSE update
    full,
  ];

  const collected: string[] = [];
  for (const step of steps) {
    collected.push(...buffer.pushAccumulated(step));
  }
  collected.push(...buffer.flushFinal(full));

  assert.equal(collected.join(" "), full);
});

test("5. AuraVoiceEngine speaks progressively during SSE and queues ordered chunks without overlap", () => {
  const mock = createQueueMockSynthesis({ autoComplete: false });
  const engine = new AuraVoiceEngine({
    synthesis: mock.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  assert.equal(engine.startProgressiveResponse(), true);

  engine.pushProgressiveAccumulatedText(
    "Prima frase completa pronta subito. Seconda frase in coda per dopo. "
  );

  // First utterance started immediately, second is queued
  assert.equal(mock.spoken.length, 1);
  assert.equal(mock.spoken[0].text, "Prima frase completa pronta subito.");
  assert.equal(engine.getPendingSpeechQueueLength(), 1);
  assert.equal(engine.getTurnTakingSnapshot().state, "AURA_SPEAKING");

  // Complete first utterance -> second starts automatically
  mock.spoken[0].onend?.();
  assert.equal(mock.spoken.length, 2);
  assert.equal(mock.spoken[1].text, "Seconda frase in coda per dopo.");

  // Finish stream with last fragment
  engine.finishProgressiveResponse(
    "Prima frase completa pronta subito. Seconda frase in coda per dopo. Terzo frammento finale"
  );
  mock.spoken[1].onend?.();
  assert.equal(mock.spoken.length, 3);
  assert.equal(mock.spoken[2].text, "Terzo frammento finale");

  mock.spoken[2].onend?.();
  assert.equal(engine.getTurnTakingSnapshot().state, "IDLE");
});

test("6. Interruption during progressive TTS immediately stops speech and empties pending queue", () => {
  const mock = createQueueMockSynthesis({ autoComplete: false });
  const engine = new AuraVoiceEngine({
    synthesis: mock.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  engine.startProgressiveResponse();
  engine.pushProgressiveAccumulatedText(
    "Prima frase che AURA sta leggendo. Seconda frase ancora in coda. Terza frase abbastanza lunga da entrare in coda. "
  );

  assert.equal(mock.spoken.length, 1);
  assert.equal(engine.getPendingSpeechQueueLength(), 2);

  const snap = engine.interruptAura();
  assert.equal(snap.state, "INTERRUPTED");
  assert.ok(mock.getCancelCount() >= 1);
  assert.equal(engine.getPendingSpeechQueueLength(), 0);

  // Subsequent late SSE chunks after interruption must NOT re-trigger TTS
  const afterInterrupt = engine.pushProgressiveAccumulatedText(
    "Prima frase che AURA sta leggendo. Seconda frase ancora in coda. Terza frase in coda. Quarta frase tardiva. "
  );
  assert.deepEqual(afterInterrupt, []);
  assert.equal(mock.spoken.length, 1);
});

test("7. TTS error during progressive playback reports error and falls back to full-text reading at stream end", () => {
  const mock = createQueueMockSynthesis({
    autoComplete: true,
    failFirstUtterance: true,
  });
  const errors: VoiceErrorInfo[] = [];
  const engine = new AuraVoiceEngine({
    synthesis: mock.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  engine.startProgressiveResponse({
    onError: (e) => errors.push(e),
  });

  const fullText = "Prima frase che fallisce sul dispositivo. Seconda frase completa.";
  engine.pushProgressiveAccumulatedText("Prima frase che fallisce sul dispositivo. ");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "SYNTHESIS_ERROR");

  // Stream finishes -> fallback reads the complete response cleanly
  const fallbackStarted = engine.finishProgressiveResponse(fullText);
  assert.equal(fallbackStarted, true);
  assert.ok(mock.spoken.length >= 2);
});

test("8. Handles late-loaded Android voices via voiceschanged and non-SSE full-text fallback", () => {
  const mock = createQueueMockSynthesis({
    autoComplete: true,
    initialVoices: [],
  });
  const engine = new AuraVoiceEngine({
    synthesis: mock.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  // Simulate Android Chrome loading Italian voice asynchronously
  mock.setVoices([{ name: "Google italiano", lang: "it-IT", default: true }]);

  engine.startProgressiveResponse();
  // Simulate non-SSE response where no chunks arrived before finishProgressiveResponse
  const spoke = engine.finishProgressiveResponse("Risposta completa ricevuta senza chunk intermedi.");
  assert.equal(spoke, true);
  assert.equal(mock.spoken.length, 1);
  assert.equal(mock.spoken[0].voice?.name, "Google italiano");
});
