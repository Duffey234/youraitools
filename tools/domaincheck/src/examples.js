// Real outputs captured live on 2026-10-21 (used as Bazaar / OpenAPI examples; live values drift).
export const DOMAIN_EXAMPLE = {
 "input": "example.com",
 "domain": "example.com",
 "registrable_domain": "example.com",
 "public_suffix": "com",
 "tier": "full",
 "exists": true,
 "verdict": "low_risk",
 "score": 90,
 "flags": [
  {
   "id": "null_mx",
   "severity": "medium",
   "penalty": 10,
   "description": "Null MX (RFC 7505): the domain explicitly accepts no email."
  }
 ],
 "dns": {
  "a": [
   "172.66.147.243",
   "104.20.23.154"
  ],
  "aaaa": [
   "2606:4700:10::6814:179a",
   "2606:4700:10::ac42:93f3"
  ],
  "ns": [
   "hera.ns.cloudflare.com",
   "elliott.ns.cloudflare.com"
  ],
  "mx": [],
  "null_mx": true,
  "cname": [],
  "dnssec_validated": true,
  "caa": [],
  "txt_count": 2
 },
 "email": {
  "accepts_mail": false,
  "mx_provider": null,
  "spf": {
   "present": true,
   "record": "v=spf1 -all",
   "multiple": false,
   "all": "-all",
   "policy": "fail",
   "includes": [],
   "redirect": null,
   "dns_lookups_top_level": 0,
   "invalid_terms": []
  },
  "dmarc": {
   "present": true,
   "record": "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s",
   "multiple": false,
   "inherited_from": null,
   "policy": "reject",
   "subdomain_policy": "reject",
   "pct": 100,
   "rua": false,
   "ruf": false,
   "adkim": "s",
   "aspf": "s"
  },
  "dkim": {
   "selectors_found": [],
   "revoked_selectors": 10,
   "selectors_checked": 10,
   "note": "DKIM selectors cannot be enumerated; only common selectors are checked, so none found does not mean DKIM is absent."
  },
  "mta_sts": {
   "present": false
  },
  "tls_rpt": {
   "present": false
  },
  "bimi": {
   "present": false
  },
  "grade": "A"
 },
 "registration": {
  "available": true,
  "found": true,
  "source": "iana-bootstrap",
  "server": "https://rdap.verisign.com/com/v1/",
  "domain": "example.com",
  "registrar": "RESERVED-Internet Assigned Numbers Authority",
  "registrar_iana_id": "376",
  "created": "1995-08-14T04:00:00Z",
  "expires": "2027-08-13T04:00:00Z",
  "age_days": 11391,
  "expires_in_days": 295,
  "status": [
   "client delete prohibited",
   "client transfer prohibited",
   "client update prohibited"
  ],
  "nameservers": [
   "elliott.ns.cloudflare.com",
   "hera.ns.cloudflare.com"
  ],
  "dnssec_signed": true
 },
 "engine": "domaincheck-2026.10.21",
 "dns_queries": 20,
 "ms": 180
};
export const EMAIL_EXAMPLE = {
 "input": "jane.doe+news@gmail.com",
 "tier": "full",
 "syntax": {
  "valid": true,
  "reason": null
 },
 "normalized": "jane.doe+news@gmail.com",
 "canonical": "janedoe@gmail.com",
 "local": "jane.doe+news",
 "domain": "gmail.com",
 "plus_tag": "news",
 "role": false,
 "free_provider": true,
 "disposable": false,
 "smtputf8": false,
 "verdict": "valid",
 "score": 95,
 "deliverability": {
  "domain_exists": true,
  "accepts_mail": true,
  "mx": [
   {
    "priority": 5,
    "host": "gmail-smtp-in.l.google.com"
   },
   {
    "priority": 10,
    "host": "alt1.gmail-smtp-in.l.google.com"
   },
   {
    "priority": 20,
    "host": "alt2.gmail-smtp-in.l.google.com"
   },
   {
    "priority": 30,
    "host": "alt3.gmail-smtp-in.l.google.com"
   },
   {
    "priority": 40,
    "host": "alt4.gmail-smtp-in.l.google.com"
   }
  ],
  "null_mx": false,
  "mx_provider": "Google Workspace / Gmail"
 },
 "domain_auth": {
  "spf": "redirect",
  "dmarc": "none",
  "grade": "D"
 },
 "registration": null,
 "flags": [
  {
   "id": "free_email_provider",
   "severity": "info",
   "penalty": 0,
   "description": "Free webmail provider (gmail.com, outlook.com ...)."
  },
  {
   "id": "dmarc_none",
   "severity": "low",
   "penalty": 5,
   "description": "DMARC policy is p=none (monitoring only, no enforcement)."
  }
 ],
 "mailbox_checked": false,
 "note": "Mailbox existence is not probed (no SMTP RCPT check). \"valid\" means the address is well-formed, the domain accepts mail and nothing looks risky.",
 "engine": "domaincheck-2026.10.21",
 "dns_queries": 6,
 "ms": 40
};
