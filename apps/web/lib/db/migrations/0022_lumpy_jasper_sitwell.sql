ALTER TABLE "instance_settings" ADD COLUMN "claude_credential_kind" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "claude_credential_sealed" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "claude_credential_set_at" timestamp;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "claude_base_url" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "claude_model_discovery" boolean DEFAULT false NOT NULL;