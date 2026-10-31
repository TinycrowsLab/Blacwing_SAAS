# Third-party notices

## swiftPentest

Portions of Blackwing may be derived from swiftPentest (https://github.com/swiftsaneai/swiftPentest).

MIT License

Copyright (c) 2026 SwiftSaneAI

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## @pandatix/js-cvss

Blackwing computes CVSS v4.0 and v3.1 scores with `@pandatix/js-cvss` 0.4.4 (FINDING-005, `packages/domain/src/findings/cvss.ts`),
the FIRST specification implementation. It is used as shipped, not copied.
https://github.com/pandatix/js-cvss

```
MIT License

Copyright (c) 2023 Lucas TESSON - PandatiX <lucastesson@protonmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ProjectDiscovery tools (bundled in the bw-sandbox image)

The sandbox image bundles these release binaries unmodified (IMAGE-002, #600). Pinned versions and sha256 digests are in
`infra/docker/sandbox/tools.pin.json`. Each is MIT-licensed; the licence text ships in each release archive as `LICENSE.md`.

| Tool | Version | Copyright (from the release LICENSE.md) |
|---|---|---|
| subfinder | 2.17.0 | Copyright (c) 2021 ProjectDiscovery, Inc. |
| dnsx | 1.3.1 | Copyright (c) 2021 ProjectDiscovery, Inc. |
| httpx | 1.12.0 | Copyright (c) 2021 ProjectDiscovery, Inc. |
| naabu | 2.7.0 | Copyright (c) 2021 ProjectDiscovery, Inc. |
| katana | 1.8.0 | Copyright (c) 2022 ProjectDiscovery |
| nuclei | 3.11.1 | Copyright (c) 2025 ProjectDiscovery, Inc. |

Each tool is distributed under the MIT License:

```
MIT License

Copyright (c) 2021 ProjectDiscovery, Inc. (katana: Copyright (c) 2022 ProjectDiscovery)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Headless browser and fonts (bundled in the bw-sandbox image)

The sandbox image bundles the Playwright client, the Chromium build it downloads at image build time, and the Debian
font packages below (IMAGE-005, #603). Pinned versions are in `infra/docker/sandbox/tools.pin.json`. The
Playwright packages are the agent runtime's own pinned dependencies (`playwright-core`, `@playwright/mcp`).

| Component | Version | Licence |
|---|---|---|
| playwright-core, @playwright/mcp | 1.63.0, 0.0.80 | Apache-2.0 (Copyright (c) Microsoft Corporation) |
| Chromium (Chrome for Testing build, revision 1243) | 153.0.8010.12 | BSD-style and the Chromium component licences; see the build's `LICENSES` |
| fonts-noto-core, fonts-noto-cjk, fonts-noto-color-emoji | 20201225-1, 1:20220127+repack1-1, 2.042-0+deb12u1 | SIL Open Font License 1.1 (Noto fonts) |
| fonts-liberation | 1:1.07.4-11 | Per the Debian package copyright file |

The Playwright licence text ships in the installed `playwright-core` package as `LICENSE`. Chromium's licence files ship
in the browser directory under `/opt/bw/browsers`.

## Wordlists (bundled in the bw-sandbox image)

The sandbox image bundles a small curated set of content, parameter and subdomain wordlists for `ffuf` and `katana`
discovery (IMAGE-006, #604). The lists are vendored under `infra/docker/sandbox/wordlists/` and pinned in
`infra/docker/sandbox/wordlists.pin.json` by upstream commit, sha256 and licence. Every list is copied verbatim into
`/opt/bw/wordlists` at build time, and the build fails on any checksum mismatch, a licence off the allowlist or a total
above `IMAGE_WORDLISTS_MAX_MIB` (default 64).

| List | Upstream file | Version (commit) | Licence |
|---|---|---|---|
| common | `Discovery/Web-Content/common.txt` | SecLists `0008f434` | MIT |
| burp-parameter-names | `Discovery/Web-Content/burp-parameter-names.txt` | SecLists `0008f434` | MIT |
| subdomains-top1million-5000 | `Discovery/DNS/subdomains-top1million-5000.txt` | SecLists `0008f434` | MIT |

Source: https://github.com/danielmiessler/SecLists (SecLists, Copyright (c) 2018 Daniel Miessler). The MIT licence text
ships in the image as `/opt/bw/wordlists/LICENSES/LICENSE.seclists`.
