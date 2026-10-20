# Blackwing egress IP addresses

Every request Blackwing sends to your assets leaves from a small set of static public IP addresses. Allowlist
them on your firewall, WAF or CDN before you start a run, so you can tell Blackwing traffic from anything else.

## Where to get the list

```
https://egress.<your-blackwing-domain>/.well-known/blackwing-egress-ips.json
```

Use the domain of your Blackwing environment. The endpoint is static, served over HTTPS only, and does not depend
on the Blackwing application, so it stays available during an application outage.

```json
{
  "version": 1,
  "lastUpdated": "2026-10-20T10:00:00Z",
  "egressIps": ["198.51.100.7/32", "203.0.113.20/32"],
  "notes": "Source addresses of all Blackwing target traffic. ..."
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version, currently `1`. |
| `lastUpdated` | UTC time the set of addresses last changed. It does not change when the set is unchanged. |
| `egressIps` | Every egress address, as `/32` CIDRs. Only public NAT addresses are listed. |
| `notes` | Free text. |

## Keeping your allowlist current

- The response is cached for up to **1 hour**. After Blackwing changes an address it can take up to an hour before
  the new list is visible. We announce planned changes in advance and keep the old address attached for longer than
  the cache time.
- Re-fetch the document periodically (at least hourly) and compare `egressIps`. Do not hard-code addresses beyond
  what the document lists.
- Reject a document whose `version` is not one you understand, and treat an empty `egressIps` as an error.

## Asset onboarding

When you verify and register an asset, add these addresses to every control that could block
automated testing (WAF, rate limiter, IP allowlist, bot protection). Blackwing only tests assets whose ownership
is verified and that are inside your signed authorisation. If you see traffic to your asset from an address that
is not in this document, it is not Blackwing: treat it as hostile.
