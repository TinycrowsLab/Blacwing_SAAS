CREATE TABLE "verification_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"method" text NOT NULL,
	"token" text NOT NULL,
	"expected_location" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_challenges_token_check" CHECK (starts_with("verification_challenges"."token", 'blackwing-site-verification=') AND length("verification_challenges"."token") >= 80),
	CONSTRAINT "verification_challenges_status_check" CHECK ("verification_challenges"."status" IN ('pending', 'passed', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "verification_challenges_method_check" CHECK ("verification_challenges"."method" IN ('dns_txt', 'http_file', 'manual_letter')),
	CONSTRAINT "verification_challenges_attempts_check" CHECK ("verification_challenges"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "verification_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- NOT VALID: "assets" is FORCE RLS (ASSET-001), so validating this foreign key (a scan of "assets" as the owner) is refused
-- with no tenant context. The table is created empty here, so there is nothing to validate. Inserts are still checked: the
-- referential-integrity trigger runs with RLS bypassed and requires the parent in the same tenant (composite key).
-- Do not run VALIDATE CONSTRAINT on it: that scan has the same problem.
ALTER TABLE "verification_challenges" ADD CONSTRAINT "verification_challenges_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "verification_challenges_tenant_id_idx" ON "verification_challenges" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "verification_challenges_asset_id_idx" ON "verification_challenges" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_challenges_one_pending_per_asset_key" ON "verification_challenges" USING btree ("asset_id") WHERE "verification_challenges"."status" = 'pending';--> statement-breakpoint
CREATE POLICY "verification_challenges_tenant_isolation" ON "verification_challenges" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

--> statement-breakpoint
-- Hand-written (Drizzle does not model these): FORCE RLS for the owner role too, grants for the runtime role (challenges
-- are history: never deleted), and the updated_at trigger (bw_set_updated_at: 0002_column_mixins).
ALTER TABLE "verification_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "verification_challenges" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "verification_challenges" TO bw_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "verification_challenges" FROM bw_app;--> statement-breakpoint
CREATE TRIGGER verification_challenges_set_updated_at BEFORE UPDATE ON verification_challenges FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
