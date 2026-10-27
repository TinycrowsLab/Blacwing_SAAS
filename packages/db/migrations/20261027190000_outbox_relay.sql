CREATE POLICY "outbox_relay_select" ON "outbox" AS PERMISSIVE FOR SELECT TO "bw_relay" USING (true);--> statement-breakpoint
CREATE POLICY "outbox_relay_update" ON "outbox" AS PERMISSIVE FOR UPDATE TO "bw_relay" USING ("outbox"."status" = 'pending') WITH CHECK (true);--> statement-breakpoint
-- Hand-written below (Drizzle models neither grants nor column privileges). Reviewed.
-- The relay role reads outbox rows and may update only the delivery columns: never tenant_id, type,
-- payload, dedupe_key or the aggregate, and it cannot INSERT or DELETE. The policies above confine
-- UPDATE to rows still pending.
REVOKE ALL ON "outbox" FROM bw_relay;--> statement-breakpoint
GRANT SELECT ON "outbox" TO bw_relay;--> statement-breakpoint
GRANT UPDATE ("status", "attempts", "available_at", "dispatched_at", "last_error") ON "outbox" TO bw_relay;
