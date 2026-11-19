import assert from "node:assert/strict";
import test from "node:test";
import { HandsFreeSessionManager } from "./handsFreeSession";
import type {
  SpeechRecognitionLike,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
} from "./types";
import { AuraVoiceEngine } from "./voiceEngine";

class MockSpeechRecognition implements SpeechRecognitionLike {
  static lastInstance: MockSpeechRecognition | null = null;
  static startCount = 0;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string; message?: string }) => void) | null = null;
  onresult: ((event: {
    resultIndex?: number;
    results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
  }) => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    MockSpeechRecognition.lastInstance = this;
  }

  start(): void {
    MockSpeechRecognition.startCount += 1;
    this.started = true;
    this.stopped = false;
    this.onstart?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopped = true;
    this.onend?.();
  }

  abort(): void {
    this.started = false;
    this.stopped = true;
  }
}

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

function createMockSynthesis() {
  const spoken: MockUtterance[] = [];
  let cancelCount = 0;
  const synthesis: SpeechSynthesisLike = {
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
  return { synthesis, spoken, getCancelCount: () => cancelCount };
}

test("1. Hands-free starts DISABLED with mic OFF by default", () => {
  MockSpeechRecognition.startCount = 0;
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);
  const snap = manager.getHandsFreeSnapshot();

  assert.equal(snap.state, "DISABLED");
  assert.equal(snap.enabled, false);
  assert.equal(snap.micActive, false);
  assert.equal(MockSpeechRecognition.startCount, 0);
});

test("2. Explicit activation + authorized listening start enters LISTENING with micActive true", () => {
  MockSpeechRecognition.startCount = 0;
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  const readySnap = manager.enableHandsFree();
  assert.equal(readySnap.state, "READY");
  assert.equal(readySnap.enabled, true);

  const started = manager.startHandsFreeSession();
  assert.equal(started, true);
  assert.equal(manager.getHandsFreeSnapshot().state, "LISTENING");
  assert.equal(manager.getHandsFreeSnapshot().micActive, true);
  assert.equal(MockSpeechRecognition.startCount, 1);
});

test("3. End-of-turn submits exactly ONE request per turn even on repeated recognition events", () => {
  const submitted: string[] = [];
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine, {
    onSubmitTurn: (text) => submitted.push(text),
  });

  manager.enableHandsFree();
  manager.startHandsFreeSession();
  const turnId = manager.getHandsFreeSnapshot().activeTurnId;

  const first = manager.handleUserTurn("Ciao AURA, come stai?", turnId);
  const duplicate = manager.handleUserTurn("Ciao AURA, come stai?", turnId);

  assert.equal(first, true);
  assert.equal(duplicate, false);
  assert.deepEqual(submitted, ["Ciao AURA, come stai?"]);
  assert.equal(manager.getHandsFreeSnapshot().state, "PROCESSING");
});

test("4. Progressive voice response followed by resumeListeningAfterResponse restarts mic only when enabled", () => {
  const mockSynth = createMockSynthesis();
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  manager.startHandsFreeSession();
  manager.handleUserTurn("Raccontami qualcosa di rilassante.");

  engine.startProgressiveResponse();
  engine.pushProgressiveAccumulatedText(
    "Prendiamoci un momento tranquillo insieme per rallentare il ritmo. "
  );
  manager.syncFromTurnTaking(engine.getTurnTakingSnapshot());
  assert.equal(manager.getHandsFreeSnapshot().state, "AURA_SPEAKING");

  mockSynth.spoken[0].onend?.();
  const resumed = manager.resumeListeningAfterResponse();
  assert.equal(resumed, true);
  assert.equal(manager.getHandsFreeSnapshot().state, "LISTENING");
  assert.equal(manager.getHandsFreeSnapshot().micActive, true);
});

test("5. Interruption during AURA_SPEAKING stops TTS, clears queue, and supports immediate STOP", () => {
  const mockSynth = createMockSynthesis();
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  engine.startProgressiveResponse();
  engine.pushProgressiveAccumulatedText(
    "Prima frase in riproduzione vocale. Seconda frase ancora in coda da leggere. "
  );
  assert.equal(engine.getPendingSpeechQueueLength(), 1);

  const stoppedSnap = manager.stopHandsFreeSession();
  assert.equal(stoppedSnap.state, "INTERRUPTED");
  assert.equal(stoppedSnap.enabled, false);
  assert.equal(stoppedSnap.micActive, false);
  assert.ok(mockSynth.getCancelCount() >= 1);
  assert.equal(engine.getPendingSpeechQueueLength(), 0);
  assert.equal(manager.resumeListeningAfterResponse(), false);
});

test("6. Immediate disableHandsFree() stops mic and TTS and prevents further auto-resume", () => {
  const mockSynth = createMockSynthesis();
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  manager.startHandsFreeSession();
  const snap = manager.disableHandsFree();

  assert.equal(snap.state, "DISABLED");
  assert.equal(snap.enabled, false);
  assert.equal(snap.micActive, false);
  assert.equal(manager.resumeListeningAfterResponse(), false);
});

test("7. Permission denied and mid-session permission revocation immediately stop hands-free", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  manager.startHandsFreeSession();
  MockSpeechRecognition.lastInstance!.onerror?.({ error: "not-allowed" });

  const snap = manager.getHandsFreeSnapshot();
  assert.equal(snap.state, "ERROR");
  assert.equal(snap.enabled, false);
  assert.equal(snap.lastError?.code, "PERMISSION_DENIED");
  assert.equal(manager.resumeListeningAfterResponse(), false);
});

test("8. Unsupported browser fails gracefully with Android keyboard hint without throwing", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: null,
    synthesis: null,
    UtteranceCtor: null,
  });
  const manager = new HandsFreeSessionManager(engine);

  const snap = manager.enableHandsFree();
  assert.equal(snap.state, "ERROR");
  assert.equal(snap.enabled, false);
  assert.equal(snap.lastError?.code, "UNSUPPORTED");
  assert.match(snap.lastNotice ?? "", /tastiera Android/i);
});

test("9. SSE/network errors and consecutive errors prevent infinite restart loops", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  manager.handleHandsFreeError({
    code: "NETWORK",
    message: "Errore SSE temporaneo.",
  });
  assert.equal(manager.getHandsFreeSnapshot().state, "ERROR");

  // Second consecutive error disables hands-free to prevent infinite restarts
  manager.handleHandsFreeError({
    code: "NETWORK",
    message: "Secondo errore consecutivo.",
  });
  assert.equal(manager.getHandsFreeSnapshot().enabled, false);
  assert.equal(manager.resumeListeningAfterResponse(), false);
});

test("10. Android page suspension (visibility hidden) stops session cleanly", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
  });
  const manager = new HandsFreeSessionManager(engine);

  manager.enableHandsFree();
  manager.startHandsFreeSession();
  const snap = manager.handleVisibilityHidden();

  assert.equal(snap.state, "INTERRUPTED");
  assert.equal(snap.enabled, false);
  assert.equal(snap.micActive, false);
  assert.match(snap.lastNotice ?? "", /background|schermo/i);
});
