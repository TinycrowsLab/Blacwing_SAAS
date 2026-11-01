# Blackwing SSRF lab (EVAL-001, #796). Built locally on a digest-pinned Node base; eval-only, never in the product image.
ARG BASE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
FROM ${BASE_IMAGE}
WORKDIR /app
COPY eval/targets/synthetic/ssrf-lab/server.mjs ./server.mjs
ENV PORT=8080 INTERNAL_PORT=8081
EXPOSE 8080
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
