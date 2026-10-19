# Blackwing — Feature List (v1)

> Source: customer feature list. SaaS-edition overrides are recorded in `CONTEXT_PACK.md` §1.1.

| # | Area | Feature | What it does | Release |
|---|---|---|---|---|
| 1 | Scoping and authorisation | Scoping form | Structured form for assets, mode, scope, intrusiveness and budget. Not a chat. | v1 |
| 2 | Scoping and authorisation | Editable test plan | Planner proposes test cases. The user can add, remove or edit them before the run. | v1 |
| 3 | Scoping and authorisation | Standing authorisation | Signed approval per asset with an expiry date. Tests inside it need no new approval. | v1 |
| 4 | Scoping and authorisation | Intrusiveness class | Each test is tagged passive, active-safe or state-changing. Destructive tests are not in v1. | v1 |
| 5 | Scoping and authorisation | Request budget per test case | Caps requests per test case so the target is not overloaded. | v1 |
| 6 | Scoping and authorisation | Environment attestation | Asset owner confirms the environment type and any shared database or login service. | v1 |
| 7 | Testing | Three assessment modes | Black, grey and white box. Grey box is the main mode. Recon is skipped where context is supplied. | v1 |
| 8 | Testing | Grey-box web and API testing | Runs with customer-provided logins for two or more roles. | v1 |
| 9 | Testing | Multi-role authorisation matrix | Tests every role against every function and compares expected access with actual access. | v1 |
| 10 | Testing | Session manager | Keeps logins alive and checks the session is still valid during a run. | v1 |
| 11 | Testing | Scoped egress proxy | The only route to a target. Scope and request budget are enforced here. | v1 |
| 12 | Testing | Agent team | Orchestrator, planner, sub-planner, recon, threat intel, specialists, exploit developer, mentor and reflector. | v1 |
| 13 | Testing | Runtime exception gate (Gate 2) | Action outside the approved scope pauses that branch and pages on-call. No reply means denied. | v1 |
| 14 | Validation | Validator agent | Replays each finding against a check declared before the test ran. | v1 |
| 15 | Validation | Out-of-band listener | Own callback server to prove blind and delayed bugs such as blind SSRF. | v1 |
| 16 | Validation | Negative controls | Runs a harmless version of the request to confirm the result is not a false positive. | v1 |
| 17 | Validation | Confirmed and Suspected lists | Only evidence-backed findings are Confirmed. The rest stay in Suspected. | v1 |
| 18 | Validation | Standalone repro artifact | Each confirmed finding ships with steps that can be replayed offline. | v1 |
| 19 | Validation | Coverage manifest | Lists what was tested and what was not. A report cannot be exported without it. | v1 |
| 20 | Validation | Reversal journal | Records every change made to the target so it can be undone. | v1 |
| 21 | Findings and triage | Triage gate (Gate 3) | A person reviews findings before the report is released. | v1 |
| 22 | Findings and triage | Dedup and fingerprinting | Gives each finding a stable ID so repeat runs do not create duplicates. | v1 |
| 23 | Findings and triage | Baseline run | First run becomes the reference. Later runs show new, open, fixed and returned findings. | v1 |
| 24 | Findings and triage | One-click retest | Re-checks a single finding after a fix. | v1 |
| 25 | Reporting and integrations | Report export | PDF, JSON and SARIF. | v1 |
| 26 | Reporting and integrations | OWASP and CWE mapping | Every finding is tagged with OWASP category and CWE ID. | v1 |
| 27 | Reporting and integrations | Jira and GitHub or GitLab push | Creates and updates one ticket or issue per finding. | v1 |
| 28 | Reporting and integrations | Vulnerability dashboard | Findings by severity, asset and status, with trend across runs. | v1 |
| 29 | Platform, access and governance | One web console | Same web UI for developers and security engineers, separated by roles. | v1 |
| 30 | Platform, access and governance | SSO | Sign in with the customer's identity provider (Microsoft, Google, GitHub, Slack). | v1 |
| 31 | Platform, access and governance | Separation of duties | The person who requests a test cannot be the one who approves it. | v1 |
| 32 | Platform, access and governance | Customer-owned policy layer | Customer sets its own rules for allowed targets, actions and hours. | v1 |
| 33 | Platform, access and governance | Kill switch | Stops all agents at once. Halt time is measured and shown. | v1 |
| 34 | Platform, access and governance | Audit ledger | Append-only record of every login, approval, tool action and release. | v1 |
| 35 | Platform, access and governance | Secrets on customer key store | Credentials stay in the customer's own KMS or vault. | v1 |
| 36 | Platform, access and governance | Bring your own model | Azure OpenAI, AWS Bedrock, GCP or a custom endpoint. No data goes to other providers. | v1 |
| 37 | Platform, access and governance | Pinned versions | Model, prompt and tool versions are fixed per run and recorded. | v1 |
| 38 | Platform, access and governance | Cost cap | Maximum model spend per run. | v1 |
| 39 | Platform, access and governance | Retention | Customer sets how long findings, evidence and logs are kept. | v1 |
| 40 | Platform, access and governance | Evaluation harness | Fixed set of known-vulnerable targets re-run after any model, prompt or tool change. | v1 |
| 41 | Platform, access and governance | Single-node deployment | Installs in the customer's own Azure or AWS subscription. Single tenant. Host Docker socket is not exposed. | v1 |
| 42 | Later | Bitbucket, Azure DevOps and ServiceNow integrations | Push findings to more ticketing and source-control tools. | Later |
| 43 | Later | Diff-driven continuous assessment | Test only what changed in each release. | Later |
| 44 | Later | Auto-release lane in triage | Low-risk, repeatedly confirmed finding types skip manual release. | Later |

## Explicitly NOT in v1

- Destructive tests
- SAST and SCA scanning
- Build gating in CI stop vuln code to get released 
- SLA tracking
- Multi-tenant platform
- Chat-based scoping
- Second UI for developers
