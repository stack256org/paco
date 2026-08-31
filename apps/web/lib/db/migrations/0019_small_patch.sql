ALTER TABLE "github_tokens" DROP CONSTRAINT "github_tokens_pkey";--> statement-breakpoint
ALTER TABLE "github_tokens" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "github_tokens" DROP COLUMN "user_id";