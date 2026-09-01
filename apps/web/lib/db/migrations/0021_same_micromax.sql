-- Poolside is removed from the product entirely. Two kinds of data are
-- stranded by that: chats that were pinned to it, and the instance's
-- Poolside provider config.

-- 1. Chats still pinned to the removed backend.
--
-- `chats.backend` is plain `text` (no CHECK constraint, no PG enum type), so
-- nothing in the database stops a 'poolside' value from surviving; only the
-- application's Drizzle enum narrowed it, and that no longer lists
-- 'poolside'. Left alone, such a row would submit turns to a backend id no
-- factory can resolve.
--
-- These rows move to 'claude-code', the column default and the only backend
-- that exists now, exactly as migration 0015 did for the 'openfx' rows
-- before it. The chat keeps working; it simply starts a fresh session.
UPDATE "chats"
SET "backend" = 'claude-code'
WHERE "backend" = 'poolside';--> statement-breakpoint

-- 2. The stale resume token that went with it.
--
-- `resume_tokens` is keyed by backend id. The 'poolside' key is now a
-- pointer into a session store the product no longer runs: it can never
-- resume anything, and leaving it means `resolveChatResumeToken` would
-- happily hand it back if any code ever asked for that id again. Delete just
-- that key (jsonb `-`), leaving every other backend's token untouched. The
-- `->` guard keeps this from rewriting rows that never had a Poolside turn.
UPDATE "chats"
SET "resume_tokens" = "resume_tokens" - 'poolside'
WHERE "resume_tokens" -> 'poolside' IS NOT NULL;--> statement-breakpoint

-- 3. Instance provider config. Dropped, not carried anywhere — there is no
-- successor backend for these values to move to.
ALTER TABLE "instance_settings" DROP COLUMN "poolside_base_url";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "poolside_api_key_sealed";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "poolside_binary_path";
