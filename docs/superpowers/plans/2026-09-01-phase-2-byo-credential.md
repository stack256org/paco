# Phase 2: Bring-your-own Claude Credential Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the interactive `paco auth` CLI login with one typed credential stored in Settings, allow an operator to point Paco at their own Anthropic-compatible gateway, and fill the model picker from that gateway instead of a hardcoded list.

**Architecture:** One credential row in `instanceSettings`, sealed with `APP_SECRET` exactly as the GitHub token is. `run-step.ts` exports exactly one of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` per turn, following the existing `githubTokenEnv()` pattern; `child-env.ts` already passes `ANTHROPIC_*`/`CLAUDE_*` through by prefix, so no plumbing changes. The model list stays static when talking to Anthropic directly and comes from the CLI's own gateway cache when a base URL is set.

**Tech Stack:** Next.js 16 (App Router, server actions), TypeScript, Drizzle ORM + drizzle-kit, POSIX sh (`scripts/paco`), `bun test`.

**Spec:** [docs/superpowers/specs/2026-09-01-byo-claude-credential-design.md](../specs/2026-09-01-byo-claude-credential-design.md) — Phase 2.

**Depends on:** Phase 1 ([2026-09-01-phase-1-remove-poolside.md](2026-09-01-phase-1-remove-poolside.md)), which removed Poolside. This branch continues on top of it.

## Global Constraints

- **Exactly one credential variable is ever exported.** Never both. `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` in the CLI's precedence and is *always* used in `-p` mode, which is how Paco runs (`packages/claude-code/options.ts:152`). Exporting both means the key silently wins and bills the wrong account. This is the single property this phase turns on.
- **The credential goes in the environment, never in argv.** `ps` shows one process's arguments to every user on the machine — the same rule `AGENTS.md` states for `gh` tokens.
- **Seal with `lib/crypto/secret-box`**, exactly as `githubTokens.sealedToken` does. Do not invent a second mechanism, and do not change how sealing works — a stored GitHub token must still decrypt.
- **`APP_SECRET` stays and now protects two credentials.** Strengthen its backup warning; never weaken it.
- **Non-Claude models through a gateway are out of scope** — Anthropic does not support routing Claude Code to them. The gateway must speak the Anthropic Messages format. Do not add an OpenAI-compatible path.
- **Migrations:** run `pnpm --dir apps/web db:generate` after editing the schema and commit the generated `.sql`. Never `db:push`; never edit a migration that has run.
- **An empty file fails lint** (`unicorn(no-empty-file)`). If removing content empties a file, delete it.
- **The suite is `pnpm test:isolated`** (one process per file). Bare `bun test` across the repo yields ~800 spurious `Export named '…' not found` failures and is not a signal.
- Ultracite style: double quotes, 2-space indent, no `any`, kebab-case filenames. Quote paths containing `[` `]` — zsh globs.
- Follow the daisyUI skill (`.agents/skills/daisyui/SKILL.md`) for any markup — standing rule in `AGENTS.md`.
- Node 24. If `node -v` shows v22, prefix with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
- **Writing a file is not committing it.** Verify each task with `git status --short` and `git show --stat HEAD`.

## Reconnaissance already done (do not re-derive)

- `apps/web/lib/agent/run-step.ts:113` defines `githubTokenEnv(token)` returning `{}` or `{GH_TOKEN, GITHUB_TOKEN}`; line 207-208 spreads it into `backendOptions.env`. **This is the pattern and the insertion point.**
- `packages/claude-code/child-env.ts:113-118` allows the `ANTHROPIC_` and `CLAUDE_` prefixes through to the CLI. Nothing needs adding there.
- `apps/web/lib/settings/instance-settings.ts` exposes `InstanceSettingsView`, `readInstanceSettings()` and per-area save actions such as `saveAppDomain`.
- `apps/web/app/settings/models/` now holds only `page.tsx` and `loading.tsx` — Phase 1 deleted the Poolside section.
- `apps/web/lib/model-catalog.ts` holds `CLAUDE_MODELS`, the tier aliases (`opus`, `sonnet`, `haiku`).
- `scripts/paco` still has `cmd_auth`, `auth_claude` and `claude_auth_state`; Phase 1 deliberately left them.

---

### Task 1: Store one typed credential

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — `instanceSettings`
- Create: the generated migration
- Modify: `apps/web/lib/settings/instance-settings.ts`, `apps/web/lib/admin/instance-settings-schemas.ts`, `apps/web/lib/admin/instance-settings-actions.ts`
- Test: `apps/web/lib/settings/instance-settings.test.ts`

**Interfaces:**
- Consumes: `seal`/`open` from `lib/crypto/secret-box`.
- Produces: `readClaudeCredential(): Promise<{kind: "api_key" | "setup_token"; value: string; setAt: Date} | null>` and `saveClaudeCredential({kind, value})`, plus `claudeBaseUrl` and `claudeModelDiscovery` on the settings view. Task 2 consumes `readClaudeCredential`; Task 3 consumes the base URL and discovery flag.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/settings/instance-settings.test.ts`:

```ts
describe("claude credential", () => {
  test("round-trips an api key through the seal", async () => {
    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-test-123" });

    const credential = await readClaudeCredential();

    expect(credential?.kind).toBe("api_key");
    expect(credential?.value).toBe("sk-ant-test-123");
  });

  test("saving one kind clears the other", async () => {
    // The precedence trap this design exists to make unreachable: with both
    // set, ANTHROPIC_API_KEY wins in -p mode and silently bills the API
    // account instead of the subscription the operator pasted a token for.
    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-test-123" });
    await saveClaudeCredential({ kind: "setup_token", value: "oauth-abc" });

    const credential = await readClaudeCredential();

    expect(credential?.kind).toBe("setup_token");
    expect(credential?.value).toBe("oauth-abc");
  });

  test("stores the credential sealed, never in the clear", async () => {
    await saveClaudeCredential({ kind: "api_key", value: "sk-ant-secret" });

    const [row] = await db.select().from(instanceSettings).limit(1);

    expect(row?.claudeCredentialSealed).not.toContain("sk-ant-secret");
  });

  test("returns null when nothing is configured", async () => {
    expect(await readClaudeCredential()).toBeNull();
  });
});
```

Follow whatever database setup the existing tests in that file use; do not invent a new harness.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/lib/settings/instance-settings.test.ts`

Expected: FAIL — `saveClaudeCredential` and `readClaudeCredential` do not exist.

- [ ] **Step 3: Add the columns**

In `apps/web/lib/db/schema.ts`, add to `instanceSettings`:

```ts
  /**
   * The one credential the agent runs on, and which kind it is.
   *
   * One, not two. `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` in
   * the CLI's precedence and is always used in `-p` mode, which is how every
   * turn runs — so an instance with both set would silently bill the API
   * account while the operator believed their subscription token was in use.
   * Storing one value with its kind makes that state unreachable rather than
   * documented.
   *
   * `api_key` is API billing; `setup_token` is a one-year OAuth token from
   * `claude setup-token` against a Claude subscription.
   */
  claudeCredentialKind: text("claude_credential_kind", {
    enum: ["api_key", "setup_token"],
  }),
  /** Sealed with `lib/crypto/secret-box`, exactly as the GitHub token is. */
  claudeCredentialSealed: text("claude_credential_sealed"),
  /**
   * When the credential was saved.
   *
   * A setup token expires after a year and nothing warns: turns simply start
   * failing with a CLI error. Paco cannot renew it, so surfacing its age is
   * the whole mitigation.
   */
  claudeCredentialSetAt: timestamp("claude_credential_set_at"),
  /** A gateway speaking the Anthropic Messages format. Null means Anthropic. */
  claudeBaseUrl: text("claude_base_url"),
  /** Let the CLI fetch the model list from that gateway. */
  claudeModelDiscovery: boolean("claude_model_discovery")
    .notNull()
    .default(false),
```

- [ ] **Step 4: Implement the accessors**

In `apps/web/lib/settings/instance-settings.ts`, add `readClaudeCredential` and `saveClaudeCredential`. `saveClaudeCredential` writes all three credential columns in one update — kind, sealed value, and `setAt` — so the two kinds can never both be present. `readClaudeCredential` returns `null` when either the kind or the sealed value is missing, rather than a half-populated object.

Add `claudeBaseUrl`, `claudeModelDiscovery` and a `claudeCredentialKind`/`claudeCredentialSetAt` pair (**never the value**) to `InstanceSettingsView`, and a `saveClaudeGateway({baseUrl, modelDiscovery})` action. The view crosses to the client; the secret must not.

Add the matching Zod schemas in `instance-settings-schemas.ts` and the server actions in `instance-settings-actions.ts`, following how the existing domain and GitHub fields are done.

- [ ] **Step 5: Generate the migration**

Run: `pnpm --dir apps/web db:generate`

Read the generated `.sql`. It should add five columns to `instance_settings` and nothing else. **If it proposes dropping or altering anything, STOP and report.**

- [ ] **Step 6: Run the tests and commit**

```bash
bun test apps/web/lib/settings/instance-settings.test.ts
pnpm exec turbo typecheck --filter=web
git add -A && git commit -m "feat: store one typed Claude credential in Settings"
git status --short && git show --stat HEAD
```

---

### Task 2: Export the credential to the turn

**Files:**
- Modify: `apps/web/lib/agent/run-step.ts` (near `githubTokenEnv` at line 113, and the `env` block at line 207)
- Test: `apps/web/lib/agent/run-step.test.ts`

**Interfaces:**
- Consumes: `readClaudeCredential()` from Task 1.
- Produces: exactly one credential variable in the turn's environment. Task 3 adds the gateway variables beside it.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/agent/run-step.test.ts`:

```ts
describe("claudeCredentialEnv", () => {
  test("exports ANTHROPIC_API_KEY for an api key", () => {
    const env = claudeCredentialEnv({ kind: "api_key", value: "sk-ant-1" });

    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-1" });
  });

  test("exports CLAUDE_CODE_OAUTH_TOKEN for a setup token", () => {
    const env = claudeCredentialEnv({ kind: "setup_token", value: "oauth-1" });

    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-1" });
  });

  test("never exports both", () => {
    // ANTHROPIC_API_KEY outranks CLAUDE_CODE_OAUTH_TOKEN and is always used
    // in -p mode, so both present means the key silently wins.
    for (const kind of ["api_key", "setup_token"] as const) {
      const env = claudeCredentialEnv({ kind, value: "v" });

      expect(Object.keys(env)).toHaveLength(1);
    }
  });

  test("exports nothing when no credential is configured", () => {
    expect(claudeCredentialEnv(null)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/lib/agent/run-step.test.ts`

Expected: FAIL — `claudeCredentialEnv` is not exported.

- [ ] **Step 3: Implement it beside `githubTokenEnv`**

In `apps/web/lib/agent/run-step.ts`, directly after `githubTokenEnv` (line 113-118), add:

```ts
/**
 * The instance's Claude credential, as exactly one environment variable.
 *
 * Which variable depends on what the operator configured, and only ever one
 * of them is set. `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` in
 * the CLI's precedence and is always used in `-p` mode — the mode every turn
 * runs in — so setting both would silently charge the API account while the
 * operator believed their subscription token was in use. Settings stores one
 * credential with its kind precisely so this function has one answer.
 *
 * In the environment and never in argv, for the same reason as the `gh`
 * token above: `ps` shows one process's arguments to every user.
 */
export function claudeCredentialEnv(
  credential: { kind: "api_key" | "setup_token"; value: string } | null,
): Record<string, string> {
  if (credential === null) {
    return {};
  }
  return credential.kind === "api_key"
    ? { ANTHROPIC_API_KEY: credential.value }
    : { CLAUDE_CODE_OAUTH_TOKEN: credential.value };
}
```

Then spread it into `backendOptions.env` at line 207, beside `githubTokenEnv`, reading the credential with `await readClaudeCredential()`.

- [ ] **Step 4: Handle the unconfigured case deliberately**

A turn with no credential will fail inside the CLI with an authentication error that says nothing about Paco. Before starting the run, if `readClaudeCredential()` returns `null`, fail with a message naming Settings → Models as the place to fix it. Follow however `run-step.ts` already surfaces a pre-run failure — do not invent a new error channel.

- [ ] **Step 5: Run the tests and commit**

```bash
bun test apps/web/lib/agent/run-step.test.ts
pnpm exec turbo typecheck --filter=web
git add -A && git commit -m "feat: run turns on the configured Claude credential"
git status --short && git show --stat HEAD
```

---

### Task 3: The gateway and the model list

**Files:**
- Modify: `apps/web/lib/agent/run-step.ts`, `apps/web/lib/model-catalog.ts`
- Test: `apps/web/lib/agent/run-step.test.ts`, `apps/web/lib/model-catalog.test.ts`

**Interfaces:**
- Consumes: `claudeBaseUrl` and `claudeModelDiscovery` from Task 1.
- Produces: `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` in the turn environment when configured; a model list that reflects the gateway when one is set.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/agent/run-step.test.ts`:

```ts
describe("claudeGatewayEnv", () => {
  test("exports nothing when no base URL is set", () => {
    expect(claudeGatewayEnv({ baseUrl: null, modelDiscovery: false })).toEqual(
      {},
    );
  });

  test("exports the base URL when one is set", () => {
    const env = claudeGatewayEnv({
      baseUrl: "https://llm.example.com",
      modelDiscovery: false,
    });

    expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.example.com");
  });

  test("enables discovery only alongside a base URL", () => {
    // The CLI ignores discovery when the base URL is unset or points at
    // api.anthropic.com, so setting it alone would be a lie in the process
    // environment rather than a working feature.
    expect(
      claudeGatewayEnv({ baseUrl: null, modelDiscovery: true }),
    ).toEqual({});

    const env = claudeGatewayEnv({
      baseUrl: "https://llm.example.com",
      modelDiscovery: true,
    });

    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/lib/agent/run-step.test.ts`

Expected: FAIL — `claudeGatewayEnv` is not exported.

- [ ] **Step 3: Implement it**

Add `claudeGatewayEnv` beside `claudeCredentialEnv`, returning `{}` when `baseUrl` is null, `{ANTHROPIC_BASE_URL}` when set, and additionally `{CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"}` when discovery is on **and** a base URL is set. Comment why discovery without a base URL is meaningless: the CLI skips discovery entirely when the base URL is unset or is `api.anthropic.com`.

Spread it into `backendOptions.env` beside the credential.

- [ ] **Step 4: Make the catalog reflect the gateway**

In `apps/web/lib/model-catalog.ts`, keep `CLAUDE_MODELS` as the list used when no base URL is configured — its comment already explains why static tier aliases are right there, and that reasoning still holds.

When a base URL **is** configured, read the CLI's own discovery cache at `<PACO_HOME>/.claude/cache/gateway-models.json` — the CLI writes it after querying the gateway's `/v1/models`. Its shape is `{"data":[{"id": "...", "display_name": "..."}]}`. Fall back to `CLAUDE_MODELS` when the file is absent or unreadable: a gateway that has not been queried yet must not empty the picker.

Add a test for the fallback with the cache absent, and one for parsing a cache file with two entries. Do not test the CLI's own fetching — that is its behaviour, not Paco's.

- [ ] **Step 5: Run the tests and commit**

```bash
bun test apps/web/lib/agent/run-step.test.ts apps/web/lib/model-catalog.test.ts
pnpm exec turbo typecheck --filter=web
git add -A && git commit -m "feat: support an Anthropic-format gateway and its model list"
git status --short && git show --stat HEAD
```

---

### Task 4: The Settings UI

**Files:**
- Create: `apps/web/app/settings/models/claude-credential-section.tsx`
- Modify: `apps/web/app/settings/models/page.tsx`

**Interfaces:**
- Consumes: the view fields and save actions from Task 1.
- Produces: no new interface.

- [ ] **Step 1: Build the section**

A single card with:
- a radio pair choosing **API key** or **Setup token**, with one line each saying what they mean — an API key bills the Anthropic API; a setup token comes from `claude setup-token` and needs a Claude subscription;
- one password-type input for the value, never pre-filled with the stored secret (show whether one is set, and when, from `claudeCredentialKind` and `claudeCredentialSetAt`);
- an optional **Base URL** input, with help text saying it must speak the Anthropic Messages format and that non-Claude models are not supported through it;
- a **Fetch available models from this gateway** checkbox, disabled unless a base URL is set.

Use daisyUI components per `.agents/skills/daisyui/SKILL.md`. Label every input; the credential input must have `type="password"` and `autoComplete="off"`.

If a setup token is more than eleven months old, show a warning that it expires after a year and Paco cannot renew it.

- [ ] **Step 2: Wire it into the page and verify**

```bash
pnpm exec turbo typecheck --filter=web
pnpm check
git add -A && git commit -m "feat: add the Claude credential section to Settings"
git status --short && git show --stat HEAD
```

---

### Task 5: Remove `paco auth`, and the documentation

**Files:**
- Modify: `scripts/paco` — `cmd_auth`, `auth_claude`, `claude_auth_state`, `usage()`, `cmd_status`, the dispatch
- Modify: `README.md`, `docs/self-hosting.md`, `docs/contributing.md`, `apps/web/.env.example`, `AGENTS.md`
- Modify: `install.sh` — its closing summary tells the operator to run `sudo paco auth`
- Modify: `package.json` — version to `0.7.0`

- [ ] **Step 1: Remove the command**

Delete `cmd_auth`, `auth_claude` and `claude_auth_state` from `scripts/paco`, the `auth` arm of the dispatch, and the `auth` entry in `usage()`. In `cmd_status`, replace the `Claude:` row — which reported CLI login state — with one reporting whether a credential is configured in Settings, read the same way `configured_domain()` reads the database. It must degrade to "unknown (run as root to check)" off a Debian host, like its siblings.

- [ ] **Step 2: Fix the installer's closing advice**

`install.sh` currently ends by telling the operator `sudo paco auth` is the one remaining step. Replace that with opening Settings → Models and adding a credential. Check the whole closing summary — it describes what is left to do, and that changed.

- [ ] **Step 3: Verify the shell**

```bash
sh -n scripts/paco && echo "sh OK"
command -v dash >/dev/null && dash -n scripts/paco && echo "dash OK"
sh scripts/paco --help | grep -c "auth"     # must print 0
sh scripts/paco status | head -6            # must run, no Claude login row
```

- [ ] **Step 4: Update the documentation**

`README.md` and `docs/self-hosting.md` describe `paco auth` as the provisioning step; §3 of the self-hosting guide is titled after it. Rewrite them for a credential entered in Settings. `docs/contributing.md`'s setup step 4 says to run `claude auth login` — replace it with configuring a credential.

**Strengthen the `APP_SECRET` backup warning**: it now seals two credentials, and the Claude credential — unlike the old CLI login under `/var/lib/paco` — does not survive `apt purge`. Say both things plainly in the backup section.

`AGENTS.md`'s Authentication section must describe the credential and the gateway.

- [ ] **Step 5: Bump the version and verify everything**

Root `package.json`: `"version": "0.6.0"` → `"version": "0.7.0"`. Do not tag by hand.

```bash
pnpm check
pnpm exec turbo typecheck
pnpm test:isolated
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: remove the CLI login; credentials live in Settings"
git status --short && git show --stat HEAD
```

---

## Manual verification (human operator, on a real Debian host)

None of this can be checked from the test suite:

- A fresh install with no credential: the app loads, Settings → Models explains what is missing, and starting a chat fails with a message naming Settings rather than a raw CLI error.
- An **API key** saved in Settings drives a turn end to end.
- A **setup token** from `claude setup-token` drives a turn end to end — this is the path most likely to differ from expectation, because it is the lower-precedence variable.
- Rotating the credential takes effect on the next turn with no restart.
- With a real Anthropic-format gateway: `ANTHROPIC_BASE_URL` reaches the CLI, a turn runs through it, and with discovery enabled the picker shows the gateway's models rather than the tier aliases.
- `apt purge` destroys the credential and `apt install` starts from nothing — the consequence the backup section now documents.
