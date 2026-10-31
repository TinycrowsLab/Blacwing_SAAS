# Blackwing custom nuclei templates

This directory (`/opt/bw/templates/blackwing/` in the bw-sandbox image) holds Blackwing's own nuclei templates. It is
root-owned and read-only for the sandbox user, so a run cannot write new templates into it.

## Authoring convention

- One template per file, YAML, named after the check (`<product>-<check>.yaml`). Use the nuclei v3 template format.
- Every template is safe and non-intrusive: detections that observe responses (`passive`, or `active_safe` as in
  CONTEXT_PACK F4). No destructive requests, no state changes, no brute force, no fuzzing, no exploit payloads.
- Every template declares `info` metadata with `severity` `info` or `low`, a `description`, a `reference`, and
  `tags` that include at least one of `tech`, `detect`, `exposure`, `misconfig`, `ssl`, `dns` or `panel`.
- Never use the `intrusive`, `dos`, `fuzz`, `fuzzing`, `brute-force`, `default-login`, `credential-stuffing`,
  `token-spray`, `sqli`, `xss`, `rce`, `lfi`, `ssrf`, `injection`, `exploit`, `oast` or `oob` tags. The default profile
  excludes them and a template carrying one never runs.
- Never embed credentials, tokens or customer data. Use placeholders and let the run supply values.

## Default profile

`/etc/bw/nuclei.yaml` is the default profile the sandbox passes with `-config`. It selects both directories
(`/opt/bw/templates/official`, pinned to the nuclei-templates commit in `tools.pin.json`, and this directory), keeps
only `info` and `low` severities, allows only the safe tags above, excludes the intrusive tags, disables
out-of-band callbacks, and turns off template updates (`update-templates: false`, `disable-update-check: true`).
Changing the profile is a reviewed change, and `pnpm check:sandbox-image` fails if the profile loses an exclusion.

## Updating templates

The template commit is pinned by SHA in `infra/docker/sandbox/tools.pin.json` and recorded in the run manifest (S8.9).
A bump is a reviewed change that updates the commit, the archive `sha256` and the kept-tree `treeSha256` together.
