ALTER TABLE "secrets" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_tenant_idempotency_idx" ON "secrets" USING btree ("tenant_id","idempotency_key_hash");--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_idempotency_pair_check" CHECK (("secrets"."idempotency_key_hash" IS NULL) = ("secrets"."idempotency_fingerprint" IS NULL));