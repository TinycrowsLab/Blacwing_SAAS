-- DEMO-STORY (`pnpm demo` only): the demo admin (BW_DEMO_LOGIN_EMAIL) may approve its own Gate 1 request, so the
-- table check that forced requester <> approver goes. The demo API still refuses every other requester and
-- records an admin self-approval in the audit ledger. Hand-written like 20261105120000_demo_gaps.sql. Forward-only.
ALTER TABLE demo.assessment_requests DROP CONSTRAINT demo_requests_sod_check;
