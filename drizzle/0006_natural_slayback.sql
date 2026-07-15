ALTER TABLE "chunks" drop column "tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('italian', "chunks"."content")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin_idx" ON "chunks" USING gin ("tsv");