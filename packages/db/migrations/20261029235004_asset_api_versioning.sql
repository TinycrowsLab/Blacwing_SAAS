ALTER TABLE "assets" ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_idempotency_key_idx" ON "assets" USING btree ("tenant_id","idempotency_key") WHERE "assets"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_state_version_check" CHECK ("assets"."state_version" >= 0);--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_idempotency_check" CHECK (("assets"."idempotency_key" IS NULL) = ("assets"."idempotency_fingerprint" IS NULL));