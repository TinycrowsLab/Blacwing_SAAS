-- Dev-only reverse of 20261030212954_secrets_idempotency_key (refused in production; see migrate-guard.ts). Drops the idempotency columns with their pair check and unique index.
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_idempotency_pair_check";--> statement-breakpoint
DROP INDEX "secrets_tenant_idempotency_idx";--> statement-breakpoint
ALTER TABLE "secrets" DROP COLUMN "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "secrets" DROP COLUMN "idempotency_key_hash";
