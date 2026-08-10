import { NextResponse, type NextRequest } from "next/server";

import { requireMembership } from "@/lib/auth/dal";
import { getEnv, requireEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Audio blob → transcript, via Whisper (SPEC §5). A route handler rather than
 * a server action because the payload is binary multipart, which actions
 * handle poorly. Auth is the same DAL gate every mutation uses.
 *
 * Push-to-talk clips are seconds long; the 15 MB cap is far above any real
 * clip and far below the platform's own request limit, so a runaway recording
 * fails here with a clear message instead of a 413 from the edge.
 */
const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    await requireMembership();
  } catch {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json(
      { error: "No audio arrived. Hold the button while you speak." },
      { status: 400 },
    );
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That recording is too long. Keep it under a minute." },
      { status: 413 },
    );
  }

  const upstream = new FormData();
  upstream.append("file", audio, "command.webm");
  upstream.append("model", getEnv().OPENAI_STT_MODEL);
  // Whisper drifts less on short clips when told the domain language.
  upstream.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: upstream,
  });

  if (!res.ok) {
    return NextResponse.json(
      { error: `Transcription failed (HTTP ${res.status}). Try again.` },
      { status: 502 },
    );
  }

  const payload = (await res.json().catch(() => null)) as { text?: string } | null;
  const text = payload?.text?.trim();
  if (!text) {
    return NextResponse.json(
      { error: "Heard nothing in that clip. Try again, closer to the mic." },
      { status: 422 },
    );
  }

  return NextResponse.json({ text });
}
