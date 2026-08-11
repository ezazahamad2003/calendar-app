"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Press-to-start, press-to-stop dictation that also stops itself.
 *
 * Three things happen at once while recording, and they are independent on
 * purpose:
 *
 *   1. MediaRecorder captures the audio that gets sent to Whisper. This is the
 *      only transcript that is ever acted on.
 *   2. An AnalyserNode measures loudness, which drives both the level meter
 *      and the silence detection that ends the recording.
 *   3. SpeechRecognition, where the browser has it, produces interim words to
 *      show while speaking. These are throwaway — Chrome and Edge only, and
 *      noticeably worse than Whisper on trade names and site slang.
 *
 * Splitting 3 from 1 is what makes the live caption safe: the words on screen
 * come from the fast, sloppy engine, the words that change the schedule come
 * from the accurate, slow one. The caption is a progress indicator that
 * happens to be readable, not an input.
 */

/** Speech must exceed the calibrated noise floor by this much (RMS, 0–1). */
const SPEECH_MARGIN = 0.02;
/** Absolute floor, so a silent room with a hot mic doesn't self-trigger. */
const MIN_THRESHOLD = 0.02;
/** How long the room stays quiet before we call it finished. */
const SILENCE_MS = 1800;
/** Give up if nothing was ever said — a muted or dead mic. */
const NO_SPEECH_MS = 8000;
/** Hard cap. Whisper's own limit is far higher; this is about cost and typos. */
const MAX_MS = 90_000;
/** Noise floor is averaged over this window before detection starts. */
const CALIBRATE_MS = 400;

export type DictationState = {
  recording: boolean;
  /** 0–1, for the level meter. */
  level: number;
  /** Interim words, where the browser supports it. Never sent anywhere. */
  caption: string;
  /** True when this browser can show live words at all. */
  captionsSupported: boolean;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useDictation(options: {
  /** Called with the recorded audio once recording ends normally. */
  onAudio: (blob: Blob) => void;
  /** Called instead when the recording produced nothing usable. */
  onEmpty: (reason: string) => void;
  onError: (message: string) => void;
}) {
  const { onAudio, onEmpty, onError } = options;

  const [state, setState] = useState<DictationState>({
    recording: false,
    level: 0,
    caption: "",
    captionsSupported: false,
  });

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const finalCaption = useRef("");
  /** Set by the loudness loop, read by `onstop` to tell speech from silence. */
  const sawSpeech = useRef(false);

  // Callbacks are read through a ref so the long-lived MediaRecorder and rAF
  // callbacks never close over a stale render's version of them. Assigned in
  // an effect rather than during render — a ref write during render is not
  // safe under concurrent rendering.
  const handlers = useRef({ onAudio, onEmpty, onError });
  useEffect(() => {
    handlers.current = { onAudio, onEmpty, onError };
  }, [onAudio, onEmpty, onError]);

  const teardown = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    recognition.current?.stop();
    recognition.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close();
    audioCtx.current = null;
  }, []);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (recorder.current?.state === "recording") return;

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      handlers.current.onError(
        "Microphone blocked. Allow mic access in the browser, or type instead.",
      );
      return;
    }

    // Capability is resolved here rather than on mount: reading it during
    // render would differ between the server (no window, always false) and the
    // browser, and a hydration mismatch over a caption hint is not worth it.
    const Recognition = speechRecognitionCtor();

    stream.current = media;
    finalCaption.current = "";
    setState((s) => ({
      ...s,
      recording: true,
      caption: "",
      level: 0,
      captionsSupported: Recognition !== null,
    }));

    // ── 1. Audio for Whisper ────────────────────────────────────────────────
    const mr = new MediaRecorder(media);
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      const spoke = sawSpeech.current;
      teardown();
      setState((s) => ({ ...s, recording: false, level: 0 }));
      if (blob.size === 0 || !spoke) {
        handlers.current.onEmpty(
          "Heard nothing. Check the mic, or type it instead.",
        );
        return;
      }
      handlers.current.onAudio(blob);
    };
    recorder.current = mr;
    mr.start();

    // ── 2. Loudness: level meter + silence detection ────────────────────────
    const ctx = new AudioContext();
    audioCtx.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(media).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);

    const startedAt = performance.now();
    let floorSum = 0;
    let floorCount = 0;
    let threshold = MIN_THRESHOLD;
    let quietSince: number | null = null;
    sawSpeech.current = false;

    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = performance.now();
      const elapsed = now - startedAt;

      // Calibrate against this room and this mic before judging anything. A
      // fixed threshold works in an office and fails next to a compressor.
      if (elapsed < CALIBRATE_MS) {
        floorSum += rms;
        floorCount += 1;
        threshold = Math.max(MIN_THRESHOLD, (floorSum / floorCount) * 3 + SPEECH_MARGIN);
      } else if (rms > threshold) {
        sawSpeech.current = true;
        quietSince = null;
      } else if (sawSpeech.current) {
        if (quietSince === null) quietSince = now;
        else if (now - quietSince > SILENCE_MS) {
          stop();
          return;
        }
      } else if (elapsed > NO_SPEECH_MS) {
        stop();
        return;
      }

      if (elapsed > MAX_MS) {
        stop();
        return;
      }

      // Meter is scaled against the speech threshold, not absolute RMS, so it
      // reads full at a normal speaking volume rather than hugging zero.
      setState((s) => ({ ...s, level: Math.min(1, rms / (threshold * 3)) }));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    // ── 3. Interim captions, where supported ────────────────────────────────
    if (Recognition) {
      try {
        const rec = new Recognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = navigator.language || "en-US";
        rec.onresult = (event) => {
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const text = result[0]?.transcript ?? "";
            if (result.isFinal) finalCaption.current += text;
            else interim += text;
          }
          setState((s) => ({ ...s, caption: (finalCaption.current + interim).trim() }));
        };
        // A caption failure is cosmetic. Recording continues without it.
        rec.onerror = () => {};
        rec.onend = () => {};
        recognition.current = rec;
        rec.start();
      } catch {
        recognition.current = null;
      }
    }
  }, [stop, teardown]);

  // Releasing the mic on unmount matters: the browser keeps showing the
  // recording indicator otherwise, which reads as the app listening in on you.
  useEffect(() => teardown, [teardown]);

  return { ...state, start, stop, toggle: () => (state.recording ? stop() : void start()) };
}
