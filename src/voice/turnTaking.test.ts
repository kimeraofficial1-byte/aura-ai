import assert from "node:assert/strict";
import test from "node:test";
import {
  AuraTurnTakingEngine,
  DEFAULT_TURN_TAKING_CONFIG,
} from "./turnTaking";
import type {
  SpeechRecognitionLike,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
  TurnEndReason,
  TurnTakingState,
  TurnTakingTimerAdapter,
  VoiceErrorInfo,
} from "./types";
import { AuraVoiceEngine } from "./voiceEngine";

class FakeTimers implements TurnTakingTimerAdapter {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { due: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.tasks.set(id, { due: this.now + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.tasks.delete(id as unknown as number);
  };

  advanceBy(ms: number): void {
    const target = this.now + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestDue = Infinity;
      for (const [id, task] of this.tasks.entries()) {
        if (task.due <= target && task.due < earliestDue) {
          earliestDue = task.due;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const task = this.tasks.get(earliestId);
      this.tasks.delete(earliestId);
      this.now = earliestDue;
      task?.fn();
    }
    this.now = target;
  }
}

class MockSpeechRecognition implements SpeechRecognitionLike {
  static lastInstance: MockSpeechRecognition | null = null;
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
  const spoken: SpeechSynthesisUtteranceLike[] = [];
  let cancelCount = 0;
  const synthesis: SpeechSynthesisLike = {
    getVoices: () => [{ name: "Google italiano", lang: "it-IT", default: true }],
    speak: (u) => {
      spoken.push(u);
      u.onstart?.();
    },
    cancel: () => {
      cancelCount += 1;
    },
    pause: () => {},
    resume: () => {},
  };
  return {
    synthesis,
    spoken,
    getCancelCount: () => cancelCount,
  };
}

test("1. Short pause (700ms) enters USER_PAUSED without ending turn and resumes on new speech", () => {
  const timers = new FakeTimers();
  const ended: TurnEndReason[] = [];
  const engine = new AuraTurnTakingEngine({
    timers,
    callbacks: {
      onTurnEnd: (reason) => ended.push(reason),
    },
  });

  assert.equal(engine.getSnapshot().vadSupported, false);
  assert.deepEqual(engine.getConfig(), DEFAULT_TURN_TAKING_CONFIG);

  engine.onListeningStart();
  assert.equal(engine.getSnapshot().state, "LISTENING");

  engine.onSpeechActivity({ hasInterim: true, hasFinal: false });
  assert.equal(engine.getSnapshot().state, "USER_SPEAKING");

  timers.advanceBy(700);
  assert.equal(engine.getSnapshot().state, "USER_PAUSED");
  assert.equal(engine.getSnapshot().pausePhase, "short");
  assert.equal(ended.length, 0);

  // User resumes speaking before longPauseMs (1500ms)
  timers.advanceBy(300);
  engine.onSpeechActivity({ hasInterim: true, hasFinal: false });
  assert.equal(engine.getSnapshot().state, "USER_SPEAKING");
  assert.equal(engine.getSnapshot().pausePhase, "none");
  assert.equal(ended.length, 0);
});

test("2. Long pause (1500ms) ends turn with long_pause, stops recognition, and preserves transcript", () => {
  const timers = new FakeTimers();
  const ended: TurnEndReason[] = [];
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true },
    timers,
  });

  engine.setTurnTakingCallbacks({
    onTurnEnd: (reason) => ended.push(reason),
  });

  let latestTranscript = "";
  engine.startListening({
    onTranscript: (p) => {
      latestTranscript = p.combinedTranscript;
    },
  });

  const rec = MockSpeechRecognition.lastInstance!;
  rec.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "Oggi mi sento un po' stanco" } }],
  });

  assert.equal(engine.getTurnTakingSnapshot().state, "USER_SPEAKING");
  assert.equal(engine.getTurnTakingSnapshot().sentenceFinalized, true);

  timers.advanceBy(1500);

  assert.deepEqual(ended, ["long_pause"]);
  assert.equal(rec.stopped, true);
  assert.equal(latestTranscript, "Oggi mi sento un po' stanco");
  assert.equal(engine.getTurnTakingSnapshot().state, "IDLE");
});

test("3. Configurable pause timings can be modified dynamically", () => {
  const timers = new FakeTimers();
  const ended: TurnEndReason[] = [];
  const engine = new AuraTurnTakingEngine({
    timers,
    callbacks: { onTurnEnd: (r) => ended.push(r) },
  });

  const updated = engine.updateConfig({
    shortPauseMs: 500,
    longPauseMs: 1100,
    maxTurnTimeoutMs: 3000,
  });
  assert.equal(updated.shortPauseMs, 500);
  assert.equal(updated.longPauseMs, 1100);
  assert.equal(updated.maxTurnTimeoutMs, 3000);

  engine.onListeningStart();
  engine.onSpeechActivity({ hasInterim: true, hasFinal: false });
  timers.advanceBy(500);
  assert.equal(engine.getSnapshot().state, "USER_PAUSED");
  timers.advanceBy(600);
  assert.deepEqual(ended, ["long_pause"]);
});

test("4. Max timeout (5000ms) ends listening turn cleanly with max_timeout", () => {
  const timers = new FakeTimers();
  const ended: TurnEndReason[] = [];
  const engine = new AuraTurnTakingEngine({
    timers,
    callbacks: { onTurnEnd: (r) => ended.push(r) },
  });

  engine.onListeningStart();
  timers.advanceBy(4999);
  assert.equal(engine.getSnapshot().state, "LISTENING");
  assert.equal(ended.length, 0);

  timers.advanceBy(1);
  assert.deepEqual(ended, ["max_timeout"]);
  assert.equal(engine.getSnapshot().state, "IDLE");
});

test("5. Barge-in during AURA_SPEAKING immediately cancels TTS, transitions through INTERRUPTED -> LISTENING, and keeps prior text", () => {
  const timers = new FakeTimers();
  const mockSynth = createMockSynthesis();
  const states: TurnTakingState[] = [];
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true },
    timers,
  });

  engine.setTurnTakingCallbacks({
    onStateChange: (s) => states.push(s.state),
  });

  engine.speakReply("Ciao, prendiamoci un momento per respirare insieme.");
  assert.equal(engine.getTurnTakingSnapshot().state, "AURA_SPEAKING");

  let draft = "Testo precedente";
  const started = engine.startListening(
    {
      onTranscript: (p) => {
        draft = p.combinedTranscript;
      },
    },
    draft
  );

  assert.equal(started, true);
  assert.ok(mockSynth.getCancelCount() >= 1);
  assert.ok(states.includes("INTERRUPTED"));
  assert.equal(engine.getTurnTakingSnapshot().state, "LISTENING");

  MockSpeechRecognition.lastInstance!.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "e continuo" } }],
  });
  assert.equal(draft, "Testo precedente e continuo");
});

test("6. Explicit interruptAura() immediately stops TTS and enters INTERRUPTED state", () => {
  const mockSynth = createMockSynthesis();
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true },
  });

  engine.speakReply("Risposta vocale in corso.");
  assert.equal(engine.getTurnTakingSnapshot().state, "AURA_SPEAKING");

  const snap = engine.interruptAura();
  assert.equal(snap.state, "INTERRUPTED");
  assert.equal(snap.interruptedAura, true);
  assert.ok(mockSynth.getCancelCount() >= 1);
});

test("7. Permission denied transitions state machine to ERROR with Italian message", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: createMockSynthesis().synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true },
  });

  const errors: VoiceErrorInfo[] = [];
  engine.startListening({
    onError: (err) => errors.push(err),
  });

  MockSpeechRecognition.lastInstance!.onerror?.({ error: "not-allowed" });
  assert.equal(errors[0]?.code, "PERMISSION_DENIED");
  assert.equal(engine.getTurnTakingSnapshot().state, "ERROR");
});

test("8. Unsupported browser fails gracefully into ERROR without throwing", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: null,
    synthesis: null,
    UtteranceCtor: null,
    initialPreferences: { voiceModeEnabled: true },
  });

  const errors: VoiceErrorInfo[] = [];
  const started = engine.startListening({
    onError: (err) => errors.push(err),
  });
  assert.equal(started, false);
  assert.equal(errors[0]?.code, "UNSUPPORTED");
  assert.equal(engine.getTurnTakingSnapshot().state, "ERROR");
});

test("9. Manual stop and disabling voice mode reset state machine to IDLE and stop STT/TTS", () => {
  const mockSynth = createMockSynthesis();
  const engine = new AuraVoiceEngine({
    recognitionCtor: MockSpeechRecognition,
    synthesis: mockSynth.synthesis,
    UtteranceCtor: MockUtterance,
    initialPreferences: { voiceModeEnabled: true },
  });

  engine.startListening({});
  assert.equal(engine.getTurnTakingSnapshot().state, "LISTENING");

  engine.stopListening();
  assert.equal(engine.getTurnTakingSnapshot().state, "IDLE");

  engine.notifyProcessingStart();
  assert.equal(engine.getTurnTakingSnapshot().state, "PROCESSING");

  engine.setVoiceModeEnabled(false);
  assert.equal(engine.getTurnTakingSnapshot().state, "IDLE");
  assert.ok(mockSynth.getCancelCount() >= 1);
});
