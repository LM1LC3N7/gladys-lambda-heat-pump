// -----------------------------------------------------------------------------
// /data: what is kept (the controller, the stops held, the floors, the time
// of the last read), dates in the future refused, a file that cannot be read
// never written over, a file that is not JSON moved aside.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, emptyData, sanitize } from '../src/store.js';

const NOW = Date.UTC(2026, 9, 27, 12);

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'lambda-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('sanitize keeps the stops (whatever their date) and valid floors only', () => {
  const data = sanitize(
    {
      target: { host: '192.168.1.20', port: 502, unitId: 1 },
      lastPollAt: NOW + 1_000,
      holds: {
        0: { mode: 'off', at: NOW + 99_999 },
        1: { mode: 'summer' },
        12: { mode: 'off' },
        x: {},
      },
      floors: {
        'hc-0': { at: NOW - 1_000, sends: 1 },
        'dhw-0': { at: NOW + 1_000, sends: 0 },
        'hc-1': { at: NOW - 3_600_000, sends: 0 },
        'dhw-9': { at: NOW, sends: 0 },
        'hc-2': { at: NOW, sends: 3 },
      },
      __proto__: { polluted: true },
    },
    NOW,
  );
  assert.deepEqual(data.target, { host: '192.168.1.20', port: 502, unitId: 1 });
  assert.equal(data.lastPollAt, undefined, 'a date in the future is invalid');
  assert.deepEqual(data.holds, { 0: { mode: 'off', at: NOW } });
  assert.deepEqual(data.floors, { 'hc-0': { at: NOW - 1_000, sends: 1 } });
  assert.equal(sanitize({ target: { host: 'a b', port: 502, unitId: 1 } }, NOW).target, undefined);
  assert.equal({}.polluted, undefined);
});

test('a file that is not JSON is moved aside; a missing file is empty', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, now: () => NOW });
  assert.deepEqual(await store.load(), emptyData());
  await writeFile(join(path, 'lambda.json'), '{nope');
  assert.deepEqual(await store.load(), emptyData());
  assert.equal(store.corrupted, true);
  assert.deepEqual((await readdir(path)).sort(), ['lambda.json.bad']);
});

test('a file that cannot be read is never written over', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root reads everything');
    return;
  }
  const path = await dir(t);
  const file = join(path, 'lambda.json');
  await writeFile(file, JSON.stringify({ holds: { 0: { mode: 'off', at: NOW } } }));
  await chmod(file, 0o000);
  const store = new FileStore({ dir: path, now: () => NOW });
  await store.load();
  assert.equal(store.unavailable, true);
  await assert.rejects(store.save(emptyData()));
  await chmod(file, 0o600);
  assert.match(await readFile(file, 'utf8'), /off/);
});

test('saved with mode 0600, one write at a time', async (t) => {
  const path = await dir(t);
  const store = new FileStore({ dir: path, now: () => NOW });
  await Promise.all([1, 2, 3].map((n) => store.save({ ...emptyData(), lastPollAt: NOW - n })));
  const data = await store.load();
  assert.equal(data.lastPollAt, NOW - 3);
});
