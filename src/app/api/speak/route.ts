export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const text = body.text?.trim();
  if (!text || text.length > 2_000) {
    return Response.json({ error: "Please provide between 1 and 2,000 characters." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "Speech is not configured." }, { status: 503 });

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "tts-1",
      voice: process.env.OPENAI_TTS_VOICE || "nova",
      input: text,
      response_format: "mp3",
      speed: 1.04,
    }),
  });

  if (!response.ok || !response.body) {
    console.error("OpenAI speech failed", response.status, (await response.text()).slice(0, 400));
    return Response.json({ error: "Spoken reply is temporarily unavailable." }, { status: 502 });
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
