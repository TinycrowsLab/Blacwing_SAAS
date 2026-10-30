# k6 load-test harness (PERF-001, #320). Every target runs k6 from the repository root, so the JSON summaries
# land in infra/perf/results/. Environment: PERF_BASE_URL (default http://localhost:3000), PERF_TOKEN (required),
# PERF_TENANT_ID (optional UUID). See infra/perf/README.md.

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
K6 ?= k6

.PHONY: smoke load stress soak run ci-smoke unit

smoke: ## 1 VU for 30s
	@$(MAKE) --no-print-directory run PROFILE=smoke SCRIPT=baseline

load: ## ramp to 50 VUs over 5m
	@$(MAKE) --no-print-directory run PROFILE=load SCRIPT=baseline

stress: ## ramp to 300 VUs over 5m
	@$(MAKE) --no-print-directory run PROFILE=stress SCRIPT=baseline

soak: ## 20 VUs for 1h
	@$(MAKE) --no-print-directory run PROFILE=soak SCRIPT=baseline

# Prometheus remote-write is enabled only when K6_PROMETHEUS_RW_SERVER_URL is set AND answers. An unreachable
# endpoint produces a warning and the run continues with the JSON summary only.
run:
	@cd $(ROOT) && out=""; \
	if [ -n "$$K6_PROMETHEUS_RW_SERVER_URL" ]; then \
	  code=$$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$$K6_PROMETHEUS_RW_SERVER_URL" || true); \
	  if [ "$$code" = "000" ] || [ -z "$$code" ]; then \
	    echo "warning: Prometheus remote-write unreachable at $$K6_PROMETHEUS_RW_SERVER_URL; writing the JSON summary only" >&2; \
	  else \
	    out="--out experimental-prometheus-rw"; \
	  fi; \
	fi; \
	PERF_PROFILE=$(PROFILE) $(K6) run $$out infra/perf/k6/$(SCRIPT).js

ci-smoke: ## offline: smoke + threshold-breach against the seeded local target (no stack)
	@cd $(ROOT) && node infra/perf/fixtures/ci-smoke.mjs

unit: ## harness unit tests (node:test)
	@cd $(ROOT) && node --test infra/perf/lib/harness.test.mjs
