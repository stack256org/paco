/**
 * The capability API handed to plugin slot code inside the worker process.
 *
 * Every method here is a *request*, not an action: it serializes into a
 * `capability-request` message and the host decides — against the operator's
 * granted list — whether anything happens. A rejected promise is the normal
 * outcome for an ungranted capability, so plugin code must handle it.
 */
export interface PluginKvApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface PluginFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PluginFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PluginSessionEvent {
  id: number;
  chatId: string;
  event: unknown;
}

export interface PluginEventsApi {
  /** Registers a session-event listener. Returns an unsubscribe function. */
  subscribe(callback: (event: PluginSessionEvent) => void): () => void;
}

export interface PluginApi {
  readonly pluginId: string;
  /** `net:fetch` — the host enforces the manifest's domain allowlist. */
  fetch(request: PluginFetchRequest): Promise<PluginFetchResponse>;
  /** `storage:kv` — per-plugin key/value storage. */
  kv: PluginKvApi;
  /** `messages:post` — posts a user message into a chat. */
  postMessage(message: { chatId: string; text: string }): Promise<unknown>;
  /** `events:subscribe` — session events the host fans out. */
  events: PluginEventsApi;
  /** `ui:panel` — pushes state to the plugin's sandboxed panel. */
  panel(payload: unknown): Promise<unknown>;
  /** Diagnostics, surfaced through the host's logger. */
  log(level: "info" | "warn" | "error", message: string): void;
}

/** The shape a `tools/*` module must default-export. */
export interface PluginToolModule {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown, api: PluginApi): unknown | Promise<unknown>;
}

/** The shape a `hooks/*` module must default-export. */
export type PluginHookModule = (api: PluginApi) => void | Promise<void>;
