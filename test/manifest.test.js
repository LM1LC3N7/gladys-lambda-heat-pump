// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, DHW_CAP, MODULE_COUNTS, POLL_INTERVAL, UNIT_ID } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('no config key starts with gladys_ (the core keeps those)', () => {
  for (const field of manifest.config_schema) {
    assert.doesNotMatch(field.key, /^gladys_/i, field.key);
  }
});

test('the store basics; the four versions agree, never pinned in the test', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-lambda-heat-pump');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-lambda-heat-pump:${manifest.version}`,
  );
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-lambda-heat-pump/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['climate', 'energy']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    const flat = docs.replace(/\n>\s*/g, ' ');
    assert.match(flat, /not\s+affiliated\s+with\s+Lambda|sans\s+lien\s+avec\s+Lambda/i);
    assert.match(
      flat,
      /never\s+been\s+tested\s+with\s+a\s+real\s+device|jamais\s+été\s+testée?\s+avec\s+un\s+vrai\s+appareil/i,
      'say it was never tested',
    );
    assert.match(docs, /trusted\s+network|réseau\s+de\s+confiance/i, 'say Modbus has no password');
    assert.match(docs, /55\s*°C/, 'document the hot water ceiling');
  }
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real device/);
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai appareil/);
  assert.match(read('README.md'), /never been tested with a real device/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('no capture, no sub-container, no keywords nor countries', () => {
  for (const key of ['network_discovery', 'network_wake', 'containers', 'keywords', 'countries']) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the configuration matches the code; the commands are off; the ceiling bounded', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  assert.equal(fields.allow_commands.type, 'boolean');
  assert.equal(fields.allow_commands.default, false);
  const range = (f) => [f.min, f.max, f.default];
  assert.deepEqual(range(fields.dhw_max_temperature), [DHW_CAP.min, DHW_CAP.max, DHW_CAP.default]);
  assert.equal(DHW_CAP.max, 60);
  assert.equal(DHW_CAP.default, 55);
  assert.deepEqual(range(fields.poll_interval), [
    POLL_INTERVAL.min,
    POLL_INTERVAL.max,
    POLL_INTERVAL.default,
  ]);
  assert.deepEqual(range(fields.unit_id), [UNIT_ID.min, UNIT_ID.max, UNIT_ID.default]);
  for (const [key, limits] of Object.entries(MODULE_COUNTS)) {
    assert.deepEqual(range(fields[key]), [limits.min, limits.max, limits.default], key);
  }
  assert.equal(manifest.config_schema.filter((f) => f.type === 'secret').length, 0);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds <= 60, action.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the image ships the license and the third-party notices; LICENSE names nobody', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /lambda_heat_pumps/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) 2024 Your Name/);
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'no personal name');
});
