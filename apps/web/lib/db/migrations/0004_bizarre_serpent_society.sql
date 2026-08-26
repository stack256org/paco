CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"version" text NOT NULL,
	"content_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"granted_capabilities" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
