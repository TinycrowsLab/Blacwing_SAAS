---
last_reviewed: 2026-10-21
---

# Blackwing admin guide

This guide is for the **Org Owner/Admin** of a Blackwing tenant (the `org_admin` role). It explains how to
connect single sign-on, assign roles, author tenant policy, store secrets and bring your own keys, choose a model
provider and set retention. It also explains the safety controls you cannot switch off, so you can govern your tenant with
confidence.

It does not cover the end-user journeys (scope, plan, run, triage and retest), the public API or operator runbooks.

## Status of each area

Each area below is either **live** in the current build or **planned**. Planned sections describe the intended configuration so
you can prepare. Do not rely on a planned feature until your Blackwing contact confirms it is
available on your tenant.

| Area | Status | Notes |
|---|---|---|
| Role model and permission matrix | Live | Enforced in the platform's permission catalogue. Role assignment is planned. |
| Separation of duties on gate decisions and scope exceptions | Live | Enforced by the platform policy baseline (see [Separation of duties](#separation-of-duties)). |
| Platform policy baseline (non-overridable) | Live | Shipped and tested. |
| Tenant policy authoring and activation | Planned | The policy compiler exists. The authoring and activation screens are not yet shipped. |
| SSO through Keycloak (Entra ID, Google, GitHub, Slack, OIDC, SAML) | Planned | The reference realm has brute-force protection on, but no identity providers are configured yet. |
| Blackwing-managed secrets store (OpenBao) | Planned | Accepted design ([ADR-0009](../adr/0009-openbao-secrets-byok.md)). |
| Bring-your-own key and vault adapters | Planned | Same design as above. |
| Model provider: Blackwing-managed Anthropic API | Live | Default provider. |
| Model provider: your own Anthropic API key, Amazon Bedrock, Google Vertex AI, Microsoft Foundry | Planned | Per-tenant credentials are not yet resolved from the secrets store. |
| Retention settings per data class and legal hold | Planned | The retention fields exist on evidence records. The retention job and settings are not yet shipped. |
| Tenant deletion (crypto-shredding) | Planned | Not yet shipped. |

## Before you start

You need:

- An account with the `org_admin` role on your tenant. Keep a separate account for administration (see [Separation of
  duties](#separation-of-duties)).
- The contact details of your Blackwing operator, who gives you your Keycloak host name (shown below as `<keycloak-host>`)
  and your tenant's realm details.
- Administrator access to your identity provider, your cloud account or your key store, depending on the sections you
  configure.

Never paste a secret, password, token, private key or customer credential into a ticket, a chat or a configuration field
other than the secret store. Blackwing shows secret values only once, when you enter them, and never again. Examples in this
guide use placeholders only.

## 1. Single sign-on (SSO)

Users sign in to the Blackwing console through Keycloak 26, using OpenID Connect with PKCE through the console's server side.
Keycloak brokers the sign-in to your identity provider (IdP). Keycloak organisations map the users of your IdP to your
tenant, so a user from another organisation cannot join your tenant by signing in.

Four rules apply to every IdP:

- **Enforce MFA at the IdP.** Blackwing relies on your IdP's MFA policy. Keycloak brute-force detection is on for every
  login, but it does not replace MFA.
- **Unmapped users have no access.** A user who is in no mapped group gets no tenant role. A role that is unknown or removed
  grants nothing (fail closed).
- **Map only the groups you need.** Give each Blackwing role its own narrow group. Do not map a broad group such as "All
  staff".
- **Agree a break-glass method with your Blackwing operator.** Plan how an administrator signs in if your IdP is unavailable.

### 1.1 Choose a protocol and an IdP

| IdP | Protocol | Groups in the sign-in token | Notes |
|---|---|---|---|
| Microsoft Entra ID | OpenID Connect | Yes, as a group claim | Use group object IDs for large groups (see below). |
| Google | OpenID Connect | Not by default | Group membership needs Google Cloud Identity groups. Otherwise assign roles directly. |
| GitHub | OAuth 2.0 identity provider | Only if your mapper reads team membership | Enforce two-factor authentication in your GitHub organisation. |
| Slack | OpenID Connect ("Sign in with Slack") | No | Assign roles directly. |
| Generic OIDC | OpenID Connect | Depends on your provider | Ask for a `groups` claim. |
| Generic SAML 2.0 | SAML | Yes, as an attribute statement | Requires signing-certificate and metadata exchange (see 1.4). |

### 1.2 Redirect (callback) address

Register this address with every IdP. Keycloak derives it from the realm and the provider alias you choose:

```
https://<keycloak-host>/realms/blackwing/broker/<alias>/endpoint
```

Use a short lowercase alias such as `entra`, `google`, `github`, `slack`, `oidc` or `saml`. The alias must match the address
exactly. A mismatch is the most common cause of a "redirect URI" error at sign-in.

### 1.3 Microsoft Entra ID (OpenID Connect)

1. In the Entra admin centre, register an application (single tenant, or multi-tenant if you sign in users from several
   directories). Add a **Web** redirect URI from 1.2.
2. Under **Certificates and secrets**, create a client secret. Record its expiry date. Store the secret value in the Blackwing
   secret store (section 4), never in a document. An expired secret stops sign-in for every user.
3. Under **Token configuration**, add the **groups** claim for security groups. If a user is in more than 200 groups, Entra
   sends an overage indicator instead of the list. In that case, select **Group ID** and map by group object ID.
4. In the Blackwing SSO settings, enter:
   - issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`;
   - client ID (the application ID);
   - the client secret reference;
   - the group claim name (`groups`).
5. Map each Entra group to one Blackwing role (section 2).

### 1.4 Google, GitHub, Slack and generic OIDC

- **Google:** create an OAuth client in Google Cloud for a web application and add the redirect address. Use issuer
  `https://accounts.google.com`. Restrict sign-in to your Google Workspace domain. Assign roles directly unless you use
  Cloud Identity groups.
- **GitHub:** create an OAuth app for your organisation, set the callback to the address from 1.2, and enter the client ID
  and secret reference. Require two-factor authentication for the organisation.
- **Slack:** create a Slack app with the OpenID Connect sign-in scope and the redirect address. Use issuer `https://slack.com`.
  Slack does not send groups, so assign roles directly.
- **Generic OIDC:** enter the issuer URL, client ID, client secret reference and the claim that carries groups.

### 1.5 SAML 2.0 (differences from OIDC)

SAML differs from OIDC in four ways:

1. **Metadata, not an issuer URL.** Exchange metadata with your operator. Keycloak publishes the service-provider metadata for the
   realm, and your IdP needs it. The assertion consumer address is the one from 1.2 (`.../broker/<alias>/endpoint`).
2. **Signing certificate.** Give Blackwing your IdP's signing certificate, and rotate it before it expires. Keep assertion
   signing on. Unsigned assertions must never be accepted.
3. **Attribute, not claim.** Send groups as a multi-value attribute statement, and name it exactly as you configure the
   mapping in section 2.
4. **Clock skew.** SAML assertions carry a validity window. A badly synchronised clock makes valid sign-ins fail. Keep the IdP's
   time synchronised with NTP.

### 1.6 Troubleshooting sign-in

| Symptom | Likely cause | Fix |
|---|---|---|
| "Invalid redirect URI" | Alias or host differs from the registered address | Compare 1.2 with the registration exactly, including the trailing `/endpoint`. |
| Sign-in succeeds but the user sees no workspace | No mapped group, or the group is not in the token | Check the group mapping (section 2) and the group claim name. |
| Sign-in fails after months | Expired client secret or signing certificate | Renew it, store the new value, and retest with a test user. |
| Entra user missing groups | More than 200 groups (overage) | Switch the claim to group object IDs (1.3, step 3). |
| SAML sign-in fails intermittently | Clock skew | Synchronise the IdP and Blackwing clocks. |

## 2. Roles and the permission matrix

Each user holds one or more of six tenant roles. A user's permissions are the union of the permissions of their roles.

| Role | Purpose | Can do | Cannot do |
|---|---|---|---|
| `org_admin` | Administers the tenant | Manage SSO, members, tenant policies (read and write), connectors, secret references, tenant settings (retention and model endpoint), access tokens, the kill switch, and read the audit ledger. | Create or cancel runs, edit test plans, approve authorisations or gates, triage or release findings. |
| `appsec_engineer` | Operates assessments | Manage assets and verify ownership, create authorisations, create and cancel runs, edit test plans, triage and release findings, export reports, trigger the kill switch. | Approve authorisations, approve test plans, decide gates. |
| `asset_owner` | Authorises testing of their assets | Manage and verify their assets, create, approve and revoke authorisations, approve test plans, decide Gate 1 and Gate 2, cancel runs, trigger the kill switch. | Manage tenant settings, policies, members or secrets. |
| `developer` | Consumes findings | Read assets, authorisations, runs, test plans, findings, reports and coverage. Trigger pre-production runs and retests on assets assigned to them. | Release findings, approve anything, change settings. |
| `auditor` | Read-only oversight | Read assets, authorisations, runs, test plans, gates, findings, reports, coverage, tenant policies and the audit ledger. | Any write. |
| `ci_pipeline` | Unattended pipeline runs | Read, and create runs inside a standing authorisation, using a scoped CI token. | Approve, triage, release or change anything. |

Role assignment is planned. Until it ships, your operator assigns roles for you. Give each person the smallest role that
does their job.

### Mapping IdP groups to roles

Map one narrow group per role. For example:

| IdP group (example name) | Blackwing role |
|---|---|
| `bw-tenant-admins` | `org_admin` |
| `bw-appsec` | `appsec_engineer` |
| `bw-asset-owners` | `asset_owner` |
| `bw-developers` | `developer` |
| `bw-auditors` | `auditor` |

Group names are examples. Use your own. A user in several groups receives the union of those roles, so avoid putting the same
person in both `bw-tenant-admins` and `bw-asset-owners`.

Reference realm role names use hyphens (for example `org-admin`). Blackwing role identifiers use underscores (for example
`org_admin`). Map to the Blackwing identifiers in the SSO settings.

### Separation of duties

Three decisions must come from someone other than the person who asked for them:

- **Authorisation (standing authorisation, SA):** the requester cannot approve their own request. Approval belongs only to
  `asset_owner`. `org_admin` cannot approve authorisations, and this is by design.
- **Gate 1 (scope and test-plan approval):** a user cannot decide a gate request they raised. The platform policy baseline
  enforces this on every decision.
- **Gate 2 (runtime exception):** a scope exception's approver can never be its requester. The platform policy baseline
  enforces this on every request. A request with no reply is denied.

Practical rules:

- Do not give `org_admin` to the people who approve authorisations or gates.
- Give administrators a separate account from their day-to-day operating or approving account.
- Do not map the same person to both `appsec_engineer` and `asset_owner` unless you accept that they can raise a request
  under one role and approve a different request under the other. Separate the roles where you can.

## 3. Tenant policy layer

Your tenant policies narrow what agents may do. They sit on top of a platform baseline that you cannot change.

### 3.1 The platform baseline (non-overridable)

The baseline is a set of Cedar `forbid` rules that Blackwing ships and every tenant inherits. In Cedar, a `forbid` always
overrides a `permit`, so no tenant policy can allow what the baseline forbids. The baseline covers:

| Rule | Effect |
|---|---|
| Destructive class (`destructive`) | Denied for egress, tool use and scope exceptions, whether the class comes from the request or from the test case. This is a hard block. |
| Envelope validity | Traffic is denied before the authorisation starts, at its expiry, and while the testing window is closed. |
| Intrusiveness ceiling | Traffic and tools may not exceed the authorisation's maximum or the agent's ceiling. |
| Out of scope | A target that is not in scope is unreachable (default deny). |
| Private and metadata ranges | Denied unless the target is in scope and the authorisation names that range. |
| Scope hash | The authorisation's scope hash must match the hash pinned on the run. |
| Separation of duties | Gate decisions and scope exceptions as described in section 2. |
| Tenant isolation | Principal, resource and request must belong to the same tenant. |
| State-changing class | Needs a prior reversal-journal entry and an authorisation ceiling that allows it. |

If you try to write a tenant policy that allows a baseline-forbidden action, the action is still denied. A tenant policy that
uses a reserved `baseline.` identifier, or the reserved annotation, is rejected for the whole policy set. Nothing from the
rejected set is loaded.

### 3.2 Authoring tenant policies

Tenant policies use Cedar. Blackwing validates every policy against its strict schema before activation. Unknown actions,
entity types or attributes are rejected, so you cannot redefine the model. A missing attribute fails closed.

The main entity types are `Blackwing::Target` (a destination, with `host`, `port`, `path`, `method` and `inScope`),
`Blackwing::TestCase`, `Blackwing::Asset`, `Blackwing::Run`, `Blackwing::User`, `Blackwing::ServiceAccount` and
`Blackwing::AgentSession`. The main actions are `Egress::Action::"httpRequest"`, `Egress::Action::"tcpConnect"`,
`Egress::Action::"dnsResolve"`, `Tool::Action::"invoke"`, `Scope::Action::"requestException"`, `Gate::Action::"decide"` and
`Policy::Action::"edit"`.

A tenant policy that blocks traffic to one host pattern looks like this:

```cedar
forbid (
  principal,
  action in [Egress::Action::"httpRequest"],
  resource is Blackwing::Target
)
when {
  resource.host like "*.payments.example.com"
};
```

Use `forbid` to narrow. Use `permit` only where the baseline allows the action and you want an explicit grant; a `permit` never
widens the baseline.

### 3.3 Versions and activation

- Every policy change is a new version. The change and its author are written to the audit ledger (section 8).
- Each run records the hash of the policy set it started with, so a run never silently changes its rules. A new version applies
  to runs started after you activate it.
- To roll back, activate a previous version. Rollback is audited the same way.
- Only `org_admin` can write tenant policies. `appsec_engineer`, `asset_owner` and `auditor` can read them.

## 4. Secrets and bring-your-own key (BYOK)

Blackwing never stores a credential in plaintext in a configuration table. You store a **secret reference** in the tenant, and
the secret value stays in a secret store:

- The session manager and the egress gateway inject the credential when a request needs it.
- Agents, the model and the logs never see the plaintext value. Known secret values are redacted from tool output before the model
  receives it.
- Every add, change or delete of a secret reference is audited. Values are never displayed after entry.

### 4.1 Choose where the key lives

| Option | Who holds the key | Use when |
|---|---|---|
| Blackwing-managed OpenBao (default) | Blackwing, with a separate key per tenant (envelope encryption) | You do not need to hold keys yourself. |
| Your AWS KMS key (cross-account) | You | You need key control and can revoke Blackwing's access. |
| Your HashiCorp Vault or OpenBao | You | You already run a Vault or OpenBao estate. |
| AWS Secrets Manager | You | Your secrets live in AWS Secrets Manager. |
| Azure Key Vault | You | Your secrets live in Azure Key Vault. |

If you revoke Blackwing's access to a BYOK key, Blackwing operations that need it fail. They do not fall back to a weaker store.

### 4.2 Granting Blackwing access to your AWS KMS key

Add a statement to the key policy that allows only the Blackwing role for your tenant, and only the operations the envelope
encryption needs. Restrict the statement to this one key, never to `*`:

```json
{
  "Sid": "BlackwingTenantEnvelopeEncryption",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<blackwing-account-id>:role/<blackwing-tenant-role>" },
  "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
  "Resource": "*"
}
```

In a key policy the resource is always the key the policy is attached to, so `"Resource": "*"` scopes the statement to this key
only. Your Blackwing operator gives you the exact role ARN for your tenant. Keep the key enabled and out of a pending-deletion
state, and create it in the region your Blackwing environment runs in.

### 4.3 Other vaults

- **Vault or OpenBao:** mount a KV v2 or Transit engine for Blackwing only, and grant a policy that covers only that mount.
- **AWS Secrets Manager:** attach a resource policy that allows the Blackwing role to read only the secrets you name.
- **Azure Key Vault:** assign the Blackwing service principal a built-in role scoped to the vault (for example Key Vault Secrets
  User for secrets, or Key Vault Crypto User for keys). Role assignments can take several minutes to take effect.

### 4.4 Registering a secret reference

Enter a reference name you choose (for example `target-admin-credentials`), the option from 4.1, and the location in your store
(for example the vault path or the secret ARN). Do not enter the value into the reference field. Blackwing stores only the
reference.

Rotate a credential in your own store. Blackwing picks up the new value on the next use. Rotate immediately if a value has been
exposed anywhere.

### 4.5 BYOK troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Access denied when Blackwing reads or writes a secret | The key policy, resource policy or role assignment does not grant the Blackwing role | Compare 4.2 or 4.3 with your policy. Check the Blackwing role ARN or service principal. |
| Operations fail after a key change | The key is disabled, pending deletion or in another region | Re-enable the key, or point the reference at the key in the correct region. |
| Operations fail after a vault restart or seal | The vault is sealed or unreachable | Unseal the vault. Blackwing does not fall back to another store. |
| Access worked yesterday and fails today | A role or policy was removed or changed | Restore the grant. Check your change history and the audit ledger. |
| Failures start after a rotation | The reference points at the old version | Update the reference to the new version or path. |

## 5. Model providers

Blackwing's agents run on Claude only. Each run's model calls go through the Blackwing model gateway, which routes them to one
provider. A run never sends data to a second provider.

| Provider | Status | Notes |
|---|---|---|
| Blackwing-managed Anthropic API | Live | Default. Blackwing holds the provider credential. |
| Your own Anthropic API key | Planned | Your key is held as a secret reference (section 4). |
| Amazon Bedrock (your Claude deployment) | Planned | Uses your AWS account and IAM. |
| Google Vertex AI (your Claude deployment) | Planned | Uses your Google Cloud project and IAM. |
| Microsoft Foundry (your Claude deployment) | Planned | Uses your Foundry deployment. |

Not supported: Azure OpenAI and GPT models, and any other model family. "Bring your own model" on Blackwing means bring your own
**Claude** endpoint. A Claude.ai subscription login is never accepted for customer runs. Only a developer platform API key or a
supported cloud deployment can power a run.

### Selecting a provider

Select the provider in the tenant's model endpoint settings (`org_admin`). The change applies to runs started after you save it.
Every change is audited.

### Pinning and reproducibility

Every run records the model IDs it used, along with the agent prompt versions, the SDK and CLI versions, and the policy hash.
Runs never silently pick up a newer model. To move to a new model, change the setting for future runs and keep the old runs'
records.

### Failover and outages

- **No cross-provider failover.** If your provider is unavailable, runs pause or fail. Blackwing does not send the run to another
  provider.
- **Fallback model.** A fallback model is used only if your provider policy allows it, and it stays on the same provider.
- **Check first.** When a run stops, check its status in the console, then your provider's status page. Resume the run when the
  provider recovers.

## 6. Retention

Retention decides how long Blackwing keeps each class of data. It is set per data class and must stay within the platform
floor, which Blackwing operates. You can extend retention for a class. You cannot shorten it below the floor.

| Data class | Platform default (reference) | Notes |
|---|---|---|
| Evidence artefacts (screenshots, traces, repro artefacts) | 30 days in object-lock COMPLIANCE mode | Locked versions cannot be deleted or shortened by anyone, including Blackwing staff. |
| Reports and exports | 90 days | |
| Agent transcripts | 180 days | |
| Backups | 35 days | Operated by Blackwing. |

The defaults above come from the platform storage design. Your tenant's effective values are in the retention settings.

### Legal hold

A legal hold stops evidence from being deleted when its retention date passes, until the hold is released. Holds apply per
evidence item. Setting or releasing a hold is an audited change. Use holds for investigations or litigation, and release them
when they end, or your data will be kept longer than you intend.

### Object lock and deletion

Evidence is stored in object-lock COMPLIANCE mode. Within the lock period nobody can shorten it or delete a locked version,
including Blackwing staff. Retention is enforced by server time, not by client clocks.

### Tenant deletion (crypto-shredding)

When a tenant is deleted, Blackwing destroys the tenant's encryption keys. Stored data then cannot be read, including in backups.
Data still under object lock remains in storage until its retention date, but it is unreadable once the keys are gone. If you
hold your own key (section 4), revoking Blackwing's access to it stops Blackwing from reading the data under that key.

Tenant deletion is not reversible. Export anything you need before you start it.

## 7. Tenant settings checklist

Work through this list before you invite users to a live tenant:

1. Configure SSO with MFA enforced at the IdP, and test sign-in with a test user from each group.
2. Map one narrow group to each role. Confirm that an unmapped test user has no access.
3. Keep administrator accounts separate from approving accounts.
4. Register secret references for every credential, and confirm that no value appears in any configuration field, ticket or chat.
5. If you use BYOK, grant only the Blackwing role on the one key or vault, and test a read and a write.
6. Choose a model provider, and confirm that it is the one you expect in the tenant settings.
7. Set retention per data class, and decide who may place and release legal holds.
8. Add a tenant policy only where you need one, and confirm that it does not conflict with the platform baseline.
9. Confirm that your audit ledger shows the changes you just made.

## 8. Audit and the kill switch

Every login, approval, gate decision, tool action, finding release, export, kill and configuration change is written to the
append-only audit ledger. Your `auditor` and `org_admin` roles can read it. Audit events cannot be edited or deleted, and no
retention setting can remove them.

Any role with `kill:trigger` can stop agents in scope at run, asset, or tenant level. The kill switch blocks egress first, then
terminates sandboxes and cancels workflows. Your SOC can trigger it through a link that does not need a Blackwing account. Halt
time is measured and shown.
