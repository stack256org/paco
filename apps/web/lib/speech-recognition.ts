/**
 * Minimal typings for the Web Speech API.
 *
 * `SpeechRecognition` is not in TypeScript's DOM library — it is a draft spec
 * that browsers ship behind a vendor prefix — so the shape it is used with is
 * declared here rather than reaching for `any` at each call site.
 */

export interface SpeechRecognitionAlternative {
  readonly transcript: string;
}

export interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

/**
 * Declared as an EventTarget so handlers attach with `addEventListener` rather
 * than the `on<event>` properties the spec also exposes — one listener per
 * event assignment is easy to clobber, and `{ once: true }` is useful here.
 */
export interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  addEventListener(
    type: "result",
    listener: (event: SpeechRecognitionEvent) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: SpeechRecognitionErrorEvent) => void,
  ): void;
  addEventListener(
    type: "end",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

type SpeechCapableWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

/**
 * The browser's speech recognition constructor, if it has one.
 *
 * Chrome, Edge and Safari expose it prefixed; Firefox does not implement it at
 * all, which callers surface as an explanation rather than a dead button.
 */
export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const scope = window as SpeechCapableWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognition() !== null;
}

/** Turn a spec error code into something worth showing a user. */
export function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access denied. Allow it in your browser to use voice input.";
    case "no-speech":
      return "No speech detected. Try again.";
    case "audio-capture":
      return "No microphone found.";
    case "network":
      return "Speech recognition is unavailable — check your connection.";
    case "aborted":
      return "Dictation stopped.";
    default:
      return `Dictation failed: ${code}`;
  }
}
