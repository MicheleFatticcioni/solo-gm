CREATE TYPE "public"."chat_provider" AS ENUM('anthropic', 'ollama');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "chat_provider" "chat_provider";--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "ollama_api_key" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "ollama_chat_model" text;