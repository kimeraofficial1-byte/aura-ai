import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, AudioLines, Brain, CalendarCheck, Check, ChevronRight, Cpu, Database, HeartPulse, History, Lightbulb, Mic, Moon, RotateCcw, Send, Settings2, ShieldCheck, Sparkles, Waves, X } from "lucide-react";
import { AuraDataCenter } from "./components/AuraDataCenter";
import { CognitiveActionCard } from "./components/CognitiveActionCard";
import { EmotionIndicator } from "./components/EmotionIndicator";
import { EmotionalTrendSection } from "./components/EmotionalTrendSection";
import { GrowthDashboardSection } from "./components/GrowthDashboardSection";
import { MemoryModalSection } from "./components/MemoryModalSection";
import { MissionsView } from "./components/MissionsView";
import { OrchestrationDashboard } from "./components/OrchestrationDashboard";
import { PlanningDashboard } from "./components/PlanningDashboard";
import { ProactiveDashboard } from "./components/ProactiveDashboard";
import {
  routeChatMessageWithCoordinator,
  type PendingCognitiveAction,
} from "./cognitive/chatBridge";
import { CognitiveCoordinator } from "./cognitive/cognitiveCoordinator";
import { DataRepository } from "./persistence/dataManagement";
import { VoiceConversationPanel } from "./components/VoiceConversationPanel";
import {
  clearPlansFromStorage,
  createPlan,
  detectOverdueTasks,
  exportPlansData,
  recalculatePlan,
  togglePlanPause,
  transitionTaskStatus,
} from "./planning/planningEngine";
import type { PersonalPlan, PlanHorizon, TaskStatus } from "./planning/types";
import { orchestratePersonalContext } from "./context/contextOrchestrator";
import { formatOrchestratedContextForGemini } from "./context/geminiContextAdapter";
import { buildEmotionalTrendSummaryForGemini } from "./emotion/empathy";
import type { EmotionCategory, EmotionalAnalysis, EmotionalTrendEntry } from "./emotion/types";
import {
  addGrowthGoalStep,
  createGrowthGoal,
  deleteGrowthGoal,
  generateLocalPersonalInsights,
  removeGrowthGoalStep,
  setGrowthGoalStatus,
  toggleGrowthGoalStep,
  updateGrowthGoal,
} from "./growth/engine";
import type {
  GrowthGoal,
  GrowthGoalStatus,
  PersonalInsightsResult,
} from "./growth/types";
import {
  buildMemorySummaryForGemini,
  createEmptyLongTermMemory,
  dedupeAndCap,
  extractLongTermMemoryUpdate,
  syncCompletedMissionsToMemory,
} from "./memory/extractor";
import { isSafeForLongTermMemory } from "./memory/privacyFilter";
import { AuraMemoryStore } from "./memory/storage";
import type { CheckInRecord, LongTermMemory } from "./memory/types";
import {
  generateAdaptiveMissionsLocal,
  transitionMissionStatus,
  updateMissionDetails,
} from "./missions/engine";
import type {
  AdaptiveMission,
  EnergyLevel,
  MissionStatus,
} from "./missions/types";
import {
  AuraClientError,
  requestAdaptiveMissions,
  requestPersonalInsights,
  sendAuraChatMessage,
} from "./services/auraClient";
import type { ChatHistoryItem } from "./types/aura";
import { HandsFreeSessionManager } from "./voice/handsFreeSession";
import { AuraVoiceEngine } from "./voice/voiceEngine";
import type {
  HandsFreeSnapshot,
  TurnTakingConfig,
  TurnTakingSnapshot,
  VoiceRecognitionStatus,
  VoiceSynthesisStatus,
} from "./voice/types";

type Message = ChatHistoryItem & { time: string };

function mapMoodToEmotionCategory(mood: string): EmotionCategory {
  switch (mood) {
    case "Sereno":
      return "Serenità";
    case "Bene":
      return "Gioia";
    case "Teso":
      return "Ansia";
    case "Giù":
      return "Tristezza";
    case "Così così":
    default:
      return "Neutro";
  }
}

function createTrendEntryFromAnalysis(analysis: EmotionalAnalysis): EmotionalTrendEntry {
  return {
    id: `emo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    date: analysis.analyzedAt || new Date().toISOString(),
    primaryEmotion: analysis.primaryEmotion,
    secondaryEmotions: analysis.secondaryEmotions,
    intensity: analysis.intensity,
    confidence: analysis.confidence,
    uncertain: analysis.uncertain,
    stressSignals: analysis.stressSignals,
    source: "chat",
  };
}

function createTrendEntryFromCheckIn(
  mood: string,
  stress: number,
  dateIso: string
): EmotionalTrendEntry {
  return {
    id: `chk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    date: dateIso,
    primaryEmotion: mapMoodToEmotionCategory(mood),
    secondaryEmotions: [],
    intensity: Math.max(0, Math.min(10, Math.round(stress))),
    confidence: 1,
    uncertain: mood === "Così così",
    stressSignals: stress >= 7 ? ["stress elevato al check-in"] : [],
    source: "checkin",
  };
}

function createInitialAdaptiveMissions(): AdaptiveMission[] {
  return generateAdaptiveMissionsLocal(
    {
      availableMinutes: 10,
      energyLevel: "media",
      goals: [],
      preferences: [],
      consentEnabled: false,
      existingMissions: [],
    },
    3
  ).missions;
}

const now = () => new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

function createInitialMessages(): Message[] {
  return [
    {
      role: "assistant",
      text: "Buongiorno. Sono AURA. Questo è uno spazio tranquillo, senza giudizi e senza fretta. Come ti senti oggi?",
      time: now(),
    },
  ];
}

export default function App() {
  const memoryStore = useMemo(() => new AuraMemoryStore(), []);

  const [consent, setConsent] = useState<boolean>(() => memoryStore.getConsent().enabled);
  const [longTermMemory, setLongTermMemory] = useState<LongTermMemory>(() =>
    memoryStore.getConsent().enabled
      ? memoryStore.getLongTermMemory()
      : createEmptyLongTermMemory()
  );
  const [checkIns, setCheckIns] = useState<CheckInRecord[]>(() =>
    memoryStore.getConsent().enabled ? memoryStore.getCheckIns() : []
  );
  const [emotionalTrends, setEmotionalTrends] = useState<EmotionalTrendEntry[]>(() =>
    memoryStore.getConsent().enabled ? memoryStore.getEmotionalTrends() : []
  );

  const dataRepository = useMemo(() => new DataRepository(), []);
  const cognitiveCoordinator = useMemo(
    () => new CognitiveCoordinator({ repository: dataRepository, memoryStore }),
    [dataRepository, memoryStore]
  );
  const [pendingCognitiveAction, setPendingCognitiveAction] =
    useState<PendingCognitiveAction | null>(null);
  const [tab, setTab] = useState<"overview" | "chat" | "missions" | "planning" | "proactive" | "orchestration" | "datacenter" | "progress">("overview");
  const [plans, setPlans] = useState<PersonalPlan[]>(() =>
    dataRepository.getPlans().map((p) => detectOverdueTasks(p))
  );
  const [messages, setMessages] = useState<Message[]>(() => {
    if (!memoryStore.getConsent().enabled) return createInitialMessages();
    const restored = memoryStore.getShortTermMemory().messages;
    return restored.length > 0 ? restored : createInitialMessages();
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [latestAnalysis, setLatestAnalysis] = useState<EmotionalAnalysis | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [stress, setStress] = useState<number>(() => {
    if (!memoryStore.getConsent().enabled) return 5;
    const saved = memoryStore.getCheckIns();
    return saved.length > 0 ? saved[saved.length - 1].stress : 5;
  });
  const [mood, setMood] = useState<string>(() => {
    if (!memoryStore.getConsent().enabled) return "Così così";
    const saved = memoryStore.getCheckIns();
    return saved.length > 0 ? saved[saved.length - 1].mood : "Così così";
  });
  const [missions, setMissions] = useState<AdaptiveMission[]>(() => {
    const saved = dataRepository.getMissions();
    return saved.length > 0 ? saved : createInitialAdaptiveMissions();
  });
  const [growthGoals, setGrowthGoals] = useState<GrowthGoal[]>(() => {
    const saved = dataRepository.getGrowthGoals();
    if (saved.length > 0) return saved;
    if (!memoryStore.getConsent().enabled) return [];
    const legacyTitles = memoryStore.getLongTermMemory().goalsAndStrategies;
    const migratedFromTitles = legacyTitles
      .map((t) => createGrowthGoal({ title: t }))
      .filter((g): g is GrowthGoal => g !== null);
    if (migratedFromTitles.length > 0) {
      dataRepository.saveGrowthGoals(migratedFromTitles);
    }
    return migratedFromTitles;
  });
  const [insightsResult, setInsightsResult] = useState<PersonalInsightsResult | null>(null);
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const [availableMinutes, setAvailableMinutes] = useState<number>(10);
  const [energyLevel, setEnergyLevel] = useState<EnergyLevel>("media");
  const [generatingMissions, setGeneratingMissions] = useState(false);
  const [missionPreferencePrompt, setMissionPreferencePrompt] = useState<string | null>(null);
  const [missionNotice, setMissionNotice] = useState<string | null>(null);
  const [sessionCrisisBlocked, setSessionCrisisBlocked] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const voiceEngine = useMemo(() => new AuraVoiceEngine(), []);
  const voiceCapabilities = useMemo(() => voiceEngine.getCapabilities(), [voiceEngine]);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [autoSpeakResponses, setAutoSpeakResponses] = useState(true);
  const [recognitionStatus, setRecognitionStatus] = useState<VoiceRecognitionStatus>(() =>
    voiceCapabilities.speechRecognitionSupported ? "idle" : "unsupported"
  );
  const [synthesisStatus, setSynthesisStatus] = useState<VoiceSynthesisStatus>(() =>
    voiceCapabilities.speechSynthesisSupported ? "idle" : "unsupported"
  );
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [turnTaking, setTurnTaking] = useState<TurnTakingSnapshot>(() =>
    voiceEngine.getTurnTakingSnapshot()
  );
  const handsFreeManager = useMemo(
    () => new HandsFreeSessionManager(voiceEngine),
    [voiceEngine]
  );
  const [handsFree, setHandsFree] = useState<HandsFreeSnapshot>(() =>
    handsFreeManager.getHandsFreeSnapshot()
  );
  const [status, setStatus] = useState("SISTEMA ONLINE");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const sendMessageRef = useRef<(value?: string) => Promise<void>>(async () => {});

  useEffect(() => {
    handsFreeManager.setCallbacks({
      onSnapshotChange: (snap) => {
        setHandsFree(snap);
        if (snap.lastNotice) {
          setVoiceNotice(snap.lastNotice);
        }
      },
      onRecognitionStatus: setRecognitionStatus,
      onSynthesisStatus: setSynthesisStatus,
      onTranscriptUpdate: (combined, interim) => {
        setInput(combined);
        setInterimTranscript(interim);
      },
      onSubmitTurn: (transcript) => {
        void sendMessageRef.current(transcript);
      },
    });

    voiceEngine.setTurnTakingCallbacks({
      onStateChange: (snapshot) => {
        setTurnTaking(snapshot);
        handsFreeManager.syncFromTurnTaking(snapshot);
      },
      onTurnEnd: (reason) => {
        setInterimTranscript("");
        if (reason === "long_pause") {
          if (handsFreeManager.getHandsFreeSnapshot().enabled && inputRef.current.trim()) {
            handsFreeManager.handleUserTurn(inputRef.current);
          } else {
            setVoiceNotice("Pausa rilevata: puoi rivedere il testo o inviarlo a AURA.");
          }
        } else if (reason === "max_timeout") {
          setVoiceNotice("Ascolto concluso per inattività. Puoi modificare o inviare il testo.");
        }
        setStatus("SISTEMA ONLINE");
      },
    });

    const onVisibilityChange = () => {
      if (document.hidden) {
        handsFreeManager.handleVisibilityHidden();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      handsFreeManager.disableHandsFree();
      voiceEngine.dispose();
    };
  }, [voiceEngine, handsFreeManager]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streamingReply, tab]);
  const listening = recognitionStatus === "listening";
  const speaking = synthesisStatus === "speaking";
  const latestAssistantReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") return messages[i].text;
    }
    return null;
  }, [messages]);
  const completed = missions.filter((m) => m.status === "completata").length;
  const activeMissionCount =
    missions.filter(
      (m) => m.status === "proposta" || m.status === "accettata" || m.status === "completata"
    ).length || 1;
  const activeGoals = useMemo(
    () =>
      dedupeAndCap([
        ...growthGoals.filter((g) => g.status === "attivo").map((g) => g.title),
        ...(consent ? longTermMemory.goalsAndStrategies : []),
      ]),
    [growthGoals, consent, longTermMemory.goalsAndStrategies]
  );
  const stressHistory = checkIns.map((c) => c.stress);
  const stressLabel = stress <= 3 ? "Basso" : stress <= 6 ? "Moderato" : "Elevato";
  const stressColor = stress <= 3 ? "mint" : stress <= 6 ? "amber" : "rose";

  function handleToggleVoiceMode(enabled: boolean) {
    voiceEngine.setVoiceModeEnabled(enabled, {
      onRecognitionStatus: setRecognitionStatus,
      onSynthesisStatus: setSynthesisStatus,
    });
    setVoiceModeEnabled(enabled);
    if (!enabled) {
      setInterimTranscript("");
      setVoiceNotice(null);
      setStatus("SISTEMA ONLINE");
    }
  }

  function handleToggleAutoSpeak(enabled: boolean) {
    voiceEngine.setAutoSpeakResponses(enabled);
    setAutoSpeakResponses(enabled);
  }

  function speakText(text: string, force = false) {
    if (!force && (!voiceModeEnabled || !autoSpeakResponses)) return;
    setVoiceNotice(null);
    voiceEngine.speakReply(text, {
      force,
      callbacks: {
        onStatusChange: setSynthesisStatus,
        onError: (err) => setVoiceNotice(err.message),
      },
    });
  }

  function startListening() {
    if (!voiceModeEnabled) {
      voiceEngine.setVoiceModeEnabled(true);
      setVoiceModeEnabled(true);
    }
    setTab("chat");
    setVoiceNotice(null);
    setInterimTranscript("");
    const started = voiceEngine.startListening(
      {
        onSynthesisStatus: setSynthesisStatus,
        onStatusChange: (next) => {
          setRecognitionStatus(next);
          setStatus(next === "listening" ? "TI STO ASCOLTANDO" : "SISTEMA ONLINE");
        },
        onTranscript: (payload) => {
          setInterimTranscript(payload.interimTranscript);
          setInput(payload.combinedTranscript);
        },
        onError: (err) => {
          setInterimTranscript("");
          setVoiceNotice(err.message);
          setStatus("SISTEMA ONLINE");
        },
      },
      input
    );
    if (!started) {
      setStatus("SISTEMA ONLINE");
    }
  }

  function stopListening() {
    voiceEngine.stopListening(setRecognitionStatus);
    setInterimTranscript("");
    setStatus("SISTEMA ONLINE");
  }

  function handlePauseSpeaking() {
    voiceEngine.pauseSpeaking(setSynthesisStatus);
  }

  function handleResumeSpeaking() {
    voiceEngine.resumeSpeaking(setSynthesisStatus);
  }

  function handleStopSpeaking() {
    voiceEngine.stopSpeaking(setSynthesisStatus);
  }

  function handleInterruptVoice() {
    voiceEngine.interruptAura({
      onSynthesisStatus: setSynthesisStatus,
      onRecognitionStatus: setRecognitionStatus,
    });
    setInterimTranscript("");
    setVoiceNotice("Riproduzione interrotta. Puoi parlare o scrivere quando vuoi.");
    setStatus("SISTEMA ONLINE");
  }

  function handleToggleHandsFree(enabled: boolean) {
    if (enabled) {
      setTab("chat");
      setVoiceModeEnabled(true);
      setAutoSpeakResponses(true);
      handsFreeManager.enableHandsFree();
      handsFreeManager.startHandsFreeSession(input);
    } else {
      handsFreeManager.disableHandsFree();
      setInterimTranscript("");
      setStatus("SISTEMA ONLINE");
    }
  }

  function handleStopHandsFree() {
    handsFreeManager.stopHandsFreeSession("Sessione vivavoce interrotta dall'utente.");
    setInterimTranscript("");
    setStatus("SISTEMA ONLINE");
  }

  function handleUpdateTurnConfig(partial: Partial<TurnTakingConfig>) {
    voiceEngine.setTurnTakingConfig(partial);
  }

  async function requestAiReply(
    cleanMessage: string,
    historySnapshot: Message[],
    updatedMessagesWithUser: Message[]
  ) {
    setBusy(true);
    voiceEngine.notifyProcessingStart();
    setStreamingReply("");
    setChatError(null);
    setStatus("AURA STA ELABORANDO");

    let sawSpeakingInTurn = false;
    const progressiveEnabled = voiceEngine.startProgressiveResponse({
      onStatusChange: (nextStatus) => {
        setSynthesisStatus(nextStatus);
        if (nextStatus === "speaking") {
          sawSpeakingInTurn = true;
        } else if (nextStatus === "idle" && sawSpeakingInTurn) {
          sawSpeakingInTurn = false;
          if (handsFreeManager.getHandsFreeSnapshot().enabled) {
            handsFreeManager.resumeListeningAfterResponse();
          }
        }
      },
      onError: (err) => {
        setVoiceNotice(err.message);
        if (handsFreeManager.getHandsFreeSnapshot().enabled) {
          handsFreeManager.handleHandsFreeError(err);
        }
      },
    });

    try {
      const memorySummary = buildMemorySummaryForGemini({
        consentEnabled: consent,
        memory: longTermMemory,
        checkIns,
      });
      const emotionalTrendSummary = buildEmotionalTrendSummaryForGemini({
        consentEnabled: consent,
        trends: emotionalTrends,
      });
      const orchestrated = orchestratePersonalContext({
        userMessage: cleanMessage,
        history: historySnapshot.slice(-14),
        consentEnabled: consent,
        crisisBlocked: sessionCrisisBlocked,
        currentMood: mood,
        currentStress: stress,
        availableMinutes,
        energyLevel,
        longTermMemory,
        checkIns,
        latestEmotionalAnalysis: latestAnalysis,
        emotionalTrends,
        missions,
        growthGoals,
      });
      const orchestratedContextSummary = formatOrchestratedContextForGemini(orchestrated);

      const data = await sendAuraChatMessage(
        {
          message: cleanMessage,
          history: historySnapshot.slice(-14).map((m) => ({ role: m.role, text: m.text, time: m.time })),
          context: {
            mood,
            stress,
            completedMissions: completed,
            totalMissions: activeMissionCount,
            memorySummary,
            emotionalTrendSummary,
            orchestratedContextSummary,
          },
        },
        {
          onAnalysis: (analysis) => {
            setLatestAnalysis(analysis);
          },
          onChunk: (accumulated) => {
            setStreamingReply(accumulated);
            if (progressiveEnabled) {
              voiceEngine.pushProgressiveAccumulatedText(accumulated);
            }
          },
        }
      );

      const assistantMsg: Message = { role: "assistant", text: data.reply, time: now() };
      const finalMessages = [...updatedMessagesWithUser, assistantMsg];
      setStreamingReply("");
      setMessages(finalMessages);
      setLastFailedMessage(null);
      setStatus("SISTEMA ONLINE");

      if (data.crisisDetected) {
        setLatestAnalysis(null);
        setSessionCrisisBlocked(true);
      } else if (data.emotionalAnalysis) {
        setSessionCrisisBlocked(false);
        setLatestAnalysis(data.emotionalAnalysis);
        if (isSafeForLongTermMemory(cleanMessage)) {
          const trendEntry = createTrendEntryFromAnalysis(data.emotionalAnalysis);
          if (consent) {
            const nextTrends = memoryStore.saveEmotionalTrend(trendEntry, {
              rawText: cleanMessage,
              crisisDetected: false,
            });
            setEmotionalTrends(nextTrends);
          } else {
            setEmotionalTrends((prev) => [...prev, trendEntry].slice(-60));
          }
        }
      }

      if (consent && !data.crisisDetected && isSafeForLongTermMemory(cleanMessage)) {
        memoryStore.saveShortTermMemory(finalMessages);
        const nextLongTerm = extractLongTermMemoryUpdate({
          current: longTermMemory,
          userMessage: cleanMessage,
          crisisDetected: data.crisisDetected,
        });
        if (nextLongTerm !== longTermMemory) {
          setLongTermMemory(nextLongTerm);
          memoryStore.saveLongTermMemory(nextLongTerm);
        }
      }

      voiceEngine.notifyProcessingEnd();
      if (progressiveEnabled) {
        voiceEngine.finishProgressiveResponse(data.reply);
      } else {
        speakText(data.reply, false);
      }
    } catch (error) {
      voiceEngine.cancelProgressiveResponse(setSynthesisStatus);
      voiceEngine.notifyProcessingEnd();
      setStreamingReply("");
      const errMsg =
        error instanceof AuraClientError
          ? error.message
          : "Impossibile contattare AURA AI in questo momento. Riprova tra poco.";
      if (handsFreeManager.getHandsFreeSnapshot().enabled) {
        handsFreeManager.handleHandsFreeError({
          code: "NETWORK",
          message: errMsg,
        });
      }
      setChatError(errMsg);
      setLastFailedMessage(cleanMessage);
      setStatus("ERRORE CONNESSIONE AI");
    } finally {
      setBusy(false);
    }
  }

  function syncOperationalStateFromRepository() {
    const snap = dataRepository.loadSnapshot();
    setPlans(snap.plans.map((p) => detectOverdueTasks(p)));
    if (snap.missions.length > 0) {
      setMissions(snap.missions);
    }
    setGrowthGoals(snap.growthGoals);
  }

  async function sendMessage(value = input) {
    const clean = value.trim();
    if (!clean || busy) return;
    stopListening();
    const historySnapshot = messages;
    const userMsg: Message = { role: "user", text: clean, time: now() };
    const nextMessages = [...messages, userMsg];
    setTab("chat");
    setInput("");
    setInterimTranscript("");
    setMessages(nextMessages);
    setChatError(null);

    try {
      const routed = await routeChatMessageWithCoordinator(cognitiveCoordinator, {
        input: clean,
        consentEnabled: consent,
        crisisBlocked: sessionCrisisBlocked,
        sessionContext: {
          recentMood: mood,
          recentStress: stress,
          activeTab: tab,
        },
      });

      if (routed.mode === "stream_gemini") {
        await requestAiReply(clean, historySnapshot, nextMessages);
        return;
      }

      if (routed.crisisDetected) {
        setLatestAnalysis(null);
        setSessionCrisisBlocked(true);
      }

      if (routed.mode === "awaiting_confirmation" && routed.pendingAction) {
        setPendingCognitiveAction(routed.pendingAction);
      } else {
        setPendingCognitiveAction(null);
      }

      const replyText = routed.reply ?? routed.result.summary;
      const assistantMsg: Message = { role: "assistant", text: replyText, time: now() };
      const finalMessages = [...nextMessages, assistantMsg];
      setMessages(finalMessages);
      syncOperationalStateFromRepository();

      if (consent && !routed.crisisDetected && isSafeForLongTermMemory(clean)) {
        memoryStore.saveShortTermMemory(finalMessages);
      }

      speakText(replyText, false);
    } catch {
      await requestAiReply(clean, historySnapshot, nextMessages);
    }
  }
  sendMessageRef.current = sendMessage;

  async function handleConfirmCognitiveAction() {
    if (!pendingCognitiveAction || busy) return;
    const action = pendingCognitiveAction;
    setBusy(true);
    try {
      const routed = await routeChatMessageWithCoordinator(cognitiveCoordinator, {
        input: action.originalInput,
        consentEnabled: consent,
        crisisBlocked: sessionCrisisBlocked,
        approvedOperationIds: [action.operationId],
        explicitSteps: action.explicitSteps,
      });
      setPendingCognitiveAction(null);
      syncOperationalStateFromRepository();
      const replyText = routed.reply ?? routed.result.summary;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: replyText, time: now() },
      ]);
      speakText(replyText, false);
    } finally {
      setBusy(false);
    }
  }

  function handleCancelCognitiveAction() {
    if (!pendingCognitiveAction) return;
    const cancelledIntent = pendingCognitiveAction.intent;
    setPendingCognitiveAction(null);
    const replyText = `Operazione ${cancelledIntent} annullata. Nessun dato è stato modificato.`;
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: replyText, time: now() },
    ]);
    speakText(replyText, false);
  }

  async function retryLastMessage() {
    if (!lastFailedMessage || busy) return;
    const historyWithoutLastUser =
      messages.length > 0 && messages[messages.length - 1].role === "user"
        ? messages.slice(0, -1)
        : messages;
    await requestAiReply(lastFailedMessage, historyWithoutLastUser, messages);
  }

  function saveCheckin() {
    const record: CheckInRecord = { date: new Date().toISOString(), stress, mood };
    const trendEntry = createTrendEntryFromCheckIn(mood, stress, record.date);
    if (consent) {
      const updated = memoryStore.saveCheckIn(record);
      setCheckIns(updated);
      const updatedTrends = memoryStore.saveEmotionalTrend(trendEntry);
      setEmotionalTrends(updatedTrends);
    } else {
      setCheckIns((prev) => [...prev, record].slice(-60));
      setEmotionalTrends((prev) => [...prev, trendEntry].slice(-60));
    }
    setTab("progress");
  }

  function persistMissionsAndSync(nextMissions: AdaptiveMission[], currentConsent = consent) {
    dataRepository.saveMissions(nextMissions);
    if (!currentConsent) return;
    const completedTitles = nextMissions
      .filter((m) => m.status === "completata")
      .map((m) => m.title);
    const synced = syncCompletedMissionsToMemory(longTermMemory, completedTitles);
    if (synced !== longTermMemory) {
      setLongTermMemory(synced);
      memoryStore.saveLongTermMemory(synced);
    }
  }

  function handleTransitionMissionStatus(id: string, nextStatus: MissionStatus) {
    setMissions((prev) => {
      const next = prev.map((m) =>
        m.id === id ? transitionMissionStatus(m, nextStatus) : m
      );
      persistMissionsAndSync(next);
      return next;
    });
  }

  function handleEditMission(
    id: string,
    patch: { title?: string; description?: string; estimatedMinutes?: number }
  ) {
    setMissions((prev) => {
      const next = prev.map((m) =>
        m.id === id ? updateMissionDetails(m, patch) : m
      );
      persistMissionsAndSync(next);
      return next;
    });
  }

  async function handleGenerateMissions(focusNote?: string) {
    if (generatingMissions || sessionCrisisBlocked) return;
    setGeneratingMissions(true);
    setMissionNotice(null);
    try {
      const result = await requestAdaptiveMissions({
        availableMinutes,
        energyLevel,
        goals: activeGoals,
        preferences: consent ? longTermMemory.preferences : [],
        recentMood: mood,
        recentStress: stress,
        emotionalAnalysis: latestAnalysis,
        consentEnabled: consent,
        existingMissions: missions,
        focusNote: focusNote?.trim() || undefined,
      });

      if (result.blockedBySafety) {
        setSessionCrisisBlocked(true);
        setMissionPreferencePrompt(null);
        return;
      }

      setMissionPreferencePrompt(
        result.askUserPreference ? result.preferencePrompt ?? null : null
      );

      setMissions((prev) => {
        const kept = prev.filter((m) => m.status !== "proposta");
        const next = [...kept, ...result.missions];
        persistMissionsAndSync(next);
        return next;
      });

      setMissionNotice(
        result.fallbackUsed
          ? "Missioni calibrate localmente in base al tuo contesto attuale."
          : "Nuove missioni del giorno calibrate sul tuo contesto."
      );
    } catch {
      const local = generateAdaptiveMissionsLocal({
        availableMinutes,
        energyLevel,
        goals: activeGoals,
        preferences: consent ? longTermMemory.preferences : [],
        recentMood: mood,
        recentStress: stress,
        emotionalAnalysis: latestAnalysis,
        consentEnabled: consent,
        existingMissions: missions,
        focusNote: focusNote?.trim() || undefined,
      });
      setMissionPreferencePrompt(
        local.askUserPreference ? local.preferencePrompt ?? null : null
      );
      setMissions((prev) => {
        const kept = prev.filter((m) => m.status !== "proposta");
        const next = [...kept, ...local.missions];
        persistMissionsAndSync(next);
        return next;
      });
      setMissionNotice("Missioni calibrate localmente in base al tuo contesto.");
    } finally {
      setGeneratingMissions(false);
    }
  }

  function persistGrowthGoals(nextGoals: GrowthGoal[], currentConsent = consent) {
    dataRepository.saveGrowthGoals(nextGoals);
    if (!currentConsent) return;
    const activeTitles = dedupeAndCap(
      nextGoals.filter((g) => g.status === "attivo").map((g) => g.title)
    );
    const nextLongTerm: LongTermMemory = {
      ...longTermMemory,
      goalsAndStrategies: activeTitles,
      updatedAt: new Date().toISOString(),
    };
    memoryStore.saveLongTermMemory(nextLongTerm);
    setLongTermMemory(memoryStore.getLongTermMemory());
  }

  function handleCreateGrowthGoal(title: string, description?: string): boolean {
    const created = createGrowthGoal({ title, description });
    if (!created) return false;
    setGrowthGoals((prev) => {
      const next = [...prev, created];
      persistGrowthGoals(next);
      return next;
    });
    return true;
  }

  function handleEditGrowthGoal(
    id: string,
    patch: { title?: string; description?: string }
  ) {
    setGrowthGoals((prev) => {
      const next = prev.map((g) => (g.id === id ? updateGrowthGoal(g, patch) : g));
      persistGrowthGoals(next);
      return next;
    });
  }

  function handleChangeGrowthGoalStatus(id: string, nextStatus: GrowthGoalStatus) {
    setGrowthGoals((prev) => {
      const next = prev.map((g) =>
        g.id === id ? setGrowthGoalStatus(g, nextStatus) : g
      );
      persistGrowthGoals(next);
      return next;
    });
  }

  function handleDeleteGrowthGoal(id: string) {
    setGrowthGoals((prev) => {
      const next = deleteGrowthGoal(prev, id);
      persistGrowthGoals(next);
      return next;
    });
  }

  function handleAddGrowthGoalStep(goalId: string, stepTitle: string): boolean {
    let added = false;
    setGrowthGoals((prev) => {
      const next = prev.map((g) => {
        if (g.id !== goalId) return g;
        const updated = addGrowthGoalStep(g, stepTitle);
        if (updated !== g) added = true;
        return updated;
      });
      persistGrowthGoals(next);
      return next;
    });
    return added;
  }

  function handleToggleGrowthGoalStep(goalId: string, stepId: string) {
    setGrowthGoals((prev) => {
      const next = prev.map((g) =>
        g.id === goalId ? toggleGrowthGoalStep(g, stepId) : g
      );
      persistGrowthGoals(next);
      return next;
    });
  }

  function handleRemoveGrowthGoalStep(goalId: string, stepId: string) {
    setGrowthGoals((prev) => {
      const next = prev.map((g) =>
        g.id === goalId ? removeGrowthGoalStep(g, stepId) : g
      );
      persistGrowthGoals(next);
      return next;
    });
  }

  async function handleRefreshPersonalInsights(focusPrompt?: string) {
    if (generatingInsights || sessionCrisisBlocked) return;
    setGeneratingInsights(true);
    try {
      const res = await requestPersonalInsights({
        goals: growthGoals,
        preferences: consent ? longTermMemory.preferences : [],
        missions,
        checkIns,
        emotionalTrends: consent ? emotionalTrends : [],
        latestAnalysis,
        consentEnabled: consent,
        focusPrompt: focusPrompt?.trim() || undefined,
      });

      if (res.blockedBySafety) {
        setSessionCrisisBlocked(true);
        setInsightsResult(res);
        return;
      }

      setInsightsResult(res);
    } catch {
      const local = generateLocalPersonalInsights({
        goals: growthGoals,
        preferences: consent ? longTermMemory.preferences : [],
        missions,
        checkIns,
        emotionalTrends: consent ? emotionalTrends : [],
        latestAnalysis,
        consentEnabled: consent,
        focusPrompt: focusPrompt?.trim() || undefined,
      });
      setInsightsResult(local);
    } finally {
      setGeneratingInsights(false);
    }
  }

  function handleAddGoal(goal: string): boolean {
    return handleCreateGrowthGoal(goal);
  }

  function handleRemoveGoal(index: number) {
    const titleToRemove = activeGoals[index];
    if (!titleToRemove) return;
    setGrowthGoals((prev) => {
      const next = prev.filter((g) => g.title !== titleToRemove);
      persistGrowthGoals(next);
      return next;
    });
  }

  function handleToggleConsent(nextEnabled: boolean) {
    memoryStore.setConsent(nextEnabled);
    setConsent(nextEnabled);
    if (nextEnabled) {
      const safeMessages = messages.filter((m) => isSafeForLongTermMemory(m.text));
      memoryStore.saveShortTermMemory(
        safeMessages.length > 0 ? safeMessages : createInitialMessages()
      );
      const completedTitles = missions
        .filter((m) => m.status === "completata")
        .map((m) => m.title);
      const mergedGoals = dedupeAndCap([
        ...longTermMemory.goalsAndStrategies,
        ...growthGoals.filter((g) => g.status === "attivo").map((g) => g.title),
      ]);
      const synced = syncCompletedMissionsToMemory(
        { ...longTermMemory, goalsAndStrategies: mergedGoals },
        completedTitles
      );
      setLongTermMemory(synced);
      memoryStore.saveLongTermMemory(synced);
      checkIns.forEach((c) => memoryStore.saveCheckIn(c));
      emotionalTrends.forEach((t) => memoryStore.saveEmotionalTrend(t));
    } else {
      // Revoca del consenso AI: rimuove solo la memoria personale AI, preservando i dati operativi
      setLongTermMemory(createEmptyLongTermMemory());
      setInsightsResult(null);
      setEmotionalTrends([]);
      setLatestAnalysis(null);
      setCheckIns([]);
    }
  }

  function handleUpdateLongTermMemory(next: LongTermMemory) {
    if (!consent) return;
    memoryStore.saveLongTermMemory(next);
    setLongTermMemory(memoryStore.getLongTermMemory());
  }

  function handleDeleteMemory() {
    // Cancella solo la memoria personale AI, preservando piani, missioni e obiettivi operativi
    memoryStore.clearAllPersonalMemory();
    setLongTermMemory(createEmptyLongTermMemory());
    setMessages(createInitialMessages());
    setCheckIns([]);
    setEmotionalTrends([]);
    setLatestAnalysis(null);
    setInsightsResult(null);
    setSessionCrisisBlocked(false);
    setMissionPreferencePrompt(null);
    setMissionNotice(null);
    setStress(5);
    setMood("Così così");
    setChatError(null);
    setLastFailedMessage(null);
  }

  function updatePlansState(updater: (prev: PersonalPlan[]) => PersonalPlan[]) {
    setPlans((prev) => {
      const next = updater(prev);
      dataRepository.savePlans(next);
      return next;
    });
  }

  function handleCreatePlan(input: {
    declaredGoal: string;
    desiredOutcome?: string;
    horizon: PlanHorizon;
    dailyMinutesLimit: number;
    constraints: string[];
  }) {
    if (sessionCrisisBlocked) return;
    const newPlan = createPlan({
      declaredGoal: input.declaredGoal,
      desiredOutcome: input.desiredOutcome,
      horizon: input.horizon,
      dailyMinutesLimit: input.dailyMinutesLimit,
      constraints: input.constraints,
      consentEnabled: consent,
      crisisBlocked: sessionCrisisBlocked,
      existingMissionTitles: missions.map((m) => m.title),
      growthGoalTitles: growthGoals.filter((g) => g.status === "attivo").map((g) => g.title),
      emotionalTone: latestAnalysis?.primaryEmotion,
    });
    updatePlansState((prev) => [newPlan, ...prev]);
  }

  function handleTogglePausePlan(planId: string) {
    updatePlansState((prev) => prev.map((p) => (p.id === planId ? togglePlanPause(p) : p)));
  }

  function handleRecalculatePlan(planId: string, reason: string, newDailyMinutesLimit?: number) {
    updatePlansState((prev) =>
      prev.map((p) =>
        p.id === planId
          ? recalculatePlan(p, { reason, newDailyMinutesLimit })
          : p
      )
    );
  }

  function handleTransitionPlanTask(planId: string, taskId: string, newStatus: TaskStatus) {
    updatePlansState((prev) =>
      prev.map((p) => (p.id === planId ? transitionTaskStatus(p, taskId, newStatus) : p))
    );
  }

  function handleDeletePlan(planId: string) {
    updatePlansState((prev) => prev.filter((p) => p.id !== planId));
  }

  function handleExportPlans() {
    const json = exportPlansData(plans, consent);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aura-piani-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function handleDeleteAllPlans() {
    clearPlansFromStorage();
    setPlans([]);
  }

  function handleExportData() {
    const bundle = memoryStore.exportBundle({
      shortTermMessages: messages,
      longTermMemory,
      checkIns,
      emotionalTrends,
      missions,
      growthGoals,
    });
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aura-dati-personali-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Waves size={22}/></div><div><b>AURA AI</b><small>WELLNESS INTELLIGENCE</small></div></div>
      <div className="side-label">WORKSPACE</div>
      <nav>
        <button className={tab === "overview" ? "nav-item active" : "nav-item"} onClick={() => setTab("overview")}><Activity size={18}/> Panoramica</button>
        <button className={tab === "chat" ? "nav-item active" : "nav-item"} onClick={() => setTab("chat")}><Brain size={18}/> Conversazione</button>
        <button className={tab === "missions" ? "nav-item active" : "nav-item"} onClick={() => setTab("missions")}><Sparkles size={18}/> Missioni <span className="nav-count">{completed}/{activeMissionCount}</span></button>
        <button className={tab === "planning" ? "nav-item active" : "nav-item"} onClick={() => setTab("planning")}><CalendarCheck size={18}/> Piani {plans.length > 0 && <span className="nav-count">{plans.length}</span>}</button>
        <button className={tab === "proactive" ? "nav-item active" : "nav-item"} onClick={() => setTab("proactive")}><Lightbulb size={18}/> Proattività</button>
        <button className={tab === "orchestration" ? "nav-item active" : "nav-item"} onClick={() => setTab("orchestration")}><Cpu size={18}/> Strumenti</button>
        <button className={tab === "datacenter" ? "nav-item active" : "nav-item"} onClick={() => setTab("datacenter")}><Database size={18}/> Data Center</button>
        <button className={tab === "progress" ? "nav-item active" : "nav-item"} onClick={() => setTab("progress")}><History size={18}/> Progressi</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="privacy-note">
          <ShieldCheck size={17}/>
          <span>
            {consent
              ? "Memoria locale attiva: conversazioni e preferenze salvate in questo browser."
              : "Memoria disattivata: nessun dato personale viene salvato dopo la sessione."}
          </span>
        </div>
        <button className="nav-item" onClick={() => setShowSettings(true)}><Settings2 size={18}/> Impostazioni</button>
        <div className="profile"><div className="avatar">A</div><div><b>Assistente AURA</b><small>Modalità benessere</small></div><span className="online-dot"/></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="mobile-brand"><div className="brand-mark"><Waves size={19}/></div><b>AURA AI</b></div>
        <div className="system-status"><span className="pulse-dot"/>{status}</div>
        <div className="top-actions">
          <button
            type="button"
            className={`memory-status-pill ${consent ? "active" : "inactive"}`}
            onClick={() => setShowSettings(true)}
            title="Gestisci consenso e memoria"
          >
            {consent ? "MEMORIA ATTIVA" : "MEMORIA DISATTIVATA"}
          </button>
          <span className="date">{new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}</span>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Impostazioni"><Settings2 size={19}/></button>
        </div>
      </header>

      {tab === "overview" && <section className="content">
        <div className="welcome-row"><div><div className="eyebrow"><span className="tiny-orb"/> IL TUO SPAZIO PERSONALE</div><h1>Buongiorno.<br/><span>Come stai oggi?</span></h1><p>Prendiamoci un momento per capire di cosa hai bisogno.</p></div>
          <div className={"aura-orb " + (speaking ? "speaking" : "")}><div className="orb-core"><Waves size={34}/></div><div className="orb-ring ring-one"/><div className="orb-ring ring-two"/><div className="orb-ring ring-three"/></div>
        </div>
        <div className="grid two">
          <div className="panel checkin-panel"><div className="panel-head"><div><span className="eyebrow">CHECK-IN QUOTIDIANO</span><h2>Facciamo il punto</h2></div><span className="panel-icon"><HeartPulse size={19}/></span></div>
            <label className="field-label">Come descriveresti il tuo umore?</label>
            <div className="mood-options">{["Sereno","Bene","Così così","Teso","Giù"].map(m => <button key={m} className={mood === m ? "mood selected" : "mood"} onClick={() => setMood(m)}>{m}</button>)}</div>
            <div className="range-head"><label className="field-label">Quanto stress senti oggi?</label><strong>{stress}/10</strong></div>
            <input className="stress-range" type="range" min="0" max="10" value={stress} onChange={e => setStress(Number(e.target.value))}/>
            <div className="range-labels"><span>Per niente</span><span>Molto</span></div>
            <button className="primary-btn full" onClick={saveCheckin}>Salva check-in <ChevronRight size={17}/></button>
          </div>
          <div className="panel talk-panel"><div className="panel-head"><div><span className="eyebrow">AURA CORE</span><h2>Parliamone</h2></div><span className="panel-icon"><AudioLines size={19}/></span></div>
            <p className="talk-copy">Puoi raccontarmi cosa ti passa per la testa. Ti ascolterò senza giudicare e ti aiuterò a individuare un prossimo piccolo passo.</p>
            <div className="voice-visual"><div className="voice-bars">{Array.from({length:25}, (_,i)=><i key={i} style={{height: `${10 + ((i*17)%29)}px`}}/>)}</div><span>{speaking ? "AURA STA PARLANDO" : "PRONTA AD ASCOLTARTI"}</span></div>
            <div className="talk-actions"><button className="primary-btn" onClick={() => setTab("chat")}>Apri conversazione <ChevronRight size={17}/></button><button className="round-btn" onClick={startListening} aria-label="Parla con AURA"><Mic size={19}/></button></div>
          </div>
        </div>
        <div className="section-title"><div><span className="eyebrow">IL TUO EQUILIBRIO</span><h2>Oggi, in sintesi</h2></div><button className="text-btn" onClick={() => setTab("progress")}>Vedi progressi <ChevronRight size={15}/></button></div>
        <div className="grid three">
          <div className="metric-card"><div className="metric-top"><span>STRESS PERCEPITO</span><Activity size={17}/></div><div className="metric-value">{stress}<small>/10</small></div><span className={`metric-status ${stressColor}`}>{stressLabel}</span><div className="mini-track"><i style={{width:`${stress*10}%`}}/></div></div>
          <div className="metric-card"><div className="metric-top"><span>MISSIONI COMPLETATE</span><Check size={17}/></div><div className="metric-value">{completed}<small>/{activeMissionCount}</small></div><span className="metric-caption">Piccoli passi, senza fretta</span><div className="mini-track"><i style={{width:`${Math.round((completed/activeMissionCount)*100)}%`}}/></div></div>
          <div className="metric-card"><div className="metric-top"><span>STATO AURA</span><Sparkles size={17}/></div><div className="metric-value text-value">Presente</div><span className="metric-caption">Pronta quando vuoi</span><div className="status-line"><i/> {consent ? "Gemini AI + Memoria attiva" : "Gemini AI · Memoria disattivata"}</div></div>
        </div>
        <div className="disclaimer"><ShieldCheck size={17}/><span>AURA è uno strumento di supporto al benessere, non formula diagnosi e non sostituisce uno psicologo o un servizio di emergenza.</span></div>
      </section>}

      {tab === "chat" && <section className="content chat-content">
        <div className="chat-heading">
          <div>
            <span className="eyebrow">AURA CORE / SESSIONE PRIVATA</span>
            <h1>Conversazione</h1>
            <p>Uno spazio per esprimerti liberamente.</p>
          </div>
          <div className="mini-aura"><Waves size={21}/></div>
        </div>
        {latestAnalysis && <EmotionIndicator analysis={latestAnalysis} />}
        <VoiceConversationPanel
          capabilities={voiceCapabilities}
          voiceModeEnabled={voiceModeEnabled}
          autoSpeakResponses={autoSpeakResponses}
          recognitionStatus={recognitionStatus}
          synthesisStatus={synthesisStatus}
          turnTaking={turnTaking}
          handsFree={handsFree}
          busy={busy}
          transcriptDraft={input}
          interimTranscript={interimTranscript}
          voiceNotice={voiceNotice}
          latestAssistantReply={latestAssistantReply}
          onToggleVoiceMode={handleToggleVoiceMode}
          onToggleHandsFree={handleToggleHandsFree}
          onStopHandsFree={handleStopHandsFree}
          onToggleAutoSpeak={handleToggleAutoSpeak}
          onStartListening={startListening}
          onStopListening={stopListening}
          onInterrupt={handleInterruptVoice}
          onUpdateTurnConfig={handleUpdateTurnConfig}
          onChangeTranscriptDraft={setInput}
          onSendTranscript={() => void sendMessage(input)}
          onClearTranscript={() => {
            setInput("");
            setInterimTranscript("");
          }}
          onSpeakLatestReply={() => {
            if (latestAssistantReply) speakText(latestAssistantReply, true);
          }}
          onPauseSpeaking={handlePauseSpeaking}
          onResumeSpeaking={handleResumeSpeaking}
          onStopSpeaking={handleStopSpeaking}
        />
        <div className="chat-window">{messages.map((m,i)=><div key={i} className={`message-row ${m.role}`}><div className="message-avatar">{m.role === "assistant" ? <Waves size={16}/> : "TU"}</div><div className="message-bubble"><div className="message-meta">{m.role === "assistant" ? "AURA" : "TU"} <span>{m.time}</span></div>{m.text}</div></div>)}{pendingCognitiveAction && <CognitiveActionCard action={pendingCognitiveAction} busy={busy} onConfirm={() => void handleConfirmCognitiveAction()} onCancel={handleCancelCognitiveAction} />}{busy && streamingReply && <div className="message-row assistant"><div className="message-avatar"><Waves size={16}/></div><div className="message-bubble"><div className="message-meta">AURA <span>{now()}</span></div>{streamingReply}</div></div>}{busy && !streamingReply && <div className="typing"><span/><span/><span/> AURA sta elaborando</div>}{chatError && <div className="chat-error" role="alert"><AlertCircle size={16}/><span>{chatError}</span>{lastFailedMessage && <button className="retry-btn" onClick={() => void retryLastMessage()} disabled={busy}><RotateCcw size={13}/> Riprova</button>}</div>}<div ref={bottomRef}/></div>
        <div className="chat-composer"><button className={`round-btn mic-composer ${listening ? "recording" : ""}`} onClick={listening ? stopListening : startListening} title={listening ? "Interrompi ascolto" : "Parla"} aria-label={listening ? "Interrompi ascolto" : "Parla con AURA"}><Mic size={19}/></button><input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter" && void sendMessage()} placeholder="Scrivi qui quello che senti..." aria-label="Messaggio per AURA" /><button className="send-btn" onClick={()=>void sendMessage()} disabled={!input.trim() || busy} aria-label="Invia messaggio"><Send size={18}/></button></div>
        <div className="chat-foot"><ShieldCheck size={14}/> {consent ? "Memoria attiva su questo dispositivo · AURA AI non costituisce assistenza clinica." : "Memoria disattivata · AURA AI offre supporto al benessere e non costituisce assistenza clinica o medica."}</div>
      </section>}

      {tab === "missions" && (
        <MissionsView
          missions={missions}
          goals={activeGoals}
          availableMinutes={availableMinutes}
          energyLevel={energyLevel}
          consent={consent}
          generating={generatingMissions}
          crisisBlocked={sessionCrisisBlocked}
          preferencePrompt={missionPreferencePrompt}
          generationNotice={missionNotice}
          onChangeAvailableMinutes={setAvailableMinutes}
          onChangeEnergyLevel={setEnergyLevel}
          onGenerateMissions={(note) => void handleGenerateMissions(note)}
          onTransitionStatus={handleTransitionMissionStatus}
          onEditMission={handleEditMission}
          onAddGoal={handleAddGoal}
          onRemoveGoal={handleRemoveGoal}
        />
      )}

      {tab === "planning" && (
        <PlanningDashboard
          plans={plans}
          consent={consent}
          crisisBlocked={sessionCrisisBlocked}
          onCreatePlan={handleCreatePlan}
          onTogglePausePlan={handleTogglePausePlan}
          onRecalculatePlan={handleRecalculatePlan}
          onTransitionTaskStatus={handleTransitionPlanTask}
          onDeletePlan={handleDeletePlan}
          onExportPlans={handleExportPlans}
          onDeleteAllPlans={handleDeleteAllPlans}
        />
      )}

      {tab === "proactive" && (
        <ProactiveDashboard
          plans={plans}
          missions={missions}
          growthGoals={growthGoals}
          consent={consent}
          crisisBlocked={sessionCrisisBlocked}
        />
      )}

      {tab === "orchestration" && (
        <OrchestrationDashboard
          consent={consent}
          crisisBlocked={sessionCrisisBlocked}
        />
      )}

      {tab === "datacenter" && (
        <AuraDataCenter
          repository={dataRepository}
          snapshot={{
            ...dataRepository.loadSnapshot(),
            plans,
            missions,
            growthGoals,
          }}
          consent={consent}
          onRefreshFromRepository={() => {
            const snap = dataRepository.loadSnapshot();
            setPlans(snap.plans.map((p) => detectOverdueTasks(p)));
            setMissions(
              snap.missions.length > 0 ? snap.missions : createInitialAdaptiveMissions()
            );
            setGrowthGoals(snap.growthGoals);
          }}
          onOpenAiMemorySettings={() => setShowSettings(true)}
          onExportAiMemory={handleExportData}
          onDeleteOperationalData={() => {
            dataRepository.deleteOperationalData(true);
            clearPlansFromStorage();
            setPlans([]);
            setMissions(createInitialAdaptiveMissions());
            setGrowthGoals([]);
          }}
        />
      )}

      {tab === "progress" && <section className="content"><div className="page-heading"><span className="eyebrow">PROGRESS CENTER</span><h1>Il tuo percorso.</h1><p>Osservare come ti senti può aiutarti a riconoscere schemi e cambiamenti nel tempo.</p></div><div className="panel progress-panel"><div className="panel-head"><div><span className="eyebrow">CHECK-IN</span><h2>Stress percepito</h2></div><span className="panel-icon"><Activity size={19}/></span></div><div className="chart-placeholder"><div className="chart-y"><span>10</span><span>5</span><span>0</span></div><div className="chart-area"><div className="chart-grid"><i/><i/><i/></div><div className="chart-bars">{(stressHistory.length?stressHistory:[stress]).slice(-14).map((v,i)=><div key={i} className="chart-bar-wrap"><i style={{height:`${Math.max(4,v*10)}%`}}/><span>{i+1}</span></div>)}</div></div></div><p className="chart-note">{consent ? "I valori rappresentano autovalutazioni personali, non misurazioni cliniche. I dati vengono salvati localmente in questo browser." : "Memoria disattivata: i check-in restano visibili solo durante la sessione corrente e non vengono salvati."}</p></div><EmotionalTrendSection trends={emotionalTrends} consent={consent} /><GrowthDashboardSection goals={growthGoals} preferences={consent ? longTermMemory.preferences : []} missions={missions} checkIns={checkIns} emotionalTrends={emotionalTrends} consent={consent} insightsResult={insightsResult} generatingInsights={generatingInsights} crisisBlocked={sessionCrisisBlocked} onCreateGoal={handleCreateGrowthGoal} onEditGoal={handleEditGrowthGoal} onChangeGoalStatus={handleChangeGrowthGoalStatus} onDeleteGoal={handleDeleteGrowthGoal} onAddGoalStep={handleAddGrowthGoalStep} onToggleGoalStep={handleToggleGrowthGoalStep} onRemoveGoalStep={handleRemoveGrowthGoalStep} onRefreshInsights={(prompt) => void handleRefreshPersonalInsights(prompt)} /><div className="grid two"><div className="metric-card"><div className="metric-top"><span>ULTIMO CHECK-IN</span><HeartPulse size={17}/></div><div className="metric-value">{stress}<small>/10</small></div><span className="metric-caption">Stress percepito oggi</span></div><div className="metric-card"><div className="metric-top"><span>UMORE DICHIARATO</span><Moon size={17}/></div><div className="metric-value text-value">{mood}</div><span className="metric-caption">La tua percezione attuale</span></div></div></section>}
    </main>

    <nav className="mobile-nav" aria-label="Navigazione mobile">
      <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><Activity size={17}/><span>Panoramica</span></button>
      <button type="button" className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}><Brain size={17}/><span>Chat</span></button>
      <button type="button" className={tab === "missions" ? "active" : ""} onClick={() => setTab("missions")}><Sparkles size={17}/><span>Missioni</span></button>
      <button type="button" className={tab === "planning" ? "active" : ""} onClick={() => setTab("planning")}><CalendarCheck size={17}/><span>Piani</span></button>
      <button type="button" className={tab === "proactive" ? "active" : ""} onClick={() => setTab("proactive")}><Lightbulb size={17}/><span>Proattività</span></button>
      <button type="button" className={tab === "orchestration" ? "active" : ""} onClick={() => setTab("orchestration")}><Cpu size={17}/><span>Strumenti</span></button>
      <button type="button" className={tab === "datacenter" ? "active" : ""} onClick={() => setTab("datacenter")}><Database size={17}/><span>Dati</span></button>
      <button type="button" className={tab === "progress" ? "active" : ""} onClick={() => setTab("progress")}><History size={17}/><span>Progressi</span></button>
    </nav>

    {showSettings && <div className="modal-backdrop" onClick={()=>setShowSettings(false)}><div className="settings-modal settings-modal-wide" onClick={e=>e.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">CONFIGURAZIONE</span><h2>Impostazioni AURA</h2></div><button className="icon-btn" onClick={()=>setShowSettings(false)} aria-label="Chiudi impostazioni"><X size={19}/></button></div><label className="setting-row"><div><b>Modalità vocale</b><small>Abilita i controlli vocali e la lettura naturale delle risposte in italiano.</small></div><input type="checkbox" checked={voiceModeEnabled} onChange={e=>handleToggleVoiceMode(e.target.checked)} aria-label="Modalità vocale"/></label><label className="setting-row"><div><b>Lettura automatica risposte</b><small>Legge automaticamente le risposte di AURA quando la modalità vocale è attiva.</small></div><input type="checkbox" checked={autoSpeakResponses} onChange={e=>handleToggleAutoSpeak(e.target.checked)} aria-label="Lettura automatica risposte"/></label><label className="setting-row"><div><b>Consenso alla memoria locale</b><small>Salva su questo browser la cronologia recente, preferenze, obiettivi e check-in. Disattivandola, ogni dato salvato viene rimosso.</small></div><input type="checkbox" checked={consent} onChange={e=>handleToggleConsent(e.target.checked)} aria-label="Consenso alla memoria locale"/></label><MemoryModalSection consent={consent} memory={longTermMemory} onUpdateMemory={handleUpdateLongTermMemory} onExportData={handleExportData} onDeleteMemory={handleDeleteMemory} /><div className="safety-box"><ShieldCheck size={18}/><span>Contenuti di crisi o informazioni cliniche/sanitarie non vengono mai memorizzati automaticamente. AURA non formula diagnosi mediche né sostituisce un professionista sanitario.</span></div><button className="primary-btn full" onClick={()=>setShowSettings(false)}>Salva e chiudi</button></div></div>}
  </div>;
}
