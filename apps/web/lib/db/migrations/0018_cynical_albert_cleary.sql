ALTER TABLE "accounts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "accounts" CASCADE;--> statement-breakpoint
DROP TABLE "auth_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "invitations" CASCADE;--> statement-breakpoint
DROP TABLE "organization_members" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
DROP TABLE "verification" CASCADE;--> statement-breakpoint
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_user_id_unique";--> statement-breakpoint
DROP INDEX "chat_reads_chat_id_idx";--> statement-breakpoint
DROP INDEX "sessions_user_id_idx";--> statement-breakpoint
DROP INDEX "workflow_runs_user_id_idx";--> statement-breakpoint
ALTER TABLE "chat_reads" DROP CONSTRAINT "chat_reads_user_id_chat_id_pk";--> statement-breakpoint
DELETE FROM "chat_reads" WHERE ctid NOT IN (SELECT DISTINCT ON ("chat_id") ctid FROM "chat_reads" ORDER BY "chat_id", "last_read_at" DESC);--> statement-breakpoint
ALTER TABLE "chat_reads" ADD PRIMARY KEY ("chat_id");--> statement-breakpoint
DELETE FROM "user_preferences" WHERE "id" NOT IN (SELECT "id" FROM "user_preferences" ORDER BY "updated_at" DESC LIMIT 1);--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "id" SET DATA TYPE boolean USING true;--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "id" SET DEFAULT true;--> statement-breakpoint
-- The instance now has exactly one GitHub token, not one per user. Picking
-- "most recently updated" would silently inherit an arbitrary departed
-- teammate's identity and scopes for the instance's git commit author (see
-- lib/github/gh-identity.ts) with nothing logged and no prompt to reconnect.
-- A single-token instance is unambiguous and keeps its token; an instance
-- with more than one token has no way to know which one is "the operator's",
-- so it comes up with none and the operator reconnects once, deliberately,
-- via Settings -> Connections.
DELETE FROM "github_tokens" WHERE (SELECT count(*) FROM "github_tokens") > 1;--> statement-breakpoint
ALTER TABLE "github_tokens" ADD COLUMN "id" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_reads" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "plugins" DROP COLUMN "installed_by";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "usage_events" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "workflow_runs" DROP COLUMN "user_id";