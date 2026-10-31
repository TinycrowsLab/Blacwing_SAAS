-- Dev-only reverse of 20261031031952_policy_decision_logs (refused in production; see migrate-guard.ts). Drops the decision log.
DROP TABLE "policy_decision_logs";
