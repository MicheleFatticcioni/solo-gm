CREATE TYPE "public"."embeddings_provider" AS ENUM('voyage', 'ollama');--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"anthropic_api_key" text,
	"model_gm" text,
	"model_summary" text,
	"model_improve" text,
	"embeddings_provider" "embeddings_provider",
	"voyage_api_key" text,
	"ollama_host" text,
	"ollama_embed_model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;