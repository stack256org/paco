# Bring-your-own Claude credential; remove Poolside and the CLI login

**Date:** 2026-09-01
**Status:** Approved in brainstorming; awaiting implementation planning
**Prior spec:** [2026-08-31-remove-auth-instance-password-design.md](2026-08-31-remove-auth-instance-password-design.md)

## Context

Paco authenticates its agent by running `sudo paco auth`, which runs
`claude auth login` as the `paco` user and leaves an OAuth credential in
`/var/lib/paco/.claude`. A second backend, Poolside, is authenticated the same
way with `paco auth poolside`, or by pasting an API key into Settings.

Two things are wrong with that. Provisioning requires an interactive terminal
session as a system user — it cannot be done from the product, scripted, or
handed to someone without shell access. And the credential is machine-local:
it is invisible to the operator, cannot be rotated from the UI, and is tied to
whichever account happened to be at that terminal.

This design replaces the CLI login with a credential stored in Settings,
removes the Poolside backend entirely, and lets an operator point Paco at
their own Anthropic-compatible gateway with the model list fetched rather than
hardcoded.

## What the research established

These facts are load-bearing and were verified against the installed CLI
(v2.1.236) and Anthropic's documentation, not recalled. Several contradict the
shape this work was originally requested in.

**`claude setup-token` is not an API key.** It performs a browser OAuth flow
and prints a **one-year token that requires a Claude subscription** — not API
billing. The token is *saved nowhere*; the operator captures it and supplies it
as `CLAUDE_CODE_OAUTH_TOKEN`.

**Auth precedence, and why it matters here.** Highest to lowest: cloud-provider
vars (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` →
`ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profile →
subscription login. Paco runs the CLI with `-p`
(`packages/claude-code/options.ts:152`), and `ANTHROPIC_API_KEY` is *always*
used in that mode. **A setup token therefore ranks below an API key**: set
both, and the key silently wins and bills the wrong account.

**Non-Claude models through a gateway are not supported.** Anthropic's docs
state that they "don't support routing Claude Code to non-Claude models through
any gateway". The supported contract requires the gateway to speak the
Anthropic Messages format (`ANTHROPIC_BASE_URL`), Bedrock InvokeModel, or
Vertex rawPredict — all three serving Claude models. There is no
OpenAI-compatible mode, and OpenRouter appears nowhere in the documentation.
**Routing OpenRouter's non-Claude models through Paco is therefore out of
scope, because Claude Code cannot do it** — not because this design declines
to. What is in scope is Claude reached through an operator's own gateway.

**Model discovery already exists in the CLI.**
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` makes the CLI call
`GET /v1/models?limit=1000` on the configured gateway, filter to ids containing
"claude" or "anthropic", and cache the result at
`~/.claude/cache/gateway-models.json`. It does not run when a `CLAUDE_CODE_USE_*`
var is set, or when the base URL is unset or `api.anthropic.com`.

**Model names are validated against Anthropic, not against a gateway.** On the
first-party API an unrecognised model id is rejected. On a gateway reached with
`ANTHROPIC_BASE_URL` alone, that validation still applies unless discovery or
`modelOverrides` registers the name first.

**The environment already reaches the CLI.**
`packages/claude-code/child-env.ts` passes `ANTHROPIC_*` and `CLAUDE_*` through
by prefix, deliberately, so new CLI variables work without code changes. This
design adds no plumbing — only what sets those variables.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| What is the gateway for? | Claude through the operator's own gateway — the supported path |
| API key or setup token? | **One credential, typed.** Never both |
| CLI login | Removed entirely — `paco auth` and all its subcommands |
| Poolside | Removed entirely, including its CLI surface |
| Models | Aliases when direct; fetched from the gateway when one is configured |
| The `agent-backend` seam | **Kept.** Only the Poolside implementation goes |

## Architecture

```text
Settings -> Models -> Claude
  Credential type  ( ) API key   ( ) Setup token
  Credential       [ sealed with APP_SECRET ]
  Base URL         [ empty = Anthropic direct ]
  [x] Fetch available models from this gateway

                    │
                    ▼  per turn, lib/agent/chat-environment.ts
        exactly one of:
          ANTHROPIC_API_KEY=…          (API billing)
          CLAUDE_CODE_OAUTH_TOKEN=…    (subscription)
        plus, when a base URL is set:
          ANTHROPIC_BASE_URL=…
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
                    │
                    ▼  child-env.ts (ANTHROPIC_*/CLAUDE_* prefix passthrough)
                 claude -p …
```

### Schema

Added to `instanceSettings`:

```ts
claudeCredentialKind:   text("claude_credential_kind", {
                          enum: ["api_key", "setup_token"] }),
claudeCredentialSealed: text("claude_credential_sealed"),
claudeCredentialSetAt:  timestamp("claude_credential_set_at"),
claudeBaseUrl:          text("claude_base_url"),
claudeModelDiscovery:   boolean("claude_model_discovery").notNull().default(false),
```

Sealed with `lib/crypto/secret-box`, exactly as the GitHub token is. `APP_SECRET`
therefore now protects two credentials, which strengthens rather than changes
the existing backup requirement.

Removed: `instanceSettings.poolsideBaseUrl`, `poolsideApiKeySealed`,
`poolsideBinaryPath`; and the `"poolside"` value from the `chats.backend` enum.

**`chats.backend` and `@paco/agent-backend` both survive.** With one
implementation the column holds one value, which looks vestigial — but the
interface is what `fake-backend.ts` and `conformance.ts` test against, and the
column is threaded through `resumeTokens` and the roster. Deleting a working
extension point to save a single-valued column is a larger change than it
appears and buys nothing this design needs.

### Why one credential, not two fields

The precedence trap above is silent and expensive: a customer who pastes a
subscription setup token while an API key is still set gets charged to the API
account and has no way to tell from the UI. Storing one credential with a kind
tag makes that state unreachable — the UI is a radio, saving one clears the
other, and exactly one variable is ever exported.

### Models

Two modes, because the existing static catalog is genuinely better when Paco
talks to Anthropic directly:

- **No base URL** — the tier aliases (`opus`, `sonnet`, `haiku`) that
  `lib/model-catalog.ts` holds today. They never go stale, the CLI resolves
  them to the current model in each tier, and the picker needs no network call.
- **Base URL set, discovery on** — the CLI fetches `/v1/models` from the
  gateway and populates its own picker; Paco reads back
  `~/.claude/cache/gateway-models.json` to render the same list.

`ModelTier` in `packages/claude-code/options.ts` already accepts any string, so
arbitrary ids need no type change.

**What this does not deliver, stated plainly:** discovery filters to ids
containing "claude" or "anthropic", so "any model from any gateway" is not
achievable. "Any Claude model your gateway serves" is.

## Phasing

**Phase 1 — Remove Poolside.** `packages/poolside-backend` (17 files) and its
~69 referencing files; the Settings → Models → Poolside section; the
`poolside_*` columns; the `"poolside"` enum value; `auth_poolside`,
`poolside_binary`, `poolside_credentials_file` and `poolside_state` in
`scripts/paco`; §18 and the scattered references in `docs/self-hosting.md`; the
`POOLSIDE_*` documentation in `.env.example`.

**Phase 2 — The credential and the gateway.** The schema above, the Settings
section, `chat-environment.ts` exporting the variables, removal of `cmd_auth`
and `claude_auth_state` from `scripts/paco`, the two-mode model list, and the
documentation.

Phase 1 is pure deletion and Phase 2 is pure addition; entangling them would
make both harder to review.

## Consequences accepted

**The credential stops surviving `apt remove`.** Today it lives in
`/var/lib/paco`, which dpkg never touches. In Settings it lives in Postgres:
backed up with the database, visible, rotatable from the UI — but destroyed by
`apt purge`, and sealed with `APP_SECRET`, so it shares that key's fate. The
self-hosting backup section must say so.

**A setup token expires after a year, silently.** Nothing warns; turns simply
begin failing with a CLI error. `claudeCredentialSetAt` exists so Settings can
show the credential's age and `paco status` can report it, which is the whole
mitigation — Paco cannot renew it.

**An instance with no credential cannot run a turn.** Today a fresh install
also cannot, until `paco auth` is run; the difference is that the failure moves
from a shell command to a Settings page, and can be explained there.

## Testing

- `chat-environment` exports exactly one credential variable, and the correct
  one for each kind — the property the precedence trap turns on.
- No credential configured produces a clear error rather than an unauthenticated
  CLI invocation.
- A configured base URL sets `ANTHROPIC_BASE_URL`, and enabling discovery sets
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; neither appears otherwise.
- Sealing round-trips through `secret-box` for both credential kinds.
- After Phase 1, no reference to `poolside` survives in code, comments,
  packaging or documentation.

The gateway path itself cannot be tested here — it needs a real
Anthropic-format gateway. That belongs in the manual verification, alongside
confirming that a real setup token and a real API key each drive a turn.
