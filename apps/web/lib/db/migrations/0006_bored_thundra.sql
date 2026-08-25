CREATE TABLE "plugin_kv" (
	"plugin_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_kv_plugin_id_key_pk" PRIMARY KEY("plugin_id","key")
);
--> statement-breakpoint
ALTER TABLE "plugin_kv" ADD CONSTRAINT "plugin_kv_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;