CREATE TYPE "public"."tts_mode" AS ENUM('auto', 'on_demand', 'off');--> statement-breakpoint
CREATE TYPE "public"."tts_provider" AS ENUM('elevenlabs', 'openai');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "tts_mode" "tts_mode";--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "tts_provider" "tts_provider";--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "elevenlabs_api_key" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "elevenlabs_voice_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "elevenlabs_tts_model" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "openai_api_key" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "openai_tts_model" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "openai_tts_voice" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "openai_tts_instructions" text;