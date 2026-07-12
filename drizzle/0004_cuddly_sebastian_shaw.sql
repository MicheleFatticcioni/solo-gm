CREATE TYPE "public"."wiki_folder" AS ENUM('core', 'pg', 'npc', 'luoghi', 'eventi', 'storia', 'note');--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"folder" "wiki_folder" NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "wiki_covers_until_message_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_campaign_folder_slug_idx" ON "wiki_pages" USING btree ("campaign_id","folder","slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_campaign_folder_idx" ON "wiki_pages" USING btree ("campaign_id","folder");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_wiki_covers_until_message_id_messages_id_fk" FOREIGN KEY ("wiki_covers_until_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;