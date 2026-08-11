"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { applyPlan, planCommand } from "@/lib/voice/actions";
import type { PlanResponse } from "@/lib/voice/actions";
import { useDictation } from "./use-dictation";

/**
 * The assistant column (SPEC §5: voice is the headline, typing is for when the
 * site is loud, both go through the same path).
 *
 * It lives in the right rail rather than a bar across the bottom because the
 * whole chain is now visible at once — what you said, what it heard, what it
 * plans, what it will send — and that is a column of text, not a strip. The
 * confirm step used to be a full-screen modal over the schedule you were
 * trying to check it against, which is exactly backwards.
 *
 * Nothing auto-executes. Speak or type → plan → readable diff → Confirm.
 */

type Stage =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "transcribing" }
  | { kind: "planning" }
  | { kind: "review"; response: Extract<PlanResponse, { ok: true }> }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

const STEPS = ["Listening", "Transcribing", "Planning", "Ready"] as const;

function stepIndex(stage: Stage): number {
  switch (stage.kind) {
    case "listening":
      return 0;
    case "transcribing":
      return 1;
    case "planning":
      return 2;
    case "review":
    case "done":
      return 3;
    default:
      return -1;
  }
}

export function VoicePanel() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [text, setText] = useState("");
  const [heard, setHeard] = useState("");
  const [pending, startTransition] = useTransition();

  const plan = useCallback((t: string) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    setStage({ kind: "planning" });
    startTransition(async () => {
      const response = await planCommand({ text: trimmed });
      if (!response.ok) setStage({ kind: "error", message: response.error });
      else setStage({ kind: "review", response });
    });
  }, []);

  /** Audio → Whisper → planner, with no tap in between. */
  const transcribeThenPlan = useCallback(
    async (blob: Blob) => {
      setStage({ kind: "transcribing" });
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
          setStage({
            kind: "error",
            message:
              payload.error ??
              `Transcription failed (server said ${res.status}). ` +
                `If this keeps happening, the OpenAI key may be missing.`,
          });
          return;
        }
        setHeard(payload.text);
        setText(payload.text);
        plan(payload.text);
      } catch {
        // Only a genuine network failure reaches here now.
        setStage({ kind: "error", message: "No connection. Try again when you have signal." });
      }
    },
    [plan],
  );

  const mic = useDictation({
    onAudio: (blob) => void transcribeThenPlan(blob),
    onEmpty: (reason) => setStage({ kind: "error", message: reason }),
    onError: (message) => setStage({ kind: "error", message }),
  });

  function toggleMic() {
    if (mic.recording) {
      mic.stop();
      return;
    }
    setHeard("");
    setStage({ kind: "listening" });
    void mic.start();
  }

  function confirm() {
    if (stage.kind !== "review") return;
    const { plan: proposed, transcript } = stage.response;
    setStage({ kind: "planning" });
    startTransition(async () => {
      const result = await applyPlan({ plan: proposed, transcript });
      if (!result.ok) {
        setStage({ kind: "error", message: result.error });
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
      setStage({
        kind: "done",
        message: notes.length > 0 ? `${result.summary} · ${notes.join(", ")}` : result.summary,
      });
      setText("");
      router.refresh();
    });
  }

  const review = stage.kind === "review" ? stage.response : null;
  const busy = pending || stage.kind === "transcribing" || stage.kind === "planning";
  const active = stepIndex(stage);

  return (
    <aside className="assistant" aria-label="Foreman assistant">
      <div className="assistant-head">
        <span className="assistant-badge">AI</span>
        <p className="assistant-title">Tell Foreman what changed</p>
      </div>

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
        <span className="assistant-mic-text">
          {mic.recording ? "Stop" : "Start talking"}
        </span>
      </button>

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
          <p className="assistant-hint">
            Stops on its own when you stop talking, then plans it.
          </p>
        </>
      ) : null}

      {active >= 0 ? (
        <ol className="assistant-steps" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={
                i < active
                  ? "assistant-step assistant-step--done"
                  : i === active
                    ? "assistant-step assistant-step--now"
                    : "assistant-step"
              }
            >
              {label}
            </li>
          ))}
        </ol>
      ) : null}

      {/* Live words while speaking, the final transcript afterwards. */}
      {mic.recording && mic.caption ? (
        <p className="assistant-caption" aria-live="polite">
          {mic.caption}
        </p>
      ) : null}
      {mic.recording && !mic.caption && mic.captionsSupported ? (
        <p className="assistant-caption assistant-caption--waiting">Listening…</p>
      ) : null}
      {!mic.recording && heard ? (
        <div className="assistant-heard">
          <p className="assistant-label">Heard</p>
          <p className="assistant-heard-text">“{heard}”</p>
        </div>
      ) : null}

      <form
        className="assistant-form"
        onSubmit={(e) => {
          e.preventDefault();
          setHeard("");
          plan(text);
        }}
      >
        <textarea
          className="assistant-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder={'Or type: "Push framing back two weeks and let Tom know"'}
          aria-label="Type a scheduling command"
          disabled={busy || mic.recording}
        />
        <button
          type="submit"
          className="btn assistant-go"
          disabled={busy || mic.recording || !text.trim()}
        >
          Plan
        </button>
      </form>

      <div className="assistant-body" aria-live="polite">
        {stage.kind === "error" ? (
          <p className="assistant-error" role="alert">
            {stage.message}
          </p>
        ) : null}

        {stage.kind === "done" ? (
          <p className="assistant-done">Done — {stage.message}</p>
        ) : null}

        {review ? <PlanReview review={review} onConfirm={confirm} onCancel={() => setStage({ kind: "idle" })} busy={pending} /> : null}
      </div>
    </aside>
  );
}

/** The diff, read before anything is written. */
function PlanReview({
  review,
  onConfirm,
  onCancel,
  busy,
}: {
  review: Extract<PlanResponse, { ok: true }>;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const p = review.preview;

  return (
    <div className="plan">
      <p className="plan-summary">{p.summary}</p>

      {p.confidence === "low" ? (
        <p className="plan-lowconf">
          I may have misheard something — check the details before confirming.
        </p>
      ) : null}

      {p.clarification ? <p className="plan-clarify">{p.clarification}</p> : null}

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

      {p.moves.length > 0 ? (
        <div className="plan-block">
          <p className="assistant-label">Schedule</p>
          {p.moves.map((mv, i) => (
            <p key={i} className={`plan-move${mv.direct ? "" : " plan-move--cascade"}`}>
              {mv.direct ? "" : "↳ "}
              <strong>{mv.name}</strong>{" "}
              {mv.isNew ? (
                <>
                  new · {mv.toStart} → {mv.toEnd}
                </>
              ) : (
                <>
                  {mv.fromStart ?? "unscheduled"} → {mv.toStart}
                  {mv.direct ? "" : " (cascaded)"}
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

      {/* Called out separately from the planner's own emails: these are ones
          the app adds on your behalf, and they go the moment you confirm. */}
      {p.notifications.length > 0 ? (
        <div className="plan-block plan-block--notify">
          <p className="assistant-label">Sends on confirm</p>
          {p.notifications.map((n, i) => (
            <p key={`n${i}`} className="plan-line">
              <strong>{n.contactName}</strong> — {n.taskName}
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

      <div className="plan-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {p.empty || p.clarification ? null : (
          <button type="button" className="btn" onClick={onConfirm} disabled={busy}>
            {busy ? "Applying…" : "Confirm"}
          </button>
        )}
      </div>
    </div>
  );
}
