// -----------------------------------------------------------------------------
// On the REAL clock (sped up), against the fake controller on the loopback:
// the reads start at the interval, the stop held is written again every
// 20 s, and a scene setting five slow heating circuits sets them all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LambdaApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { fakeLambda } from './fixtures/fakeLambda.js';
import { SELECTOR, createDevice, featureOf, memoryLogger, waitFor } from './helpers/setup.js';

async function realSetup(t, { speed, lambda: options = {}, config = {} }) {
  const lambda = await fakeLambda(options);
  t.after(() => lambda.close());
  const clock = realClock({ speed });
  t.after(() => clock.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { address: lambda.address, ...config },
  });
  const logger = memoryLogger();
  const app = new LambdaApp({
    gladys,
    logger,
    store: new MemoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  return { lambda, clock, gladys, app, logger };
}

test('real clock x20: a read every 30 s, never sooner; timers bounded', async (t) => {
  const { clock, gladys, app } = await realSetup(t, { speed: 20 });
  const spy = spyOn(app, 'poll', clock);
  await gladys.connect();
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.ok(clock.timersSet < 80, `${clock.timersSet} timers`);
});

test('real clock x20: the stop held is written again every 20 s', async (t) => {
  const { clock, gladys, app, lambda } = await realSetup(t, { speed: 20 });
  await gladys.connect();
  const hc = await createDevice(gladys, 'hc-1');
  const spy = spyOn(app, 'refreshHolds', clock);
  assert.deepEqual(await gladys.fake.setValue(hc, featureOf(hc, 'mode'), 'off'), {
    success: true,
  });
  await measurePeriod(spy, { count: 3, period: 20_000 });
  const writes = lambda.writes().filter((r) => r.address === 5006);
  assert.ok(writes.length >= 3);
  assert.ok(writes.every((r) => r.values[0] === 0));
});

test('real clock x4: a scene on five slow heating circuits (600 ms a request) sets them all', async (t) => {
  const { gladys, lambda, logger } = await realSetup(t, {
    speed: 4,
    lambda: { latencyMs: 150 },
    config: { heating_circuits: 5, allow_commands: true },
  });
  for (let i = 1; i < 5; i += 1) {
    for (const [at, v] of [
      [0, 0],
      [1, 0],
      [2, 340],
      [3, 295],
      [4, 213],
      [5, 0],
      [6, 0xffff],
      [7, 345],
      [50, 0],
      [51, 210],
      [52, 240],
    ]) {
      lambda.regs.set(5000 + 100 * i + at, v);
    }
  }
  await gladys.connect();
  const devices = [];
  for (let n = 1; n <= 5; n += 1) {
    devices.push(await createDevice(gladys, `hc-${n}`));
  }
  const acks = await Promise.all(
    devices.map((d, i) => gladys.fake.setValue(d, featureOf(d, 'room-setpoint'), 22 + i)),
  );
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
  await waitFor(
    () => [0, 1, 2, 3, 4].every((i) => lambda.regs.get(5051 + 100 * i) === 220 + 10 * i),
    'the five setpoints',
    15_000,
  );
  assert.ok(!logger.lines.some((l) => /Rien envoyé|Nothing sent/.test(l)), logger.lines.join('\n'));
  assert.equal(lambda.glued, 0);
});
