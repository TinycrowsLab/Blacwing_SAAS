# OFFLINE-STUB(online-porting #891): validated offline with a mocked provider only; apply and DKIM/SPF/DMARC checks on real AWS are tracked there.
# SES sender for production email (INFRA-008): domain identity with Easy DKIM, custom MAIL FROM,
# SPF, DMARC, configuration set with bounce/complaint events, account suppression list and the
# SMTP credentials Nodemailer uses. Runbook: docs/runbooks/ses-email.md. Dev stays on Mailpit.

# DMARC uses aspf=r: the envelope sender is the MAIL FROM subdomain, so strict SPF alignment could
# never match the From domain. DKIM stays strict (d= is the domain itself).
locals {
  mail_from_domain = "${var.mail_from_label}.${var.domain_name}"
  from_address     = "${var.from_local_part}@${var.domain_name}"
  smtp_host        = "email-smtp.${var.aws_region}.amazonaws.com"
  dmarc_record     = "v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${var.dmarc_report_local_part}@${var.domain_name}; adkim=s; aspf=r; pct=100"
  spf_record       = "v=spf1 include:amazonses.com ${var.spf_qualifier}"
  config_set_name  = "${var.name_prefix}-default"
  identity_arn     = "arn:aws:ses:${var.aws_region}:${var.aws_account_id}:identity/${var.domain_name}"
  config_set_arn   = "arn:aws:ses:${var.aws_region}:${var.aws_account_id}:configuration-set/${local.config_set_name}"
}

# ---- Domain identity, verification and Easy DKIM -------------------------------------------------

resource "aws_ses_domain_identity" "this" {
  domain = var.domain_name
}

resource "aws_route53_record" "verification" {
  zone_id = var.zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.this.verification_token]
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = var.zone_id
  name    = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.this.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Waits until SES sees the verification TXT. DNS propagation can take minutes; a timeout fails the
# apply, and a re-apply simply re-checks (the resource is idempotent).
resource "aws_ses_domain_identity_verification" "this" {
  domain     = aws_ses_domain_identity.this.id
  depends_on = [aws_route53_record.verification]

  timeouts {
    create = "15m"
  }
}

# ---- Custom MAIL FROM, SPF, DMARC ----------------------------------------------------------------

resource "aws_ses_domain_mail_from" "this" {
  domain                 = aws_ses_domain_identity.this.domain
  mail_from_domain       = local.mail_from_domain
  behavior_on_mx_failure = "RejectMessage"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = var.zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = [local.spf_record]
}

resource "aws_route53_record" "spf" {
  zone_id = var.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 600
  records = [local.spf_record]
}

resource "aws_route53_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [local.dmarc_record]
}

# ---- Suppression list, configuration set and event destinations -----------------------------------

# Account-level suppression list: hard bounces and complaints are never retried.
resource "aws_sesv2_account_suppression_attributes" "this" {
  suppressed_reasons = ["BOUNCE", "COMPLAINT"]
}

resource "aws_ses_configuration_set" "this" {
  name                       = local.config_set_name
  reputation_metrics_enabled = true
  sending_enabled            = true

  delivery_options {
    tls_policy = "Require"
  }
}

resource "aws_sns_topic" "events" {
  name = "${var.name_prefix}-ses-events"
}

data "aws_iam_policy_document" "events_topic" {
  statement {
    sid       = "AllowSesPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.events.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.config_set_arn]
    }
  }
}

resource "aws_sns_topic_policy" "events" {
  arn    = aws_sns_topic.events.arn
  policy = data.aws_iam_policy_document.events_topic.json
}

resource "aws_ses_event_destination" "sns" {
  name                   = "bounce-complaint-sns"
  configuration_set_name = aws_ses_configuration_set.this.name
  enabled                = true
  matching_types         = ["bounce", "complaint", "reject"]

  sns_destination {
    topic_arn = aws_sns_topic.events.arn
  }

  depends_on = [aws_sns_topic_policy.events]
}

resource "aws_ses_event_destination" "cloudwatch" {
  name                   = "send-metrics-cloudwatch"
  configuration_set_name = aws_ses_configuration_set.this.name
  enabled                = true
  matching_types         = ["send", "delivery", "bounce", "complaint", "reject"]

  cloudwatch_destination {
    default_value  = "none"
    dimension_name = "ses:configuration-set"
    value_source   = "messageTag"
  }
}

# ---- Alarms: reputation protection ------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "bounce_rate" {
  alarm_name          = "${var.name_prefix}-ses-bounce-rate"
  alarm_description   = "SES account bounce rate above threshold. Stop sending and inspect the suppression list: docs/runbooks/ses-email.md."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 1
  threshold           = var.bounce_rate_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = concat([aws_sns_topic.events.arn], var.alarm_actions)
}

resource "aws_cloudwatch_metric_alarm" "complaint_rate" {
  alarm_name          = "${var.name_prefix}-ses-complaint-rate"
  alarm_description   = "SES account complaint rate above threshold. Inspect recent mail and the suppression list: docs/runbooks/ses-email.md."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 1
  threshold           = var.complaint_rate_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = concat([aws_sns_topic.events.arn], var.alarm_actions)
}

# ---- SMTP credentials ----------------------------------------------------------------------------------

resource "aws_iam_user" "smtp" {
  name = "${var.name_prefix}-ses-smtp"
  path = "/service/"
}

data "aws_iam_policy_document" "smtp" {
  statement {
    sid       = "SendRawEmailFromOwnDomain"
    actions   = ["ses:SendRawEmail"]
    resources = [local.identity_arn, local.config_set_arn]

    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.domain_name}"]
    }
  }
}

resource "aws_iam_user_policy" "smtp" {
  name   = "send-raw-email"
  user   = aws_iam_user.smtp.name
  policy = data.aws_iam_policy_document.smtp.json
}

resource "aws_iam_access_key" "smtp" {
  user = aws_iam_user.smtp.name
}

# Second key only during a rotation overlap (IAM allows two keys per user).
resource "aws_iam_access_key" "smtp_next" {
  count = var.rotation_overlap ? 1 : 0

  user = aws_iam_user.smtp.name
}

# The SMTP password is derived from the secret key. It is stored only as SecureString parameters;
# the tofu state holds it too, so the state bucket stays KMS encrypted with restricted access (INFRA-001).
resource "aws_ssm_parameter" "smtp_username" {
  name   = "${var.parameter_prefix}/smtp-username"
  type   = "SecureString"
  key_id = var.ssm_kms_key_id
  value  = aws_iam_access_key.smtp.id
}

resource "aws_ssm_parameter" "smtp_password" {
  name   = "${var.parameter_prefix}/smtp-password"
  type   = "SecureString"
  key_id = var.ssm_kms_key_id
  value  = aws_iam_access_key.smtp.ses_smtp_password_v4
}

resource "aws_ssm_parameter" "smtp_username_next" {
  count = var.rotation_overlap ? 1 : 0

  name   = "${var.parameter_prefix}/smtp-username-next"
  type   = "SecureString"
  key_id = var.ssm_kms_key_id
  value  = aws_iam_access_key.smtp_next[0].id
}

resource "aws_ssm_parameter" "smtp_password_next" {
  count = var.rotation_overlap ? 1 : 0

  name   = "${var.parameter_prefix}/smtp-password-next"
  type   = "SecureString"
  key_id = var.ssm_kms_key_id
  value  = aws_iam_access_key.smtp_next[0].ses_smtp_password_v4
}
