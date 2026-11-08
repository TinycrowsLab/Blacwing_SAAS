-- Dev-only reverse of 20261108200000_demo_asset_archive (refused in production; see migrate-guard.ts).
ALTER TABLE demo.assets DROP COLUMN archived_by;
ALTER TABLE demo.assets DROP COLUMN archived_at;
