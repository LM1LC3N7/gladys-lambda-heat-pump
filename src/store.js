// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data/lambda.json (file
// mode 0600): the controller last configured (address, port, unit id), the
// time of the last read (a restart never reads sooner than the interval), the
// heating circuits held off (a stop is written again at start-up, before
// Gladys is even reached), and the floor setpoints not confirmed yet (written
// again by the next reads, 3 times at most, within 15 minutes). Nothing else:
// no other command is ever replayed after a restart.
//
// One write at a time (a queue). A file that cannot be read (permissions) is
// never taken for an empty one: nothing is written over it. A file that is
// not JSON is moved aside to `<name>.bad`, never overwritten.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODULE_COUNTS, TIMINGS, UNIT_ID } from './constants.js';

export const FILE_NAME = 'lambda.json';

export const emptyData = () => ({
  target: undefined,
  lastPollAt: undefined,
  holds: {},
  floors: {},
});

const HC_MAX = MODULE_COUNTS.heating_circuits.max;
const DHW_MAX = MODULE_COUNTS.hot_water_tanks.max;
/** A floor target: `dhw-<n>` or `hc-<n>` (module index from 0). */
export const isFloorTarget = (key) => {
  const match = /^(dhw|hc)-(\d{1,2})$/.exec(String(key));
  return Boolean(match) && Number(match[2]) < (match[1] === 'dhw' ? DHW_MAX : HC_MAX);
};
const finite = (value) => (Number.isFinite(value) ? value : undefined);

/** `now`: the wall clock, to refuse a date in the future (a clock set back). */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!data || typeof data !== 'object') {
    return base;
  }
  const t = data.target;
  if (
    t &&
    typeof t === 'object' &&
    typeof t.host === 'string' &&
    /^[a-z0-9.-]{1,253}$/.test(t.host) &&
    Number.isInteger(t.port) &&
    t.port > 0 &&
    t.port < 65536 &&
    Number.isInteger(t.unitId) &&
    t.unitId >= UNIT_ID.min &&
    t.unitId <= UNIT_ID.max
  ) {
    base.target = { host: t.host, port: t.port, unitId: t.unitId };
  }
  // The time of the last read (wall clock): a date in the future is invalid.
  const last = finite(data.lastPollAt);
  if (last !== undefined && last <= now) {
    base.lastPollAt = last;
  }
  if (data.holds && typeof data.holds === 'object') {
    for (const [key, hold] of Object.entries(data.holds).slice(0, HC_MAX)) {
      // A stop is kept whatever its date (it never ends by time); a date in
      // the future (a clock set back) only says since when it is held.
      if (/^\d{1,2}$/.test(key) && Number(key) < HC_MAX && hold && hold.mode === 'off') {
        const at = finite(hold.at);
        const from = hold.from;
        base.holds[key] = {
          mode: 'off',
          at: at !== undefined && at <= now ? at : now,
          ...(Number.isInteger(from) && from >= -1 && from <= 7 ? { from } : {}),
        };
      }
    }
  }
  if (data.floors && typeof data.floors === 'object') {
    for (const [key, floor] of Object.entries(data.floors).slice(0, HC_MAX + DHW_MAX)) {
      const at = finite(floor?.at);
      const sends = floor?.sends;
      // A date in the future is invalid; an expired floor is not written again.
      if (
        isFloorTarget(key) &&
        at !== undefined &&
        at <= now &&
        now - at < TIMINGS.floorExpiry &&
        Number.isInteger(sends) &&
        sends >= 0 &&
        sends < TIMINGS.floorResends
      ) {
        const from = floor.from;
        base.floors[key] = {
          at,
          sends,
          ...(Number.isInteger(from) && from >= 0 && from <= 0xffff ? { from } : {}),
        };
      }
    }
  }
  return base;
}

const serialize = (data) => JSON.stringify(data);

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = FILE_NAME, now = Date.now } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
    /** Not JSON: moved aside to `<name>.bad`. */
    this.corrupted = false;
    /** Not readable (permissions...): never written over. */
    this.unavailable = false;
    this.queue = Promise.resolve();
  }

  async load() {
    let content;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.unavailable = true;
      }
      return emptyData();
    }
    if (content.length > 64 * 1024) {
      this.unavailable = true;
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(content), this.now());
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  /** Queued: one write at a time, in order. Rejects when it failed. */
  save(data) {
    const json = serialize(data);
    const run = this.queue.then(async () => {
      if (this.unavailable) {
        throw new Error('/data unreadable: not written over');
      }
      await mkdir(this.dir, { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), { failSave = false, unavailable = false, now = Date.now } = {}) {
    this.data = JSON.parse(serialize(data));
    this.saves = 0;
    this.failSave = failSave;
    this.corrupted = false;
    this.unavailable = unavailable;
    this.now = now;
  }

  async load() {
    if (this.unavailable) {
      return emptyData();
    }
    return sanitize(JSON.parse(serialize(this.data)), this.now());
  }

  async save(data) {
    if (this.failSave || this.unavailable) {
      throw new Error('disk full');
    }
    this.data = JSON.parse(serialize(data));
    this.saves += 1;
  }
}
