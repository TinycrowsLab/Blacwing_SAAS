CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"prev_chain" text,
	"chain" text NOT NULL,
	"retention_until" timestamp with time zone,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_items_sequence_check" CHECK ("evidence_items"."sequence" >= 1),
	CONSTRAINT "evidence_items_prev_chain_check" CHECK (("evidence_items"."sequence" = 1) = ("evidence_items"."prev_chain" IS NULL)),
	CONSTRAINT "evidence_items_prev_chain_format_check" CHECK ("evidence_items"."prev_chain" IS NULL OR "evidence_items"."prev_chain" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_items_chain_check" CHECK ("evidence_items"."chain" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_items_kind_check" CHECK ("evidence_items"."kind" IN ('request', 'response', 'har', 'pcap', 'screenshot', 'dom', 'replay_script', 'oob_interaction', 'transcript_excerpt', 'log')),
	CONSTRAINT "evidence_items_role_check" CHECK ("evidence_items"."role" IN ('positive', 'negative_control', 'oracle')),
	CONSTRAINT "evidence_items_sha256_check" CHECK ("evidence_items"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_items_size_check" CHECK ("evidence_items"."size" >= 0 AND "evidence_items"."size" <= 5368709120),
	CONSTRAINT "evidence_items_content_type_check" CHECK (length("evidence_items"."content_type") BETWEEN 1 AND 120),
	CONSTRAINT "evidence_items_object_key_check" CHECK (length("evidence_items"."object_key") BETWEEN 1 AND 512 AND starts_with("evidence_items"."object_key", "evidence_items"."tenant_id"::text || '/'))
);
--> statement-breakpoint
ALTER TABLE "evidence_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD COLUMN "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "evidence_items_tenant_id_idx" ON "evidence_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_items_tenant_id_run_id_sequence_key" ON "evidence_items" USING btree ("tenant_id","run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_items_object_key_key" ON "evidence_items" USING btree ("object_key");--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_evidence_refs_check" CHECK (jsonb_typeof("finding_occurrences"."evidence_refs") = 'array' AND octet_length("finding_occurrences"."evidence_refs"::text) <= 8192);--> statement-breakpoint
CREATE POLICY "evidence_items_tenant_isolation" ON "evidence_items" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- Hand-written below (Drizzle models neither FORCE ROW LEVEL SECURITY nor grants). Reviewed.
-- FORCE: the owner role is subject to the tenant policy too, so nothing reads across tenants.
ALTER TABLE "evidence_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Write-once (CONTEXT_PACK §8.8): the runtime role may read and append evidence, never change or remove it.
REVOKE ALL ON "evidence_items" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "evidence_items" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "evidence_items" TO bw_app;
