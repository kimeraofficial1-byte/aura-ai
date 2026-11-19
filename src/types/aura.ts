import type { EmotionalAnalysis } from "../emotion/types";

export type { EmotionalAnalysis } from "../emotion/types";

export type ChatRole = "assistant" | "user";

export interface ChatHistoryItem {
  role: ChatRole;
  text: string;
  time?: string;
}

export interface EmotionalSignal {
  primaryEmotion?: string;
  intensity?: "low" | "moderate" | "high";
  notes?: string;
}

export interface WellnessContext {
  mood?: string;
  stress?: number;
  completedMissions?: number;
  totalMissions?: number;
  /** Sintesi persistente della memoria contestuale tra sessioni (solo con consenso) */
  memorySummary?: string;
  /** Profilo emotivo rilevato nel tempo */
  emotionalProfile?: EmotionalSignal;
  /** Analisi emotiva strutturata per Empathy Engine */
  emotionalAnalysis?: EmotionalAnalysis;
  /** Sintesi recente dell'andamento emotivo (solo con consenso attivo) */
  emotionalTrendSummary?: string;
  /** Blocco strutturato prodotto da Context Orchestration Engine + Gemini Context Adapter (FASE D) */
  orchestratedContextSummary?: string;
}

export interface AuraChatRequest {
  message: string;
  history?: ChatHistoryItem[];
  context?: WellnessContext;
}

export interface AuraChatResponse {
  reply: string;
  crisisDetected: boolean;
  meta: {
    model: string;
    source: "safety-guardrail" | "gemini";
    latencyMs: number;
  };
  /** Campo legacy mantenuto per compatibilità */
  emotionalSignal?: EmotionalSignal;
  /** Analisi emotiva validata prodotta da AURA Emotional Intelligence Engine V1 */
  emotionalAnalysis?: EmotionalAnalysis;
}

export type AuraErrorCode =
  | "INVALID_REQUEST"
  | "MISSING_API_KEY"
  | "INVALID_API_KEY"
  | "RATE_LIMIT"
  | "MODEL_NOT_FOUND"
  | "TIMEOUT"
  | "UPSTREAM_ERROR";

export interface AuraErrorResponse {
  error: string;
  code: AuraErrorCode;
}
