// Self-tests for the public ingress (INFRA-012): the bw-ingress Helm chart and
// infra/k3s/cert-manager. Everything is rendered offline with `helm template`; nothing talks to a
// cluster, Let's Encrypt or AWS. The live probes (infra/k3s/cert-manager/verify-ingress.sh against a
// real domain, and the staging renewal drill) are the integration half; see
// docs/runbooks/ingress-tls.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHART = path.join(REPO, 'infra', 'helm', 'bw-ingress');
const CM = path.join(REPO, 'infra', 'k3s', 'cert-manager');
const BASE = [
  '--set',
  'domain=bw.example',
  '--set',
  'acme.email=ops@bw.example',
  '--set',
  'acme.route53.hostedZoneID=Z0123456789',
];

/**
 * Walks a dotted path ("spec.routes.0.match") through parsed YAML.
 * @param {unknown} o @param {string} p @returns {unknown}
 */
function at(o, p) {
  let cur = o;
  for (const key of p.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = /** @type {Record<string, unknown>} */ (cur)[key];
  }
  return cur;
}
/** @param {unknown} o @param {string} p @returns {unknown[]} */
function arr(o, p) {
  const v = at(o, p);
  assert.ok(Array.isArray(v), `${p} must be a list`);
  return v;
}
/** @param {unknown} o @param {string} p @returns {string} */
function str(o, p) {
  const v = at(o, p);
  assert.equal(typeof v, 'string', `${p} must be a string`);
  return /** @type {string} */ (v);
}
/** @param {unknown} o @param {string} p @returns {number} */
function num(o, p) {
  const v = at(o, p);
  assert.equal(typeof v, 'number', `${p} must be a number`);
  return /** @type {number} */ (v);
}

/**
 * @param {string[]} extra additional helm arguments
 * @param {string[]} [base]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function helm(extra = [], base = BASE) {
  const r = spawnSync(
    'helm',
    ['template', 'bw-ingress', CHART, '-n', 'bw-system', ...base, ...extra],
    {
      encoding: 'utf8',
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @param {string} text @returns {unknown[]} */
function parse(text) {
  return parseAllDocuments(text)
    .map((d) => {
      /** @type {unknown} */
      const js = d.toJS();
      return js;
    })
    .filter((d) => d !== null && d !== undefined);
}

/** @param {string[]} extra @returns {unknown[]} */
function render(extra = []) {
  const r = helm(extra);
  assert.equal(r.status, 0, r.stderr);
  return parse(r.stdout);
}

/** @param {unknown[]} docs @param {string} kind @param {string} [name] */
function pick(docs, kind, name) {
  return docs.filter(
    (d) => at(d, 'kind') === kind && (name === undefined || at(d, 'metadata.name') === name),
  );
}

/** @param {unknown[]} docs @param {string} kind @param {string} name */
function one(docs, kind, name) {
  const found = pick(docs, kind, name);
  assert.equal(found.length, 1, `${kind}/${name} must exist exactly once`);
  return found[0];
}

/** @param {string[]} extra @param {RegExp} message */
function rejects(extra, message) {
  const r = helm(extra);
  assert.notEqual(r.status, 0, 'helm template must fail closed');
  assert.match(r.stderr, message);
}

describe('issuers and certificates', () => {
  const docs = render();

  it('creates letsencrypt-staging and letsencrypt-prod ClusterIssuers using Route53 DNS-01', () => {
    const issuers = pick(docs, 'ClusterIssuer');
    assert.deepEqual(issuers.map((i) => str(i, 'metadata.name')).sort(), [
      'letsencrypt-prod',
      'letsencrypt-staging',
    ]);
    for (const issuer of issuers) {
      const solver = arr(issuer, 'spec.acme.solvers')[0];
      assert.equal(at(solver, 'dns01.route53.hostedZoneID'), 'Z0123456789');
      assert.deepEqual(at(solver, 'selector.dnsZones'), ['bw.example']);
      assert.equal(
        at(solver, 'dns01.route53.accessKeyIDSecretRef'),
        undefined,
        'no static AWS keys by default',
      );
    }
    assert.match(
      str(one(docs, 'ClusterIssuer', 'letsencrypt-staging'), 'spec.acme.server'),
      /acme-staging-v02/,
    );
    assert.match(
      str(one(docs, 'ClusterIssuer', 'letsencrypt-prod'), 'spec.acme.server'),
      /acme-v02\.api/,
    );
  });

  it('issues one auto-renewing certificate each for app.<domain> and api.<domain>, on staging by default', () => {
    const certs = pick(docs, 'Certificate');
    assert.deepEqual(certs.map((c) => arr(c, 'spec.dnsNames')[0]).sort(), [
      'api.bw.example',
      'app.bw.example',
    ]);
    for (const c of certs) {
      assert.equal(at(c, 'spec.issuerRef.name'), 'letsencrypt-staging');
      assert.equal(at(c, 'spec.renewBefore'), '720h');
      assert.equal(at(c, 'spec.privateKey.rotationPolicy'), 'Always');
    }
  });

  it('switches to production issuance only with values-prod.yaml', () => {
    const prod = render(['-f', path.join(CHART, 'values-prod.yaml')]);
    for (const c of pick(prod, 'Certificate'))
      assert.equal(at(c, 'spec.issuerRef.name'), 'letsencrypt-prod');
  });

  it('supports a short-lived staging renewal drill', () => {
    const drill = render(['-f', path.join(CHART, 'values-renewal-drill.yaml')]);
    for (const c of pick(drill, 'Certificate')) {
      assert.equal(at(c, 'spec.issuerRef.name'), 'letsencrypt-staging');
      assert.equal(at(c, 'spec.renewBefore'), '2159h');
    }
  });

  it('requires the domain, the ACME contact and the hosted zone', () => {
    const noDomain = helm(
      [],
      ['--set', 'acme.email=a@b.c', '--set', 'acme.route53.hostedZoneID=Z1'],
    );
    assert.match(noDomain.stderr, /domain is required/);
    const noEmail = helm(
      [],
      ['--set', 'domain=bw.example', '--set', 'acme.route53.hostedZoneID=Z1'],
    );
    assert.match(noEmail.stderr, /acme\.email is required/);
    const noZone = helm([], ['--set', 'domain=bw.example', '--set', 'acme.email=a@b.c']);
    assert.match(noZone.stderr, /hostedZoneID is required/);
  });

  it('rejects an unknown issuer name', () => {
    rejects(['--set', 'tls.issuer=selfsigned'], /tls\.issuer must be/);
  });
});

describe('TLS options and security headers', () => {
  const docs = render();

  it('enforces TLS 1.2 minimum with ECDHE AEAD suites only', () => {
    const tls = one(docs, 'TLSOption', 'bw-tls');
    assert.equal(at(tls, 'spec.minVersion'), 'VersionTLS12');
    assert.equal(at(tls, 'spec.sniStrict'), true);
    for (const suite of arr(tls, 'spec.cipherSuites')) {
      assert.match(String(suite), /ECDHE/);
      assert.doesNotMatch(String(suite), /_CBC_|RC4|3DES/);
    }
  });

  it('rejects TLS below 1.2 and weak cipher suites', () => {
    rejects(['--set', 'tls.minVersion=VersionTLS11'], /tls\.minVersion must be/);
    rejects(
      ['--set', 'tls.cipherSuites[0]=TLS_RSA_WITH_AES_128_CBC_SHA'],
      /weak or non-forward-secret/,
    );
  });

  it('sets HSTS (>= 15552000, includeSubDomains), nosniff, frame deny and referrer policy', () => {
    const h = one(docs, 'Middleware', 'secure-headers');
    assert.ok(num(h, 'spec.headers.stsSeconds') >= 15552000);
    assert.equal(at(h, 'spec.headers.stsIncludeSubdomains'), true);
    assert.equal(at(h, 'spec.headers.forceSTSHeader'), true);
    assert.equal(at(h, 'spec.headers.contentTypeNosniff'), true);
    assert.equal(at(h, 'spec.headers.frameDeny'), true);
    assert.ok(str(h, 'spec.headers.referrerPolicy').length > 0);
  });

  it('refuses an HSTS max-age below 180 days', () => {
    rejects(['--set', 'headers.stsSeconds=3600'], /stsSeconds must be at least 15552000/);
  });

  it('chains secure headers, rate limit and in-flight limit on public routes', () => {
    const chain = arr(one(docs, 'Middleware', 'public-chain'), 'spec.chain.middlewares').map((m) =>
      at(m, 'name'),
    );
    assert.deepEqual(chain, ['secure-headers', 'rate-limit', 'inflight']);
    assert.ok(num(one(docs, 'Middleware', 'rate-limit'), 'spec.rateLimit.average') > 0);
    assert.ok(num(one(docs, 'Middleware', 'inflight'), 'spec.inFlightReq.amount') > 0);
    for (const route of pick(docs, 'IngressRoute')) {
      for (const r of arr(route, 'spec.routes')) {
        assert.ok(arr(r, 'middlewares').some((m) => at(m, 'name') === 'public-chain'));
      }
    }
  });

  it('applies headers and TLS options cluster-wide and redirects HTTP to HTTPS (no header downgrade)', () => {
    const cfg = one(docs, 'HelmChartConfig', 'traefik');
    const values = parse(str(cfg, 'spec.valuesContent'))[0];
    assert.deepEqual(at(values, 'ports.web.http.redirections.entryPoint'), {
      to: 'websecure',
      scheme: 'https',
      permanent: true,
    });
    assert.deepEqual(at(values, 'ports.websecure.http.middlewares'), [
      'bw-system-secure-headers@kubernetescrd',
    ]);
    assert.equal(at(values, 'ports.websecure.http.tls.options'), 'bw-system-bw-tls@kubernetescrd');
    assert.equal(at(values, 'metrics.prometheus.addRoutersLabels'), true);
  });
});

describe('exposure', () => {
  const docs = render();
  const routes = pick(docs, 'IngressRoute');

  it('exposes exactly the web console and the public API', () => {
    assert.deepEqual(routes.map((r) => at(r, 'metadata.name')).sort(), ['api', 'web']);
    const matches = routes.flatMap((r) => arr(r, 'spec.routes').map((x) => str(x, 'match')));
    assert.ok(matches.some((m) => m.includes('app.bw.example')));
    assert.ok(matches.some((m) => m.includes('api.bw.example')));
  });

  it('routes only /v1 and /graphql on the API host and never /internal/broker', () => {
    const api = one(docs, 'IngressRoute', 'api');
    assert.match(
      str(arr(api, 'spec.routes')[0], 'match'),
      /PathPrefix\(`\/v1`\) \|\| PathPrefix\(`\/graphql`\)/,
    );
    const all = JSON.stringify(routes);
    assert.doesNotMatch(all, /\/internal/);
    assert.doesNotMatch(all, /broker/i);
  });

  it('serves HTTPS only through the websecure entry point with a certificate secret', () => {
    for (const r of routes) {
      assert.deepEqual(at(r, 'spec.entryPoints'), ['websecure']);
      assert.ok(str(r, 'spec.tls.secretName'));
      assert.equal(at(r, 'spec.tls.options.name'), 'bw-tls');
    }
  });

  it('refuses to render when a public path would reach the broker or the whole API', () => {
    for (const p of ['/internal', '/internal/broker', '/', '/v1/broker']) {
      rejects(['--set', `api.publicPaths[0]=${p}`], /would expose the internal Run Broker surface/);
    }
    rejects(['--set', 'api.publicPaths[0]=v1'], /must start with \//);
  });

  it('renders no route for Temporal UI, Grafana or OpenBao by default', () => {
    assert.doesNotMatch(JSON.stringify(docs), /temporal|grafana|openbao/i);
  });

  it('publishes an internal UI only behind an IP allowlist and an authenticating middleware', () => {
    /** @param {string[]} extra */
    const ui = (extra) => [
      '--set',
      'internalUis.grafana.enabled=true',
      '--set',
      'internalUis.grafana.host=grafana',
      '--set',
      'internalUis.grafana.service.name=grafana',
      '--set',
      'internalUis.grafana.service.port=3000',
      ...extra,
    ];
    const allow = ['--set', 'internalUis.grafana.ipAllowList[0]=203.0.113.0/24'];
    const auth = ['--set', 'internalUis.grafana.authMiddleware=grafana-forward-auth'];

    rejects(ui(auth), /ipAllowList is required/);
    rejects(ui(allow), /authMiddleware is required/);
    rejects(
      ui([...auth, '--set', 'internalUis.grafana.ipAllowList[0]=0.0.0.0/0']),
      /must not allow every address/,
    );

    const ok = render(ui([...allow, ...auth]));
    const route = one(ok, 'IngressRoute', 'grafana');
    const mws = arr(arr(route, 'spec.routes')[0], 'middlewares').map((m) => at(m, 'name'));
    assert.deepEqual(mws, ['grafana-ip-allow', 'grafana-forward-auth', 'public-chain']);
    assert.deepEqual(
      at(one(ok, 'Middleware', 'grafana-ip-allow'), 'spec.ipAllowList.sourceRange'),
      ['203.0.113.0/24'],
    );
    one(ok, 'Certificate', 'grafana-tls');
  });
});

describe('observability', () => {
  const docs = render();

  it('alerts on certificate expiry, renewal failure and broker-path requests through the ingress', () => {
    const text = JSON.stringify(one(docs, 'PrometheusRule', 'bw-ingress'));
    assert.match(text, /certmanager_certificate_expiration_timestamp_seconds/);
    assert.match(text, /BlackwingCertificateNotReady/);
    assert.match(text, /traefik_router_requests_total/);
  });

  it('pages on any /internal request seen by the ingress', () => {
    const loki = one(docs, 'ConfigMap', 'bw-ingress-loki-rules');
    const rules = JSON.stringify(at(loki, 'data'));
    assert.match(rules, /\^\/internal/);
    assert.match(rules, /severity: page/);
  });

  it('can disable the rule objects when the operator CRDs are absent', () => {
    const none = render(['--set', 'alerts.prometheusRule=false', '--set', 'alerts.lokiRule=false']);
    assert.equal(pick(none, 'PrometheusRule').length, 0);
    assert.equal(pick(none, 'ConfigMap').length, 0);
  });
});

describe('kubeconform', () => {
  it('validates every rendered object against the Kubernetes, Traefik and cert-manager schemas', () => {
    const rendered = helm();
    assert.equal(rendered.status, 0, rendered.stderr);
    const r = spawnSync(
      'kubeconform',
      [
        '-strict',
        '-summary',
        '-schema-location',
        'default',
        '-schema-location',
        'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json',
        '-ignore-missing-schemas',
        '-',
      ],
      { input: rendered.stdout, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Invalid: 0, Errors: 0/);
  });
});

describe('cert-manager install and external probes', () => {
  const env = fs.readFileSync(path.join(CM, 'versions.env'), 'utf8');
  const install = path.join(CM, 'install.sh');
  const verify = path.join(CM, 'verify-ingress.sh');

  it('pins the cert-manager chart to an exact version', () => {
    assert.match(env, /^CERT_MANAGER_CHART_VERSION="v\d+\.\d+\.\d+"$/m);
  });

  it('runs cert-manager non-root with CRDs kept on uninstall', () => {
    const values = parse(fs.readFileSync(path.join(CM, 'values.yaml'), 'utf8'))[0];
    assert.equal(at(values, 'crds.keep'), true);
    assert.equal(at(values, 'containerSecurityContext.allowPrivilegeEscalation'), false);
    assert.deepEqual(at(values, 'containerSecurityContext.capabilities.drop'), ['ALL']);
    assert.ok(arr(values, 'extraArgs').includes('--dns01-recursive-nameservers-only'));
  });

  it('dry-runs on staging and needs an explicit flag for production', () => {
    const args = [
      '--domain',
      'bw.example',
      '--email',
      'ops@bw.example',
      '--zone-id',
      'Z1',
      '--dry-run',
    ];
    const staging = spawnSync('bash', [install, ...args], { encoding: 'utf8' });
    assert.equal(staging.status, 0, staging.stderr);
    for (const c of pick(parse(staging.stdout), 'Certificate')) {
      assert.equal(at(c, 'spec.issuerRef.name'), 'letsencrypt-staging');
    }
    const prod = spawnSync('bash', [install, ...args, '--prod'], { encoding: 'utf8' });
    assert.equal(prod.status, 0, prod.stderr);
    for (const c of pick(parse(prod.stdout), 'Certificate')) {
      assert.equal(at(c, 'spec.issuerRef.name'), 'letsencrypt-prod');
    }
  });

  it('refuses incomplete input and production combined with the renewal drill', () => {
    const missing = spawnSync('bash', [install, '--dry-run'], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    const both = spawnSync(
      'bash',
      [
        install,
        '--domain',
        'd.example',
        '--email',
        'a@d.example',
        '--zone-id',
        'Z1',
        '--prod',
        '--renewal-drill',
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(both.status, 2);
    assert.match(both.stderr, /cannot be combined/);
  });

  it('ships an external probe script with valid syntax that needs a domain', () => {
    assert.equal(spawnSync('bash', ['-n', verify]).status, 0);
    assert.equal(spawnSync('bash', [verify], { encoding: 'utf8' }).status, 2);
  });

  /**
   * Runs verify-ingress.sh with mocked curl/openssl; `brokerCode` is what the broker path answers.
   * @param {string} brokerCode @param {boolean} tlsOld whether the mocked server accepts TLS < 1.2
   */
  function probe(brokerCode, tlsOld) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-ingress-'));
    const curl = `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/internal/"*) printf '${brokerCode}'; exit 0 ;;
  *"-I https://"*) printf 'HTTP/2 200\\r\\nstrict-transport-security: max-age=31536000; includeSubDomains\\r\\nx-content-type-options: nosniff\\r\\nx-frame-options: DENY\\r\\n\\r\\n'; exit 0 ;;
  *"-D - http://"*) host="\${args##*http://}"; host="\${host%%/*}"; printf 'HTTP/1.1 308 Permanent Redirect\\r\\nLocation: https://%s/\\r\\n\\r\\n' "$host"; exit 0 ;;
esac
exit 0
`;
    const openssl = `#!/usr/bin/env bash
case "$*" in *tls1_1*|*" -tls1 "*|*" -tls1") exit ${tlsOld ? 0 : 1} ;; esac
exit 0
`;
    fs.writeFileSync(path.join(dir, 'curl'), curl, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'openssl'), openssl, { mode: 0o755 });
    try {
      return spawnSync('bash', [verify, 'bw.example'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('probe passes when the broker path is 404 and old TLS is refused', () => {
    const r = probe('404', false);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /0 failed/);
  });

  it('probe fails when the broker path answers or old TLS is accepted', () => {
    const exposed = probe('200', false);
    assert.equal(exposed.status, 1);
    assert.match(exposed.stdout, /FAIL api: \/internal\/broker answered 200/);
    const oldTls = probe('404', true);
    assert.equal(oldTls.status, 1);
    assert.match(oldTls.stdout, /FAIL .*tls1_1 was accepted/);
  });
});
