import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAuraReply, generateAuraReplyStream, getAuraModelName, mapGeminiError } from "./server/auraAgent";
import { analyzeMessageEmotion } from "./server/emotionEngine";
import { generatePersonalInsights, validateGrowthInsightsRequest } from "./server/growthEngine";
import { generateAdaptiveMissions, validateMissionGenerateRequest } from "./server/missionEngine";
import { createCognitiveRouter } from "./server/cognitiveRoutes";
import { evaluatePreModelSafety, validateChatRequest } from "./server/safety";
import type { AuraChatResponse, AuraErrorResponse } from "./src/types/aura";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const isProduction = process.env.NODE_ENV === "production";

async function startServer() {
  const app = express();

  app.use(express.json({ limit: "64kb" }));

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === "object" && "type" in err && (err as { type?: string }).type === "entity.parse.failed") {
      const payload: AuraErrorResponse = {
        error: "Il corpo JSON della richiesta non è valido.",
        code: "INVALID_REQUEST",
      };
      return res.status(400).json(payload);
    }
    return next(err);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      model: getAuraModelName(),
    });
  });

  app.use(createCognitiveRouter());

  app.post("/api/chat", async (req, res) => {
    const startedAt = Date.now();
    const validation = validateChatRequest(req.body);
    if (!validation.ok) {
      const payload: AuraErrorResponse = {
        error: validation.error,
        code: "INVALID_REQUEST",
      };
      return res.status(400).json(payload);
    }

    const { message, history, context } = validation.data;

    // Controllo di sicurezza preventivo PRIMA di inviare la richiesta a Gemini
    const safety = evaluatePreModelSafety(message);
    if (safety.crisisDetected && safety.reply) {
      const responsePayload: AuraChatResponse = {
        reply: safety.reply,
        crisisDetected: true,
        meta: {
          model: "safety-guardrail",
          source: "safety-guardrail",
          latencyMs: Date.now() - startedAt,
        },
      };
      return res.status(200).json(responsePayload);
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      const payload: AuraErrorResponse = {
        error:
          "Servizio AI non configurato: imposta la variabile server GEMINI_API_KEY nel pannello Settings > Secrets.",
        code: "MISSING_API_KEY",
      };
      return res.status(503).json(payload);
    }

    const wantsStream = Boolean(req.headers.accept?.includes("text/event-stream"));
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    if (wantsStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const keepalive = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": keepalive\n\n");
        }
      }, 10_000);

      try {
        const emotionResult = await analyzeMessageEmotion({
          apiKey,
          message,
          history,
          context,
          signal: abortController.signal,
        });
        const analysis = emotionResult.analysis ?? undefined;
        if (analysis && !res.writableEnded) {
          res.write(`event: analysis\ndata: ${JSON.stringify(analysis)}\n\n`);
        }

        const enrichedContext = analysis
          ? { ...context, emotionalAnalysis: analysis }
          : context;

        const result = await generateAuraReplyStream({
          apiKey,
          message,
          history,
          context: enrichedContext,
          signal: abortController.signal,
          onChunk: (chunkText, accumulatedText) => {
            if (!res.writableEnded) {
              res.write(
                `event: chunk\ndata: ${JSON.stringify({
                  chunk: chunkText,
                  accumulated: accumulatedText,
                })}\n\n`
              );
            }
          },
        });

        const responsePayload: AuraChatResponse = {
          reply: result.reply,
          crisisDetected: false,
          meta: {
            model: result.model,
            source: "gemini",
            latencyMs: Date.now() - startedAt,
          },
          emotionalAnalysis: analysis,
        };
        if (!res.writableEnded) {
          res.write(`event: done\ndata: ${JSON.stringify(responsePayload)}\n\n`);
          res.end();
        }
      } catch (error) {
        if (!abortController.signal.aborted && !res.writableEnded) {
          const mapped = mapGeminiError(error);
          const errName = error instanceof Error ? error.name : typeof error;
          const errStatus = (error as { status?: unknown })?.status;
          const errMsg = error instanceof Error ? error.message.slice(0, 200) : String(error ?? "").slice(0, 200);
          console.error("[AURA /api/chat] Gemini stream failed:", mapped.code, { errName, errStatus, errMsg });
          const payload: AuraErrorResponse = {
            error: mapped.message,
            code: mapped.code,
          };
          res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
          res.end();
        }
      } finally {
        clearInterval(keepalive);
      }
      return;
    }

    try {
      const emotionResult = await analyzeMessageEmotion({
        apiKey,
        message,
        history,
        context,
        signal: abortController.signal,
      });
      const analysis = emotionResult.analysis ?? undefined;
      const enrichedContext = analysis
        ? { ...context, emotionalAnalysis: analysis }
        : context;

      const result = await generateAuraReply({
        apiKey,
        message,
        history,
        context: enrichedContext,
        signal: abortController.signal,
      });

      const responsePayload: AuraChatResponse = {
        reply: result.reply,
        crisisDetected: false,
        meta: {
          model: result.model,
          source: "gemini",
          latencyMs: Date.now() - startedAt,
        },
        emotionalAnalysis: analysis,
      };
      return res.status(200).json(responsePayload);
    } catch (error) {
      if (abortController.signal.aborted && res.writableEnded) {
        return;
      }
      const mapped = mapGeminiError(error);
      const errName = error instanceof Error ? error.name : typeof error;
      const errStatus = (error as { status?: unknown })?.status;
      const errMsg = error instanceof Error ? error.message.slice(0, 200) : String(error ?? "").slice(0, 200);
      console.error("[AURA /api/chat] Gemini call failed:", mapped.code, { errName, errStatus, errMsg });
      const payload: AuraErrorResponse = {
        error: mapped.message,
        code: mapped.code,
      };
      return res.status(mapped.status).json(payload);
    }
  });

  app.post("/api/missions/generate", async (req, res) => {
    const validation = validateMissionGenerateRequest(req.body);
    if (!validation.ok) {
      const payload: AuraErrorResponse = {
        error: validation.error,
        code: "INVALID_REQUEST",
      };
      return res.status(400).json(payload);
    }

    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const result = await generateAdaptiveMissions({
      context: validation.data,
      apiKey: process.env.GEMINI_API_KEY?.trim(),
      useGemini: validation.data.useGemini,
      signal: abortController.signal,
    });

    return res.status(200).json(result);
  });

  app.post("/api/growth/insights", async (req, res) => {
    const validation = validateGrowthInsightsRequest(req.body);
    if (!validation.ok) {
      const payload: AuraErrorResponse = {
        error: validation.error,
        code: "INVALID_REQUEST",
      };
      return res.status(400).json(payload);
    }

    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const result = await generatePersonalInsights({
      context: validation.data,
      apiKey: process.env.GEMINI_API_KEY?.trim(),
      useGemini: validation.data.useGemini,
      signal: abortController.signal,
    });

    return res.status(200).json(result);
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*path", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AURA server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start AURA server:", err);
  process.exit(1);
});
