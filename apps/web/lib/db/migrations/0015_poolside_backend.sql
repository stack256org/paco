-- Paco's second agent backend changes hands: OpenFX is removed from the
-- product entirely and Poolside's `pool` CLI takes its place. Two kinds of
-- data are stranded by that: chats that were pinned to the old backend, and
-- the instance's OpenFX provider credentials.

-- 1. Chats still pinned to the removed backend.
--
-- `chats.backend` is plain `text` (no CHECK constraint, no PG enum type), so
-- nothing in the database stops an 'openfx' value from surviving; only the
-- application's Drizzle enum narrowed it, and that no longer lists 'openfx'.
-- Left alone, such a row would submit turns to a backend id no factory can
-- resolve.
--
-- These rows move to 'claude-code', NOT to 'poolside'. Rewriting them to
-- 'poolside' would be a lie about resumability: the chat's history was
-- produced by a different agent, and its `resume_tokens->>'openfx'` names a
-- session in a session store that no longer exists anywhere. 'claude-code'
-- is the column default and the one backend that is always available, so the
-- chat keeps working; it simply starts a fresh session, which is the honest
-- outcome. An operator who wants Poolside for one of these chats can pick it
-- in the UI, and that choice starts a real Poolside session.
UPDATE "chats"
SET "backend" = 'claude-code'
WHERE "backend" = 'openfx';--> statement-breakpoint

-- 2. The stale resume token that went with it.
--
-- `resume_tokens` is keyed by backend id (migration 0012). The 'openfx' key
-- is now a pointer into a deleted agent's session store: it can never resume
-- anything, and leaving it means `resolveChatResumeToken` would happily hand
-- it back if any code ever asked for that id again. Delete just that key
-- (jsonb `-`), leaving every other backend's token — 'claude-code' above
-- all — untouched. The `->` guard keeps this from rewriting rows that never
-- had an OpenFX turn.
UPDATE "chats"
SET "resume_tokens" = "resume_tokens" - 'openfx'
WHERE "resume_tokens" -> 'openfx' IS NOT NULL;--> statement-breakpoint

-- 3. Instance provider config.
--
-- Dropped rather than renamed, on purpose. `openfx_api_key_sealed` is a
-- secret for a service that is gone; carrying it into `poolside_api_key_sealed`
-- would give the operator an instance that looks configured and then fails to
-- authenticate on the first turn — strictly worse than an empty field that
-- says "enter your Poolside key". `openfx_endpoint` is not carried over
-- either: it was inert (the OpenFX binary had no way to be told where to send
-- provider traffic), so its value was never a working base URL for anything,
-- least of all a different vendor's API. `openfx_binary_path` points at an
-- `openfx` executable, not at `pool`.
--
-- The three new columns are genuinely wired: `poolside_base_url` is passed as
-- POOLSIDE_STANDALONE_BASE_URL, `poolside_api_key_sealed` (unsealed) as
-- POOLSIDE_API_KEY, and `poolside_binary_path` is the executable to spawn.
ALTER TABLE "instance_settings" ADD COLUMN "poolside_base_url" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "poolside_api_key_sealed" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "poolside_binary_path" text;--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "openfx_endpoint";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "openfx_api_key_sealed";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "openfx_binary_path";
