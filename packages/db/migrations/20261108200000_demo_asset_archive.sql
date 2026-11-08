-- DEMO-STORY: a target can be removed from the list. The row is kept (requests, runs and findings reference it and the
-- ledger names it); archived_at hides it from the target list and from the "already added" check, so the same site can
-- be added and verified again. Forward-only.
ALTER TABLE demo.assets ADD COLUMN archived_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE demo.assets ADD COLUMN archived_by uuid;
