/**
 * The capability API handed to plugin slot code inside the worker process.
 *
 * Every method here is a *request*, not an action: it serializes into a
 * `capability-request` message and the host decides — against the operator's
 * granted list — whether anything happens. A rejected promise is the normal
 * outcome for an ungranted capability, so plugin code must handle it.
 */
/** One row returned by `kv.list` — see `KvListPage`. */
export interface KvListItem {
  key: string;
  value: unknown;
}

/**
 * A single page of `storage:kv`'s "list" op, exactly as the host's handler
 * returns it: keyset-paginated (ordered by key, capped per page) rather than
 * prefix-filtered. `nextAfterKey` is present iff the page was full; pass it
 * back as `afterKey` to fetch the next page, and its absence means listing is
 * complete.
 */
export interface KvListPage {
  items: KvListItem[];
  nextAfterKey?: string;
}

export interface PluginKvApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Pass the previous page's `nextAfterKey` to continue; omit to start from the beginning. */
  list(afterKey?: string): Promise<KvListPage>;
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

/** Input to `api.tasks.create` — see `tasks:create`'s capability handler. */
export interface PluginTaskCreateInput {
  sessionId: string;
  title: string;
  goal: string;
  autoStart?: boolean;
}

export interface PluginTaskCreateResult {
  taskId: string;
  chatId?: string;
  /** Set when `autoStart` was requested but starting the task failed. */
  error?: string;
}

export interface PluginTasksApi {
  /** `tasks:create` — creates a task on the board from an inbound message. */
  create(input: PluginTaskCreateInput): Promise<PluginTaskCreateResult>;
}

export interface PluginApi {
  readonly pluginId: string;
  /**
   * A directory the plugin may write to — the only writable path it has.
   * Created by the host under the OS temp dir and passed in as
   * `PACO_PLUGIN_STATE_DIR`. Scratch space, not durable storage: use the
   * `storage:kv` capability for anything that must survive a restart.
   */
  readonly stateDir: string;
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
  /** `tasks:create` — creates tasks on the board from an inbound message. */
  tasks: PluginTasksApi;
  /** Diagnostics, surfaced through the host's logger. */
  log(level: "info" | "warn" | "error", message: string): void;
}

/**
 * The shape a `tools/*` module must default-export.
 *
 * `signal` aborts when the host gives up on the call (its `invokeTool`
 * timeout). A tool that ignores it still has its result discarded, but a
 * long-running one should stop working when asked.
 */
export interface PluginToolModule {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(
    input: unknown,
    api: PluginApi,
    signal: AbortSignal,
  ): unknown | Promise<unknown>;
}

/** The shape a `hooks/*` module must default-export. */
export type PluginHookModule = (api: PluginApi) => void | Promise<void>;

/** One inbound webhook request, as handed to a `channels/*` module. */
export interface PluginChannelRequest {
  headers: Record<string, string>;
  /** Best-effort `JSON.parse` of `rawBody`; `undefined` when it isn't JSON. */
  body: unknown;
  /**
   * The exact bytes Paco received, before any parsing. A channel that
   * verifies a signature over the raw request body (Slack's v0 HMAC scheme,
   * for example) MUST use this, not a re-serialization of `body` — that
   * would not reproduce the bytes the sender actually signed.
   */
  rawBody: string;
}

export interface PluginChannelResponse {
  status: number;
  body?: unknown;
}

/**
 * The shape a `channels/*` module must default-export. `name` picks the key
 * this channel is addressed by in the ingress route
 * (`/api/channels/[pluginId]/[channel]`); when omitted, the worker falls
 * back to the slot file's own basename (see `worker-entry.ts`'s
 * `loadChannels`).
 */
export interface PluginChannelModule {
  name?: string;
  handle(
    request: PluginChannelRequest,
    api: PluginApi,
  ): PluginChannelResponse | Promise<PluginChannelResponse>;
}
