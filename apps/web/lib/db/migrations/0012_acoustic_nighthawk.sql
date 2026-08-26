ALTER TABLE "chats" ADD COLUMN "resume_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill: every chat's pre-existing single-backend `claude_session_id`
-- becomes its "claude-code" resume token, so a chat that has already run a
-- Claude Code turn keeps resuming it after this migration, without relying
-- on the `claudeSessionId` legacy-read fallback in application code.
UPDATE "chats"
SET "resume_tokens" = jsonb_build_object('claude-code', "claude_session_id")
WHERE "claude_session_id" IS NOT NULL;
