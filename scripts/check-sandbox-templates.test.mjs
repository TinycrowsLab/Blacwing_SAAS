// Tests for the vendored nuclei-templates guard (IMAGE-004, #602). The real pin, profile and Dockerfile must pass, and
// each mutation (a missing exclusion, a runtime update left on, an intrusive tag, a writable template tree) must fail.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  checkNucleiProfile,
  checkTemplatesDockerfile,
  checkTemplatesPin,
  EXCLUDED_CATEGORIES,
  INTRUSIVE_TAGS,
  NUCLEI_PROFILE,
} from './check-sandbox-templates.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const read = (/** @type {string} */ p) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const PIN_TEXT = read('infra/docker/sandbox/tools.pin.json');
const PROFILE_TEXT = read(NUCLEI_PROFILE);
const DOCKERFILE = read('infra/docker/sandbox/Dockerfile');
const DOCKERIGNORE = read('infra/docker/sandbox/Dockerfile.dockerignore');

/** @param {string} text @param {string} from @param {string} to */
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `fixture contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

/** @param {(pins: { templates: { exclude: string[] }[] }) => void} mutate @returns {string} */
const mutatePin = (mutate) => {
  /** @type {unknown} */
  const parsed = JSON.parse(PIN_TEXT);
  const pins = /** @type {{ templates: { exclude: string[] }[] }} */ (parsed);
  mutate(pins);
  return JSON.stringify(pins);
};

describe('real nuclei-templates pin, profile and Dockerfile', () => {
  it('pass the guard', () => {
    assert.deepEqual(checkTemplatesPin(PIN_TEXT), []);
    assert.deepEqual(checkNucleiProfile(PROFILE_TEXT), []);
    assert.deepEqual(checkTemplatesDockerfile(DOCKERFILE, DOCKERIGNORE), []);
  });
});

describe('checkTemplatesPin', () => {
  it('refuses a pin file that is not JSON', () => {
    assert.deepEqual(checkTemplatesPin('{'), ['tools.pin.json is not valid JSON']);
  });

  it('refuses a pin without the nuclei-templates entry', () => {
    const text = mutatePin((p) => {
      p.templates = [];
    });
    assert.ok(checkTemplatesPin(text).some((e) => e.includes('nuclei-templates entry')));
  });

  it('refuses a pin that does not name a full commit SHA', () => {
    const text = swap(PIN_TEXT, '79fb682760ab3d5b0e22afbb44709353cbebf023', 'main');
    assert.ok(
      checkTemplatesPin(text).some((e) => e.includes('commit must be a full 40-character SHA')),
    );
  });

  it('refuses a pin that drops an excluded intrusive category', () => {
    for (const category of EXCLUDED_CATEGORIES) {
      const text = mutatePin((p) => {
        const [entry] = p.templates;
        if (!entry) throw new Error('fixture has a templates entry');
        entry.exclude = entry.exclude.filter((c) => c !== category);
      });
      assert.ok(
        checkTemplatesPin(text).some((e) => e.includes(`must exclude ${category}`)),
        category,
      );
    }
  });
});

describe('checkNucleiProfile', () => {
  it('refuses a profile that is not YAML or not a mapping', () => {
    assert.ok(checkNucleiProfile('templates: [\n')[0]?.includes('not valid YAML'));
    assert.deepEqual(checkNucleiProfile('- a\n- b\n'), [
      `${NUCLEI_PROFILE}: must be a YAML mapping`,
    ]);
  });

  it('refuses runtime template updates or the update check left on', () => {
    assert.ok(
      checkNucleiProfile(
        swap(PROFILE_TEXT, 'update-templates: false', 'update-templates: true'),
      ).some((e) => e.includes('update-templates must be false')),
    );
    assert.ok(
      checkNucleiProfile(
        swap(PROFILE_TEXT, 'disable-update-check: true', 'disable-update-check: false'),
      ).some((e) => e.includes('disable-update-check must be true')),
    );
  });

  it('refuses out-of-band callbacks being enabled', () => {
    assert.ok(
      checkNucleiProfile(swap(PROFILE_TEXT, 'no-interactsh: true', 'no-interactsh: false')).some(
        (e) => e.includes('no-interactsh must be true'),
      ),
    );
  });

  it('refuses a severity above low', () => {
    assert.ok(
      checkNucleiProfile(swap(PROFILE_TEXT, '  - low\n', '  - low\n  - medium\n')).some((e) =>
        e.includes('severity medium is not allowed'),
      ),
    );
  });

  it('refuses a selected tag that is not on the safe allow-list', () => {
    assert.ok(
      checkNucleiProfile(swap(PROFILE_TEXT, '  - panel\n', '  - panel\n  - intrusive\n')).some(
        (e) => e.includes('tag intrusive is not a safe tag'),
      ),
    );
  });

  it('refuses a profile that stops excluding any intrusive tag', () => {
    for (const tag of INTRUSIVE_TAGS) {
      const text = swap(PROFILE_TEXT, `  - ${tag}\n`, '');
      assert.ok(
        checkNucleiProfile(text).some((e) => e.includes(`exclude-tags must exclude ${tag}`)),
        tag,
      );
    }
  });

  it('refuses code, DAST or headless modes being enabled', () => {
    for (const key of ['code', 'dast', 'headless']) {
      assert.ok(
        checkNucleiProfile(swap(PROFILE_TEXT, `${key}: false`, `${key}: true`)).some((e) =>
          e.includes(`${key} must be false`),
        ),
        key,
      );
    }
  });

  it('refuses an include list that could re-enable excluded templates', () => {
    assert.ok(
      checkNucleiProfile(`${PROFILE_TEXT}\ninclude-tags:\n  - rce\n`).some((e) =>
        e.includes('must not re-enable excluded templates'),
      ),
    );
  });

  it('refuses a profile that does not select both the pinned and the Blackwing directories', () => {
    assert.ok(
      checkNucleiProfile(swap(PROFILE_TEXT, '  - /opt/bw/templates/blackwing\n', '')).some((e) =>
        e.includes('templates must select /opt/bw/templates/blackwing'),
      ),
    );
    assert.ok(
      checkNucleiProfile(swap(PROFILE_TEXT, '  - /opt/bw/templates/official\n', '')).some((e) =>
        e.includes('templates must select /opt/bw/templates/official'),
      ),
    );
  });
});

describe('checkTemplatesDockerfile', () => {
  it('refuses an image that does not install the pinned templates at build time', () => {
    const text = swap(
      DOCKERFILE,
      'node /build/install-templates.mjs /pin/tools.pin.json /opt/bw/templates/official',
      'true',
    );
    assert.ok(
      checkTemplatesDockerfile(text, DOCKERIGNORE).some((e) =>
        e.includes('install the pinned templates'),
      ),
    );
  });

  it('refuses a runtime stage that does not install the default profile at /etc/bw/nuclei.yaml', () => {
    const text = swap(
      DOCKERFILE,
      'infra/docker/sandbox/templates/nuclei.yaml /etc/bw/nuclei.yaml',
      '',
    );
    assert.ok(
      checkTemplatesDockerfile(text, DOCKERIGNORE).some((e) => e.includes('default profile')),
    );
  });

  it('refuses a template tree the runtime user can rewrite', () => {
    const text = swap(
      DOCKERFILE,
      'chown -R bw:bw /etc/bw /workspace',
      'chown -R bw:bw /opt/bw/templates /etc/bw /workspace',
    );
    assert.ok(checkTemplatesDockerfile(text, DOCKERIGNORE).some((e) => e.includes('root-owned')));
  });

  it('refuses a build context that does not allow-list the template inputs', () => {
    const text = swap(DOCKERIGNORE, '!infra/docker/sandbox/templates/nuclei.yaml\n', '');
    assert.ok(
      checkTemplatesDockerfile(DOCKERFILE, text).some((e) =>
        e.includes('allow-list infra/docker/sandbox/templates/nuclei.yaml'),
      ),
    );
  });
});
