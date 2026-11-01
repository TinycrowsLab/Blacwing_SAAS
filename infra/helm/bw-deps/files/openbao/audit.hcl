# Dev audit device (DEVENV-005). OpenBao 2.x only accepts audit devices declared in config, never via
# the API. Every request and response is logged as JSON to the container's stdout, with secret values
# HMAC'd (log_raw = false), so `docker compose logs openbao` is the dev audit trail (CONTEXT_PACK §8.8).
audit "file" "file" {
  description = "Dev audit log (JSON lines on stdout, values HMAC'd)"
  options {
    file_path = "stdout"
    log_raw   = "false"
  }
}
