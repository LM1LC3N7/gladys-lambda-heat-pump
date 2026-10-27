// -----------------------------------------------------------------------------
// Review r2: the stop lets go only on proof (a documented other mode, neither
// ours nor the one before ours, read twice in a row); a floor in doubt is
// written again; every refusal republishes the value read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, command, createDevice, id, setup, sleep, waitFor } from './helpers/setup.js';

const writesTo = (lambda, address) =>
  lambda
    .writes()
    .filter((r) => r.address === address)
    .map((r) => r.values[0]);

async function heldOff(t, options = {}) {
  const env = await setup(t, options);
  const hc = await createDevice(env.gladys, 'hc-1');
  assert.deepEqual(await command(env.gladys, hc, 'mode', 'off'), { success: true });
  return { ...env, hc };
}

for (const [label, word] of [
  ['-1 (lapsed)', 0xffff],
  ['1 manual (read only)', 1],
  ['7 screed (read only)', 7],
  ['9 unknown', 9],
  ['0x7fff unknown', 0x7fff],
  ['-3000 sentinel', 0x10000 - 3000],
  ['0x8000 not available', 0x8000],
]) {
  test(`the stop is written again over ${label}, never let go`, async (t) => {
    const { testClock } = await import('./kit/clock.mjs');
    const clock = testClock();
    const { lambda, app } = await heldOff(t, { clock });
    lambda.regs.set(5006, word);
    await advance(clock, 21_000);
    await waitFor(() => lambda.regs.get(5006) === 0, 'written again');
    assert.equal(app.holds.get(0).key, 'off');
  });
}

test('a failed read before the refresh: the stop is written all the same', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { lambda, app } = await heldOff(t, { clock });
  lambda.regs.set(5006, 0xffff);
  lambda.illegal.add(5006);
  lambda.silent = undefined;
  // Reads of 5006 refused, writes too (illegal): then reads refused, writes allowed.
  lambda.illegal.delete(5006);
  lambda.silent = (r) => r.fn === 3 && r.address === 5006 && r.count === 1;
  await advance(clock, 21_000);
  await clock.advance(3_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'written');
  assert.ok(app.holds.has(0));
});

test('another mode read twice in a row lets go; nothing written in between', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { lambda, app, gladys } = await heldOff(t, { clock });
  lambda.regs.set(5006, 2);
  const count = writesTo(lambda, 5006).length;
  await advance(clock, 20_000);
  await waitFor(() => lambda.reads().filter((r) => r.address === 5006).length >= 1, 'read');
  await advance(clock, 3_000);
  await waitFor(() => app.holds.size === 0, 'let go');
  assert.equal(writesTo(lambda, 5006).length, count);
  assert.equal(lambda.regs.get(5006), 2);
  assert.match(gladys.fake.connectionStatus.message.en, /mode changed elsewhere/);
});

test('another mode seen once, then gone: the stop is kept and written', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { lambda, app } = await heldOff(t, { clock });
  lambda.regs.set(5006, 2);
  const reads = lambda.reads().length;
  await advance(clock, 20_000);
  await waitFor(() => lambda.reads().length > reads, 'the first read');
  await sleep(10);
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 3_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'written again');
  assert.ok(app.holds.has(0));
});

test('s16: a stop acknowledged but not applied (the mode before still read) is written again', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.regs.set(5006, 2);
  await advance(clock, 30_000);
  await sleep(10);
  lambda.ignoreWrites = true;
  const ack = await command(gladys, hc, 'mode', 'off');
  assert.equal(ack.success, false);
  assert.equal(app.holds.get(0).from, 2);
  for (let i = 0; i < 3; i += 1) {
    await advance(clock, 20_000);
    await sleep(10);
  }
  assert.ok(app.holds.has(0), 'never taken for a change made elsewhere');
  assert.match(gladys.fake.connectionStatus.message.en, /does not apply the stop/);
  lambda.ignoreWrites = false;
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'applied at last');
});

test('a floor asked while the heat pump is silent is written again when it answers', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.silent = () => true;
  await advance(clock, 30_000);
  await clock.advance(3_000);
  await waitFor(() => app.online === false, 'offline');
  const ack = command(gladys, hc, 'room-setpoint', 15);
  await sleep(10);
  await clock.advance(3_000);
  await sleep(10);
  await clock.advance(3_000);
  assert.equal((await ack).success, false);
  assert.equal(store.data.floors['hc-0'].from, undefined);
  lambda.silent = undefined;
  await advance(clock, 60_000);
  await waitFor(() => lambda.regs.get(5051) === 150, 'the floor written once back');
});

test('a refusal before the queue republishes the value read (option off, ceiling, bad value)', async (t) => {
  const { gladys, lambda } = await setup(t);
  const hc = await createDevice(gladys, 'hc-1');
  const dhw = await createDevice(gladys, 'dhw-1');
  for (const [device, role, value, feature, shown] of [
    [hc, 'room-setpoint', 23, id('hc-1', 'room-setpoint'), 21],
    [dhw, 'setpoint', 58, id('dhw-1', 'setpoint'), 50],
    [hc, 'mode', 'summer', id('hc-1', 'mode'), 'release'],
  ]) {
    const before = gladys.fake.states.length;
    assert.equal((await command(gladys, device, role, value)).success, false);
    await waitFor(
      () =>
        gladys.fake.states
          .slice(before)
          .some((s) => s.device_feature_external_id === feature && (s.state ?? s.text) === shown),
      `${role} republished`,
    );
  }
  assert.equal(lambda.writes().length, 0);
});

test('another address lets the hold go; the hold notes show offline too', async (t) => {
  const { testClock } = await import('./kit/clock.mjs');
  const clock = testClock();
  const { lambda, app, gladys } = await heldOff(t, { clock });
  lambda.silent = () => true;
  await advance(clock, 30_000);
  await clock.advance(3_000);
  await waitFor(() => app.online === false, 'offline');
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable.*held off by Gladys since/);
  lambda.silent = undefined;
  await app.configUpdated({ address: '127.0.0.1:1' });
  assert.equal(app.holds.size, 0);
});
