# Repro bundle (format 1.0)

Standalone reproduction of one finding. The runner (REPRO-004) replays `requests/` in order against a target
whose base URL is supplied at run time through `${TARGET_BASE_URL}`. No credentials are stored here.

- `manifest.json`: the bundle contract (`ReproManifestSchema`).
- `requests/NNNN.json`: the sanitised request descriptors, in order.
- `expected.json`: the declared oracle and the result the bundle expects.
