"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import CalendarTimeline from "./calendar-timeline";
import ManagementViews from "./management-views";

type Project = { id: string; name: string; location: string; color: string };
type Person = { id: string; name: string; email: string; role: string; initials: string };
type ScheduleEvent = { id: string; title: string; projectId: string; assigneeIds: string[]; date: string; startTime: string; durationMinutes: number; trade: string; notes: string; createdAt: string };
type Notification = { id: string; eventId: string; personId: string; channel: "email"; status: "sent"; subject: string; createdAt: string };
type ScheduleDatabase = { company: { name: string; timezone: string }; projects: Project[]; people: Person[]; events: ScheduleEvent[]; notifications: Notification[] };
type Message = { id: string; role: "user" | "assistant"; content: string };
type Step = { id: string; label: string; state: "active" | "complete" };
type ViewMode = "day" | "week" | "month" | "year";
type WorkspaceView = "schedule" | "projects" | "crew";

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function fromDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function monthDays(cursor: Date) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
}

function weekDays(cursor: Date) {
  const start = new Date(cursor);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
}

function displayTime(value: string) {
  const [hourValue, minute] = value.split(":").map(Number);
  return `${hourValue % 12 || 12}:${String(minute).padStart(2, "0")} ${hourValue >= 12 ? "PM" : "AM"}`;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function personTone(index: number) { return ["clay", "sage", "gold", "blue", "rose", "plum"][index % 6]; }

function EventButton({ event, project, people, onClick, compact = false }: { event: ScheduleEvent; project?: Project; people: Map<string, Person>; onClick: () => void; compact?: boolean }) {
  return (
    <button className={`event-card ${compact ? "compact" : ""}`} onClick={onClick} style={{ "--event-color": project?.color ?? "#447a72" } as React.CSSProperties} aria-label={`Open ${event.title}`}>
      <span className="event-time">{displayTime(event.startTime)}</span>
      <strong>{event.title}</strong>
      <span className="event-meta">{event.assigneeIds.map((id) => people.get(id)?.name.split(" ")[0]).filter(Boolean).join(", ") || "Unassigned"}</span>
    </button>
  );
}

function MiniYearMonth({ month, year, events, projects, onOpen }: { month: number; year: number; events: ScheduleEvent[]; projects: Project[]; onOpen: () => void }) {
  const firstDay = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstDay + count }, (_, index) => index - firstDay + 1);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const monthEvents = events.filter((event) => Number(event.date.slice(0, 4)) === year && Number(event.date.slice(5, 7)) === month + 1);
  return (
    <button className="mini-month" onClick={onOpen} aria-label={`Open ${monthNames[month]} ${year}`}>
      <div className="mini-month-head"><strong>{monthNames[month]}</strong><span>{monthEvents.length} jobs</span></div>
      <div className="mini-weekdays">{dayNames.map((day) => <span key={day}>{day[0]}</span>)}</div>
      <div className="mini-grid">
        {cells.map((day, index) => {
          if (day < 1) return <span key={`blank-${index}`} />;
          const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const item = monthEvents.find((event) => event.date === key);
          return <span className={key === localDateKey(new Date()) ? "mini-today" : ""} key={key}>{day}{item && <i style={{ background: projectMap.get(item.projectId)?.color }} />}</span>;
        })}
      </div>
    </button>
  );
}

export default function ScheduleDashboard() {
  const today = useMemo(() => new Date(), []);
  const [database, setDatabase] = useState<ScheduleDatabase | null>(null);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12));
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("schedule");
  const [projectFilter, setProjectFilter] = useState("all");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ id: "welcome", role: "assistant", content: "Morning! I can answer questions about the whole calendar or create, move, reassign, and remove work." }]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceReplies, setVoiceReplies] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [loadError, setLoadError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const voiceMonitorRef = useRef<number | null>(null);
  const voiceTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const replyAudioRef = useRef<HTMLAudioElement | null>(null);
  const replyAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/schedule", { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(); return response.json() as Promise<ScheduleDatabase>; })
      .then(setDatabase)
      .catch(() => setLoadError("The local schedule could not be loaded."));
  }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, steps]);

  const projectsById = useMemo(() => new Map(database?.projects.map((project) => [project.id, project]) ?? []), [database]);
  const peopleById = useMemo(() => new Map(database?.people.map((person) => [person.id, person]) ?? []), [database]);
  const filteredEvents = useMemo(() => database?.events.filter((event) => projectFilter === "all" || event.projectId === projectFilter) ?? [], [database, projectFilter]);
  const selectedEvent = database?.events.find((event) => event.id === selectedEventId) ?? null;
  const monthPrefix = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
  const monthEvents = filteredEvents.filter((event) => event.date.startsWith(monthPrefix));
  const todayKey = localDateKey(today);
  const peopleOnSite = new Set(filteredEvents.filter((event) => event.date === todayKey).flatMap((event) => event.assigneeIds)).size;
  const monthHours = monthEvents.reduce((total, event) => total + event.durationMinutes / 60, 0);

  function selectEvent(event: ScheduleEvent) {
    setSelectedEventId(event.id);
    setPanelExpanded(true);
  }

  function setView(mode: ViewMode) {
    setViewMode(mode);
    if (mode === "day" || mode === "week") setCursor(selectedEvent ? fromDateKey(selectedEvent.date) : cursor);
  }

  function shiftPeriod(amount: number) {
    setCursor((current) => {
      const next = new Date(current);
      if (viewMode === "day") next.setDate(next.getDate() + amount);
      if (viewMode === "week") next.setDate(next.getDate() + amount * 7);
      if (viewMode === "month") next.setMonth(next.getMonth() + amount);
      if (viewMode === "year") next.setFullYear(next.getFullYear() + amount);
      return next;
    });
  }

  function periodTitle() {
    if (viewMode === "day") return cursor.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (viewMode === "week") {
      const days = weekDays(cursor);
      return `${days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (viewMode === "year") return String(cursor.getFullYear());
    return `${monthNames[cursor.getMonth()]} ${cursor.getFullYear()}`;
  }

  function prepareCommand(value: string) {
    setInput(value);
    setPanelExpanded(true);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }

  function upsertStep(step: Step) {
    setSteps((current) => current.some((item) => item.id === step.id) ? current.map((item) => item.id === step.id ? step : item) : [...current, step]);
  }


  function stopSpeaking() {
    replyAudioRef.current?.pause();
    replyAudioRef.current = null;
    if (replyAudioUrlRef.current) URL.revokeObjectURL(replyAudioUrlRef.current);
    replyAudioUrlRef.current = null;
    setSpeaking(false);
  }

  async function speakReply(text: string, force = false) {
    if ((!voiceReplies && !force) || !text.trim()) return;
    stopSpeaking();
    try {
      const response = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      replyAudioRef.current = audio;
      replyAudioUrlRef.current = url;
      audio.onplay = () => setSpeaking(true);
      audio.onended = stopSpeaking;
      audio.onerror = stopSpeaking;
      await audio.play();
    } catch {
      stopSpeaking();
    }
  }

  function toggleVoiceReplies() {
    if (voiceReplies) stopSpeaking();
    setVoiceReplies((enabled) => !enabled);
  }
  async function sendMessage(preset?: string) {
    const message = (preset ?? input).trim();
    if (!message || working) return;
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: message };
    const assistantId = crypto.randomUUID();
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", content: "" }]);
    setSteps([]);
    setInput("");
    setWorking(true);
    setPanelExpanded(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history, selectedEventId }) });
      if (!response.ok || !response.body) throw new Error("The assistant did not respond.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let replyForSpeech = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const item = JSON.parse(line) as { type: string; id?: string; label?: string; state?: Step["state"]; text?: string; database?: ScheduleDatabase; changedIds?: string[] };
          if (item.type === "step" && item.id && item.label && item.state) upsertStep({ id: item.id, label: item.label, state: item.state });
          if (item.type === "delta") { replyForSpeech += item.text ?? ""; setMessages((current) => current.map((entry) => entry.id === assistantId ? { ...entry, content: entry.content + (item.text ?? "") } : entry)); }
          if (item.type === "done" && item.database) {
            setDatabase(item.database);
            if (item.changedIds?.length === 1 && item.database.events.some((event) => event.id === item.changedIds?.[0])) setSelectedEventId(item.changedIds[0]);
            if (selectedEventId && !item.database.events.some((event) => event.id === selectedEventId)) setSelectedEventId(null);
          }
          if (item.type === "error") throw new Error(item.text);
        }
        if (done) break;
      }
      if (replyForSpeech.trim()) void speakReply(replyForSpeech);
    } catch (error) {
      setMessages((current) => current.map((entry) => entry.id === assistantId ? { ...entry, content: error instanceof Error ? error.message : "Something went wrong. Please try again." } : entry));
      upsertStep({ id: "error", label: "No calendar changes were made", state: "complete" });
    } finally {
      setWorking(false);
      inputRef.current?.focus();
    }
  }

  async function toggleVoice() {
    if (voiceState !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: "This browser cannot record audio. You can still type the same scheduling request." }]);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        setVoiceState("transcribing");
        if (voiceMonitorRef.current !== null) cancelAnimationFrame(voiceMonitorRef.current);
        if (voiceTimeoutRef.current !== null) window.clearTimeout(voiceTimeoutRef.current);
        voiceMonitorRef.current = null;
        voiceTimeoutRef.current = null;
        void audioContextRef.current?.close();
        audioContextRef.current = null;
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const form = new FormData();
        form.set("audio", blob, recorder.mimeType.includes("mp4") ? "request.m4a" : "request.webm");
        try {
          const response = await fetch("/api/transcribe", { method: "POST", body: form });
          const result = await response.json() as { text?: string; error?: string };
          if (!response.ok) throw new Error(result.error || "Voice transcription failed.");
          if (result.text) {
            setInput(result.text);
            await sendMessage(result.text);
          }
          else throw new Error("I didn’t hear any words. Please record again.");
        } catch (error) {
          setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: error instanceof Error ? error.message : "Voice transcription failed." }]);
        } finally { setVoiceState("idle"); }
      };
      recorder.start();
      setVoiceState("recording");

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();
      let speechDetected = false;
      let lastSpeechAt = startedAt;

      const monitorSilence = () => {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const volume = Math.sqrt(energy / samples.length);
        const now = performance.now();
        if (volume > 0.022) {
          speechDetected = true;
          lastSpeechAt = now;
        }
        if (speechDetected && now - lastSpeechAt > 1300 && recorder.state === "recording") {
          recorder.stop();
          return;
        }
        voiceMonitorRef.current = requestAnimationFrame(monitorSilence);
      };
      voiceMonitorRef.current = requestAnimationFrame(monitorSilence);
      voiceTimeoutRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 60_000);
    } catch {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: "Microphone access was not available. Please allow it in the browser or type your request." }]);
    }
  }

  async function addJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      title: String(form.get("title") ?? ""),
      projectId: String(form.get("projectId") ?? ""),
      assigneeIds: form.getAll("assignees").map(String),
      date: String(form.get("date") ?? ""),
      startTime: String(form.get("startTime") ?? ""),
      durationMinutes: Number(form.get("duration")) * 60,
      trade: String(form.get("trade") ?? "General"),
      notes: String(form.get("notes") ?? ""),
    };
    const response = await fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json() as { database?: ScheduleDatabase; event?: ScheduleEvent; error?: string };
    if (!response.ok || !result.database || !result.event) { setAddError(result.error ?? "The job could not be added."); return; }
    setDatabase(result.database);
    setSelectedEventId(result.event.id);
    setCursor(fromDateKey(result.event.date));
    setAddOpen(false);
    setPanelExpanded(true);
    setSteps([
      { id: "manual", label: `Added ${result.event.title} to the calendar`, state: "complete" },
      ...(result.event.assigneeIds.length ? [{ id: "notify", label: "Demo email sent to assigned crew", state: "complete" as const }] : []),
    ]);
  }

  if (loadError) return <main className="load-state"><div><span>!</span><h1>Schedule unavailable</h1><p>{loadError}</p></div></main>;
  if (!database) return <main className="load-state"><div className="loader" /><p>Opening the job board…</p></main>;

  const renderEvent = (event: ScheduleEvent, compact = false) => <EventButton key={event.id} event={event} project={projectsById.get(event.projectId)} people={peopleById} compact={compact} onClick={() => selectEvent(event)} />;

  return (
    <main className={`app-shell ${panelExpanded ? "assistant-expanded" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">F</span><div><strong>Foreman</strong><small>Northstar Builders</small></div></div>
        <nav className="side-nav" aria-label="Workspace">
          <p>Workspace</p>
          <button className={workspaceView === "schedule" ? "active" : ""} onClick={() => setWorkspaceView("schedule")}><span aria-hidden="true">S</span> Schedule <i>{database.events.length}</i></button>
          <button className={workspaceView === "projects" ? "active" : ""} onClick={() => setWorkspaceView("projects")}><span aria-hidden="true">P</span> Projects <i>{database.projects.length}</i></button>
          <button className={workspaceView === "crew" ? "active" : ""} onClick={() => setWorkspaceView("crew")}><span aria-hidden="true">C</span> Crew <i>{database.people.length}</i></button>
        </nav>
        <div className="project-nav">
          <div className="side-section-title"><p>Projects</p><button onClick={() => setWorkspaceView("projects")} aria-label="Manage projects">+</button></div>
          <button className={projectFilter === "all" ? "selected" : ""} onClick={() => { setProjectFilter("all"); setWorkspaceView("schedule"); }}><span className="project-dot all" />All projects</button>
          {database.projects.map((project) => <button key={project.id} className={projectFilter === project.id ? "selected" : ""} onClick={() => { setProjectFilter(project.id); setWorkspaceView("schedule"); }}><span className="project-dot" style={{ background: project.color }} />{project.name}</button>)}
        </div>
        <div className="sidebar-bottom">
          <div className="crew-row"><div className="crew-stack">{database.people.slice(0, 5).map((person, index) => <span className={`avatar ${personTone(index)}`} key={person.id}>{person.initials}</span>)}</div><span>{database.people.length} crew</span></div>
          <div className="profile"><span className="avatar dark">AW</span><div><strong>Alex Walker</strong><small>Owner</small></div><button aria-label="Account menu">•••</button></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar"><div><span className="eyebrow">FIELD OPERATIONS</span><h1>{workspaceView === "schedule" ? "Construction schedule" : workspaceView === "projects" ? "Project portfolio" : "Crew directory"}</h1></div><div className="top-actions"><span className="sync-note"><i /> Saved locally</span>{workspaceView === "schedule" && <button className="add-job" onClick={() => setAddOpen(true)} data-testid="add-job"><span>+</span> Add job</button>}</div></header>
        {workspaceView === "schedule" ? <>
        <section className="summary-row" aria-label="Schedule summary">
          <div><span className="summary-icon clay">▦</span><p><strong>{monthEvents.length}</strong><small>Jobs this month</small></p></div>
          <div><span className="summary-icon sage">●</span><p><strong>{peopleOnSite}</strong><small>Crew on site today</small></p></div>
          <div><span className="summary-icon gold">◷</span><p><strong>{Math.round(monthHours)}</strong><small>Scheduled hours</small></p></div>
          <div className="week-note"><span>Live plan</span><p>{database.notifications.length} <strong>crew notices</strong></p></div>
        </section>

        <section className="calendar-card" data-testid={`${viewMode}-view`}>
          <div className="calendar-toolbar">
            <div className="calendar-title"><button onClick={() => shiftPeriod(-1)} aria-label="Previous period">‹</button><button onClick={() => shiftPeriod(1)} aria-label="Next period">›</button><h2>{periodTitle()}</h2><button className="today-button" onClick={() => setCursor(new Date(today))}>Today</button></div>
            <div className="view-switch" aria-label="Calendar view">{(["day", "week", "month", "year"] as ViewMode[]).map((mode) => <button key={mode} className={viewMode === mode ? "active" : ""} onClick={() => setView(mode)} aria-label={`${mode[0].toUpperCase()}${mode.slice(1)} view`}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}</div>
          </div>

          {(viewMode === "day" || viewMode === "week") && <CalendarTimeline mode={viewMode} cursor={cursor} events={filteredEvents} projects={projectsById} people={peopleById} timezone={database.company.timezone} onSelect={selectEvent} />}

          {viewMode === "month" && <div className="month-view"><div className="weekday-row">{dayNames.map((day) => <div key={day}>{day}</div>)}</div><div className="calendar-grid">{monthDays(cursor).map((day) => { const key = localDateKey(day); const events = filteredEvents.filter((event) => event.date === key).sort((a, b) => a.startTime.localeCompare(b.startTime)); return <div className={`day-cell ${day.getMonth() !== cursor.getMonth() ? "outside" : ""} ${key === todayKey ? "today" : ""}`} key={key}><button className="date-number" onClick={() => { setCursor(day); setViewMode("day"); }}><span>{day.getDate()}</span>{key === todayKey && <i>Today</i>}</button><div className="day-events">{events.slice(0, 3).map((event) => renderEvent(event))}{events.length > 3 && <span className="more-events">+{events.length - 3} more</span>}</div></div>; })}</div></div>}

          {viewMode === "year" && <div className="year-grid">{Array.from({ length: 12 }, (_, month) => <MiniYearMonth key={month} month={month} year={cursor.getFullYear()} events={filteredEvents} projects={database.projects} onOpen={() => { setCursor(new Date(cursor.getFullYear(), month, 1, 12)); setViewMode("month"); }} />)}</div>}
        </section>
        </> : <ManagementViews mode={workspaceView} database={database} onDatabase={setDatabase} onOpenSchedule={(projectId) => { setProjectFilter(projectId || "all"); setWorkspaceView("schedule"); }} />}
      </section>

      <aside className="assistant-panel">
        <div className="assistant-head"><div className="ai-mark">{"\u2726"}</div><div><strong>Foreman AI</strong><span><i /> Calendar agent</span></div><div className="assistant-head-actions"><button className={`voice-toggle ${voiceReplies ? "on" : ""} ${speaking ? "speaking" : ""}`} onClick={toggleVoiceReplies} aria-label={voiceReplies ? "Turn spoken replies off" : "Turn spoken replies on"}><span>{voiceReplies ? "\u25D6" : "\u25CB"}</span>{speaking ? "Speaking" : voiceReplies ? "Voice on" : "Voice off"}</button><button className="expand-panel" onClick={() => setPanelExpanded((value) => !value)} aria-label={panelExpanded ? "Collapse assistant" : "Expand assistant"}>{panelExpanded ? "\u21E5" : "\u21E4"}</button></div></div>
        <div className="assistant-context"><span>Today</span><strong>{today.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</strong><small>{database.company.timezone.replace("America/", "")}</small></div>

        <div className="messages" aria-live="polite">
          {selectedEvent && <section className="selected-job"><div className="selected-job-head"><span style={{ background: projectsById.get(selectedEvent.projectId)?.color }} /><p>Selected job</p><button onClick={() => setSelectedEventId(null)} aria-label="Clear selected job">×</button></div><strong>{selectedEvent.title}</strong><div className="selected-job-meta"><span>{projectsById.get(selectedEvent.projectId)?.name}</span><span>{selectedEvent.date} · {displayTime(selectedEvent.startTime)} · {formatDuration(selectedEvent.durationMinutes)}</span><span>{selectedEvent.assigneeIds.map((id) => peopleById.get(id)?.name).filter(Boolean).join(", ") || "Unassigned"}</span></div><div className="selected-job-actions"><button onClick={() => prepareCommand("Change this job to ")}>Change</button><button onClick={() => prepareCommand("Add James to this job")}>+ James</button><button className="danger" onClick={() => prepareCommand("Remove this job")}>Remove</button></div></section>}

          {steps.length > 0 && <section className="work-log"><div className="work-log-title"><span>Agent activity</span><small>{working ? "Working" : "Complete"}</small></div>{steps.map((step) => <div className="work-step" key={step.id}><i className={step.state}>{step.state === "complete" ? "✓" : ""}</i><span>{step.label}</span></div>)}</section>}

          {messages.map((message) => <div className={`message-row ${message.role}`} key={message.id}>{message.role === "assistant" && <span className="message-mark">{"\u2726"}</span>}{message.role === "assistant" ? <div className={`message-bubble assistant-card ${message.content ? "" : "pending"}`}>{message.content ? <><div className="message-meta"><span>Foreman reply</span><button onClick={() => void speakReply(message.content, true)} aria-label="Play this reply">{"\u25B6"}</button></div><p className="message-content">{message.content}</p></> : <div className="message-content pending">{working ? <><i /><i /><i /></> : "Request unavailable."}</div>}</div> : <div className="message-bubble">{message.content}</div>}</div>)}
          {messages.length === 1 && <div className="suggestions"><p>Try asking</p><button onClick={() => void sendMessage("Who is working this week and where?")}>Who’s working this week?</button><button onClick={() => prepareCommand("Move tomorrow's plumbing job to 10 AM and add James to it")}>Move a job + add James</button><button onClick={() => prepareCommand("What conflicts do we have this month?")}>Check calendar conflicts</button></div>}
          <div ref={chatEndRef} />
        </div>

        <div className="composer-wrap">
          {voiceState !== "idle" && <div className="listening"><span /><span /><span /><span /> {voiceState === "recording" ? "Listening — I’ll send when you finish speaking" : "Transcribing and sending…"}</div>}
          <div className={`composer ${working ? "busy" : ""}`}><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask about the schedule, or tell Foreman what to change…" rows={3} disabled={working} aria-label="Message Foreman AI" /><div className="composer-actions"><button className={voiceState === "recording" ? "mic active" : "mic"} onClick={() => void toggleVoice()} disabled={working || voiceState !== "idle"} aria-label="Start hands-free voice command">●</button><span>{voiceState === "recording" ? "Auto-send is on" : "Voice or text"}</span><button className="send" onClick={() => void sendMessage()} disabled={!input.trim() || working} aria-label="Send message">↑</button></div></div>
          <p className="ai-note">Crew emails are simulated and recorded locally for this demo.</p>
        </div>
      </aside>

      {addOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddOpen(false); }}><section className="job-modal" role="dialog" aria-modal="true" aria-labelledby="add-job-title"><div className="modal-head"><div><span>NEW SCHEDULE ITEM</span><h2 id="add-job-title">Add a job</h2></div><button onClick={() => setAddOpen(false)} aria-label="Close add job">×</button></div><form onSubmit={(event) => void addJob(event)}><label>Job name<input name="title" required minLength={2} placeholder="e.g. Foundation inspection" /></label><div className="form-row"><label>Project<select name="projectId" required defaultValue={projectFilter !== "all" ? projectFilter : database.projects[0].id}>{database.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>Trade<input name="trade" required defaultValue="General" /></label></div><div className="form-row"><label>Date<input name="date" type="date" required defaultValue={localDateKey(cursor)} /></label><label>Start time<input name="startTime" type="time" required defaultValue="08:00" /></label><label>Hours<input name="duration" type="number" min="0.5" max="12" step="0.5" required defaultValue="2" /></label></div><fieldset><legend>Assign crew <small>Schedule notices will be logged</small></legend><div className="crew-picker">{database.people.map((person, index) => <label key={person.id}><input type="checkbox" name="assignees" value={person.id} /><span className={`avatar ${personTone(index)}`}>{person.initials}</span><span><strong>{person.name}</strong><small>{person.role}</small></span></label>)}</div></fieldset><label>Notes<textarea name="notes" rows={2} placeholder="Optional field notes" /></label>{addError && <p className="form-error">{addError}</p>}<div className="modal-actions"><button type="button" onClick={() => setAddOpen(false)}>Cancel</button><button type="submit">Add to schedule</button></div></form></section></div>}
    </main>
  );
}
