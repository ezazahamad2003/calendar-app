export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice is not configured." }, { status: 503 });

  const incoming = await request.formData().catch(() => null);
  const audio = incoming?.get("audio");
  if (!audio || typeof audio === "string" || audio.size === 0) {
    return Response.json({ error: "No recording was received." }, { status: 400 });
  }
  if (audio.size > 20 * 1024 * 1024) {
    return Response.json({ error: "That recording is too long for this demo." }, { status: 413 });
  }

  const payload = new FormData();
  payload.set("file", audio, audio.name || "foreman-recording.webm");
  payload.set("model", process.env.OPENAI_STT_MODEL || "whisper-1");
  payload.set("language", "en");
  payload.set("prompt", "Construction scheduling request with project names, crew names, dates, and times.");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: payload,
  });
  if (!response.ok) {
    console.error("OpenAI transcription failed", response.status, (await response.text()).slice(0, 400));
    return Response.json({ error: "I couldn’t transcribe that recording. Please try again." }, { status: 502 });
  }

  const result = await response.json() as { text?: string };
  return Response.json({ text: result.text?.trim() ?? "" });
}
