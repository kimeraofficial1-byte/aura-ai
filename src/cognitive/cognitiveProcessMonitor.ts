import type { DataRepository } from "../persistence/dataManagement";
import type { ControlledLearningEngine } from "../proactive/controlledLearningEngine";
import type { CognitiveTimeline } from "./cognitiveTimeline";
import type { ExperienceSummary } from "./experienceAnalyzer";
import { evaluateMetaCognitiveSafety } from "./metaCognitiveSafetyGuard";
import type {
  CognitiveProcessTrace,
  MetaCognitiveEvidenceItem,
  MetaCognitiveProcessStatus,
  MetaCognitiveSafetyDecision,
  MissingInformationItem,
} from "./metaCognitiveTypes";
import type {
  EpistemicTag,
  EvidenceType,
  LearningConsentState,
} from "./selfLearningTypes";

export type ProcessLifecycleState =
  | "iniziato"
  | "in_elaborazione"
  | "completato"
  | "sospeso"
  | "bloccato";

export interface MonitoredProcessStep {
  id: string;
  stage: string;
  status: "started" | "in_progress" | "completed" | "suspended" | "blocked";
  note?: string;
}

export interface ExplicitEvidenceInput {
  id?: string;
  evidenceType: EvidenceType;
  epistemicTag: EpistemicTag;
  dataSource: string;
  summary: string;
  confidence: number;
  timestamp?: string;
}

export interface CognitiveProcessMonitorInput {
  traceId?: string;
  consentState: LearningConsentState;
  usesLearningData?: boolean;
  repository?: DataRepository;
  timeline?: CognitiveTimeline;
  controlledLearning?: ControlledLearningEngine;
  experienceSummary?: ExperienceSummary;
  expectedInputs?: string[];
  availableInputs?: Record<string, unknown>;
  processSteps?: MonitoredProcessStep[];
  explicitEvidences?: ExplicitEvidenceInput[];
  crisisBlocked?: boolean;
  userTextForSafetyCheck?: string;
  storageAvailable?: boolean;
  corruptedDataDetected?: boolean;
  nowIso?: string;
}

export interface CognitiveProcessMonitorResult {
  allowed: boolean;
  advisoryOnly: true;
  readOnly: true;
  processLifecycleState: ProcessLifecycleState;
  trace: CognitiveProcessTrace;
  incompleteSteps: string[];
  inconsistencies: string[];
  evidenceCounts: Record<EvidenceType, number>;
  readableTrace: string[];
  safetyDecision: MetaCognitiveSafetyDecision;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function isPresentValue(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "string") return val.trim().length > 0;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

/**
 * Cognitive Process Monitor V1.
 * Monitora in sola lettura i passaggi del processo cognitivo, distingue evidenze
 * e ipotesi, individua informazioni mancanti e incongruenze senza alterare altri motori.
 */
export function monitorCognitiveProcess(
  input: CognitiveProcessMonitorInput
): CognitiveProcessMonitorResult {
  const nowIso = input?.nowIso ?? new Date().toISOString();
  const traceId =
    input?.traceId?.trim() || `meta-trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const usesLearningData =
    input?.usesLearningData ??
    Boolean(input?.controlledLearning || input?.experienceSummary);

  const safetyDecision = evaluateMetaCognitiveSafety({
    operation: "analyze",
    consentState: input?.consentState,
    usesLearningData,
    crisisBlocked: input?.crisisBlocked,
    userTextForSafetyCheck: input?.userTextForSafetyCheck,
    storageAvailable: input?.storageAvailable,
    corruptedDataDetected: input?.corruptedDataDetected,
    nowIso,
  });

  if (!safetyDecision.allowed) {
    return {
      allowed: false,
      advisoryOnly: true,
      readOnly: true,
      processLifecycleState: "bloccato",
      trace: {
        traceId,
        timestamp: nowIso,
        status: "blocked",
        stagesExecuted: ["safety_check"],
        evidences: [],
        missingInformation: [],
        contradictionsDetected: 0,
        dataSources: [],
      },
      incompleteSteps: [],
      inconsistencies: [],
      evidenceCounts: {
        explicit_feedback: 0,
        observed_behavior: 0,
        hypothesis: 0,
      },
      readableTrace: [
        `[${nowIso}] Processo cognitivo bloccato (fail-closed): ${safetyDecision.reason}`,
      ],
      safetyDecision,
    };
  }

  try {
    const stagesExecuted: string[] = ["safety_check", "input_inspection"];
    const evidences: MetaCognitiveEvidenceItem[] = [];
    const missingInformation: MissingInformationItem[] = [];
    const inconsistencies: string[] = [];
    const dataSourcesSet = new Set<string>();

    // 1. Verifica input attesi vs disponibili
    const available = input.availableInputs ?? {};
    for (const field of input.expectedInputs ?? []) {
      const cleanField = field.trim();
      if (!cleanField) continue;
      if (!isPresentValue(available[cleanField])) {
        missingInformation.push({
          field: cleanField,
          reason: `Informazione attesa "${cleanField}" assente o vuota.`,
          impact: "high",
        });
      }
    }

    // 2. Raccolta evidenze esplicite fornite in input (sola lettura)
    for (let i = 0; i < (input.explicitEvidences ?? []).length; i += 1) {
      const ev = input.explicitEvidences![i];
      if (!ev || !ev.summary?.trim() || !ev.dataSource?.trim()) continue;
      dataSourcesSet.add(ev.dataSource.trim());
      evidences.push({
        id: ev.id?.trim() || `ev-input-${i + 1}`,
        evidenceType: ev.evidenceType,
        epistemicTag: ev.epistemicTag,
        dataSource: ev.dataSource.trim(),
        timestamp: ev.timestamp ?? nowIso,
        summary: ev.summary.trim(),
        confidence: clampConfidence(ev.confidence),
      });
    }

    // 3. Raccolta da DataRepository in sola lettura (piani/missioni/obiettivi)
    if (input.repository) {
      dataSourcesSet.add("DataRepository");
      const snapshot = input.repository.loadSnapshot();
      let completedTasks = 0;
      let pausedOrOverdueTasks = 0;

      for (const plan of snapshot.plans) {
        for (const task of plan.tasks) {
          if (task.status === "completed") completedTasks += 1;
          else if (task.status === "paused" || task.status === "overdue") {
            pausedOrOverdueTasks += 1;
          }
        }
      }

      if (completedTasks > 0) {
        evidences.push({
          id: "ev-repo-completed",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          timestamp: nowIso,
          summary: `${completedTasks} task completati osservati nei piani operativi.`,
          confidence: 0.85,
        });
      }
      if (pausedOrOverdueTasks > 0) {
        evidences.push({
          id: "ev-repo-stalled",
          evidenceType: "observed_behavior",
          epistemicTag: "fatto_osservato",
          dataSource: "DataRepository",
          timestamp: nowIso,
          summary: `${pausedOrOverdueTasks} task in pausa o in ritardo nei piani operativi.`,
          confidence: 0.8,
        });
      }
      if (
        snapshot.plans.length === 0 &&
        snapshot.missions.length === 0 &&
        snapshot.growthGoals.length === 0
      ) {
        missingInformation.push({
          field: "operational_records",
          reason: "Nessun piano, missione o obiettivo disponibile in DataRepository.",
          impact: "medium",
        });
      }
    }

    // 4. Raccolta da CognitiveTimeline in sola lettura
    if (input.timeline) {
      dataSourcesSet.add("CognitiveTimeline");
      const events = input.timeline.getEvents();
      for (const ev of events.slice(0, 20)) {
        evidences.push({
          id: `ev-tl-${ev.id}`,
          evidenceType: "observed_behavior",
          epistemicTag: ev.epistemicTag,
          dataSource: `CognitiveTimeline:${ev.source}`,
          timestamp: ev.date,
          summary: `${ev.title}: ${ev.description}`,
          confidence: clampConfidence(ev.reliability),
        });
      }
    }

    // 5. Raccolta da ControlledLearningEngine in sola lettura (solo se usesLearningData e consenso ON)
    if (input.controlledLearning && usesLearningData) {
      dataSourcesSet.add("ControlledLearningEngine");
      const exported = input.controlledLearning.exportLearningData();
      for (let i = 0; i < Math.min(20, exported.interactions.length); i += 1) {
        const item = exported.interactions[i];
        evidences.push({
          id: `ev-cl-${i + 1}`,
          evidenceType: "explicit_feedback",
          epistemicTag: "fatto_osservato",
          dataSource: "ControlledLearningEngine",
          timestamp: item.timestamp,
          summary: `Scelta esplicita "${item.action}" per categoria "${item.category}".`,
          confidence: 0.9,
        });
      }
    }

    // 6. Raccolta da ExperienceSummary in sola lettura
    if (input.experienceSummary && input.experienceSummary.allowed && usesLearningData) {
      dataSourcesSet.add("ExperienceAnalyzer");
      for (const pat of input.experienceSummary.patterns) {
        evidences.push({
          id: `ev-exp-${pat.id}`,
          evidenceType: pat.evidenceType,
          epistemicTag: pat.epistemicTag,
          dataSource: pat.dataSource,
          timestamp: input.experienceSummary.analyzedAt,
          summary: pat.description,
          confidence: clampConfidence(pat.confidence),
        });
      }
      if (input.experienceSummary.insufficientData) {
        missingInformation.push({
          field: "experience_observations",
          reason: input.experienceSummary.uncertaintyNote,
          impact: "medium",
        });
      }
    }

    stagesExecuted.push("evidence_classification");

    // 7. Analisi passaggi del processo e stati incompleti
    const steps = input.processSteps ?? [];
    const incompleteSteps: string[] = [];
    let hasBlockedStep = false;
    let hasSuspendedStep = false;
    let hasInProgressStep = false;
    let hasStartedOnlyStep = false;

    for (const step of steps) {
      if (step.status === "blocked") {
        hasBlockedStep = true;
        incompleteSteps.push(`${step.stage} (bloccato)`);
      } else if (step.status === "suspended") {
        hasSuspendedStep = true;
        incompleteSteps.push(`${step.stage} (sospeso)`);
      } else if (step.status === "in_progress") {
        hasInProgressStep = true;
        incompleteSteps.push(`${step.stage} (in elaborazione)`);
      } else if (step.status === "started") {
        hasStartedOnlyStep = true;
        incompleteSteps.push(`${step.stage} (iniziato ma non completato)`);
      }
    }

    // 8. Rilevamento incongruenze diagnostiche
    stagesExecuted.push("consistency_check");
    for (const ev of evidences) {
      if (ev.evidenceType === "hypothesis" && ev.epistemicTag === "fatto_osservato") {
        inconsistencies.push(
          `Incongruenza epistemica su "${ev.id}": un'ipotesi è marcata come fatto_osservato.`
        );
      }
      if (ev.epistemicTag === "fatto_osservato" && ev.confidence < 0.4) {
        inconsistencies.push(
          `Incongruenza confidenza su "${ev.id}": fatto_osservato con confidenza troppo bassa (${ev.confidence}).`
        );
      }
    }

    const hasExplicitAccept = evidences.some(
      (e) => e.evidenceType === "explicit_feedback" && e.summary.includes('"accepted"')
    );
    const hasExplicitReject = evidences.some(
      (e) => e.evidenceType === "explicit_feedback" && e.summary.includes('"rejected"')
    );
    if (hasExplicitAccept && hasExplicitReject && evidences.length < 4) {
      inconsistencies.push(
        "Segnali espliciti contrastanti (accettazioni e rifiuti) su un campione ridotto di osservazioni."
      );
    }

    if (steps.some((s) => s.status === "completed") && missingInformation.some((m) => m.impact === "high")) {
      inconsistencies.push(
        "Passaggio marcato come completato nonostante la presenza di informazioni obbligatorie mancanti."
      );
    }

    // 9. Determinazione stato del ciclo di vita e stato trace
    const evidenceCounts: Record<EvidenceType, number> = {
      explicit_feedback: evidences.filter((e) => e.evidenceType === "explicit_feedback").length,
      observed_behavior: evidences.filter((e) => e.evidenceType === "observed_behavior").length,
      hypothesis: evidences.filter((e) => e.evidenceType === "hypothesis").length,
    };

    let processLifecycleState: ProcessLifecycleState;
    let traceStatus: MetaCognitiveProcessStatus;

    if (hasBlockedStep) {
      processLifecycleState = "bloccato";
      traceStatus = "blocked";
    } else if (hasSuspendedStep) {
      processLifecycleState = "sospeso";
      traceStatus = "monitoring";
    } else if (hasInProgressStep) {
      processLifecycleState = "in_elaborazione";
      traceStatus = "monitoring";
    } else if (hasStartedOnlyStep) {
      processLifecycleState = "iniziato";
      traceStatus = "monitoring";
    } else if (evidences.length === 0 && missingInformation.length > 0) {
      processLifecycleState = "iniziato";
      traceStatus = "insufficient_data";
    } else if (steps.length === 0 && evidences.length === 0) {
      processLifecycleState = "iniziato";
      traceStatus = "insufficient_data";
    } else if (evidences.length === 0 && steps.every((s) => s.status === "completed")) {
      processLifecycleState = "completato";
      traceStatus = "insufficient_data";
    } else {
      processLifecycleState = "completato";
      traceStatus = "completed";
    }

    stagesExecuted.push("trace_generation");

    const dataSources = Array.from(dataSourcesSet);
    const readableTrace: string[] = [
      `[${nowIso}] Trace ${traceId} — stato processo: ${processLifecycleState} (${traceStatus}).`,
      `Evidenze raccolte: ${evidenceCounts.explicit_feedback} feedback espliciti, ${evidenceCounts.observed_behavior} comportamenti osservati, ${evidenceCounts.hypothesis} ipotesi.`,
      missingInformation.length > 0
        ? `Informazioni mancanti rilevate (${missingInformation.length}): ${missingInformation.map((m) => m.field).join(", ")}.`
        : "Nessuna informazione attesa mancante.",
      incompleteSteps.length > 0
        ? `Passaggi incompleti: ${incompleteSteps.join("; ")}.`
        : "Tutti i passaggi monitorati risultano conclusi.",
      inconsistencies.length > 0
        ? `Incongruenze rilevate (${inconsistencies.length}): ${inconsistencies.join(" | ")}`
        : "Nessuna incongruenza interna rilevata.",
    ];

    return {
      allowed: true,
      advisoryOnly: true,
      readOnly: true,
      processLifecycleState,
      trace: {
        traceId,
        timestamp: nowIso,
        status: traceStatus,
        stagesExecuted,
        evidences,
        missingInformation,
        contradictionsDetected: inconsistencies.length,
        dataSources,
      },
      incompleteSteps,
      inconsistencies,
      evidenceCounts,
      readableTrace,
      safetyDecision,
    };
  } catch {
    return {
      allowed: false,
      advisoryOnly: true,
      readOnly: true,
      processLifecycleState: "bloccato",
      trace: {
        traceId,
        timestamp: nowIso,
        status: "blocked",
        stagesExecuted: ["error_fallback"],
        evidences: [],
        missingInformation: [],
        contradictionsDetected: 0,
        dataSources: [],
      },
      incompleteSteps: [],
      inconsistencies: [],
      evidenceCounts: {
        explicit_feedback: 0,
        observed_behavior: 0,
        hypothesis: 0,
      },
      readableTrace: [
        `[${nowIso}] Errore interno nel Cognitive Process Monitor: blocco fail-closed senza impatto sui motori esistenti.`,
      ],
      safetyDecision: {
        ...safetyDecision,
        allowed: false,
        failClosed: true,
        blockedBy: "internal_error",
      },
    };
  }
}
