# Runbook: SES email (INFRA-008)

Production mail is sent through Amazon SES SMTP by Nodemailer (CONTEXT_PACK §5). Dev uses Mailpit and never
touches SES. Code: `infra/tofu/modules/email`, wired per environment in `environments/<env>/email.tf`.

## What the module creates

| Item | Detail |
|---|---|
| Domain identity | `aws_ses_domain_identity` for the environment domain, verified by a `_amazonses` TXT record, with a waiter (`aws_ses_domain_identity_verification`, 15 min). |
| Easy DKIM | Three `<token>._domainkey` CNAMEs written to the INFRA-007 app zone. |
| MAIL FROM | `mail.<domain>` with MX to `feedback-smtp.<region>.amazonses.com` and its own SPF TXT. |
| SPF | `v=spf1 include:amazonses.com -all` at the apex. |
| DMARC | `_dmarc.<domain>`: `p=quarantine` in prod (`p=none` in dev and staging), `rua=mailto:dmarc@<domain>`, strict alignment. |
| Configuration set | `<prefix>-default`: reputation metrics, TLS required, events to CloudWatch (send, delivery, bounce, complaint, reject) and to the SNS topic `<prefix>-ses-events` (bounce, complaint, reject). |
| Suppression | Account-level suppression list for `BOUNCE` and `COMPLAINT`. |
| Alarms | `Reputation.BounceRate` (default 4%) and `Reputation.ComplaintRate` (default 0.05%), notifying the events topic. |
| SMTP credentials | IAM user `<prefix>-ses-smtp` allowed only `ses:SendRawEmail` from `*@<domain>`; the SMTP username and password are SSM SecureString parameters under `/blackwing/<env>/email/`. |

Outputs for app config: `email_smtp_host`, `email_smtp_port` (587, STARTTLS), `email_configuration_set`,
`email_from_address`, and the SSM parameter names. The values never appear as outputs.

## Before the first apply

1. DNS delegation is done (`dns-delegation.md`): the app zone must answer publicly or verification times out.
2. Create the `dmarc@<domain>` mailbox or alias (a human-monitored inbox). DMARC aggregate reports go there.
3. Set `TF_VAR_aws_account_id`. Never apply from a laptop without review.

## Sandbox exit (manual, long lead time)

A new SES account is sandboxed: only verified recipients, 200 messages/day. **Request production access early** (AWS
Console, SES, Account dashboard, "Request production access", per region): state the use case (transactional mail:
verification, invitations, SOC notices, gate notifications), the bounce/complaint handling above, and the expected
volume. AWS answers in about 24 hours but can ask follow-ups, so file it weeks before launch. Until it is
granted, prod must not send to unverified recipients: keep the prod mail feature flag off, and verify test recipients
individually.

## Verifying a deployment

```
aws ses get-identity-verification-attributes --identities <domain>      # VerificationStatus = Success
aws ses get-identity-dkim-attributes --identities <domain>              # DkimVerificationStatus = Success
dig +short TXT _dmarc.<domain>
dig +short TXT <domain>                                                  # contains v=spf1 include:amazonses.com
dig +short MX mail.<domain>
```

Send a test message through SMTP (587, STARTTLS, credentials read from SSM), with the header
`X-SES-Configuration-Set: <prefix>-default`, to a mailbox you control and read the headers: expect `dkim=pass`,
`spf=pass` and `dmarc=pass`. To prove event delivery, send to `bounce@simulator.amazonses.com` and
`complaint@simulator.amazonses.com` (allowed in the sandbox) and confirm the events appear on the SNS topic and
in the CloudWatch metrics.

DKIM propagation can take minutes. If apply times out in the verification step, re-run it: the step re-checks.

## Reading the credentials

```
aws ssm get-parameter --with-decryption --name /blackwing/<env>/email/smtp-password --query Parameter.Value --output text
```

Only operators and the workload role granted `ssm:GetParameter` plus `kms:Decrypt` on the key can read them.
OpenBao (SECRETS epic) syncs them by reference. The tofu state also contains the password (an IAM access-key
attribute), so the state bucket stays KMS encrypted with restricted access.

## Rotating the SMTP credentials without downtime

IAM allows two keys per user, so rotation overlaps old and new:

1. Set `rotation_overlap = true` on the module and apply. A second key appears, stored as `smtp-username-next` and
   `smtp-password-next`.
2. Roll the application to the `-next` parameters and confirm sending works.
3. Taint the old key (`tofu apply -replace='module.email.aws_iam_access_key.smtp'`) so the primary parameters get a
   fresh key, point the application back at the primary parameters, then set `rotation_overlap = false` to delete the
   second key.

Never delete the key in use before step 2 is confirmed.

## Bounce and complaint spikes

An alarm means sender reputation is at risk (SES reviews from 5% bounce and 0.1% complaint). Pause the sending
feature, review the SNS events for the offending flow, fix the list source and keep the suppression list intact. Do
not remove entries from the suppression list to retry delivery.

## Privacy

Recipient addresses are PII. Application logs must redact them (`@blackwing/logger` redaction, CONTEXT_PACK §5); the
SNS event payloads contain addresses, so the topic has no subscribers beyond the NOTIFY handler and the alarms.
CloudTrail records IAM and SES changes.
