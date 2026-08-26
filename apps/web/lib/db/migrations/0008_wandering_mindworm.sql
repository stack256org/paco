ALTER TABLE "tasks" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "backend" text DEFAULT 'claude-code' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "consented_net_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;