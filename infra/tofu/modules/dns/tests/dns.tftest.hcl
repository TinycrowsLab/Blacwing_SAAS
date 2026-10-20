# Offline tests for the DNS module (INFRA-007). The AWS provider is mocked: nothing here talks to
# AWS. Run with infra/tofu/scripts/check.sh modules/dns.

mock_provider "aws" {}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/route53/mock"
    }
  }
}

variables {
  name_prefix = "blackwing-test"
  domain_name = "test.blackwing.example"
}

run "app_zone_and_oob_delegation_exist" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = aws_route53_zone.app.name == "test.blackwing.example"
    error_message = "The app hosted zone must be named after the environment's domain."
  }

  assert {
    condition     = aws_route53_record.oob_delegation.type == "NS" && aws_route53_record.oob_delegation.name == "oob.test.blackwing.example"
    error_message = "oob.<domain> must be delegated with an NS record."
  }

  assert {
    condition     = toset(output.oob_ns_set) == toset(["ns1.test.blackwing.example", "ns2.test.blackwing.example"])
    error_message = "The OOB delegation must point at ns1/ns2 of the app domain."
  }

  assert {
    condition     = output.oob_domain == "oob.test.blackwing.example"
    error_message = "The OOB domain output must be oob.<domain>."
  }
}

run "wildcard_base_is_scoped_to_the_oob_subdomain" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = output.oob_wildcard_base == "*.oob.test.blackwing.example"
    error_message = "The OOB wildcard base must be *.oob.<domain>."
  }
}

run "no_glue_until_interactsh_has_addresses" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = length(aws_route53_record.oob_glue) == 0
    error_message = "No glue records may be planned before oob_server_ips is set (INFRA-010)."
  }
}

run "no_record_shadows_the_oob_wildcard" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    oob_server_ips = ["203.0.113.10", "198.51.100.20"]
    ingress_alias = {
      dns_name = "lb.example.elb.amazonaws.com"
      zone_id  = "Z0000000000000"
    }
  }

  assert {
    condition     = length(aws_route53_record.oob_glue) == 2
    error_message = "Two addresses must produce ns1 and ns2 glue records."
  }

  assert {
    condition = alltrue([
      for record in concat(values(aws_route53_record.oob_glue), values(aws_route53_record.ingress)) :
      record.name != "oob.test.blackwing.example" && !endswith(record.name, ".oob.test.blackwing.example")
    ])
    error_message = "Only the delegation may live at or under the OOB subdomain; glue and ingress records must sit outside it."
  }

  assert {
    condition     = length(aws_route53_record.ingress) == 3
    error_message = "The ingress alias must create the apex, app and api records."
  }
}

run "single_address_serves_both_name_servers" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    oob_server_ips = ["203.0.113.10"]
  }

  assert {
    condition     = length(aws_route53_record.oob_glue) == 2 && alltrue([for record in values(aws_route53_record.oob_glue) : contains(record.records, "203.0.113.10")])
    error_message = "With one address both ns1 and ns2 must point at it."
  }
}

run "rejects_private_oob_addresses" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    oob_server_ips = ["10.0.0.5"]
  }

  expect_failures = [var.oob_server_ips]
}

run "rejects_more_than_two_oob_addresses" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    oob_server_ips = ["203.0.113.1", "203.0.113.2", "203.0.113.3"]
  }

  expect_failures = [var.oob_server_ips]
}

run "rejects_malformed_domain" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    domain_name = "Blackwing.Example."
  }

  expect_failures = [var.domain_name]
}

run "rejects_oob_label_colliding_with_an_ingress_host" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    oob_subdomain_label = "app"
  }

  expect_failures = [aws_route53_record.oob_delegation]
}

run "query_logging_and_volume_metrics_are_enabled" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = aws_route53_query_log.app.cloudwatch_log_group_arn == aws_cloudwatch_log_group.query.arn
    error_message = "Route53 query logging must be enabled for the zone."
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.oob_queries.metric_transformation[0].name == "OobDnsQueries"
    error_message = "A query-volume metric for the OOB subdomain must exist."
  }
}
