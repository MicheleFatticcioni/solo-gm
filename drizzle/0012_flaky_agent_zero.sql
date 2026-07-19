CREATE TYPE "public"."module_status" AS ENUM('pending', 'ready', 'error');--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "module_status" "module_status";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "module_error" text;