# Application DNS zone and OOB delegation (INFRA-007).
#
# - The app zone is public. Its name servers are an output: pointing the registrar at them is a
#   manual, out-of-band step (docs/runbooks/dns-delegation.md); the zone answers the Internet only
#   after that.
# - oob.<domain> is delegated with NS records to ns1/ns2.<domain>, which are glue A records for the
#   interactsh servers (INFRA-010). interactsh is then authoritative for oob.<domain> and every
#   label below it, so it answers arbitrary per-interaction hostnames itself. This zone therefore
#   holds NO record at or below oob.<domain> other than the delegation, and a precondition keeps it
#   that way. The NS hosts deliberately live outside the oob subtree.
# - Route53 query logging on the app zone records the referral queries for oob.<domain>.

locals {
  oob_fqdn  = "${var.oob_subdomain_label}.${var.domain_name}"
  ns_labels = ["ns1", "ns2"]
  ns_fqdns  = [for label in local.ns_labels : "${label}.${var.domain_name}"]
  # With one address, both name servers point at it.
  glue_ips = length(var.oob_server_ips) == 0 ? {} : {
    for index, label in local.ns_labels :
    label => var.oob_server_ips[min(index, length(var.oob_server_ips) - 1)]
  }
  ingress_records = var.ingress_alias == null ? toset([]) : toset(var.ingress_hostnames)
}

resource "aws_route53_zone" "app" {
  name    = var.domain_name
  comment = "Blackwing application zone (${var.name_prefix}), managed by OpenTofu"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "oob_delegation" {
  zone_id = aws_route53_zone.app.zone_id
  name    = local.oob_fqdn
  type    = "NS"
  ttl     = 300
  records = local.ns_fqdns

  lifecycle {
    precondition {
      condition     = !contains(var.ingress_hostnames, var.oob_subdomain_label) && !contains(local.ns_labels, var.oob_subdomain_label)
      error_message = "The OOB subdomain label collides with an ingress host or a name-server host label."
    }
  }
}

resource "aws_route53_record" "oob_glue" {
  for_each = local.glue_ips

  zone_id = aws_route53_zone.app.zone_id
  name    = "${each.key}.${var.domain_name}"
  type    = "A"
  ttl     = 300
  records = [each.value]
}

resource "aws_route53_record" "ingress" {
  for_each = local.ingress_records

  zone_id = aws_route53_zone.app.zone_id
  name    = each.value == "" ? var.domain_name : "${each.value}.${var.domain_name}"
  type    = "A"

  alias {
    name                   = var.ingress_alias.dns_name
    zone_id                = var.ingress_alias.zone_id
    evaluate_target_health = true
  }
}

# Query logging. Route53 only delivers to a log group in us-east-1.
resource "aws_cloudwatch_log_group" "query" {
  provider = aws.us_east_1

  name              = "/aws/route53/${var.name_prefix}-${var.domain_name}"
  retention_in_days = var.query_log_retention_days
}

data "aws_iam_policy_document" "query_log" {
  statement {
    sid       = "AllowRoute53QueryLogDelivery"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.query.arn}:*"]

    principals {
      type        = "Service"
      identifiers = ["route53.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "query" {
  provider = aws.us_east_1

  policy_name     = "${var.name_prefix}-route53-query-log"
  policy_document = data.aws_iam_policy_document.query_log.json
}

resource "aws_route53_query_log" "app" {
  zone_id                  = aws_route53_zone.app.zone_id
  cloudwatch_log_group_arn = aws_cloudwatch_log_group.query.arn

  depends_on = [aws_cloudwatch_log_resource_policy.query]
}

# Query volume for the whole zone and for the OOB subtree (abuse detection, OOB correlation).
resource "aws_cloudwatch_log_metric_filter" "queries" {
  provider = aws.us_east_1

  name           = "${var.name_prefix}-dns-queries"
  log_group_name = aws_cloudwatch_log_group.query.name
  pattern        = ""

  metric_transformation {
    name      = "DnsQueries"
    namespace = "Blackwing/${var.name_prefix}/DNS"
    value     = "1"
  }
}

resource "aws_cloudwatch_log_metric_filter" "oob_queries" {
  provider = aws.us_east_1

  name           = "${var.name_prefix}-dns-oob-queries"
  log_group_name = aws_cloudwatch_log_group.query.name
  pattern        = "\"${local.oob_fqdn}\""

  metric_transformation {
    name      = "OobDnsQueries"
    namespace = "Blackwing/${var.name_prefix}/DNS"
    value     = "1"
  }
}

# cert-manager DNS-01 solver permissions (INFRA-012). Least privilege: it may only create and
# delete TXT records named _acme-challenge.* in THIS zone, read the change status and look the
# zone up by name. It cannot touch A/NS records (including the oob delegation) or other zones.
data "aws_iam_policy_document" "cert_manager" {
  statement {
    sid       = "ReadChangeStatus"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }

  statement {
    sid       = "ListZoneRecords"
    actions   = ["route53:ListResourceRecordSets"]
    resources = [aws_route53_zone.app.arn]
  }

  statement {
    sid       = "ChangeAcmeChallengeTxtOnly"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = [aws_route53_zone.app.arn]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }

    condition {
      test     = "ForAllValues:StringLike"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["_acme-challenge.${var.domain_name}", "_acme-challenge.*.${var.domain_name}"]
    }
  }

  statement {
    sid       = "FindZoneByName"
    actions   = ["route53:ListHostedZonesByName"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "cert_manager" {
  name        = "${var.name_prefix}-cert-manager-dns01"
  description = "cert-manager DNS-01 (Route53) for the application zone: _acme-challenge TXT records only."
  policy      = data.aws_iam_policy_document.cert_manager.json
}
