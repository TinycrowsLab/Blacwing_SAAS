import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  listOperations,
  main,
  parseSpec,
  REFERENCE_FILE,
  renderApiReference,
  renderFromRoot,
  SPEC_FILE,
  syncReference,
} from './render-api-reference.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {string[]} */
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROBLEM = {
  type: 'object',
  required: ['type', 'title', 'status', 'code', 'traceId'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string', description: 'Stable registry code.' },
    traceId: { type: 'string' },
  },
};

/** A small spec with the shapes the renderer must handle: refs, deprecation, an untagged operation, pipes. */
function fixtureSpec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Fixture API', version: '1.2.3' },
    tags: [{ name: 'widgets', description: 'Widget endpoints.' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/v1/widgets': {
        post: {
          tags: ['widgets'],
          operationId: 'createWidget',
          summary: 'Create a widget',
          description: 'Creates a widget. Requires `widgets:write`.',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Widget' },
                examples: {
                  small: { summary: 'Small widget', value: { name: 'a | b' } },
                  big: { value: { name: 'large' } },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Created.',
              headers: {
                Location: { description: 'URL of the widget.', schema: { type: 'string' } },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
            },
            422: {
              description: 'Problem details; code is one of VALIDATION_FAILED.',
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/Problem' },
                  example: {
                    type: 'https://errors.blackwing.dev/VALIDATION_FAILED',
                    title: 'Validation failed',
                    status: 422,
                    code: 'VALIDATION_FAILED',
                    traceId: '0'.repeat(32),
                  },
                },
              },
            },
          },
        },
      },
      '/v1/legacy': {
        get: {
          tags: ['widgets'],
          operationId: 'legacyList',
          deprecated: true,
          description: 'Use `createWidget` instead.',
          security: [],
          responses: { 200: { description: 'OK.' } },
        },
      },
      '/v1/untagged': {
        delete: {
          operationId: 'untaggedDelete',
          responses: { 204: { description: 'Deleted.' } },
        },
      },
      '/internal/broker/tokens': {
        post: {
          tags: ['widgets'],
          operationId: 'brokerSecret',
          responses: { 200: { description: 'Internal only.' } },
        },
      },
    },
    components: {
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description: 'Required on creating POSTs.',
          schema: { type: 'string', minLength: 8 },
        },
      },
      schemas: {
        Widget: {
          type: 'object',
          description: 'A widget.',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 64, description: 'Display | name.' },
            kind: { enum: ['basic', 'pro'] },
            createdAt: { type: 'string', format: 'date-time' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        Problem: PROBLEM,
      },
    },
  };
}

function scratchRoot(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-api-ref-'));
  scratch.push(root);
  mkdirSync(path.join(root, 'docs/api'), { recursive: true });
  writeFileSync(path.join(root, SPEC_FILE), `${JSON.stringify(spec, null, 2)}\n`);
  return root;
}

describe('parseSpec', () => {
  it('rejects text that is not JSON', () => {
    assert.throws(() => parseSpec('{ not json'), /not valid JSON/);
  });

  it('rejects a spec that is not OpenAPI 3.1', () => {
    assert.throws(
      () => parseSpec(JSON.stringify({ ...fixtureSpec(), openapi: '3.0.3' })),
      /3\.1\.x/,
    );
  });

  it('rejects a spec without info.title or paths', () => {
    assert.throws(() => parseSpec(JSON.stringify({ ...fixtureSpec(), info: {} })), /info\.title/);
    assert.throws(
      () => parseSpec(JSON.stringify({ ...fixtureSpec(), paths: [] })),
      /paths must be an object/,
    );
  });

  it('rejects an operation without an operationId, and duplicated operationIds', () => {
    const missing = fixtureSpec();
    delete missing.paths['/v1/untagged'].delete.operationId;
    assert.throws(() => parseSpec(JSON.stringify(missing)), /needs an operationId/);

    const duplicate = fixtureSpec();
    duplicate.paths['/v1/untagged'].delete.operationId = 'createWidget';
    assert.throws(
      () => parseSpec(JSON.stringify(duplicate)),
      /operationId createWidget is not unique/,
    );
  });

  it('rejects an operation without responses and a path that is not absolute', () => {
    const noResponses = fixtureSpec();
    noResponses.paths['/v1/untagged'].delete.responses = {};
    assert.throws(() => parseSpec(JSON.stringify(noResponses)), /has no responses/);

    const relative = fixtureSpec();
    relative.paths['v1/x'] = relative.paths['/v1/untagged'];
    assert.throws(() => parseSpec(JSON.stringify(relative)), /must start with \//);
  });
});

describe('renderApiReference', () => {
  const spec = parseSpec(JSON.stringify(fixtureSpec()));
  const markdown = renderApiReference(spec);

  it('renders every public operation', () => {
    for (const { method, route } of listOperations(spec)) {
      assert.match(
        markdown,
        new RegExp(`### ${method.toUpperCase()} ${route.replace(/[/{}]/g, (c) => `\\${c}`)}\n`),
      );
    }
  });

  it('never renders the internal Run Broker API', () => {
    assert.equal(
      listOperations(spec).some((entry) => entry.route.startsWith('/internal')),
      false,
    );
    assert.doesNotMatch(markdown, /brokerSecret|\/internal\/broker\/tokens/);
  });

  it('marks deprecated operations and keeps untagged operations under Other operations', () => {
    assert.match(markdown, /> \*\*Deprecated\.\*\*/);
    assert.match(markdown, /## Other operations/);
    assert.match(markdown, /### DELETE \/v1\/untagged/);
  });

  it('describes parameters, request and response bodies and their examples', () => {
    assert.match(
      markdown,
      /\| `Idempotency-Key` \| header \| yes \| string \| Required on creating POSTs\. \|/,
    );
    assert.match(markdown, /Content type `application\/json`: \[Widget\]\(#widget\)\./);
    assert.match(markdown, /\| `Location` \| URL of the widget\. \|/);
    assert.match(markdown, /Example: Small widget\./);
    assert.match(markdown, /Example: big\./);
  });

  it('escapes pipes inside table cells, and keeps example values as JSON', () => {
    assert.match(markdown, /\| `name` \| string \| yes \| Display \\\| name\. \|/);
    assert.match(markdown, /"name": "a \| b"/);
  });

  it('lists each component schema with its properties', () => {
    assert.match(markdown, /## Schemas\n\n### Widget\n/);
    assert.match(markdown, /\| `name` \| string \| yes \| Display \\\| name\. \|/);
    assert.match(markdown, /\| `createdAt` \| string \(date-time\) \| no \|/);
  });

  it('authentication names the schemes and says when none apply', () => {
    assert.match(markdown, /- Authentication: `bearerAuth`/);
    assert.match(markdown, /- Authentication: None \(public\)\./);
  });

  it('is deterministic', () => {
    assert.equal(renderApiReference(spec), markdown);
  });

  it('fences JSON whose content contains backticks with a longer fence', () => {
    const tricky = fixtureSpec();
    tricky.paths['/v1/widgets'].post.requestBody.content['application/json'].examples.small.value =
      {
        name: '```code```',
      };
    const out = renderApiReference(parseSpec(JSON.stringify(tricky)));
    assert.match(out, /````json\n\{\n {2}"name": "```code```"\n\}\n````/);
  });
});

describe('committed reference (repository)', () => {
  it('documents every operation of the committed spec', () => {
    const spec = parseSpec(readFileSync(path.join(repoRoot, SPEC_FILE), 'utf8'));
    const committed = readFileSync(path.join(repoRoot, REFERENCE_FILE), 'utf8');
    for (const { method, route } of listOperations(spec)) {
      assert.ok(
        committed.includes(`### ${method.toUpperCase()} ${route}\n`),
        `${method} ${route} is missing`,
      );
    }
  });

  it('is exactly what the committed spec renders to (staleness)', async () => {
    const markdown = await renderFromRoot(repoRoot);
    assert.equal(readFileSync(path.join(repoRoot, REFERENCE_FILE), 'utf8'), markdown);
  });

  it('never publishes a credential-looking value or the internal broker', () => {
    for (const file of readdirSync(path.join(repoRoot, 'docs/api')).filter((f) =>
      f.endsWith('.md'),
    )) {
      const text = readFileSync(path.join(repoRoot, 'docs/api', file), 'utf8');
      assert.doesNotMatch(
        text,
        /bw_(pat|ci)_[A-Za-z0-9]{12,}/,
        `${file} contains a token-like value`,
      );
      assert.doesNotMatch(
        text,
        /^#+ .*\/internal\/broker/m,
        `${file} documents the internal broker as a path`,
      );
    }
  });
});

describe('syncReference (regeneration and staleness)', () => {
  it('writes the page when run without --check and reports it current afterwards', async () => {
    const root = scratchRoot(fixtureSpec());
    assert.deepEqual(await syncReference({ root, check: false }), { stale: false });
    assert.deepEqual(await syncReference({ root, check: true }), { stale: false });
  });

  it('reports a missing page as stale', async () => {
    const root = scratchRoot(fixtureSpec());
    assert.deepEqual(await syncReference({ root, check: true }), { stale: true });
  });

  it('fails when the spec changed and the page was not regenerated', async () => {
    const root = scratchRoot(fixtureSpec());
    await syncReference({ root, check: false });
    const changed = fixtureSpec();
    changed.paths['/v1/widgets'].post.summary = 'Make a widget';
    writeFileSync(path.join(root, SPEC_FILE), JSON.stringify(changed));
    assert.deepEqual(await syncReference({ root, check: true }), { stale: true });
    await syncReference({ root, check: false });
    assert.deepEqual(await syncReference({ root, check: true }), { stale: false });
  });

  it('returns 1 for a stale page or an invalid spec, and 2 for a usage error', async () => {
    const root = scratchRoot(fixtureSpec());
    assert.equal(await main(['--check', '--root', root]), 1);
    await syncReference({ root, check: false });
    assert.equal(await main(['--check', '--root', root]), 0);

    writeFileSync(path.join(root, SPEC_FILE), '{ broken');
    assert.equal(await main(['--root', root]), 1);
    assert.equal(await main(['--root']), 2);
  });
});
