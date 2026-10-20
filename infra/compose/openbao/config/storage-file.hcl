# Optional persistent dev storage (BW_DEV_OPENBAO_STORAGE=file). Used instead of `-dev` when you want
# keys and KV data to survive container restarts. The server starts uninitialised and sealed;
# `infra/compose/openbao/bootstrap.sh` initialises it once (1 key share, dev only) and unseals it on
# every run. Never use this configuration outside a dev machine.
storage "file" {
  path = "/openbao/file"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr      = "http://127.0.0.1:8200"
disable_mlock = true
ui            = false
