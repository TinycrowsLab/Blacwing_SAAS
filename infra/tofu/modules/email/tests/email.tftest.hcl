# Offline tests for the SES email module (INFRA-008). The AWS provider is mocked: nothing here
# talks to AWS. Run with infra/tofu/scripts/check.sh modules/email.

mock_provider "aws" {
  mock_resource "aws_ses_domain_dkim" {
    defaults = {
      dkim_tokens = ["tokena", "tokenb", "tokenc"]
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:eu-central-1:123456789012:blackwing-test-ses-events"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name_prefix      = "blackwing-test"
  domain_name      = "test.blackwing.example"
  zone_id          = "Z0000000000000000000"
  aws_region       = "eu-central-1"
  aws_account_id   = "123456789012"
  parameter_prefix = "/blackwing/test/email"
}

run "identity_dkim_and_verification_records_exist" {
  command = plan

  assert {
    condition     = aws_ses_domain_identity.this.domain == "test.blackwing.example"
    error_message = "The SES identity must be the environment's domain."
  }

  assert {
    condition     = length(aws_route53_record.dkim) == 3 && alltrue([for r in aws_route53_record.dkim : r.type == "CNAME" && endswith(r.name, "._domainkey.test.blackwing.example")])
    error_message = "Easy DKIM needs exactly three CNAMEs under _domainkey."
  }

  assert {
    condition     = aws_route53_record.verification.name == "_amazonses.test.blackwing.example" && aws_route53_record.verification.type == "TXT"
    error_message = "The domain verification TXT must sit at _amazonses.<domain>."
  }
}

run "spf_dmarc_and_mail_from_are_published" {
  command = plan

  assert {
    condition     = aws_route53_record.spf.name == "test.blackwing.example" && one(aws_route53_record.spf.records) == "v=spf1 include:amazonses.com -all"
    error_message = "The apex SPF record must authorise SES and fail everything else."
  }

  assert {
    condition     = aws_route53_record.dmarc.name == "_dmarc.test.blackwing.example" && startswith(one(aws_route53_record.dmarc.records), "v=DMARC1; p=quarantine;") && strcontains(one(aws_route53_record.dmarc.records), "rua=mailto:dmarc@test.blackwing.example")
    error_message = "DMARC defaults to p=quarantine with rua=mailto:dmarc@<domain>."
  }

  assert {
    condition     = aws_ses_domain_mail_from.this.mail_from_domain == "mail.test.blackwing.example" && aws_route53_record.mail_from_mx.type == "MX" && aws_route53_record.mail_from_mx.name == "mail.test.blackwing.example" && one(aws_route53_record.mail_from_mx.records) == "10 feedback-smtp.eu-central-1.amazonses.com"
    error_message = "The MAIL FROM subdomain needs its MX to the regional SES feedback endpoint."
  }

  assert {
    condition     = aws_route53_record.mail_from_spf.name == "mail.test.blackwing.example" && one(aws_route53_record.mail_from_spf.records) == "v=spf1 include:amazonses.com -all"
    error_message = "The MAIL FROM subdomain needs its own SPF TXT."
  }
}

run "dmarc_policy_is_configurable_per_environment" {
  command = plan

  variables {
    dmarc_policy = "none"
  }

  assert {
    condition     = startswith(one(aws_route53_record.dmarc.records), "v=DMARC1; p=none;")
    error_message = "dev/staging may relax DMARC to p=none."
  }
}

run "invalid_dmarc_policy_is_rejected" {
  command = plan

  variables {
    dmarc_policy = "monitor"
  }

  expect_failures = [var.dmarc_policy]
}

run "bounces_complaints_and_suppression_are_wired" {
  command = plan

  assert {
    condition     = contains(aws_sesv2_account_suppression_attributes.this.suppressed_reasons, "BOUNCE") && contains(aws_sesv2_account_suppression_attributes.this.suppressed_reasons, "COMPLAINT")
    error_message = "The account suppression list must cover bounces and complaints."
  }

  assert {
    condition     = contains(aws_ses_event_destination.sns.matching_types, "bounce") && contains(aws_ses_event_destination.sns.matching_types, "complaint") && aws_ses_event_destination.sns.configuration_set_name == "blackwing-test-default"
    error_message = "Bounce and complaint events must reach the SNS destination of the configuration set."
  }

  assert {
    condition     = contains(aws_ses_event_destination.cloudwatch.matching_types, "send") && contains(aws_ses_event_destination.cloudwatch.matching_types, "delivery")
    error_message = "Send/bounce/complaint/delivery metrics must reach CloudWatch."
  }

  assert {
    condition     = aws_ses_configuration_set.this.reputation_metrics_enabled && aws_ses_configuration_set.this.delivery_options[0].tls_policy == "Require"
    error_message = "The configuration set must publish reputation metrics and require TLS."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.bounce_rate.metric_name == "Reputation.BounceRate" && aws_cloudwatch_metric_alarm.complaint_rate.metric_name == "Reputation.ComplaintRate"
    error_message = "Bounce and complaint rate alarms protect sender reputation."
  }
}

run "smtp_credentials_live_only_in_secure_parameters" {
  command = plan

  assert {
    condition     = aws_ssm_parameter.smtp_username.type == "SecureString" && aws_ssm_parameter.smtp_password.type == "SecureString" && aws_ssm_parameter.smtp_password.name == "/blackwing/test/email/smtp-password"
    error_message = "SMTP credentials must be SecureString parameters under the prefix."
  }

  assert {
    condition     = length(aws_iam_access_key.smtp_next) == 0 && length(output.smtp_next_parameters) == 0
    error_message = "No second key exists outside a rotation overlap."
  }
}

run "rotation_overlap_creates_a_second_key" {
  command = plan

  variables {
    rotation_overlap = true
  }

  assert {
    condition     = length(aws_iam_access_key.smtp_next) == 1 && length(output.smtp_next_parameters) == 2
    error_message = "The overlap flag must add a second key and the -next parameters."
  }
}

run "outputs_feed_application_config" {
  command = plan

  assert {
    condition     = output.smtp_host == "email-smtp.eu-central-1.amazonaws.com" && output.smtp_port == 587 && output.from_address == "no-reply@test.blackwing.example" && output.configuration_set_name == "blackwing-test-default"
    error_message = "Outputs must expose SMTP host/port, from-address and configuration set."
  }

  assert {
    condition     = output.smtp_username_parameter == "/blackwing/test/email/smtp-username"
    error_message = "Outputs expose parameter names, never credential values."
  }
}
