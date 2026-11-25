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
  AuraAbortError,
  AuraEmptyResponseError,
  buildAuraSystemInstruction,
  buildGeminiContents,
  computeRetryDelayMs,
  DEFAULT_AURA_MODEL,
  FALLBACK_AURA_MODEL,
  generateAuraReplyStream,
  isEmptyGeminiResponseError,
  mapGeminiError,
  MAX_STREAM_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  type StreamAttemptDiagnostic,
  waitWithAbort,
} from "./auraAgent";
import { runStructuredReasoning } from "../src/reasoning/reasoningEngine";
import {
  AuraClientError,
  resolveAuraErrorStatus,
  sendAuraChatMessage,
} from "../src/services/auraClient";

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

test("server/auraAgent.ts contains zero operational references to gemini-4-carbon and only calls authorized models", async () => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const agentSource = readFileSync(path.join(currentDir, "auraAgent.ts"), "utf8");
  assert.doesNotMatch(agentSource, /gemini-4-carbon/);

  const calledModels: string[] = [];
  const recordedDelays: number[] = [];

  const result = await generateAuraReplyStream({
    apiKey: "test-key",
    message: "Mi sento un po' teso oggi",
    primaryModelOverride: DEFAULT_AURA_MODEL,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 500,
    randomFn: () => 0.5,
    sleepFn: async (ms) => {
      recordedDelays.push(ms);
    },
    clientOverride: {
      models: {
        generateContentStream: (async (req: { model: string }) => {
          calledModels.push(req.model);
          if (req.model === DEFAULT_AURA_MODEL) {
            throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
          }
          async function* chunks() {
            yield { text: "Ciao, ti ascolto con calma." };
          }
          return chunks();
        }) as unknown as Parameters<typeof generateAuraReplyStream>[0]["clientOverride"] extends infer C
          ? C extends { models: { generateContentStream: infer F } }
            ? F
            : never
          : never,
      },
    } as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
  });

  assert.equal(result.model, FALLBACK_AURA_MODEL);
  assert.equal(result.reply, "Ciao, ti ascolto con calma.");
  assert.deepEqual(calledModels, [DEFAULT_AURA_MODEL, FALLBACK_AURA_MODEL]);
  assert.equal(calledModels.includes("gemini-4-carbon"), false);
  assert.equal(recordedDelays.length, 1);
});

test("exponential backoff with jitter respects bounds and stops after MAX_STREAM_ATTEMPTS propagating RATE_LIMIT", async () => {
  const d0 = computeRetryDelayMs(0, { randomFn: () => 0 });
  const d0Max = computeRetryDelayMs(0, { randomFn: () => 1 });
  const d1 = computeRetryDelayMs(1, { randomFn: () => 0 });
  const dCapped = computeRetryDelayMs(10, { randomFn: () => 1 });

  assert.equal(d0, RETRY_BASE_DELAY_MS);
  assert.ok(d0Max > d0);
  assert.ok(d1 > d0Max);
  assert.equal(dCapped, RETRY_MAX_DELAY_MS);

  const calledModels: string[] = [];
  const recordedDelays: number[] = [];

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key",
        message: "Aiutami a fare ordine nei pensieri",
        primaryModelOverride: DEFAULT_AURA_MODEL,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 350,
        randomFn: () => 0.4,
        sleepFn: async (ms) => {
          recordedDelays.push(ms);
        },
        clientOverride: {
          models: {
            generateContentStream: (async (req: { model: string }) => {
              calledModels.push(req.model);
              throw Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
            }) as never,
          },
        } as unknown as NonNullable<
          Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]
        >,
      }),
    (err: unknown) => {
      const mapped = mapGeminiError(err);
      assert.equal(mapped.code, "RATE_LIMIT");
      assert.equal(mapped.status, 429);
      return true;
    }
  );

  assert.equal(calledModels.length, MAX_STREAM_ATTEMPTS);
  assert.deepEqual(calledModels, [
    DEFAULT_AURA_MODEL,
    FALLBACK_AURA_MODEL,
    FALLBACK_AURA_MODEL,
  ]);
  assert.equal(recordedDelays.length, MAX_STREAM_ATTEMPTS - 1);
  assert.ok(recordedDelays[0] >= 100 && recordedDelays[0] <= 350);
  assert.ok(recordedDelays[1] > recordedDelays[0] && recordedDelays[1] <= 350);
});

test("waitWithAbort and retry waits abort immediately via AbortSignal without residual delay", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    async () => waitWithAbort(5_000, controller.signal),
    (err: unknown) => err instanceof AuraAbortError || (err instanceof Error && err.name === "AbortError")
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 500, `Expected immediate abort under 500ms, got ${elapsed}ms`);

  const streamController = new AbortController();
  const calledModels: string[] = [];
  const streamStart = Date.now();

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key",
        message: "Test interruzione retry",
        signal: streamController.signal,
        primaryModelOverride: DEFAULT_AURA_MODEL,
        retryBaseDelayMs: 5_000,
        retryMaxDelayMs: 5_000,
        clientOverride: {
          models: {
            generateContentStream: (async (req: { model: string }) => {
              calledModels.push(req.model);
              setTimeout(() => streamController.abort(), 15);
              throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
            }) as never,
          },
        } as unknown as NonNullable<
          Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]
        >,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError"
  );

  const streamElapsed = Date.now() - streamStart;
  assert.deepEqual(calledModels, [DEFAULT_AURA_MODEL]);
  assert.ok(streamElapsed < 500, `Expected retry abort under 500ms, got ${streamElapsed}ms`);
});

test("generateAuraReplyStream does not retry after emitting first chunk or on INVALID_API_KEY", async () => {
  const chunkCalls: string[] = [];
  let sleepCallsAfterChunk = 0;

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key",
        message: "Ciao",
        primaryModelOverride: DEFAULT_AURA_MODEL,
        sleepFn: async () => {
          sleepCallsAfterChunk += 1;
        },
        onChunk: () => {},
        clientOverride: {
          models: {
            generateContentStream: (async (req: { model: string }) => {
              chunkCalls.push(req.model);
              async function* partialStream() {
                yield { text: "Primo chunk" };
                throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
              }
              return partialStream();
            }) as never,
          },
        } as unknown as NonNullable<
          Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]
        >,
      }),
    (err: unknown) => mapGeminiError(err).code === "RATE_LIMIT"
  );

  assert.deepEqual(chunkCalls, [DEFAULT_AURA_MODEL]);
  assert.equal(sleepCallsAfterChunk, 0);

  const authCalls: string[] = [];
  let sleepCallsOnAuth = 0;

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "bad-key",
        message: "Ciao",
        primaryModelOverride: DEFAULT_AURA_MODEL,
        sleepFn: async () => {
          sleepCallsOnAuth += 1;
        },
        clientOverride: {
          models: {
            generateContentStream: (async (req: { model: string }) => {
              authCalls.push(req.model);
              throw Object.assign(new Error("API_KEY_INVALID"), { status: 401 });
            }) as never,
          },
        } as unknown as NonNullable<
          Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]
        >,
      }),
    (err: unknown) => mapGeminiError(err).code === "INVALID_API_KEY"
  );

  assert.deepEqual(authCalls, [DEFAULT_AURA_MODEL]);
  assert.equal(sleepCallsOnAuth, 0);
});

test("SSE client propagates status 429 for RATE_LIMIT, preserves explicit status, and cancels reader only on premature error", async () => {
  assert.equal(resolveAuraErrorStatus("RATE_LIMIT", undefined, 502), 429);
  assert.equal(resolveAuraErrorStatus("RATE_LIMIT", 503, 502), 503);
  assert.equal(resolveAuraErrorStatus("UPSTREAM_ERROR", undefined, 502), 502);

  const originalFetch = globalThis.fetch;
  try {
    let cancelCallsOnError = 0;
    globalThis.fetch = (async () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              new TextEncoder().encode(
                'event: error\ndata: {"error":"Limite richieste raggiunto","code":"RATE_LIMIT"}\n\n'
              )
            );
          }
        },
        cancel() {
          cancelCallsOnError += 1;
          return Promise.reject(new Error("cleanup error must not mask RATE_LIMIT"));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }) as typeof fetch;

    await assert.rejects(
      async () => sendAuraChatMessage({ message: "Ciao AURA" }),
      (err: unknown) => {
        assert.ok(err instanceof AuraClientError);
        assert.equal(err.code, "RATE_LIMIT");
        assert.equal(err.status, 429);
        assert.equal(err.message, "Limite richieste raggiunto");
        return true;
      }
    );
    assert.equal(cancelCallsOnError, 1);

    let cancelCallsOnDone = 0;
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: chunk\ndata: {"chunk":"Ciao","accumulated":"Ciao"}\n\n' +
                'event: done\ndata: {"reply":"Ciao, sono qui.","crisisDetected":false,"meta":{"model":"gemini-4-hydrogen","source":"gemini","latencyMs":12}}\n\n'
            )
          );
          controller.close();
        },
        cancel() {
          cancelCallsOnDone += 1;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }) as typeof fetch;

    const okRes = await sendAuraChatMessage({ message: "Ciao AURA" });
    assert.equal(okRes.reply, "Ciao, sono qui.");
    assert.equal(cancelCallsOnDone, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty primary stream switches immediately to FALLBACK_AURA_MODEL without waiting for backoff", async () => {
  const calledModels: string[] = [];
  const recordedDelays: number[] = [];
  const diagnostics: StreamAttemptDiagnostic[] = [];

  const result = await generateAuraReplyStream({
    apiKey: "test-key-empty-primary",
    message: "Mi sento stanco oggi",
    primaryModelOverride: DEFAULT_AURA_MODEL,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 1_000,
    sleepFn: async (ms) => {
      recordedDelays.push(ms);
    },
    onAttemptDiagnostic: (diag) => {
      diagnostics.push(diag);
    },
    clientOverride: {
      models: {
        generateContentStream: async (req: { model: string }) => {
          calledModels.push(req.model);
          if (req.model === DEFAULT_AURA_MODEL) {
            async function* emptyStream() {
              yield { text: "" };
            }
            return emptyStream();
          }
          async function* fallbackStream() {
            yield { text: "Risposta valida dal modello di fallback." };
          }
          return fallbackStream();
        },
      },
    } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
  });

  assert.equal(result.model, FALLBACK_AURA_MODEL);
  assert.equal(result.reply, "Risposta valida dal modello di fallback.");
  assert.deepEqual(calledModels, [DEFAULT_AURA_MODEL, FALLBACK_AURA_MODEL]);
  assert.equal(recordedDelays.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    attempt: 1,
    maxAttempts: MAX_STREAM_ATTEMPTS,
    model: DEFAULT_AURA_MODEL,
    mappedCode: "UPSTREAM_ERROR",
    httpStatus: null,
    errName: "AuraEmptyResponseError",
    emittedAnyChunk: false,
    willSwitchToFallback: true,
    willRetry: true,
  });
});

test("empty fallback stream uses remaining attempts up to MAX_STREAM_ATTEMPTS and succeeds or fails as UPSTREAM_ERROR 502", async () => {
  const recoveryModels: string[] = [];
  const recoveryDelays: number[] = [];

  const recovered = await generateAuraReplyStream({
    apiKey: "test-key-recovery",
    message: "Aiutami a fare una pausa",
    primaryModelOverride: DEFAULT_AURA_MODEL,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 400,
    randomFn: () => 0,
    sleepFn: async (ms) => {
      recoveryDelays.push(ms);
    },
    clientOverride: {
      models: {
        generateContentStream: async (req: { model: string }) => {
          recoveryModels.push(req.model);
          if (recoveryModels.length <= 2) {
            async function* emptyStream() {
              // Zero chunk utili
            }
            return emptyStream();
          }
          async function* thirdAttemptOk() {
            yield { text: "Terzo tentativo riuscito." };
          }
          return thirdAttemptOk();
        },
      },
    } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
  });

  assert.equal(recovered.model, FALLBACK_AURA_MODEL);
  assert.equal(recovered.reply, "Terzo tentativo riuscito.");
  assert.deepEqual(recoveryModels, [
    DEFAULT_AURA_MODEL,
    FALLBACK_AURA_MODEL,
    FALLBACK_AURA_MODEL,
  ]);
  assert.deepEqual(recoveryDelays, [100]);

  const exhaustedModels: string[] = [];
  const exhaustedDelays: number[] = [];
  const exhaustedDiagnostics: StreamAttemptDiagnostic[] = [];

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key-exhausted",
        message: "Messaggio di prova esaurimento",
        primaryModelOverride: DEFAULT_AURA_MODEL,
        retryBaseDelayMs: 80,
        retryMaxDelayMs: 300,
        randomFn: () => 0.5,
        sleepFn: async (ms) => {
          exhaustedDelays.push(ms);
        },
        onAttemptDiagnostic: (diag) => {
          exhaustedDiagnostics.push(diag);
        },
        clientOverride: {
          models: {
            generateContentStream: async (req: { model: string }) => {
              exhaustedModels.push(req.model);
              async function* alwaysEmpty() {
                // Nessun testo emesso
              }
              return alwaysEmpty();
            },
          },
        } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
      }),
    (err: unknown) => {
      assert.ok(err instanceof AuraEmptyResponseError);
      assert.equal(isEmptyGeminiResponseError(err), true);
      assert.equal(err.message, "Empty response from Gemini model");
      const mapped = mapGeminiError(err);
      assert.equal(mapped.code, "UPSTREAM_ERROR");
      assert.equal(mapped.status, 502);
      return true;
    }
  );

  assert.equal(exhaustedModels.length, MAX_STREAM_ATTEMPTS);
  assert.deepEqual(exhaustedModels, [
    DEFAULT_AURA_MODEL,
    FALLBACK_AURA_MODEL,
    FALLBACK_AURA_MODEL,
  ]);
  assert.equal(exhaustedDelays.length, 1);
  assert.equal(exhaustedDiagnostics.length, MAX_STREAM_ATTEMPTS);
  assert.equal(exhaustedDiagnostics[0].willSwitchToFallback, true);
  assert.equal(exhaustedDiagnostics[0].willRetry, true);
  assert.equal(exhaustedDiagnostics[1].willSwitchToFallback, false);
  assert.equal(exhaustedDiagnostics[1].willRetry, true);
  assert.equal(exhaustedDiagnostics[2].willSwitchToFallback, false);
  assert.equal(exhaustedDiagnostics[2].willRetry, false);
});

test("generateAuraReplyStream never retries after emitting first chunk even on transient 503 UPSTREAM_ERROR", async () => {
  const calledModels: string[] = [];
  const diagnostics: StreamAttemptDiagnostic[] = [];
  let sleepCalls = 0;

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key-post-chunk",
        message: "Raccontami un esercizio breve",
        primaryModelOverride: DEFAULT_AURA_MODEL,
        sleepFn: async () => {
          sleepCalls += 1;
        },
        onChunk: () => {},
        onAttemptDiagnostic: (diag) => {
          diagnostics.push(diag);
        },
        clientOverride: {
          models: {
            generateContentStream: async (req: { model: string }) => {
              calledModels.push(req.model);
              async function* partial503Stream() {
                yield { text: "Inizio risposta" };
                throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
              }
              return partial503Stream();
            },
          },
        } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
      }),
    (err: unknown) => {
      const mapped = mapGeminiError(err);
      assert.equal(mapped.code, "UPSTREAM_ERROR");
      assert.equal(mapped.status, 502);
      return true;
    }
  );

  assert.deepEqual(calledModels, [DEFAULT_AURA_MODEL]);
  assert.equal(sleepCalls, 0);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    attempt: 1,
    maxAttempts: MAX_STREAM_ATTEMPTS,
    model: DEFAULT_AURA_MODEL,
    mappedCode: "UPSTREAM_ERROR",
    httpStatus: 503,
    errName: "Error",
    emittedAnyChunk: true,
    willSwitchToFallback: false,
    willRetry: false,
  });
});

test("per-attempt diagnostic logs exclude apiKey, user message, history, context, and system prompt", async () => {
  const secretApiKey = "AIzaSySecretKeyNeverLog123456";
  const secretUserMessage = "Messaggio privato sensibile utente xyz987";
  const secretHistoryText = "Cronologia riservata precedente abc654";
  const secretMoodContext = "UmoreConfidenzialeSegreto";

  const capturedWarnArgs: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    capturedWarnArgs.push(args);
  };

  try {
    await generateAuraReplyStream({
      apiKey: secretApiKey,
      message: secretUserMessage,
      history: [{ role: "user", text: secretHistoryText }],
      context: {
        mood: secretMoodContext,
        stress: 7,
        orchestratedContextSummary: "CONTESTO_RISERVATO_NON_LOGGARE",
      },
      primaryModelOverride: DEFAULT_AURA_MODEL,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      sleepFn: async () => {},
      clientOverride: {
        models: {
          generateContentStream: async (req: { model: string }) => {
            if (req.model === DEFAULT_AURA_MODEL) {
              throw Object.assign(new Error("503 Service Unavailable"), { status: 503 });
            }
            async function* okFallback() {
              yield { text: "Risposta privata ok" };
            }
            return okFallback();
          },
        },
      } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(capturedWarnArgs.length, 1);
  const serialized = JSON.stringify(capturedWarnArgs[0]);
  assert.equal(serialized.includes(secretApiKey), false);
  assert.equal(serialized.includes(secretUserMessage), false);
  assert.equal(serialized.includes(secretHistoryText), false);
  assert.equal(serialized.includes(secretMoodContext), false);
  assert.equal(serialized.includes("CONTESTO_RISERVATO_NON_LOGGARE"), false);
  assert.equal(serialized.includes("Risposta privata ok"), false);
  assert.equal(serialized.includes("Sei AURA"), false);

  const diagPayload = capturedWarnArgs[0][1] as StreamAttemptDiagnostic;
  assert.deepEqual(diagPayload, {
    attempt: 1,
    maxAttempts: MAX_STREAM_ATTEMPTS,
    model: DEFAULT_AURA_MODEL,
    mappedCode: "UPSTREAM_ERROR",
    httpStatus: 503,
    errName: "Error",
    emittedAnyChunk: false,
    willSwitchToFallback: true,
    willRetry: true,
  });
});

test("abort during empty-fallback backoff cancels immediately without executing extra attempts", async () => {
  const controller = new AbortController();
  const calledModels: string[] = [];
  const diagnostics: StreamAttemptDiagnostic[] = [];
  const startedAt = Date.now();

  await assert.rejects(
    async () =>
      generateAuraReplyStream({
        apiKey: "test-key-abort-empty",
        message: "Test interruzione dopo fallback vuoto",
        signal: controller.signal,
        primaryModelOverride: DEFAULT_AURA_MODEL,
        retryBaseDelayMs: 5_000,
        retryMaxDelayMs: 5_000,
        onAttemptDiagnostic: (diag) => {
          diagnostics.push(diag);
        },
        clientOverride: {
          models: {
            generateContentStream: async (req: { model: string }) => {
              calledModels.push(req.model);
              if (req.model === FALLBACK_AURA_MODEL) {
                setTimeout(() => controller.abort(), 15);
              }
              async function* emptyStream() {
                // Stream vuoto
              }
              return emptyStream();
            },
          },
        } as unknown as NonNullable<Parameters<typeof generateAuraReplyStream>[0]["clientOverride"]>,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError"
  );

  const elapsed = Date.now() - startedAt;
  assert.deepEqual(calledModels, [DEFAULT_AURA_MODEL, FALLBACK_AURA_MODEL]);
  assert.ok(elapsed < 500, `Expected immediate abort under 500ms, got ${elapsed}ms`);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].willSwitchToFallback, true);
  assert.equal(diagnostics[1].model, FALLBACK_AURA_MODEL);
});



