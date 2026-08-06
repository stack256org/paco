"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  describeSpeechError,
  getSpeechRecognition,
  isSpeechRecognitionSupported,
  type SpeechRecognitionInstance,
} from "@/lib/speech-recognition";

type RecordingState = "idle" | "recording" | "processing";

/**
 * Dictation for the composer, via the browser's speech recognition.
 *
 * This previously recorded audio with MediaRecorder and POSTed it to
 * `/api/transcribe`, a route deleted along with the hosted-model stack. Nothing
 * replaced it, so the button had been receiving the HTML 404 page and failing
 * to parse it as JSON — "Unexpected token '<'".
 *
 * The browser does the recognition now, which suits a tool that authenticates
 * with a Claude subscription and holds no API keys: Claude has no speech-to-text
 * endpoint, and adding one would mean a key Paco deliberately does not have.
 *
 * Worth knowing: in Chrome this is not local. Audio is streamed to Google's
 * speech service, so dictation is the one part of Paco that leaves the machine.
 * The agent, the sandbox and the workspace all stay put.
 */
export function useAudioRecording() {
  const [state, setState] = useState<RecordingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const transcriptRef = useRef("");
  const resolveRef = useRef<((text: string | null) => void) | null>(null);

  /** Settle the pending toggleRecording() promise exactly once. */
  const settle = useCallback((text: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    recognitionRef.current = null;
    setState("idle");
    resolve?.(text);
  }, []);

  // A session holds the microphone open. Navigating away mid-dictation would
  // otherwise leave the recording indicator lit until the tab closes.
  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setError(
        "This browser has no speech recognition. Chrome, Edge and Safari support it; Firefox does not.",
      );
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    // Keep listening across natural pauses — a prompt is usually more than one
    // sentence, and the default stops at the first silence.
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    transcriptRef.current = "";

    recognition.addEventListener("result", (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) {
          transcriptRef.current += result[0]?.transcript ?? "";
        }
      }
    });

    recognition.addEventListener("error", (event) => {
      // "aborted" is what stop() produces on some browsers; it is not a failure
      // and must not overwrite a transcript the user just dictated.
      if (event.error !== "aborted") {
        setError(describeSpeechError(event.error));
      }
    });

    recognition.addEventListener(
      "end",
      () => {
        const text = transcriptRef.current.trim();
        settle(text.length > 0 ? text : null);
      },
      { once: true },
    );

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setState("recording");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Could not start dictation: ${message}`);
      setState("idle");
    }
  }, [settle]);

  const stopRecording = useCallback((): Promise<string | null> => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return Promise.resolve(null);
    }

    setState("processing");

    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
      // Resolved from `onend`, which fires after the last result is delivered,
      // so stopping does not discard the final phrase.
      recognition.stop();
    });
  }, []);

  const toggleRecording = useCallback(async (): Promise<string | null> => {
    if (state === "recording") {
      return stopRecording();
    }
    if (state === "idle") {
      await startRecording();
      return null;
    }
    return null;
  }, [state, startRecording, stopRecording]);

  const clearError = useCallback(() => setError(null), []);

  return {
    state,
    error,
    clearError,
    startRecording,
    stopRecording,
    toggleRecording,
    isRecording: state === "recording",
    isProcessing: state === "processing",
    isSupported: isSpeechRecognitionSupported(),
  };
}
