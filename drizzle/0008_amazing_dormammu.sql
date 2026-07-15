ALTER TYPE "public"."chat_provider" ADD VALUE 'deepseek';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "deepseek_api_key" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "deepseek_model_gm" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "deepseek_model_summary" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "deepseek_model_improve" text;