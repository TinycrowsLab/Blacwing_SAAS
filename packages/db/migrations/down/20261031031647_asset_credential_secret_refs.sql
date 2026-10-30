-- Dev-only reverse of 20261031031647_asset_credential_secret_refs (refused in production; see migrate-guard.ts). Restores the openbao-only secret_ref check.
ALTER TABLE "asset_credentials" DROP CONSTRAINT "asset_credentials_secret_ref_check";--> statement-breakpoint
ALTER TABLE "asset_credentials" ADD CONSTRAINT "asset_credentials_secret_ref_check" CHECK (starts_with("asset_credentials"."secret_ref", 'openbao://') AND length("asset_credentials"."secret_ref") <= 2048);
