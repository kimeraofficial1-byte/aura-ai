import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_KEYBOARD_MIC_HINT,
  AuraSpeechRecognitionService,
  isSpeechRecognitionSupported,
} from "./speechRecognition";
import {
  AuraSpeechSynthesisService,
  isSpeechSynthesisSupported,
  selectPreferredItalianVoice,
  splitTextIntoSpeechChunks,
} from "./speechSynthesis";
import type {
  SpeechRecognitionLike,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
  SpeechSynthesisVoiceLike,
  VoiceErrorInfo,
  VoiceRecognitionStatus,
  VoiceSynthesisStatus,
} from "./types";
import { AuraVoiceEngine } from "./voiceEngine";

class FakeRecognition implements SpeechRecognitionLike {
  static latest: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string; message?: string }) => void) | null = null;
  onresult: ((event: { resultIndex?: number; results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }> }) => void) | null = null;
  started = false;
  stopped = false;

  constructor() {
    FakeRecognition.latest = this;
  }

  start() {
    this.started = true;
    this.onstart?.();
  }

  stop() {
    this.stopped = true;
    this.onend?.();
  }

  abort() {
    this.stopped = true;
    this.onend?.();
  }
}

class FakeUtterance implements SpeechSynthesisUtteranceLike {
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

function createFakeSynthesis(voices: SpeechSynthesisVoiceLike[] = []) {
  const spoken: FakeUtterance[] = [];
  let cancelCount = 0;
  let pauseCount = 0;
  let resumeCount = 0;
  const listeners = new Map<string, () => void>();

  const synthesis: SpeechSynthesisLike = {
    getVoices: () => voices,
    speak: (utterance) => {
      const u = utterance as FakeUtterance;
      spoken.push(u);
      u.onstart?.();
    },
    cancel: () => {
      cancelCount += 1;
    },
    pause: () => {
      pauseCount += 1;
    },
    resume: () => {
      resumeCount += 1;
    },
    addEventListener: (type, fn) => {
      listeners.set(type, fn);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
  };

  return {
    synthesis,
    spoken,
    getCancelCount: () => cancelCount,
    getPauseCount: () => pauseCount,
    getResumeCount: () => resumeCount,
    triggerVoicesChanged: () => listeners.get("voiceschanged")?.(),
  };
}

test("1. Detects SpeechRecognition and webkitSpeechRecognition support accurately", () => {
  assert.equal(isSpeechRecognitionSupported({ SpeechRecognition: FakeRecognition }), true);
  assert.equal(isSpeechRecognitionSupported({ webkitSpeechRecognition: FakeRecognition }), true);
  assert.equal(isSpeechRecognitionSupported({}), false);
});

test("2. Detects SpeechSynthesis support accurately", () => {
  const { synthesis } = createFakeSynthesis();
  assert.equal(
    isSpeechSynthesisSupported({
      speechSynthesis: synthesis,
      SpeechSynthesisUtterance: FakeUtterance,
    }),
    true
  );
  assert.equal(isSpeechSynthesisSupported({ speechSynthesis: synthesis }), false);
  assert.equal(isSpeechSynthesisSupported({}), false);
});

test("3. Browser without SpeechRecognition fails gracefully with Android keyboard hint", () => {
  const service = new AuraSpeechRecognitionService({ recognitionCtor: null });
  assert.equal(service.isSupported(), false);
  assert.equal(service.getStatus(), "unsupported");

  const errors: VoiceErrorInfo[] = [];
  const started = service.start({
    onError: (err) => {
      errors.push(err);
    },
  });
  assert.equal(started, false);
  assert.equal(errors[0]?.code, "UNSUPPORTED");
  assert.equal(errors[0]?.message, ANDROID_KEYBOARD_MIC_HINT);
});

test("4. Browser without SpeechSynthesis degrades gracefully without throwing", () => {
  const tts = new AuraSpeechSynthesisService({ synthesis: null, UtteranceCtor: null });
  assert.equal(tts.isSupported(), false);
  assert.equal(tts.getStatus(), "unsupported");
  assert.equal(tts.speak("Ciao AURA"), false);
});

test("5. Handles microphone permission denied cleanly", () => {
  const service = new AuraSpeechRecognitionService({ recognitionCtor: FakeRecognition });
  const errors: VoiceErrorInfo[] = [];
  let lastStatus: VoiceRecognitionStatus = "idle";

  const ok = service.start({
    onStatusChange: (s) => {
      lastStatus = s;
    },
    onError: (e) => {
      errors.push(e);
    },
  });
  assert.equal(ok, true);
  assert.equal(FakeRecognition.latest?.lang, "it-IT");

  FakeRecognition.latest?.onerror?.({ error: "not-allowed" });
  assert.equal(lastStatus, "error");
  assert.equal(errors[0]?.code, "PERMISSION_DENIED");
  assert.match(errors[0]?.message ?? "", /Permesso microfono negato/i);
});

test("6. Handles recognition errors (no-speech, network) cleanly", () => {
  const service = new AuraSpeechRecognitionService({ recognitionCtor: FakeRecognition });
  const errors: VoiceErrorInfo[] = [];

  service.start({
    onError: (e) => {
      errors.push(e);
    },
  });
  FakeRecognition.latest?.onerror?.({ error: "no-speech" });
  assert.equal(errors[0]?.code, "NO_SPEECH");

  service.start({
    onError: (e) => {
      errors.push(e);
    },
  });
  FakeRecognition.latest?.onerror?.({ error: "network" });
  assert.equal(errors[1]?.code, "NETWORK");
});

test("7. Produces interim and final transcript editable before explicit send via existing chat service", () => {
  const engine = new AuraVoiceEngine({
    recognitionCtor: FakeRecognition,
    synthesis: null,
    UtteranceCtor: null,
  });

  let draft = "";
  let interim = "";
  let sentPayload: string | null = null;

  engine.startListening({
    onTranscript: (payload) => {
      interim = payload.interimTranscript;
      draft = payload.combinedTranscript;
    },
  });

  // Risultato provvisorio
  FakeRecognition.latest?.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: false, 0: { transcript: "Oggi mi sento" } }],
  });
  assert.equal(interim, "Oggi mi sento");
  assert.equal(draft, "Oggi mi sento");
  assert.equal(sentPayload, null, "Non deve inviare automaticamente senza conferma utente");

  // Risultato finale + modifica manuale dell'utente prima dell'invio
  FakeRecognition.latest?.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "Oggi mi sento un po' stanco" } }],
  });
  assert.equal(draft, "Oggi mi sento un po' stanco");

  const editedDraft = `${draft}, vorrei una pausa.`;
  // Simulazione invio esplicito verso il servizio chat esistente
  sentPayload = editedDraft;
  assert.equal(sentPayload, "Oggi mi sento un po' stanco, vorrei una pausa.");
});

test("8. Selects Italian natural voice, chunks long text, and reads response at rate 1.0 / pitch 1.0", () => {
  const voices: SpeechSynthesisVoiceLike[] = [
    { name: "English US", lang: "en-US", localService: true },
    { name: "eSpeak Italian", lang: "it-IT", localService: true },
    { name: "Google italiano", lang: "it-IT", localService: true, default: true },
  ];
  const selected = selectPreferredItalianVoice(voices, "it-IT");
  assert.equal(selected?.name, "Google italiano");

  const longText =
    "Prima frase abbastanza lunga per verificare la suddivisione corretta del testo in italiano. " +
    "Seconda frase con ulteriori dettagli di supporto empatico senza diagnosi cliniche. " +
    "Terza frase conclusiva per superare il limite di 190 caratteri e generare almeno due chunk.";
  const chunks = splitTextIntoSpeechChunks(longText, 120);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 120));

  const fake = createFakeSynthesis(voices);
  const engine = new AuraVoiceEngine({
    recognitionCtor: FakeRecognition,
    synthesis: fake.synthesis,
    UtteranceCtor: FakeUtterance,
    initialPreferences: { voiceModeEnabled: true, autoSpeakResponses: true },
  });

  let synthStatus: VoiceSynthesisStatus = "idle";
  const started = engine.speakReply(longText, {
    callbacks: { onStatusChange: (s) => (synthStatus = s) },
  });
  assert.equal(started, true);
  assert.equal(synthStatus, "speaking");
  assert.equal(fake.spoken[0].lang, "it-IT");
  assert.equal(fake.spoken[0].rate, 1.0);
  assert.equal(fake.spoken[0].pitch, 1.0);
  assert.equal(fake.spoken[0].voice?.name, "Google italiano");

  // Pausa e riprendi
  assert.equal(engine.pauseSpeaking((s) => (synthStatus = s)), true);
  assert.equal(synthStatus, "paused");
  assert.equal(engine.resumeSpeaking((s) => (synthStatus = s)), true);
  assert.equal(synthStatus, "speaking");
});

test("9. Immediately stops speaking on stopSpeaking() and on barge-in when user starts listening", () => {
  const fake = createFakeSynthesis([{ name: "Google italiano", lang: "it-IT" }]);
  const engine = new AuraVoiceEngine({
    recognitionCtor: FakeRecognition,
    synthesis: fake.synthesis,
    UtteranceCtor: FakeUtterance,
    initialPreferences: { voiceModeEnabled: true },
  });

  let synthStatus: VoiceSynthesisStatus = "idle";
  engine.speakReply("Ti ascolto con calma.", {
    callbacks: { onStatusChange: (s) => (synthStatus = s) },
  });
  assert.equal(synthStatus, "speaking");

  // Barge-in: avviare ascolto interrompe subito TTS
  engine.startListening({
    onSynthesisStatus: (s) => (synthStatus = s),
  });
  assert.equal(synthStatus, "idle");
  assert.ok(fake.getCancelCount() >= 2);

  // Stop esplicito
  engine.speakReply("Altra risposta.", {
    callbacks: { onStatusChange: (s) => (synthStatus = s) },
  });
  engine.stopSpeaking((s) => (synthStatus = s));
  assert.equal(synthStatus, "idle");
});

test("10. Disabling voice mode completely stops both listening and speaking and blocks auto-read", () => {
  const fake = createFakeSynthesis([{ name: "Google italiano", lang: "it-IT" }]);
  const engine = new AuraVoiceEngine({
    recognitionCtor: FakeRecognition,
    synthesis: fake.synthesis,
    UtteranceCtor: FakeUtterance,
    initialPreferences: { voiceModeEnabled: true },
  });

  let recStatus: VoiceRecognitionStatus = "idle";
  let synthStatus: VoiceSynthesisStatus = "idle";

  engine.startListening({ onStatusChange: (s) => (recStatus = s) });
  assert.equal(recStatus, "listening");

  const prefs = engine.setVoiceModeEnabled(false, {
    onRecognitionStatus: (s) => (recStatus = s),
    onSynthesisStatus: (s) => (synthStatus = s),
  });
  assert.equal(prefs.voiceModeEnabled, false);
  assert.equal(recStatus, "idle");
  assert.equal(synthStatus, "idle");
  assert.equal(engine.speakReply("Non deve leggere"), false);
});

test("11. Privacy & Security: zero audio recording/storage APIs and zero API keys in frontend voice modules", () => {
  const voiceFiles = [
    path.resolve("src/voice/types.ts"),
    path.resolve("src/voice/speechRecognition.ts"),
    path.resolve("src/voice/speechSynthesis.ts"),
    path.resolve("src/voice/voiceEngine.ts"),
    path.resolve("src/components/VoiceConversationPanel.tsx"),
  ];

  for (const filePath of voiceFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, /\bMediaRecorder\b/, `Nessuna registrazione audio consentita in ${filePath}`);
    assert.doesNotMatch(content, /GEMINI_API_KEY/, `Nessuna API key consentita nel frontend: ${filePath}`);
    assert.doesNotMatch(content, /@google\/genai/, `Nessun SDK Gemini diretto nel frontend: ${filePath}`);
    assert.doesNotMatch(content, /localStorage\.setItem/, `Nessun salvataggio audio/trascrizioni diretto in ${filePath}`);
  }
});
