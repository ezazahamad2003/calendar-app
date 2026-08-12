"use client";

import { useCallback, useRef, useState } from "react";

import { ask, confirm } from "@/lib/assistant/actions";
import type { Turn } from "@/lib/assistant/agent";
import type { Plan } from "@/lib/ops/schema";
import type { Preview } from "@/lib/ops/preview";
import { useDictation } from "./use-dictation";

/**
 * The part he actually uses.
 *
 * One button. Press it, talk, press it again — or say nothing for a moment and
 * it stops itself. That is the whole interaction the client described: he is
 * on site or in the truck, and the schedule changes because he said so.
 *
 * The important behaviour is what happens *after* the talking. Nothing is
 * applied. The assistant proposes, the app computes the real consequences with
 * its own date engine, and this renders them as a diff with the exact emails
 * that would go out. Only the Confirm button writes.
 */

type Stage = "idle" | "recording" | "transcribing" | "thinking" | "proposed" | "saving";

type Exchange = { you: string; them: string };

export function Assistant({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ good: boolean; text: string } | null>(null);
  const [log, setLog] = useState<Exchange[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const [typed, setTyped] = useState("");
  const lastTranscript = useRef<string | null>(null);
  const lastSource = useRef<"voice" | "ui">("ui");

  const busy = stage === "transcribing" || stage === "thinking" || stage === "saving";

  const send = useCallback(
    async (text: string, source: "voice" | "typed") => {
      setStage("thinking");
      setError(null);
      // Only a spoken turn has a transcript worth keeping. A typed one is
      // already recorded verbatim as the summary's input.
      lastTranscript.current = source === "voice" ? text : null;
      lastSource.current = source === "voice" ? "voice" : "ui";

      const result = await ask(text, turns);

      setTurns(result.turns);
      setLog((l) => [...l, { you: text, them: result.reply || "…" }].slice(-6));

      if (result.error) {
        setError(result.error);
        setPlan(null);
        setPreview(null);
        setStage("idle");
        return;
      }

      if (result.plan && result.preview && !result.preview.empty) {
        setPlan(result.plan);
        setPreview(result.preview);
        setReason(result.plan.reason ?? "");
        setStage("proposed");
        return;
      }

      // A reply with no proposal is an answer to a question, which is most
      // turns.
      setPlan(null);
      setPreview(null);
      setStage("idle");
    },
    [turns],
  );

  const onAudio = useCallback(
    async (blob: Blob) => {
      setStage("transcribing");
      setError(null);

      const form = new FormData();
      form.append("audio", blob, "command.webm");

      let response: Response;
      try {
        response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
      } catch {
        setError("Could not reach the server. Check your signal and try again.");
        setStage("idle");
        return;
      }

      const payload = (await response.json().catch(() => null)) as
        | { text?: string; error?: string }
        | null;

      if (!response.ok || !payload?.text) {
        setError(payload?.error ?? "That recording could not be transcribed.");
        setStage("idle");
        return;
      }

      await send(payload.text, "voice");
    },
    [send],
  );

  const dictation = useDictation({
    onAudio,
    onEmpty: (message) => {
      setError(message);
      setStage("idle");
    },
    onError: (message) => {
      setError(message);
      setStage("idle");
    },
  });

  const toggleMic = () => {
    setFlash(null);
    if (dictation.recording) {
      dictation.stop();
      return;
    }
    setOpen(true);
    setStage("recording");
    setError(null);
    void dictation.start();
  };

  const discard = () => {
    setPlan(null);
    setPreview(null);
    setReason("");
    setStage("idle");
  };

  const apply = async () => {
    if (!plan) return;
    setStage("saving");
    setError(null);

    const result = await confirm(plan, {
      reason: reason.trim() || null,
      notify,
      transcript: lastTranscript.current,
      source: lastSource.current,
    });

    if (!result.ok) {
      setError(result.message);
      setStage("proposed");
      return;
    }

    setFlash({
      good: true,
      text: result.simulated
        ? `${result.message} No mail service is configured, so nothing was actually sent — see History.`
        : result.message,
    });
    setPlan(null);
    setPreview(null);
    setReason("");
    setTurns([]);
    setLog([]);
    setStage("idle");
  };

  if (!enabled) return null;

  return (
    <>
      <div className="talk-dock">
        {flash && (
          <div className={`talk-flash ${flash.good ? "good" : ""}`} role="status">
            {flash.text}
          </div>
        )}

        <div className="talk-row">
          <button
            type="button"
            className={`talk-btn ${dictation.recording ? "live" : ""}`}
            onClick={toggleMic}
            disabled={busy}
            aria-pressed={dictation.recording}
            aria-label={dictation.recording ? "Stop recording" : "Hold a moment and talk"}
          >
            <span
              className="talk-ring"
              style={{ transform: `scale(${1 + dictation.level * 0.55})` }}
              aria-hidden="true"
            />
            <MicIcon recording={dictation.recording} />
            <span className="talk-label">
              {dictation.recording
                ? "Stop"
                : stage === "transcribing"
                  ? "Writing it down"
                  : stage === "thinking"
                    ? "Working it out"
                    : stage === "saving"
                      ? "Saving"
                      : "Talk"}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-ghost talk-type"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "Hide" : "Type"}
          </button>
        </div>

        {dictation.recording && (
          <p className="talk-caption" aria-live="polite">
            {dictation.caption ||
              (dictation.captionsSupported
                ? "Listening…"
                : "Listening — press Stop when you're done.")}
          </p>
        )}
      </div>

      {open && (
        <div className="talk-panel">
          <div className="talk-panel-inner">
            {log.map((entry, i) => (
              <div key={i} className="exchange">
                <p className="you">{entry.you}</p>
                <p className="them">{entry.them}</p>
              </div>
            ))}

            {error && (
              <div className="note note-warn" role="alert">
                {error}
              </div>
            )}

            {preview && plan && (
              <PreviewCard
                preview={preview}
                reason={reason}
                onReason={setReason}
                notify={notify}
                onNotify={setNotify}
                onApply={apply}
                onDiscard={discard}
                saving={stage === "saving"}
              />
            )}

            {!preview && (
              <form
                className="talk-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = typed.trim();
                  if (!text || busy) return;
                  setTyped("");
                  void send(text, "typed");
                }}
              >
                <input
                  className="input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Push the downspouts back two days — they didn't show"
                  disabled={busy}
                  aria-label="Tell the schedule what changed"
                />
                <button className="btn" type="submit" disabled={busy || !typed.trim()}>
                  Send
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function PreviewCard({
  preview,
  reason,
  onReason,
  notify,
  onNotify,
  onApply,
  onDiscard,
  saving,
}: {
  preview: Preview;
  reason: string;
  onReason: (v: string) => void;
  notify: boolean;
  onNotify: (v: boolean) => void;
  onApply: () => void;
  onDiscard: () => void;
  saving: boolean;
}) {
  const [showMail, setShowMail] = useState(false);

  return (
    <div className="proposal">
      <p className="proposal-summary">{preview.summary}</p>

      <ul className="diff">
        {preview.lines.map((line, i) => (
          <li key={i} className={line.cascaded ? "cascaded" : ""}>
            <span className={`diff-tag tag-${line.tag.toLowerCase().replace(/\s+/g, "-")}`}>
              {line.tag}
            </span>
            <span className="diff-name">
              {line.cascaded && <span className="arrow">↳</span>}
              {line.taskName}
              {line.team && <em>{line.team}</em>}
            </span>
            {(line.from || line.to) && (
              <span className="diff-dates num">
                {line.from ?? "no date"} → <b>{line.to ?? "no date"}</b>
                {line.dayShift !== null && (
                  <i>
                    {line.dayShift > 0 ? "+" : ""}
                    {line.dayShift}d
                  </i>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>

      {preview.notices.map((notice, i) => (
        <div key={i} className="note" style={{ marginTop: 8 }}>
          {notice}
        </div>
      ))}

      <div className="field" style={{ marginTop: 12 }}>
        <label className="label" htmlFor="reason">
          Why it moved — the subs read this
        </label>
        <input
          id="reason"
          className="input"
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          placeholder="Crew didn't show"
        />
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => onNotify(e.target.checked)}
        />
        <span>
          {preview.recipients.length === 0
            ? "Email anyone affected"
            : `Email ${preview.recipients.length} ${
                preview.recipients.length === 1 ? "trade" : "trades"
              }`}
        </span>
      </label>

      {notify && preview.recipients.length > 0 && (
        <div className="recipients">
          {preview.recipients.map((r) => (
            <div key={r.email} className="recipient">
              <span className="who">
                {r.name} <span className="num">{r.email}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost peek"
                onClick={() => setShowMail((s) => !s)}
              >
                {showMail ? "Hide" : "Read it"}
              </button>
              {showMail && <pre className="mail-body">{r.body}</pre>}
            </div>
          ))}
        </div>
      )}

      {preview.notNotified.length > 0 && (
        <div className="note" style={{ marginTop: 8 }}>
          <strong className="label">Nobody told about</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
            {preview.notNotified.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="proposal-actions">
        <button className="btn btn-primary" onClick={onApply} disabled={saving}>
          {saving ? "Saving…" : "Confirm"}
        </button>
        <button className="btn" onClick={onDiscard} disabled={saving}>
          Discard
        </button>
      </div>
    </div>
  );
}

function MicIcon({ recording }: { recording: boolean }) {
  return (
    <svg
      className="talk-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {recording ? (
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
      ) : (
        <>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v3" />
        </>
      )}
    </svg>
  );
}
