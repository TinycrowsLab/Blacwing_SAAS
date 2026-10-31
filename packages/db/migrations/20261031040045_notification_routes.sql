CREATE TABLE "notification_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event" text NOT NULL,
	"asset_id" uuid,
	"severity_min" text DEFAULT 'info' NOT NULL,
	"channel_id" uuid NOT NULL,
	"recipient_spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_routes_event_check" CHECK ("notification_routes"."event" IN ('*', 'gate1.requested', 'gate2.exception', 'gate3.release_requested', 'run.completed', 'run.failed', 'kill.fired', 'soc.test_window', 'soc.window_opened', 'budget.cap', 'finding.released', 'system.alert')),
	CONSTRAINT "notification_routes_severity_check" CHECK ("notification_routes"."severity_min" IN ('info', 'low', 'medium', 'high', 'critical')),
	CONSTRAINT "notification_routes_priority_check" CHECK ("notification_routes"."priority" BETWEEN -1000 AND 1000),
	CONSTRAINT "notification_routes_recipient_spec_check" CHECK (jsonb_typeof("notification_routes"."recipient_spec") = 'object')
);
--> statement-breakpoint
ALTER TABLE "notification_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE INDEX "notification_routes_tenant_id_idx" ON "notification_routes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "notification_routes_tenant_channel_idx" ON "notification_routes" USING btree ("tenant_id","channel_id");--> statement-breakpoint
CREATE POLICY "notification_routes_tenant_isolation" ON "notification_routes" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Hand-written (Drizzle does not model these): FORCE RLS for the owner role too, and grants for the runtime role. A rule
-- is configuration, not history, so the runtime role may delete one (the deletion is audited in the same transaction).
-- The updated_at trigger is bw_set_updated_at (0002_column_mixins).
ALTER TABLE "notification_routes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "notification_routes" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_routes" TO bw_app;--> statement-breakpoint
CREATE TRIGGER notification_routes_set_updated_at BEFORE UPDATE ON notification_routes FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();
-- Hand-written: the composite foreign key is NOT VALID. The table is new and empty, so there is nothing to validate, and
-- validating it scans notification_channels under its FORCE RLS policy, which needs app.tenant_id (absent during migration).
-- Every later insert and update is still checked against the same tenant's channel.
--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_channel_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."notification_channels"("tenant_id","id") ON DELETE no action ON UPDATE no action NOT VALID;
