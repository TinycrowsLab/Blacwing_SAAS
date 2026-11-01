-- Dev-only reverse of 20261101070753_policy_snapshots (refused in production; see migrate-guard.ts). Drops the snapshot rows.
DROP TABLE "policy_snapshots";
