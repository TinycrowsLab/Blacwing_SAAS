CREATE TABLE "cost_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"subtask_id" uuid,
	"agent_session_id" uuid,
	"stage" text NOT NULL,
	"persona" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"price_table_id" uuid NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cost_usd" numeric(18, 10) NOT NULL,
	"usage_event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_ledger_tenant_usage_event_key" UNIQUE("tenant_id","usage_event_id"),
	CONSTRAINT "cost_ledger_stage_check" CHECK ("cost_ledger"."stage" IN ('recon', 'planning', 'execution', 'validation', 'reporting', 'other')),
	CONSTRAINT "cost_ledger_provider_check" CHECK ("cost_ledger"."provider" IN ('anthropic', 'bedrock', 'vertex', 'foundry')),
	CONSTRAINT "cost_ledger_model_check" CHECK ("model" ~ '^[a-z0-9][a-z0-9.-]*$' AND "model" !~ '-[0-9]{8}$'),
	CONSTRAINT "cost_ledger_tokens_check" CHECK ("cost_ledger"."input_tokens" BETWEEN 0 AND 1000000000
        AND "cost_ledger"."output_tokens" BETWEEN 0 AND 1000000000
        AND "cost_ledger"."cache_write_tokens" BETWEEN 0 AND 1000000000
        AND "cost_ledger"."cache_read_tokens" BETWEEN 0 AND 1000000000),
	CONSTRAINT "cost_ledger_cost_check" CHECK ("cost_ledger"."cost_usd" >= 0),
	CONSTRAINT "cost_ledger_usage_event_check" CHECK (length(btrim("cost_ledger"."usage_event_id")) > 0),
	CONSTRAINT "cost_ledger_persona_check" CHECK ("cost_ledger"."persona" IS NULL OR length(btrim("cost_ledger"."persona")) > 0)
);
--> statement-breakpoint
ALTER TABLE "cost_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"version" bigint NOT NULL,
	"input_per_mtok" numeric(14, 6) NOT NULL,
	"output_per_mtok" numeric(14, 6) NOT NULL,
	"cache_write_per_mtok" numeric(14, 6) NOT NULL,
	"cache_read_per_mtok" numeric(14, 6) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"sha256" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_tables_provider_model_version_key" UNIQUE("provider","model","version"),
	CONSTRAINT "price_tables_provider_check" CHECK ("price_tables"."provider" IN ('anthropic', 'bedrock', 'vertex', 'foundry')),
	CONSTRAINT "price_tables_model_check" CHECK ("model" ~ '^[a-z0-9][a-z0-9.-]*$' AND "model" !~ '-[0-9]{8}$'),
	CONSTRAINT "price_tables_version_check" CHECK ("price_tables"."version" >= 1),
	CONSTRAINT "price_tables_prices_check" CHECK ("price_tables"."input_per_mtok" >= 0 AND "price_tables"."output_per_mtok" >= 0 AND "price_tables"."cache_write_per_mtok" >= 0 AND "price_tables"."cache_read_per_mtok" >= 0),
	CONSTRAINT "price_tables_currency_check" CHECK ("price_tables"."currency" = 'USD'),
	CONSTRAINT "price_tables_sha256_check" CHECK ("price_tables"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "price_tables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_price_table_id_price_tables_id_fk" FOREIGN KEY ("price_table_id") REFERENCES "public"."price_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_ledger_tenant_id_idx" ON "cost_ledger" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_tenant_run_idx" ON "cost_ledger" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_tenant_occurred_at_idx" ON "cost_ledger" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "cost_ledger_tenant_model_idx" ON "cost_ledger" USING btree ("tenant_id","model");--> statement-breakpoint
CREATE INDEX "cost_ledger_price_table_idx" ON "cost_ledger" USING btree ("price_table_id");--> statement-breakpoint
CREATE POLICY "cost_ledger_tenant_isolation" ON "cost_ledger" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "price_tables_read" ON "price_tables" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "price_tables_operator_write" ON "price_tables" AS PERMISSIVE FOR ALL TO "bw_operator" USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Hand-written (Drizzle does not model FORCE ROW LEVEL SECURITY, grants or triggers). Reviewed.
-- FORCE: the owner role is subject to the policies too, so the owner reaches no cost row without a tenant context.
ALTER TABLE "cost_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "price_tables" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The ledger is append-only (COST-001, §8.8): the runtime role inserts and reads, and never updates or deletes.
-- Corrections are compensating rows. The database default privileges grant bw_app DML, so it is narrowed here.
REVOKE ALL ON "cost_ledger" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON "cost_ledger" TO bw_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "cost_ledger" FROM bw_app;--> statement-breakpoint
-- Price tables are platform reference data (§8.9): tenants read them, only the operator path writes them, and a price
-- change is a new version row (rows are never deleted; `active` is the only mutable column).
REVOKE ALL ON "price_tables" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT ON "price_tables" TO bw_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "price_tables" FROM bw_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "price_tables" TO bw_operator;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "price_tables" FROM bw_operator;--> statement-breakpoint
-- Immutable prices (§8.9): nothing that prices a row may change after it is written, whatever the role. The
-- operator path can still flip `active` and bump `updated_at`; a different price is a different version row.
CREATE OR REPLACE FUNCTION bw_price_table_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (NEW.provider, NEW.model, NEW.version, NEW.input_per_mtok, NEW.output_per_mtok,
      NEW.cache_write_per_mtok, NEW.cache_read_per_mtok, NEW.currency, NEW.effective_from, NEW.sha256)
     IS DISTINCT FROM
     (OLD.provider, OLD.model, OLD.version, OLD.input_per_mtok, OLD.output_per_mtok,
      OLD.cache_write_per_mtok, OLD.cache_read_per_mtok, OLD.currency, OLD.effective_from, OLD.sha256) THEN
    RAISE EXCEPTION 'price table % is immutable: a price change is a new version', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER price_tables_immutable BEFORE UPDATE ON "price_tables" FOR EACH ROW EXECUTE FUNCTION bw_price_table_guard();--> statement-breakpoint
CREATE TRIGGER price_tables_set_updated_at BEFORE UPDATE ON price_tables FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
