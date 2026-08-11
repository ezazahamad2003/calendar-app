"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { applyPlan, planCommand } from "@/lib/voice/actions";
import type { PlanResponse } from "@/lib/voice/actions";

/**
 * Push-to-talk plus typed fallback (SPEC §5: voice is the headline, typing is
 * for when the site is loud, both go through the same path).
 *
 * The flow never auto-executes: speak/type → plan → readable diff → Confirm.
 * The diff is deliberately big-print — it gets read at arm's length in
 * sunlight with a glove on the other hand.
 */

type Stage =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "working"; label: string }
  | { kind: "review"; response: Extract<PlanResponse, { ok: true }> }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

export function VoiceBar() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  function submitText(t: string) {
    const trimmed = t.trim();
    if (!trimmed) return;
    setStage({ kind: "working", label: "Planning…" });
    startTransition(async () => {
      const response = await planCommand({ text: trimmed });
      if (!response.ok) setStage({ kind: "error", message: response.error });
      else setStage({ kind: "review", response });
    });
  }

  async function startRecording() {
    if (stage.kind === "recording") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        if (blob.size === 0) {
          setStage({ kind: "error", message: "Heard nothing. Hold the button while you speak." });
          return;
        }
        setStage({ kind: "working", label: "Transcribing…" });
        const form = new FormData();
        form.append("audio", blob);
        try {
          const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
          const payload = (await res.json()) as { text?: string; error?: string };
          if (!res.ok || !payload.text) {
            setStage({
              kind: "error",
              message: payload.error ?? "Transcription failed. Try again.",
            });
            return;
          }
          setText(payload.text);
          submitText(payload.text);
        } catch {
          setStage({ kind: "error", message: "No connection. Try again when you have signal." });
        }
      };
      recorder.current = mr;
      mr.start();
      setStage({ kind: "recording" });
    } catch {
      setStage({
        kind: "error",
        message: "Microphone blocked. Allow mic access in the browser, or type instead.",
      });
    }
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  function confirm() {
    if (stage.kind !== "review") return;
    const { plan, transcript } = stage.response;
    setStage({ kind: "working", label: "Applying…" });
    startTransition(async () => {
      const result = await applyPlan({ plan, transcript });
      if (!result.ok) setStage({ kind: "error", message: result.error });
      else {
        setStage({ kind: "done", message: `Done — ${result.summary}` });
        setText("");
        router.refresh();
      }
    });
  }

  const review = stage.kind === "review" ? stage.response : null;

  return (
    <>
      {review ? (
        <div className="plan-overlay" role="dialog" aria-modal="true" aria-label="Confirm plan">
          <div className="plan-sheet">
            <p className="plan-summary">{review.preview.summary}</p>
            {review.preview.confidence === "low" ? (
              <p className="plan-lowconf">
                I may have misheard something — check the details before confirming.
              </p>
            ) : null}

            {review.preview.clarification ? (
              <p className="plan-clarify">{review.preview.clarification}</p>
            ) : null}

            {review.preview.moves.length > 0 ? (
              <div className="plan-block">
                {review.preview.moves.map((mv, i) => (
                  <p key={i} className={`plan-move${mv.direct ? "" : " plan-move--cascade"}`}>
                    {mv.direct ? "" : "↳ "}
                    <strong>{mv.name}</strong>{" "}
                    {mv.isNew ? (
                      <>new · {mv.toStart} → {mv.toEnd}</>
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

            {review.preview.statusChanges.map((s, i) => (
              <p key={`s${i}`} className="plan-line">
                <strong>{s.name}</strong> {s.from} → {s.to}
              </p>
            ))}
            {review.preview.assignments.map((a, i) => (
              <p key={`a${i}`} className="plan-line">
                <strong>{a.taskName}</strong> → {a.contactName}
              </p>
            ))}
            {review.preview.newDeps.map((d, i) => (
              <p key={`d${i}`} className="plan-line">
                {d.predecessorName} → {d.successorName} ({d.depType}
                {d.lagDays ? `, ${d.lagDays}d lag` : ""})
              </p>
            ))}
            {review.preview.newContacts.map((c, i) => (
              <p key={`c${i}`} className="plan-line">
                + {c.name}
                {c.trade ? ` · ${c.trade}` : ""}
                {c.company ? ` · ${c.company}` : ""}
              </p>
            ))}
            {review.preview.emails.map((e, i) => (
              <div key={`e${i}`} className="plan-email">
                <p className="plan-line">
                  Email → <strong>{e.recipients.join(", ")}</strong>
                </p>
                <p className="plan-email-subject">{e.subject}</p>
                <p className="plan-email-body">{e.body}</p>
                <p className="plan-email-note">Queued to the outbox — nothing sends until you send it there.</p>
              </div>
            ))}

            <div className="plan-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStage({ kind: "idle" })}
                disabled={pending}
              >
                Cancel
              </button>
              {review.preview.empty || review.preview.clarification ? null : (
                <button type="button" className="btn" onClick={confirm} disabled={pending}>
                  {pending ? "Applying…" : "Confirm"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="voicebar">
        {/* The bar was previously an unlabelled input and a mic glyph, and read
            as a search box — the headline feature of the product was invisible.
            It says what it is now. */}
        <p className="voicebar-label">
          <span className="voicebar-badge">AI</span>
          Tell Foreman what changed
        </p>

        <form
          className="voicebar-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitText(text);
          }}
        >
          <input
            className="voicebar-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Try: "Push framing back two weeks and let Tom know"'
            aria-label="Type a scheduling command"
            disabled={stage.kind === "working" || pending}
          />
          <button
            type="submit"
            className="btn voicebar-go"
            disabled={stage.kind === "working" || pending || !text.trim()}
          >
            Plan
          </button>
        </form>

        <button
          type="button"
          className={`voicebar-mic${stage.kind === "recording" ? " voicebar-mic--live" : ""}`}
          onPointerDown={startRecording}
          onPointerUp={stopRecording}
          onPointerLeave={stopRecording}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              if (stage.kind === "recording") stopRecording();
              else void startRecording();
            }
          }}
          aria-pressed={stage.kind === "recording"}
          aria-label={
            stage.kind === "recording"
              ? "Recording — release to plan"
              : "Hold to talk to the schedule"
          }
        >
          <span className="voicebar-mic-glyph" aria-hidden>
            {stage.kind === "recording" ? "●" : "🎙"}
          </span>
          <span className="voicebar-mic-text" aria-hidden>
            {stage.kind === "recording" ? "Listening" : "Hold to talk"}
          </span>
        </button>

        <div className="voicebar-status" aria-live="polite">
          {stage.kind === "recording" ? "Listening — release when done" : null}
          {stage.kind === "working" ? stage.label : null}
          {stage.kind === "error" ? <span className="voicebar-error">{stage.message}</span> : null}
          {stage.kind === "done" ? stage.message : null}
        </div>
      </div>
    </>
  );
}
