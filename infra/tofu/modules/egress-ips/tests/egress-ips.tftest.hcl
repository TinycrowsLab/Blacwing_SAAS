# Offline tests for the egress-IP publishing module (INFRA-015, #50). The AWS provider is mocked:
# nothing here talks to AWS. Run with infra/tofu/scripts/check.sh modules/egress-ips.

mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::bw-test-egress-ips"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:distribution/E1TEST"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    }
  }
}

variables {
  environment       = "test"
  domain_name       = "test.blackwing.example"
  zone_id           = "Z0123456789ABC"
  egress_ips        = ["203.0.113.20", "198.51.100.7"]
  access_log_bucket = "blackwing-tfstate-logs-123456789012-eu-central-1"
}

run "published_list_equals_egress_ips_as_sorted_slash32s" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = output.published_egress_ips == ["198.51.100.7/32", "203.0.113.20/32"]
    error_message = "The published list must be exactly the egress_ips input, sorted, as /32 CIDRs."
  }

  assert {
    condition     = toset([for c in output.published_egress_ips : trimsuffix(c, "/32")]) == toset(var.egress_ips)
    error_message = "The published set must equal the egress_ips output set (drift)."
  }
}

run "document_matches_the_v1_schema" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = jsondecode(output.document).version == 1
    error_message = "The document must carry version 1."
  }

  assert {
    condition     = toset(keys(jsondecode(output.document))) == toset(["version", "lastUpdated", "egressIps", "notes"])
    error_message = "The document must have exactly version, lastUpdated, egressIps and notes."
  }

  assert {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", jsondecode(output.document).lastUpdated))
    error_message = "lastUpdated must be an ISO-8601 UTC timestamp."
  }

  assert {
    condition     = jsondecode(output.document).egressIps == output.published_egress_ips
    error_message = "The document's egressIps must equal the published list."
  }

  assert {
    condition     = aws_s3_object.document.content == output.document
    error_message = "The S3 object must hold exactly the rendered document."
  }
}

run "no_private_address_is_published" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition = !anytrue([
      for c in jsondecode(output.document).egressIps :
      anytrue([for private in ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"] : cidrcontains(private, trimsuffix(c, "/32"))])
    ])
    error_message = "No RFC1918, loopback, link-local or CGNAT address may be published."
  }
}

run "rfc1918_address_is_rejected" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = ["203.0.113.20", "10.40.1.5"]
  }

  expect_failures = [var.egress_ips]
}

run "link_local_and_cgnat_addresses_are_rejected" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = ["169.254.169.254", "100.64.0.1"]
  }

  expect_failures = [var.egress_ips]
}

run "empty_list_is_rejected" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = []
  }

  expect_failures = [var.egress_ips]
}

run "last_updated_is_stable_when_the_set_is_unchanged" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = ["198.51.100.7", "203.0.113.20"]
  }

  assert {
    condition     = output.last_updated == jsondecode(output.document).lastUpdated
    error_message = "last_updated must be the stamp inside the document."
  }
}

run "last_updated_is_restamped_when_the_set_changes" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = ["198.51.100.7", "203.0.113.99"]
  }

  # The stamp resource is replaced (new id) exactly when the address set changes.
  assert {
    condition     = terraform_data.last_updated.triggers_replace == ["198.51.100.7/32", "203.0.113.99/32"]
    error_message = "The stamp must be tied to the sorted address set."
  }

  assert {
    condition     = output.published_egress_ips == ["198.51.100.7/32", "203.0.113.99/32"]
    error_message = "A changed EIP set must be reflected in the published list."
  }
}

run "reordered_input_is_the_same_document_set" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    egress_ips = ["203.0.113.20", "198.51.100.7"]
  }

  assert {
    condition     = output.published_egress_ips == ["198.51.100.7/32", "203.0.113.20/32"]
    error_message = "Input order must not change the canonical (sorted) list."
  }
}

run "served_over_tls_only_with_json_and_cache_headers" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition     = aws_cloudfront_distribution.this.default_cache_behavior[0].viewer_protocol_policy == "https-only"
    error_message = "Plain HTTP must be refused: the distribution is https-only."
  }

  assert {
    condition     = aws_cloudfront_distribution.this.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "TLS 1.2 or newer is required."
  }

  assert {
    condition     = aws_s3_object.document.content_type == "application/json" && aws_s3_object.document.cache_control == "public, max-age=3600"
    error_message = "The object must be application/json with a one hour public cache."
  }

  assert {
    condition     = aws_cloudfront_cache_policy.this.default_ttl == 3600 && aws_cloudfront_cache_policy.this.max_ttl == 3600
    error_message = "The CDN cache TTL must be one hour so an EIP change propagates within it."
  }

  assert {
    condition     = output.url == "https://egress.test.blackwing.example/.well-known/blackwing-egress-ips.json"
    error_message = "The URL must be https://egress.<domain>/.well-known/blackwing-egress-ips.json."
  }
}

run "bucket_is_private_and_denies_plain_http" {
  command = apply

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.this.block_public_acls &&
      aws_s3_bucket_public_access_block.this.block_public_policy &&
      aws_s3_bucket_public_access_block.this.ignore_public_acls &&
      aws_s3_bucket_public_access_block.this.restrict_public_buckets
    )
    error_message = "The bucket must block all public access: only CloudFront may read it."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.this.policy, "aws:SecureTransport")
    error_message = "The bucket policy must deny non-TLS requests."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.this.policy, "AWS:SourceArn")
    error_message = "Reads must be limited to this distribution through OAC."
  }
}

run "hostname_cannot_collide_with_reserved_labels" {
  command = plan

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  variables {
    hostname_label = "oob"
  }

  expect_failures = [var.hostname_label]
}
