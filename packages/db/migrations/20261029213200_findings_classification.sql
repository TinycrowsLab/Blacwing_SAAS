ALTER TABLE "findings" ADD COLUMN "mapping_version" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "unmapped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "classification" jsonb;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_mapping_version_check" CHECK ("findings"."mapping_version" IS NULL OR "findings"."mapping_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+$');--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_mapped_check" CHECK ("findings"."unmapped" OR ("findings"."cwe_id" IS NOT NULL AND "findings"."owasp_category" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_classification_check" CHECK ("findings"."classification" IS NULL OR (jsonb_typeof("findings"."classification") = 'object' AND octet_length("findings"."classification"::text) <= 4096));