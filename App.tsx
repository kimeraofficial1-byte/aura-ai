import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AudioLines, Brain, Check, ChevronRight, CircleHelp, HeartPulse, History, Menu, Mic, MicOff, Moon, Send, Settings2, ShieldCheck, Sparkles, Volume2, Waves, Wind, X } from "lucide-react";

type Message = { role: "assistant" | "user"; text: string; time: string };
type Mission = { id: number; title: string; detail: string; duration: string; done: boolean; icon: string };

const initialMissions: Mission[] = [
  { id: 1, title: "Pausa consapevole", detail: "Fermati, appoggia i piedi a terra e fai cinque respiri lenti, senza forzare il ritmo.", duration: "2 minuti", done: false, icon: "◌" },
  { id: 2, title: "Piccola passeggiata", detail: "Se te la senti e puoi farlo in sicurezza, cammina a passo comodo e nota tre cose intorno a te.", duration: "10–15 minuti", done: false, icon: "↗" },
  { id: 3, title: "Svuota la mente", detail: "Scrivi una preoccupazione e un piccolo passo realistico che potresti fare.", duration: "5 minuti", done: false, icon: "✎" }
];

const now = () => new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

function demoReply(input: string) {
  const s = input.toLowerCase();
  if (/(suicid|ammazz|uccidermi|farla finita|autolesion|non voglio vivere)/.test(s)) {
    return "Mi dispiace che tu stia vivendo qualcosa di così pesante. La tua sicurezza viene prima di tutto. Se pensi di poterti fare del male o sei in pericolo immediato, chiama subito il 112 o vai al pronto soccorso. Se puoi, raggiungi una persona fidata e dille chiaramente che hai bisogno di aiuto adesso. Non devi affrontare questo momento da solo. Posso restare qui mentre cerchi supporto, ma non sono un servizio di emergenza.";
  }
  if (/(ansia|agit|panico|paura|preoccup)/.test(s)) {
    return "Ti ascolto. Proviamo a non risolvere tutto in una volta. Qual è la preoccupazione che occupa più spazio nella tua testa proprio adesso? Se ti va, descrivila in una o due frasi. Poi individueremo insieme un passo piccolo e concreto.";
  }
  if (/(stanc|esaust|sonno|dorm)/.test(s)) {
    return "La stanchezza può rendere tutto più difficile. Prima di aggiungere altri impegni, vorrei capire: è soprattutto stanchezza fisica, mentale, oppure entrambe? Per ora, se puoi, concediti una breve pausa senza schermi e senza obbligo di essere produttivo.";
  }
  if (/(arrabbi|rabbia|nervos|litig)/.test(s)) {
    return "Sembra che qualcosa abbia acceso molta tensione. Non dobbiamo giudicare questa emozione: possiamo provare a capirla. Che cosa è successo subito prima che la rabbia aumentasse?";
  }
  if (/(bene|felice|content|tranquill)/.test(s)) {
    return "È bello sapere che oggi c'è qualcosa che ti fa stare bene. Proviamo a riconoscere cosa ha contribuito a questo stato: è successo qualcosa, hai riposato meglio o hai trovato un momento tutto tuo?";
  }
  return "Grazie per avermelo raccontato. Vorrei capire meglio, senza saltare a conclusioni: qual è la parte più difficile di questa situazione per te, in questo momento?";
}

async function getAssistantReply(input: string): Promise<string> {
  // In modalità demo usa risposte locali. Quando il backend AI sarà configurato,
  // il client userà POST /api/chat senza esporre chiavi segrete nel browser.
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: input })
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data.reply === "string" && data.reply.trim()) return data.reply;
    }
  } catch { /* server AI non avviato: fallback demo */ }
  return demoReply(input);
}

export default function App() {
  const [tab, setTab] = useState<"overview" | "chat" | "missions" | "progress">("overview");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "Buongiorno. Sono AURA. Questo è uno spazio tranquillo, senza giudizi e senza fretta. Come ti senti oggi?", time: now() }
  ]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stress, setStress] = useState(5);
  const [mood, setMood] = useState("Così così");
  const [missions, setMissions] = useState(initialMissions);
  const [history, setHistory] = useState<number[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState("SISTEMA ONLINE");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, tab]);
  const completed = missions.filter(m => m.done).length;
  const stressLabel = stress <= 3 ? "Basso" : stress <= 6 ? "Moderato" : "Elevato";
  const stressColor = stress <= 3 ? "mint" : stress <= 6 ? "amber" : "rose";

  const SpeechRecognition = useMemo(() => {
    return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  }, []);

  function speak(text: string) {
    if (!voiceEnabled || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "it-IT"; utterance.rate = 0.96; utterance.pitch = 0.92;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  function startListening() {
    if (!SpeechRecognition) { setStatus("VOCE NON SUPPORTATA DAL BROWSER"); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "it-IT"; recognition.interimResults = false; recognition.maxAlternatives = 1;
    recognition.onstart = () => { setListening(true); setStatus("TI STO ASCOLTANDO"); };
    recognition.onend = () => { setListening(false); setStatus("SISTEMA ONLINE"); };
    recognition.onerror = () => { setListening(false); setStatus("MICROFONO NON DISPONIBILE"); };
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) { setInput(transcript); void sendMessage(transcript); }
    };
    recognition.start();
  }

  async function sendMessage(value = input) {
    const clean = value.trim();
    if (!clean || busy) return;
    setTab("chat"); setInput(""); setBusy(true);
    setMessages(prev => [...prev, { role: "user", text: clean, time: now() }]);
    const reply = await getAssistantReply(clean);
    setMessages(prev => [...prev, { role: "assistant", text: reply, time: now() }]);
    setBusy(false);
    speak(reply);
  }

  function saveCheckin() {
    const record = { date: new Date().toISOString(), stress, mood };
    const old = JSON.parse(localStorage.getItem("aura-checkins") || "[]");
    localStorage.setItem("aura-checkins", JSON.stringify([...old, record].slice(-60)));
    setHistory(prev => [...prev, stress]);
    setTab("progress");
  }

  function toggleMission(id: number) {
    setMissions(prev => prev.map(m => m.id === id ? { ...m, done: !m.done } : m));
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Waves size={22}/></div><div><b>AURA AI</b><small>WELLNESS INTELLIGENCE</small></div></div>
      <div className="side-label">WORKSPACE</div>
      <nav>
        <button className={tab === "overview" ? "nav-item active" : "nav-item"} onClick={() => setTab("overview")}><Activity size={18}/> Panoramica</button>
        <button className={tab === "chat" ? "nav-item active" : "nav-item"} onClick={() => setTab("chat")}><Brain size={18}/> Conversazione</button>
        <button className={tab === "missions" ? "nav-item active" : "nav-item"} onClick={() => setTab("missions")}><Sparkles size={18}/> Missioni <span className="nav-count">{completed}/{missions.length}</span></button>
        <button className={tab === "progress" ? "nav-item active" : "nav-item"} onClick={() => setTab("progress")}><History size={18}/> Progressi</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="privacy-note"><ShieldCheck size={17}/><span>I tuoi dati restano in questo browser in modalità demo.</span></div>
        <button className="nav-item" onClick={() => setShowSettings(true)}><Settings2 size={18}/> Impostazioni</button>
        <div className="profile"><div className="avatar">A</div><div><b>Assistente AURA</b><small>Modalità benessere</small></div><span className="online-dot"/></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="mobile-brand"><div className="brand-mark"><Waves size={19}/></div><b>AURA AI</b></div>
        <div className="system-status"><span className="pulse-dot"/>{status}</div>
        <div className="top-actions"><span className="date">{new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}</span><button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Impostazioni"><Settings2 size={19}/></button></div>
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
          <div className="metric-card"><div className="metric-top"><span>MISSIONI COMPLETATE</span><Check size={17}/></div><div className="metric-value">{completed}<small>/{missions.length}</small></div><span className="metric-caption">Piccoli passi, senza fretta</span><div className="mini-track"><i style={{width:`${completed/missions.length*100}%`}}/></div></div>
          <div className="metric-card"><div className="metric-top"><span>STATO AURA</span><Sparkles size={17}/></div><div className="metric-value text-value">Presente</div><span className="metric-caption">Pronta quando vuoi</span><div className="status-line"><i/> Tutti i moduli demo attivi</div></div>
        </div>
        <div className="disclaimer"><ShieldCheck size={17}/><span>AURA è uno strumento di supporto al benessere, non formula diagnosi e non sostituisce uno psicologo o un servizio di emergenza.</span></div>
      </section>}

      {tab === "chat" && <section className="content chat-content">
        <div className="chat-heading"><div><span className="eyebrow">AURA CORE / SESSIONE PRIVATA</span><h1>Conversazione</h1><p>Uno spazio per esprimerti liberamente.</p></div><div className="mini-aura"><Waves size={21}/></div></div>
        <div className="chat-window">{messages.map((m,i)=><div key={i} className={`message-row ${m.role}`}><div className="message-avatar">{m.role === "assistant" ? <Waves size={16}/> : "TU"}</div><div className="message-bubble"><div className="message-meta">{m.role === "assistant" ? "AURA" : "TU"} <span>{m.time}</span></div>{m.text}</div></div>)}{busy && <div className="typing"><span/><span/><span/> AURA sta elaborando</div>}<div ref={bottomRef}/></div>
        <div className="chat-composer"><button className={`round-btn mic-composer ${listening ? "recording" : ""}`} onClick={startListening} title="Parla"><Mic size={19}/></button><input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter" && void sendMessage()} placeholder="Scrivi qui quello che senti..." /><button className="send-btn" onClick={()=>void sendMessage()} disabled={!input.trim() || busy}><Send size={18}/></button></div>
        <div className="chat-foot"><ShieldCheck size={14}/> Le risposte della demo sono esempi e non costituiscono assistenza clinica.</div>
      </section>}

      {tab === "missions" && <section className="content"><div className="page-heading"><span className="eyebrow">MISSION CONTROL</span><h1>Piccoli passi.<br/><span>Il tuo ritmo.</span></h1><p>Attività semplici e facoltative. Puoi saltarle o modificarle in base a come ti senti.</p></div><div className="mission-progress"><div><b>{completed} di {missions.length}</b><span>missioni completate</span></div><div className="progress-track"><i style={{width:`${completed/missions.length*100}%`}}/></div></div><div className="mission-list">{missions.map(m=><div className={`mission-card ${m.done?"done":""}`} key={m.id}><div className="mission-symbol">{m.icon}</div><div className="mission-info"><div className="mission-kicker">MISSIONE {String(m.id).padStart(2,"0")} · {m.duration}</div><h3>{m.title}</h3><p>{m.detail}</p></div><button className={m.done?"complete-btn checked":"complete-btn"} onClick={()=>toggleMission(m.id)}>{m.done?<><Check size={16}/> Completata</>:"Segna completata"}</button></div>)}</div><div className="disclaimer"><CircleHelp size={17}/><span>Se un'attività non è adatta o non ti va, non devi completarla. Il benessere non è una gara.</span></div></section>}

      {tab === "progress" && <section className="content"><div className="page-heading"><span className="eyebrow">PROGRESS CENTER</span><h1>Il tuo percorso.</h1><p>Osservare come ti senti può aiutarti a riconoscere schemi e cambiamenti nel tempo.</p></div><div className="panel progress-panel"><div className="panel-head"><div><span className="eyebrow">CHECK-IN</span><h2>Stress percepito</h2></div><span className="panel-icon"><Activity size={19}/></span></div><div className="chart-placeholder"><div className="chart-y"><span>10</span><span>5</span><span>0</span></div><div className="chart-area"><div className="chart-grid"><i/><i/><i/></div><div className="chart-bars">{(history.length?history:[stress]).slice(-14).map((v,i)=><div key={i} className="chart-bar-wrap"><i style={{height:`${Math.max(4,v*10)}%`}}/><span>{i+1}</span></div>)}</div></div></div><p className="chart-note">I valori rappresentano autovalutazioni personali, non misurazioni cliniche. I dati vengono salvati localmente in questo browser.</p></div><div className="grid two"><div className="metric-card"><div className="metric-top"><span>ULTIMO CHECK-IN</span><HeartPulse size={17}/></div><div className="metric-value">{stress}<small>/10</small></div><span className="metric-caption">Stress percepito oggi</span></div><div className="metric-card"><div className="metric-top"><span>UMORE DICHIARATO</span><Moon size={17}/></div><div className="metric-value text-value">{mood}</div><span className="metric-caption">La tua percezione attuale</span></div></div></section>}
    </main>

    {showSettings && <div className="modal-backdrop" onClick={()=>setShowSettings(false)}><div className="settings-modal" onClick={e=>e.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">CONFIGURAZIONE</span><h2>Impostazioni AURA</h2></div><button className="icon-btn" onClick={()=>setShowSettings(false)}><X size={19}/></button></div><label className="setting-row"><div><b>Risposte vocali</b><small>AURA legge ad alta voce le proprie risposte.</small></div><input type="checkbox" checked={voiceEnabled} onChange={e=>setVoiceEnabled(e.target.checked)}/></label><label className="setting-row"><div><b>Consenso alla memoria locale</b><small>La demo salva solo i check-in su questo dispositivo. La memoria delle chat non è attiva.</small></div><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/></label><div className="safety-box"><ShieldCheck size={18}/><span>La versione dimostrativa non invia dati a un servizio AI. Prima di attivare un modello esterno saranno configurati consenso, protezione e gestione dei dati.</span></div><button className="primary-btn full" onClick={()=>setShowSettings(false)}>Salva e chiudi</button></div></div>}
  </div>;
}
