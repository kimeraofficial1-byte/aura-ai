import express from "express";
import type { AuraErrorResponse } from "../src/types/aura";
import { validateCognitiveRouteRequest } from "./cognitiveContext";
import {
  getServerCognitiveHealth,
  routeServerCognitiveRequest,
} from "./cognitiveRouter";

/**
 * Express Router per gli endpoint cognitivi V1:
 * - GET  /api/cognitive/health
 * - POST /api/cognitive/route
 *
 * Non altera POST /api/chat, SSE, /api/health, /api/missions/generate o /api/growth/insights.
 */
export function createCognitiveRouter(): express.Router {
  const router = express.Router();
  const inFlightRequestIds = new Set<string>();

  router.get("/api/cognitive/health", (_req, res) => {
    return res.status(200).json(getServerCognitiveHealth());
  });

  router.post("/api/cognitive/route", async (req, res) => {
    const validation = validateCognitiveRouteRequest(req.body);
    if (!validation.ok) {
      const payload: AuraErrorResponse = {
        error: validation.error,
        code: "INVALID_REQUEST",
      };
      return res.status(400).json(payload);
    }

    const { requestId } = validation.data;
    if (requestId && inFlightRequestIds.has(requestId)) {
      const payload: AuraErrorResponse = {
        error: "Richiesta duplicata già in elaborazione.",
        code: "INVALID_REQUEST",
      };
      return res.status(409).json(payload);
    }

    if (requestId) {
      inFlightRequestIds.add(requestId);
    }

    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      const response = await routeServerCognitiveRequest(validation.data, {
        signal: abortController.signal,
      });
      if (!res.writableEnded) {
        return res.status(200).json(response);
      }
    } catch {
      if (!res.writableEnded) {
        const payload: AuraErrorResponse = {
          error: "Errore interno durante l'elaborazione cognitiva.",
          code: "UPSTREAM_ERROR",
        };
        return res.status(500).json(payload);
      }
    } finally {
      if (requestId) {
        inFlightRequestIds.delete(requestId);
      }
    }
  });

  return router;
}
