CREATE TABLE "session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_events_chat_id_id_idx" ON "session_events" USING btree ("chat_id","id");