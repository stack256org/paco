import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { Capability, PluginManifest } from "@paco/plugin-kit";
import type { SandboxState } from "@paco/sandbox";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// users
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  email: text("email"),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at").defaultNow().notNull(),
});

/**
 * The one organisation this installation serves.
 *
 * Paco is self-hosted: a VPS runs one company's Paco, so there is exactly one
 * row here and no organisation switcher anywhere in the product. It exists as
 * a table rather than an implicit fact because membership and invitations need
 * something to point at, and because "who is in this instance" is a different
 * question from "who has a row in users".
 */
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * Always `true`, and unique — the same one-row trick `instanceSettings`
   * plays with a boolean primary key, adapted to a table whose primary key
   * is already spoken for by `organization_members`' foreign key.
   *
   * `id` has to stay a free-form primary key so membership rows keep
   * pointing at it; this column exists purely so a second `INSERT` has
   * something to collide on. Postgres enforces the "only one organisation"
   * rule structurally, so `ensureOrganizationWithOwner` no longer has to
   * win a race against a concurrent caller — it only has to handle losing
   * one.
   */
  singleton: boolean("singleton").notNull().default(true).unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Who belongs to the organisation, and what they may do.
 *
 * `owner` is the person who installed Paco — there is exactly one, and it
 * cannot be given up, because an instance with no owner has no one who can
 * invite. `admin` may invite and manage settings; `member` may not.
 */
export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })],
);

/**
 * A pending invitation to join this instance.
 *
 * This is what replaced the instance-wide "anyone may create an account"
 * switch. The token is a credential — it is emailed and never returned by any
 * API — and an invitation is single-use: `acceptedAt` is what stops one link
 * being forwarded to a second person.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    /** Random, unguessable, and the only thing that proves the holder was invited. */
    token: text("token").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("invitations_email_idx").on(table.email)],
);

export type Organization = typeof organizations.$inferSelect;
export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;

// oauth provider accounts
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// better-auth sessions
export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

// better-auth verification tokens
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * One GitHub token per user, for driving the `gh` CLI on their behalf.
 *
 * The token is stored sealed (AES-256-GCM, see `lib/crypto/secret-box`)
 * because it cannot be hashed: `gh` needs the original value on every call.
 * `login` and `scopes` are recorded in clear as they are what the UI shows —
 * whose account this is and whether it can do what the user is asking — and
 * neither grants access on its own.
 *
 * Keyed by user rather than global so two people using one Paco act as
 * themselves on GitHub. `onDelete: "cascade"` so deleting a user takes their
 * credential with them.
 */
export const githubTokens = pgTable("github_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Sealed token. Never returned to the browser. */
  sealedToken: text("sealed_token").notNull(),
  /** GitHub login the token belongs to, as reported by `gh api user`. */
  login: text("login").notNull(),
  /**
   * GitHub's numeric account id.
   *
   * Needed for the `<id>+<login>@users.noreply.github.com` commit address.
   * The shorter `<login>@users.noreply.github.com` form still resolves, but
   * repositories with email privacy enforced reject pushes that use it.
   */
  githubUserId: integer("github_user_id"),
  /** OAuth scopes the token carries, from GitHub's `x-oauth-scopes` header. */
  scopes: text("scopes").array().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type GithubToken = typeof githubTokens.$inferSelect;
export type NewGithubToken = typeof githubTokens.$inferInsert;

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "archived"],
    })
      .notNull()
      .default("running"),
    // Repository info
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    branch: text("branch"),
    cloneUrl: text("clone_url"),
    // Whether this session uses a new auto-generated branch
    isNewBranch: boolean("is_new_branch").default(false).notNull(),
    // Optional per-session override for committing locally after a turn.
    // null means "use the user's default preference".
    autoCommitLocalOverride: boolean("auto_commit_local_override"),
    // Optional per-session override for pushing those commits to GitHub.
    // null means "use the user's default preference".
    autoCommitPushOverride: boolean("auto_commit_push_override"),
    // Optional per-session override for auto PR creation after auto-commit.
    // null means "use the user's default preference".
    autoCreatePrOverride: boolean("auto_create_pr_override"),
    // Unified sandbox state
    sandboxState: jsonb("sandbox_state").$type<SandboxState>(),
    // Lifecycle orchestration state for sandbox management
    lifecycleState: text("lifecycle_state", {
      enum: [
        "provisioning",
        "active",
        "hibernating",
        "hibernated",
        "restoring",
        "archived",
        "failed",
      ],
    }),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at"),
    sandboxExpiresAt: timestamp("sandbox_expires_at"),
    hibernateAfter: timestamp("hibernate_after"),
    lifecycleRunId: text("lifecycle_run_id"),
    sandboxProvisioningRunId: text("sandbox_provisioning_run_id"),
    lifecycleError: text("lifecycle_error"),
    // Git stats (for display in session list)
    linesAdded: integer("lines_added").default(0),
    linesRemoved: integer("lines_removed").default(0),
    // PR info if created
    prNumber: integer("pr_number"),
    prStatus: text("pr_status", {
      enum: ["open", "merged", "closed"],
    }),
    /**
     * Rolled-up CI conclusion for the pull request.
     *
     * Kept alongside `prStatus` so the sidebar can say "checks failing" without
     * asking GitHub on every render. `null` means either no pull request or no
     * checks configured — the UI shows nothing in both cases, so they do not
     * need telling apart.
     */
    prChecks: text("pr_checks", {
      enum: ["passing", "failing", "pending"],
    }),
    /**
     * When GitHub was last asked about the pull request.
     *
     * Webhooks used to answer this, but GitHub cannot reach a self-hosted
     * install on localhost, so the state is polled instead. This is what keeps
     * the poll from running `gh` on every session on every list request.
     */
    prCheckedAt: timestamp("pr_checked_at"),
    // Cached diff for offline viewing
    cachedDiff: jsonb("cached_diff"),
    cachedDiffUpdatedAt: timestamp("cached_diff_updated_at"),
    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    modelId: text("model_id").default("sonnet"),
    /**
     * Reasoning effort for this chat, passed to the CLI as `--effort`.
     *
     * A separate column rather than encoded into `model_id`: model and effort
     * are independent choices, and folding them into one string meant every
     * combination needed its own "variant" row to exist before it could be
     * picked.
     */
    effort: text("effort", {
      enum: ["low", "medium", "high", "xhigh", "max"],
    }),
    /**
     * What happens when a message arrives while a turn is running.
     * "steer": buffer durably, cancel the active turn, continue with the
     * buffered message. "queue": buffer durably, run it after the turn ends.
     * (Spec 1c; both consume from the same steer/buffered events.)
     */
    turnPolicy: text("turn_policy", { enum: ["steer", "queue"] })
      .notNull()
      .default("steer"),
    /**
     * Which agent backend runs this chat's turns.
     *
     * A per-chat choice rather than instance-wide config: `"claude-code"` is
     * today's only backend and stays the default so every existing chat and
     * insert keeps working unchanged; `"openfx"` is the alternative Section 7
     * Task 5 wires up to actually run turns through. Recording it on the
     * chat, not just at submit time, is what lets a chat's turn history stay
     * attributable to the backend that actually produced it.
     */
    backend: text("backend", { enum: ["claude-code", "openfx"] })
      .notNull()
      .default("claude-code"),
    activeStreamId: text("active_stream_id"),
    /**
     * Legacy, single-backend predecessor of `resumeTokens` below.
     *
     * Nothing writes to this column anymore — every write goes through
     * `resumeTokens["claude-code"]` instead (`setChatResumeToken` in
     * `lib/db/sessions.ts`). Kept as a pure read fallback
     * (`resolveChatResumeToken`) for any row the one-time backfill
     * migration (00XX) missed, and because dropping a column is a one-way
     * door a read fallback isn't.
     */
    claudeSessionId: text("claude_session_id"),
    /**
     * Resume tokens per agent backend, keyed by backend id
     * (`"claude-code"` / `"openfx"`).
     *
     * `backend` above is a mutable, per-chat choice, and each backend's
     * resume token means something only to that backend's own session
     * store: Claude Code's `--resume` and OpenFX's ACP `sessionId` are not
     * interchangeable — handing one to the other backend either fails
     * outright or, worse, resumes the wrong conversation
     * (`OpenFxBackend.loadSession` would pass a Claude Code session id
     * straight to ACP's `session/load`). Keying the resume token by backend
     * means switching back and forth needs no clearing at all: each side's
     * token just sits under its own key until that backend runs again, and
     * a round trip (claude-code -> openfx -> claude-code) resumes both
     * sides correctly. See `resolveChatResumeToken`/`setChatResumeToken` in
     * `lib/db/sessions.ts`.
     */
    resumeTokens: jsonb("resume_tokens")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    lastAssistantMessageAt: timestamp("last_assistant_message_at"),
    /**
     * Who may open this chat's preview.
     *
     * Private by default, and deliberately so: a preview serves code the
     * agent has just written, from a container with the workspace mounted.
     * Public means anyone with the hostname can reach it — which is a
     * decision the owner makes per preview, not a default they inherit.
     */
    previewVisibility: text("preview_visibility", {
      enum: ["private", "public"],
    })
      .notNull()
      .default("private"),
    /**
     * DNS-safe slug derived from `id`, mirroring `previewSlug()` in
     * `lib/preview/hostname.ts` exactly: lowercase, `[^a-z0-9-]` replaced
     * with `-`, leading/trailing hyphens trimmed.
     *
     * Stored, not recomputed — the preview forward-auth check
     * (`app/api/preview-auth/route.ts`) has to map a hostname's leading
     * label back to a chat on every preview request, and
     * `previewSlug()` is lossy (case and `_` both collapse into `-`), so
     * there is no way to invert it back to `id`. Without a stored, indexed
     * copy the only option would be recomputing the slug for every chat row
     * on every request — a full table scan on a busy instance. `GENERATED
     * ALWAYS` lets Postgres keep it correct for every insert automatically,
     * including ones this column's own migration never has to touch, rather
     * than relying on every chat-creation call site to remember to set it.
     */
    previewSlug: text("preview_slug")
      .notNull()
      .generatedAlwaysAs(
        sql`trim(both '-' from regexp_replace(lower(id), '[^a-z0-9-]', '-', 'g'))`,
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("chats_session_id_idx").on(table.sessionId),
    // Enforced uniqueness, not just an optimization: two different chat ids
    // colliding on the same slug would otherwise route one chat's preview
    // requests at whichever chat happened to match first — a cross-tenant
    // leak, not merely a performance bug.
    uniqueIndex("chats_preview_slug_idx").on(table.previewSlug),
  ],
);

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", {
    enum: ["user", "assistant"],
  }).notNull(),
  // Store the full message parts as JSON for flexibility
  parts: jsonb("parts").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatReads = pgTable(
  "chat_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index("chat_reads_chat_id_idx").on(table.chatId),
  ],
);

/**
 * Append-only session event log — the source of truth for what happened in a
 * chat (spec: Section 1 of 2026-08-25-paco-platform-design.md).
 *
 * `chatMessages` is a projection of this log. Ordering is the bigserial `id`:
 * a single writer per chat is already enforced by the active-stream claim, so
 * global insert order is per-chat order.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("session_events_chat_id_id_idx").on(table.chatId, table.id),
    /**
     * Serves every read that wants a *kind* of event rather than all of them
     * — the steer poll (`listUnconsumedSteerEvents`, once a second for the
     * whole of a steerable turn) and the turn-boundary lookup behind
     * `listTurnSessionEvents`.
     *
     * Both are needle-in-haystack queries: the recorder writes one row per
     * streamed chunk, so `assistant/chunk` swamps every other type, and
     * without `type` in the index those queries degrade into a scan of the
     * chat's entire history with the jsonb `payload` dragged along. `id`
     * trails the key so the ordered range comes back without a sort.
     */
    index("session_events_chat_id_type_id_idx").on(
      table.chatId,
      table.type,
      table.id,
    ),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: text("model_id"),
    status: text("status", {
      enum: ["completed", "aborted", "failed"],
    }).notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    totalDurationMs: integer("total_duration_ms").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_runs_chat_id_idx").on(table.chatId),
    index("workflow_runs_session_id_idx").on(table.sessionId),
    index("workflow_runs_user_id_idx").on(table.userId),
  ],
);

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    finishReason: text("finish_reason"),
    rawFinishReason: text("raw_finish_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_run_steps_run_id_idx").on(table.workflowRunId),
    uniqueIndex("workflow_run_steps_run_step_idx").on(
      table.workflowRunId,
      table.stepNumber,
    ),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatRead = typeof chatReads.$inferSelect;
export type NewChatRead = typeof chatReads.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;

// User preferences for settings
export const userPreferences = pgTable("user_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultModelId: text("default_model_id").default("opus"),
  defaultDiffMode: text("default_diff_mode", {
    enum: ["unified", "split"],
  }).default("unified"),
  // Commit each finished turn in the chat's worktree. On by default: it only
  // writes local history, so the cost of it being wrong is a commit nobody
  // asked for, against work silently lost when it is off.
  autoCommitLocal: boolean("auto_commit_local").notNull().default(true),
  // Push those commits to GitHub. Off by default and deliberately separate:
  // pushing publishes to someone's account, which a local commit never does.
  autoCommitPush: boolean("auto_commit_push").notNull().default(false),
  autoCreatePr: boolean("auto_create_pr").notNull().default(false),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  alertSoundEnabled: boolean("alert_sound_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// Usage tracking — one row per assistant turn (append-only)
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  source: text("source", { enum: ["web"] })
    .notNull()
    .default("web"),
  agentType: text("agent_type", { enum: ["main", "subagent"] })
    .notNull()
    .default("main"),
  provider: text("provider"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

/**
 * Settings that belong to the installation rather than to a person.
 *
 * A single row, pinned by a check constraint on `id`. There is no admin UI
 * concept of "the instance" anywhere else, and a one-row table is easier to
 * reason about than a key/value bag when there is exactly one flag.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: boolean("id").primaryKey().default(true),
  /**
   * The public origin this instance is served on, once an operator sets one.
   *
   * Null until then, which is the normal state of a fresh install: it is
   * reachable on the server's address and needs no domain to work. This is not
   * read by the application at request time — `paco-entrypoint.sh` exports it
   * as `APP_URL` at start-up, so the whole process agrees on one origin.
   */
  appDomain: text("app_domain"),
  /** Whether Traefik should request certificates for this instance's hosts. */
  tlsEnabled: boolean("tls_enabled").notNull().default(false),
  /** Parent domain for preview hostnames, e.g. "previews.example.com". */
  previewBaseDomain: text("preview_base_domain"),

  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSecure: boolean("smtp_secure"),
  smtpUser: text("smtp_user"),
  /**
   * Sealed with `lib/crypto/secret-box`, never hashed.
   *
   * nodemailer authenticates with the original on every send, so there is
   * nothing to compare a hash against. Sealed with the key derived from
   * `APP_SECRET`, exactly as GitHub tokens are — changing that secret makes
   * this unreadable and the operator re-enters it.
   */
  smtpPasswordSealed: text("smtp_password_sealed"),
  smtpFrom: text("smtp_from"),

  /**
   * Bring-your-own OpenFX provider config (Section 7 Task 5): a chat whose
   * `backend` is `"openfx"` runs its turns through this endpoint instead of
   * the Claude Code CLI. All three are null until an operator configures
   * OpenFX — there is no default provider, unlike `chats.backend`'s default
   * of `"claude-code"`.
   */
  openfxEndpoint: text("openfx_endpoint"),
  /**
   * Sealed with `lib/crypto/secret-box`, never hashed — same rationale and
   * mechanism as `smtpPasswordSealed`: the original value is needed on every
   * call, so there is nothing to compare a hash against.
   */
  openfxApiKeySealed: text("openfx_api_key_sealed"),
  /** Path to the OpenFX binary on this instance, when it runs locally rather than as a remote endpoint. */
  openfxBinaryPath: text("openfx_binary_path"),
  /**
   * When the guided first-run flow (account, platform, mail) was finished.
   *
   * Null is the normal state until then, and is what makes the flow
   * re-entrant: an admin who closes the browser mid-way is sent back to
   * `/onboarding` on their next visit instead of either restarting at account
   * creation (already done, and `POST /api/auth/first-run` would 409 on it
   * anyway) or landing in the app with no way back to the mail-server step
   * that still matters.
   */
  onboardingCompletedAt: timestamp("onboarding_completed_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type InstanceSettings = typeof instanceSettings.$inferSelect;

/**
 * An organisation's subagent roster: the `--agents` definitions available in
 * every chat, editable by the organisation instead of hardcoded in
 * `@paco/claude-code`'s `DEFAULT_AGENTS`.
 *
 * `definition` is validated with `agentDefinitionSchema`
 * (`apps/web/lib/agent/agent-definition-schema.ts`) on every write and every
 * read — the column itself is untyped JSONB, so nothing stops a row from
 * predating a schema change or being written by something other than
 * `upsertRosterAgent`. An invalid row is skipped with a `console.error`
 * rather than passed through: a bad definition must not become a fatal error
 * for every turn in the organisation.
 *
 * `builtin` marks the seeded defaults (explorer/executor/reviewer/designer):
 * editable like any other row, but `deleteRosterAgent` refuses to remove
 * them, so an organisation can always get back to a working roster by
 * resetting a row rather than needing to reconstruct one from scratch.
 */
export const rosterAgents = pgTable(
  "roster_agents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Becomes the agent's key in `--agents`. */
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    builtin: boolean("builtin").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("roster_agents_org_name_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export type RosterAgent = typeof rosterAgents.$inferSelect;
export type NewRosterAgent = typeof rosterAgents.$inferInsert;

/**
 * An installed third-party plugin (spec Section 2).
 *
 * `id` is the manifest name — a plugin re-installed at the same name
 * overwrites its row rather than accumulating duplicates. `manifest` is the
 * parsed `PluginManifest` stored verbatim, and `grantedCapabilities` is
 * always a subset of `manifest.capabilities`: `setPluginGrants`
 * (`apps/web/lib/db/plugins.ts`) enforces that on every write, throwing
 * `PluginGrantEscalationError` rather than letting a plugin grant itself
 * something it never declared wanting.
 *
 * `enabled` defaults to `false` — installing a plugin only ever registers
 * it; running it (and therefore starting its host process, per the spec's
 * security invariants) is a deliberate second step, so install alone can
 * never be mistaken for consent to run.
 */
export const plugins = pgTable("plugins", {
  id: text("id").primaryKey(),
  /** "github:owner/repo#ref" or "local:<path>". */
  source: text("source").notNull(),
  version: text("version").notNull(),
  /** sha256 over the installed tree. */
  contentHash: text("content_hash").notNull(),
  manifest: jsonb("manifest").$type<PluginManifest>().notNull(),
  grantedCapabilities: jsonb("granted_capabilities")
    .$type<Capability[]>()
    .notNull(),
  /**
   * The operator-consented outbound domains, snapshotted from the manifest
   * at the moment grants are given.
   *
   * The plugin host reads THIS column, never the on-disk manifest, when
   * deciding what `net:fetch` may reach — so a plugin that widens its own
   * manifest after install (or after being granted `net:fetch`) cannot
   * widen its own network access that way. `setPluginGrants`
   * (`lib/db/plugins.ts`) snapshots `manifest.netDomains` here whenever
   * grants are written; `upsertPlugin` only ever intersects this with the
   * new manifest's `netDomains` on re-install, the same "never widens" rule
   * `grantedCapabilities` already follows.
   */
  consentedNetDomains: jsonb("consented_net_domains")
    .$type<string[]>()
    .notNull()
    .default([]),
  enabled: boolean("enabled").notNull().default(false),
  /**
   * The per-plugin shared secret for `/api/channels/[pluginId]/[channel]`,
   * sealed with `lib/crypto/secret-box` — same rationale as
   * `githubTokens.sealedToken`: the route needs the original value back on
   * every inbound webhook to compare against `x-paco-channel-secret`, so it
   * cannot be hashed.
   *
   * Null until a plugin is first enabled (`ensurePluginIngressSecret` in
   * `lib/db/plugins.ts`, called from `grantAndEnableAction`), which
   * generates one and returns it in the clear exactly once — that single
   * response is the only place the plaintext ever exists outside the
   * sealed column and the plugin author's own webhook config. Stable
   * across re-enables: only ever generated when absent, never rotated
   * automatically, so disabling and re-enabling a plugin doesn't silently
   * break its already-configured webhook.
   */
  ingressSecret: text("ingress_secret"),
  installedAt: timestamp("installed_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PluginRow = typeof plugins.$inferSelect;
export type NewPluginRow = typeof plugins.$inferInsert;

/**
 * Per-plugin key-value storage backing the `storage:kv` capability (spec
 * Section 2, Task 6).
 *
 * Keyed by `(pluginId, key)` rather than a synthetic id: a plugin's rows are
 * scoped to it by construction, so a handler that only ever queries with the
 * `pluginId` the host supplies (never one read from a payload) cannot be
 * tricked into crossing into another plugin's namespace. `onDelete: "cascade"`
 * so uninstalling a plugin (`removePlugin`) takes its stored state with it
 * instead of leaving orphaned rows behind.
 */
export const pluginKv = pgTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export type PluginKvRow = typeof pluginKv.$inferSelect;
export type NewPluginKvRow = typeof pluginKv.$inferInsert;

/**
 * The task board's state machine (Section 3 Global Constraints, binding,
 * single source of truth): `todo → running → review → done`, with `blocked`
 * reachable from `running` (approval pending) and `failed` reachable from
 * `running`/`review`, `review → running` on reviewer rejection (bounded: two
 * automatic rejections, then `blocked` for a human). Plus two edges Task 8's
 * UI needs and this task ships: `failed → todo` (retry) and `blocked →
 * running` (human unblock). See `lib/tasks/state.ts` for `canTransition`,
 * the single place this list is enforced.
 */
export const TASK_STATUSES = [
  "todo",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Who created a task: a person, the planner, a schedule, a channel
 * integration, or the reflection job (Section 4 Task 6) proposing follow-up
 * work off of session activity.
 */
export const TASK_ORIGINS = [
  "user",
  "planner",
  "schedule",
  "channel",
  "reflection",
] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/**
 * A unit of agent work tracked on the org's task board (spec Section 3).
 *
 * A task owns a chat only once started — `chatId` is null for every `todo`
 * task and is set when `startTaskAction` creates the worktree-backed chat
 * that executes it. `parentTaskId` self-references so a planner can
 * decompose one goal into a tree of subtasks; the FK cascades so deleting a
 * parent removes its subtree instead of leaving orphaned children pointing
 * at nothing.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * The session whose repo the task works in.
     *
     * Nullable: a proposal or reflection task (e.g. an org-memory promotion
     * a non-admin filed, or a follow-up the reflection job proposes) can
     * belong to no session at all — it names work to consider, not a repo
     * to act in yet. `startTask` (`lib/tasks/start.ts`) refuses to start a
     * session-less task, since starting one always means running an
     * executor turn in some session's worktree.
     */
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    /** The chat executing it, created when the task is started. */
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),
    parentTaskId: text("parent_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "cascade" },
    ),
    title: text("title").notNull(),
    /** The full prompt/goal text handed to the executor. */
    goal: text("goal").notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("todo"),
    /** Roster name; null means the orchestrator's default agent. */
    assignedAgent: text("assigned_agent"),
    reviewerRejections: integer("reviewer_rejections").notNull().default(0),
    origin: text("origin", { enum: TASK_ORIGINS }).notNull().default("user"),
    resultSummary: text("result_summary"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("tasks_org_id_status_idx").on(table.organizationId, table.status),
    index("tasks_session_id_idx").on(table.sessionId),
    index("tasks_parent_task_id_idx").on(table.parentTaskId),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

/** An eval run's terminal states, plus `running` while its turn is in flight. */
export const EVAL_RUN_STATUSES = [
  "running",
  "passed",
  "failed",
  "error",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/**
 * One execution of a repo-defined eval scenario against a throwaway chat
 * (spec Section 3 Task 9).
 *
 * Scenarios themselves are not stored — they live as `<sessionRepo>/evals/*.json`
 * files (`lib/evals/discovery.ts`) — this table only records what happened
 * when one ran: `scenarioName` names it, `details` carries the per-assertion
 * results (or the harness error, when `status` is `"error"`) as untyped
 * JSONB re-validated on read rather than a typed column, the same
 * "JSONB, revalidate on read" choice `rosterAgents.definition` makes — see
 * `lib/db/eval-runs.ts` for the shape it is expected to hold.
 *
 * `rosterSnapshot` is the organisation's roster (`lib/db/roster.ts`'s
 * `getRoster`) at the moment the scenario ran, kept alongside the result so
 * a later roster edit can be checked against whether it made evals worse —
 * the whole point of the feature — without needing separate roster history.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    scenarioName: text("scenario_name").notNull(),
    status: text("status", { enum: EVAL_RUN_STATUSES })
      .notNull()
      .default("running"),
    details: jsonb("details"),
    rosterSnapshot: jsonb("roster_snapshot")
      .$type<Record<string, ClaudeAgentDefinition>>()
      .notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("eval_runs_org_id_idx").on(table.organizationId),
    index("eval_runs_session_id_idx").on(table.sessionId),
  ],
);

export type EvalRun = typeof evalRuns.$inferSelect;
export type NewEvalRun = typeof evalRuns.$inferInsert;

/**
 * A cron schedule that fires a task (spec Section 6 Task 4) — "run the
 * suite nightly and open a fix PR if it's red" as a config row instead of a
 * hand-run command.
 *
 * `sessionId` is required (unlike `tasks.sessionId`): a schedule always
 * names the repo its fired task works in — there is no "proposal" case here
 * the way a planner/reflection task can be session-less. `goal` is the
 * prompt text handed to the executor the same way `tasks.goal` is;
 * `assignedAgent` mirrors `tasks.assignedAgent` (a roster name, or null for
 * the orchestrator's default agent). `cron` is stored as free text and
 * validated at the write boundary (`lib/db/schedules.ts`), not with a
 * database constraint, so an invalid expression is rejected with a
 * field-level message before it ever reaches a row.
 *
 * `lastFiredAt` records the most recent fire (`lib/schedules/fire.ts`);
 * there is deliberately no "missed windows" bookkeeping here — a schedule
 * that fires only records that it fired, never what it would have fired for
 * while nothing was watching (see that file's own comment on catch-up).
 * `createdBy` is nullable and set-null-on-delete like `tasks.createdBy`: the
 * schedule keeps firing after the admin who created it is gone.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** A five-field cron expression, validated by `lib/db/schedules.ts`. */
    cron: text("cron").notNull(),
    /** The full prompt/goal text handed to the executor when this fires. */
    goal: text("goal").notNull(),
    /** Roster name; null means the orchestrator's default agent. */
    assignedAgent: text("assigned_agent"),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("schedules_org_id_enabled_idx").on(
      table.organizationId,
      table.enabled,
    ),
  ],
);

export type Schedule = typeof schedules.$inferSelect;
export type NewSchedule = typeof schedules.$inferInsert;
