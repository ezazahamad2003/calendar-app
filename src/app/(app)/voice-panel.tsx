"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { applyPlan, askForeman } from "@/lib/voice/actions";
import type { PlanPreview } from "@/lib/voice/actions";
import type { Plan } from "@/lib/voice/schema";
import type { Turn } from "@/lib/voice/agent";
import { useDictation } from "./use-dictation";

/**
 * The assistant column: a conversation, not a command line.
 *
 * It used to be one shot — say a sentence, get a diff, done. Which meant you
 * could not ask it anything ("is Alex free Tuesday?"), could not correct it
 * ("make it Wednesday"), and every sentence started from nothing. Most of what
 * someone running jobs wants to say is a question or a follow-up.
 *
 * So the thread is the interface. Speak or type, it answers; when it wants to
 * change something the diff appears inline in the thread and waits for
 * Confirm. Nothing it says is an action — only Confirm is.
 */

type Message =
  | { kind: "you"; text: string }
  | { kind: "foreman"; text: string }
  | { kind: "proposal"; text: string; plan: Plan; preview: PlanPreview; settled: string | null }
  | { kind: "problem"; text: string };

type Phase = "idle" | "transcribing" | "thinking" | "applying";

export function VoicePanel() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [, startTransition] = useTransition();
  const threadEnd = useRef<HTMLDivElement | null>(null);

  const busy = phase !== "idle";

  // Follow the conversation as it grows, the way a chat should.
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, phase]);

  const send = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      setMessages((m) => [...m, { kind: "you", text: trimmed }]);
      setText("");
      setPhase("thinking");

      startTransition(async () => {
        const result = await askForeman({ text: trimmed, history: turns });

        if (!result.ok) {
          setMessages((m) => [...m, { kind: "problem", text: result.error }]);
          setPhase("idle");
          return;
        }

        setTurns(result.turns);
        setMessages((m) => [
          ...m,
          result.plan && result.preview
            ? {
                kind: "proposal" as const,
                text: result.reply,
                plan: result.plan,
                preview: result.preview,
                settled: null,
              }
            : { kind: "foreman" as const, text: result.reply },
        ]);
        setPhase("idle");
      });
    },
    [turns],
  );

  /** Audio → Whisper → the assistant, with no tap in between. */
  const transcribeThenSend = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      const form = new FormData();
      form.append("audio", blob);
      try {
        const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });

        // A server error can return an HTML page rather than JSON, and
        // res.json() throws on it. Parsing defensively keeps that from
        // surfacing as "no connection", which sends people to check their
        // signal when the real problem is on the server.
        const raw = await res.text();
        let payload: { text?: string; error?: string } = {};
        try {
          payload = JSON.parse(raw) as { text?: string; error?: string };
        } catch {
          payload = {};
        }

        if (!res.ok || !payload.text) {
          setMessages((m) => [
            ...m,
            {
              kind: "problem",
              text:
                payload.error ??
                `Transcription failed (server said ${res.status}). ` +
                  `If this keeps happening, the OpenAI key may be missing.`,
            },
          ]);
          setPhase("idle");
          return;
        }
        send(payload.text);
      } catch {
        // Only a genuine network failure reaches here now.
        setMessages((m) => [
          ...m,
          { kind: "problem", text: "No connection. Try again when you have signal." },
        ]);
        setPhase("idle");
      }
    },
    [send],
  );

  const mic = useDictation({
    onAudio: (blob) => void transcribeThenSend(blob),
    onEmpty: (reason) => {
      setMessages((m) => [...m, { kind: "problem", text: reason }]);
      setPhase("idle");
    },
    onError: (message) => {
      setMessages((m) => [...m, { kind: "problem", text: message }]);
      setPhase("idle");
    },
  });

  function toggleMic() {
    if (mic.recording) {
      mic.stop();
      return;
    }
    void mic.start();
  }

  /** Confirm a proposal, then tell the assistant what happened. */
  function confirm(index: number) {
    const message = messages[index];
    if (message?.kind !== "proposal" || message.settled) return;

    setPhase("applying");
    startTransition(async () => {
      const result = await applyPlan({
        plan: message.plan,
        transcript: message.text,
      });

      if (!result.ok) {
        setMessages((m) => [...m, { kind: "problem", text: result.error }]);
        setPhase("idle");
        return;
      }

      const notes: string[] = [];
      if (result.notified > 0) {
        notes.push(
          result.notifyMocked
            ? `${result.notified} notice${result.notified === 1 ? "" : "s"} simulated`
            : `${result.notified} notified`,
        );
      }
      if (result.notifyFailed > 0) notes.push(`${result.notifyFailed} failed — see Outbox`);
      if (result.calendarWritten > 0) {
        notes.push(`${result.calendarWritten} on your calendar`);
      }
      if (result.calendarFailed > 0) {
        notes.push(`${result.calendarFailed} calendar write${result.calendarFailed === 1 ? "" : "s"} failed`);
      }
      const settled = notes.length > 0 ? `Done · ${notes.join(", ")}` : "Done";

      setMessages((m) =>
        m.map((msg, i) =>
          i === index && msg.kind === "proposal" ? { ...msg, settled } : msg,
        ),
      );
      // The assistant needs to know it landed, or the next turn will offer to
      // do it again. Recorded as a turn, not shown as a message.
      setTurns((t) => [
        ...t,
        { role: "user", content: `[The user confirmed that change. It is now applied.]` },
      ]);
      setPhase("idle");
      router.refresh();
    });
  }

  function discard(index: number) {
    setMessages((m) =>
      m.map((msg, i) =>
        i === index && msg.kind === "proposal" ? { ...msg, settled: "Discarded" } : msg,
      ),
    );
    setTurns((t) => [
      ...t,
      { role: "user", content: "[The user discarded that proposal. Nothing was applied.]" },
    ]);
  }

  return (
    <aside className="assistant" aria-label="Foreman assistant">
      <div className="assistant-head">
        <span className="assistant-badge">AI</span>
        <p className="assistant-title">Foreman</p>
      </div>

      <div className="assistant-thread" aria-live="polite">
        {messages.length === 0 ? (
          <div className="assistant-intro">
            <p>Ask me anything about the jobs, or tell me what changed.</p>
            <ul>
              <li>“Is Alex free on Tuesday?”</li>
              <li>“What&rsquo;s late on Hillcrest?”</li>
              <li>“Push framing back two weeks and let Tom know”</li>
              <li>“Start a job called Chico Flats, plumbing on the 18th”</li>
            </ul>
          </div>
        ) : null}

        {messages.map((message, i) => {
          if (message.kind === "you") {
            return (
              <p key={i} className="msg msg--you">
                {message.text}
              </p>
            );
          }
          if (message.kind === "problem") {
            return (
              <p key={i} className="msg msg--problem" role="alert">
                {message.text}
              </p>
            );
          }
          if (message.kind === "foreman") {
            return (
              <p key={i} className="msg msg--foreman">
                {message.text}
              </p>
            );
          }
          return (
            <div key={i}>
              <p className="msg msg--foreman">{message.text}</p>
              <PlanReview
                preview={message.preview}
                settled={message.settled}
                busy={busy}
                onConfirm={() => confirm(i)}
                onDiscard={() => discard(i)}
              />
            </div>
          );
        })}

        {mic.recording && mic.caption ? (
          <p className="msg msg--you msg--draft">{mic.caption}</p>
        ) : null}

        {phase !== "idle" ? (
          <p className="assistant-working">
            {phase === "transcribing"
              ? "Writing that down…"
              : phase === "applying"
                ? "Applying…"
                : "Thinking…"}
          </p>
        ) : null}

        <div ref={threadEnd} />
      </div>

      {mic.recording ? (
        <>
          {/* Scale rather than width: it animates on the compositor, so a
              60fps meter costs nothing on a mid-range site phone. */}
          <div className="assistant-meter" aria-hidden>
            <span
              className="assistant-meter-fill"
              style={{ transform: `scaleX(${Math.max(0.03, mic.level).toFixed(3)})` }}
            />
          </div>
          <p className="assistant-hint">Stops on its own when you stop talking.</p>
        </>
      ) : null}

      <button
        type="button"
        className={`assistant-mic${mic.recording ? " assistant-mic--live" : ""}`}
        onClick={toggleMic}
        disabled={busy}
        aria-pressed={mic.recording}
      >
        <span className="assistant-mic-glyph" aria-hidden>
          {mic.recording ? "■" : "🎙"}
        </span>
        <span className="assistant-mic-text">{mic.recording ? "Stop" : "Talk"}</span>
      </button>

      <form
        className="assistant-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          className="assistant-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — chat convention, and
            // the alternative is reaching for a button after every sentence.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          rows={2}
          placeholder="Ask or tell…"
          aria-label="Message Foreman"
          disabled={busy || mic.recording}
        />
        <button
          type="submit"
          className="btn assistant-go"
          disabled={busy || mic.recording || !text.trim()}
        >
          Send
        </button>
      </form>
    </aside>
  );
}

/** The diff, read before anything is written. */
function PlanReview({
  preview: p,
  settled,
  busy,
  onConfirm,
  onDiscard,
}: {
  preview: PlanPreview;
  settled: string | null;
  busy: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className={`plan${settled ? " plan--settled" : ""}`}>
      {p.confidence === "low" ? (
        <p className="plan-lowconf">
          I may have misheard something — check the details before confirming.
        </p>
      ) : null}

      {/* Blocks: it needs an answer before anything can happen. */}
      {p.clarification ? <p className="plan-clarify">{p.clarification}</p> : null}

      {/* Does not block: the rest still applies, this is what got left out. */}
      {p.notes ? (
        <p className="plan-note">
          <strong>Note:</strong> {p.notes}
        </p>
      ) : null}

      {p.newProjects.length > 0 ? (
        <div className="plan-block">
          <p className="assistant-label">New job</p>
          {p.newProjects.map((pr, i) => (
            <p key={i} className="plan-line">
              <span className="plan-swatch" style={{ background: pr.color }} aria-hidden />
              <strong>{pr.name}</strong>
              {pr.clientName ? ` · ${pr.clientName}` : ""}
            </p>
          ))}
        </div>
      ) : null}

      {/* Before beside after. "Barney Real Estate" on its own under a NEW JOB
          heading is what let a duplicate look like a rename. */}
      {p.edits.length > 0 ? (
        <div className="plan-block">
          <p className="assistant-label">Changes</p>
          {p.edits.map((e, i) => (
            <p key={i} className="plan-line">
              {e.what}: <span className="plan-was">{e.from}</span> →{" "}
              <strong>{e.to}</strong>
            </p>
          ))}
        </div>
      ) : null}

      {p.moves.length > 0 ? (
        <div className="plan-block">
          <p className="assistant-label">Schedule</p>
          {/* "New" and "Moved" are spelled out. The old line was two ISO dates
              with an arrow between them, which reads as a date range just as
              easily as a move — and a move you didn't ask for is the one thing
              you most need to catch here. */}
          {p.moves.map((mv, i) => (
            <p key={i} className={`plan-move${mv.direct ? "" : " plan-move--cascade"}`}>
              {mv.direct ? "" : "↳ "}
              <strong>{mv.name}</strong>{" "}
              {mv.isNew ? (
                <>
                  <span className="plan-tag plan-tag--new">New</span>{" "}
                  {mv.toStart === mv.toEnd ? mv.toStart : `${mv.toStart} – ${mv.toEnd}`}
                </>
              ) : (
                <>
                  <span className="plan-tag">
                    {mv.direct ? "Moved" : "Knock-on"}
                  </span>{" "}
                  <span className="plan-was">{mv.fromStart ?? "unscheduled"}</span> →{" "}
                  {mv.toStart}
                </>
              )}
            </p>
          ))}
        </div>
      ) : null}

      {p.statusChanges.map((s, i) => (
        <p key={`s${i}`} className="plan-line">
          <strong>{s.name}</strong> {s.from} → {s.to}
        </p>
      ))}
      {p.assignments.map((a, i) => (
        <p key={`a${i}`} className="plan-line">
          <strong>{a.taskName}</strong> → {a.contactName}
        </p>
      ))}
      {p.newDeps.map((d, i) => (
        <p key={`d${i}`} className="plan-line">
          {d.predecessorName} → {d.successorName} ({d.depType}
          {d.lagDays ? `, ${d.lagDays}d lag` : ""})
        </p>
      ))}
      {p.newContacts.map((c, i) => (
        <p key={`c${i}`} className="plan-line">
          + {c.name}
          {c.trade ? ` · ${c.trade}` : ""}
          {c.company ? ` · ${c.company}` : ""}
        </p>
      ))}

      {/* Called out separately from the assistant's own emails: these are ones
          the app adds on your behalf, and they go the moment you confirm. */}
      {p.notifications.length > 0 ? (
        <div className="plan-block plan-block--notify">
          <p className="assistant-label">Sends on confirm</p>
          {p.notifications.map((n, i) => (
            <p key={`n${i}`} className="plan-line">
              <strong>{n.contactName}</strong> — {n.taskName}, {n.when}
              {n.invite ? " · email + calendar invite" : " · email"}
            </p>
          ))}
        </div>
      ) : null}

      {p.emails.map((e, i) => (
        <div key={`e${i}`} className="plan-email">
          <p className="plan-line">
            Email → <strong>{e.recipients.join(", ")}</strong>
          </p>
          <p className="plan-email-subject">{e.subject}</p>
          <p className="plan-email-body">{e.body}</p>
          <p className="plan-email-note">
            Queued to the outbox — nothing sends until you send it there.
          </p>
        </div>
      ))}

      {settled ? (
        <p className="plan-settled">{settled}</p>
      ) : p.empty || p.clarification ? (
        <div className="plan-actions">
          <button type="button" className="btn btn--ghost" onClick={onDiscard} disabled={busy}>
            Dismiss
          </button>
        </div>
      ) : (
        <div className="plan-actions">
          <button type="button" className="btn btn--ghost" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
          <button type="button" className="btn" onClick={onConfirm} disabled={busy}>
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
