// -----------------------------------------------------------------------------
// The commands. Protective (the stop of a heating circuit, a setpoint at its
// floor): never refused by the option, a read, a command, the configuration;
// sent at once, cut a frozen read, held or kept in /data, written again.
// Sensitive (the other modes and setpoints): off by default, decided on a
// fresh read, bounded, replaced by a stop, success only after the read back.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LambdaApp } from '../src/app.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { defaultRegisters, fakeLambda } from './fixtures/fakeLambda.js';
import {
  SELECTOR,
  advance,
  command,
  createDevice,
  memoryLogger,
  setup,
  sleep,
  state,
  waitFor,
} from './helpers/setup.js';

const ALLOW = { allow_commands: true };
const writesTo = (lambda, address) =>
  lambda
    .writes()
    .filter((r) => r.address === address)
    .map((r) => r.values[0]);

test('the stop of a circuit: option off, written at once (no read before), read back, held', async (t) => {
  const { gladys, lambda, store, app } = await setup(t);
  const hc = await createDevice(gladys, 'hc-1');
  const before = lambda.log.length;
  assert.deepEqual(await command(gladys, hc, 'mode', 'off'), { success: true });
  const sent = lambda.log.slice(before).map((r) => [r.fn, r.address]);
  assert.deepEqual(sent, [
    [16, 5006],
    [3, 5006],
  ]);
  assert.equal(lambda.regs.get(5006), 0);
  assert.deepEqual(store.data.holds, { 0: { mode: 'off', at: store.data.holds[0].at } });
  assert.match(gladys.fake.connectionStatus.message.en, /held off by Gladys: 1/);
  assert.equal(app.config.allowCommands, false);
});

test('the held stop is written again every 20 s, before anything else', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'the stop written again');
  await advance(clock, 40_000);
  assert.ok(writesTo(lambda, 5006).length >= 4, `${writesTo(lambda, 5006)}`);
  assert.ok(writesTo(lambda, 5006).every((v) => v === 0));
});

test('the stop cuts a read frozen for 1 s; the read cut is not a failure', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.silent = (r) => r.fn === 3 && r.address === 2000;
  await advance(clock, 30_000);
  await waitFor(() => lambda.reads().at(-1)?.address === 2000, 'the frozen read');
  lambda.silent = undefined;
  const ack = command(gladys, hc, 'mode', 'off');
  await sleep(10);
  assert.equal(writesTo(lambda, 5006).length, 0);
  await clock.advance(1_000);
  assert.deepEqual(await ack, { success: true });
  assert.equal(lambda.regs.get(5006), 0);
  assert.equal(lambda.peak, 1, 'never two connections at once');
  assert.equal(app.online, true);
  assert.equal(app.failures, 0);
});

test('the stop leaves at start-up from /data, before the configuration is read', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  const store = new MemoryStore({
    ...emptyData(),
    target: { host: '127.0.0.1', port: lambda.port, unitId: 1 },
    holds: { 0: { mode: 'off', at: clock.now() - 1_000 } },
  });
  const gladys = createFakeGladys({ selector: SELECTOR, config: {} });
  const app = new LambdaApp({
    gladys,
    logger: memoryLogger(),
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(() => app.stop());
  // Gladys never reached, no configuration.
  await app.boot();
  await clock.advance(0);
  await waitFor(() => lambda.regs.get(5006) === 0, 'the stop written');
  assert.deepEqual(
    lambda.log.map((r) => r.fn),
    [16],
    'no read before',
  );
  // getConfig() failing: the stop keeps going.
  lambda.regs.set(5006, 0xffff);
  await app.configUnread();
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'written again');
});

test('the stop goes out when /data cannot be written (said in the status)', async (t) => {
  const { gladys, lambda } = await setup(t, {
    store: new MemoryStore(emptyData(), { failSave: true }),
  });
  const hc = await createDevice(gladys, 'hc-1');
  assert.deepEqual(await command(gladys, hc, 'mode', 'off'), { success: true });
  assert.equal(lambda.regs.get(5006), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /\/data cannot be read or written/);
});

test('the stop not applied: not a success, held and written again', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { lambda: { ignoreWrites: true }, clock });
  const hc = await createDevice(gladys, 'hc-1');
  const ack = await command(gladys, hc, 'mode', 'off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /relit|reads back/);
  assert.match(ack.error, /20 s/);
  await advance(clock, 20_000);
  await waitFor(() => writesTo(lambda, 5006).length === 2, 'written again');
});

test('nothing queued before a stop leaves after it', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { config: ALLOW, clock });
  const hc = await createDevice(gladys, 'hc-1');
  // The fresh read of the sensitive command hangs; the stop arrives meanwhile.
  lambda.silent = (r) => r.fn === 3 && r.address === 5006;
  const summer = command(gladys, hc, 'mode', 'summer');
  await waitFor(() => lambda.reads().at(-1)?.address === 5006, 'the fresh read');
  lambda.silent = undefined;
  const stop = command(gladys, hc, 'mode', 'off');
  await clock.advance(1_000);
  assert.deepEqual(await stop, { success: true });
  await advance(clock, 12_000);
  const ack = await summer;
  assert.ok(ack.success === false || ack.success === true);
  assert.ok(writesTo(lambda, 5006).length >= 1);
  assert.ok(
    writesTo(lambda, 5006).every((v) => v === 0),
    `never the summer mode: ${writesTo(lambda, 5006)}`,
  );
  assert.equal(lambda.regs.get(5006), 0);
});

test('a sensitive mode: refused while the option is off, nothing sent', async (t) => {
  const { gladys, lambda } = await setup(t);
  const hc = await createDevice(gladys, 'hc-1');
  const ack = await command(gladys, hc, 'mode', 'summer');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser les commandes/);
  assert.equal(lambda.writes().length, 0);
  for (const bad of ['manual', 'screed', 'SUMMER', '', null, 6]) {
    const refused = await command(gladys, hc, 'mode', bad);
    assert.equal(refused.success, false, String(bad));
  }
});

test('a sensitive mode: fresh read, write, read back; held while allowed; replaces a stop once sent', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { config: ALLOW, clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  const before = lambda.log.length;
  assert.deepEqual(await command(gladys, hc, 'mode', 'automatic'), { success: true });
  assert.deepEqual(
    lambda.log.slice(before).map((r) => [r.fn, r.address, r.values?.[0]]),
    [
      [3, 5006, undefined],
      [16, 5006, 2],
      [3, 5006, undefined],
    ],
  );
  assert.deepEqual(store.data.holds, {});
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 2, 'the request written again');
  // The option turned off: no longer written, the request lapses.
  await app.configUpdated({ address: lambda.address });
  lambda.regs.set(5006, 0xffff);
  const count = lambda.writes().length;
  await advance(clock, 40_000);
  assert.equal(lambda.writes().length, count);
});

test('a mode refused by the controller keeps the stop held', async (t) => {
  const clock = testClock();
  const { gladys, lambda, store } = await setup(t, { config: ALLOW, clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  lambda.writeException = (r) => (r.values[0] === 3 ? 3 : undefined);
  const ack = await command(gladys, hc, 'mode', 'auto-heating');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Refusé|Refused/);
  assert.equal(store.data.holds[0].mode, 'off');
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'the stop written again');
});

test('release: allowed only with the option, nothing written, the stop no longer repeated', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  assert.equal((await command(gladys, hc, 'mode', 'release')).success, false);
  await app.configUpdated({ address: lambda.address, ...ALLOW });
  const count = lambda.writes().length;
  assert.deepEqual(await command(gladys, hc, 'mode', 'release'), { success: true });
  assert.equal(lambda.writes().length, count);
  assert.deepEqual(store.data.holds, {});
  await advance(clock, 40_000);
  assert.equal(lambda.writes().length, count);
});

test('hot water: never above the configured ceiling nor 60 °C, whole degrees', async (t) => {
  const { gladys, lambda, app } = await setup(t, { config: ALLOW });
  const dhw = await createDevice(gladys, 'dhw-1');
  for (const bad of [56, 61, 65, 52.5, '', null, 'abc', '1e2', 24]) {
    assert.equal((await command(gladys, dhw, 'setpoint', bad)).success, false, String(bad));
  }
  assert.deepEqual(writesTo(lambda, 2050), []);
  assert.deepEqual(await command(gladys, dhw, 'setpoint', 52), { success: true });
  assert.equal(lambda.regs.get(2050), 520);
  await app.configUpdated({ address: lambda.address, ...ALLOW, dhw_max_temperature: 99 });
  assert.equal(app.config.dhwCap, 60);
  assert.deepEqual(await command(gladys, dhw, 'setpoint', 60), { success: true });
  assert.equal((await command(gladys, dhw, 'setpoint', 61)).success, false);
  assert.equal(Math.max(...writesTo(lambda, 2050)), 600);
});

test('hot water: a ceiling lowered while the command waits stops it before the bytes', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { config: ALLOW, clock });
  const dhw = await createDevice(gladys, 'dhw-1');
  lambda.latencyMs = 40;
  const ack = command(gladys, dhw, 'setpoint', 55);
  await waitFor(() => lambda.reads().at(-1)?.address === 2050, 'the fresh read');
  await app.configUpdated({ address: lambda.address, ...ALLOW, dhw_max_temperature: 50 });
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /50 °C/);
  assert.deepEqual(writesTo(lambda, 2050), []);
});

test('hot water at its floor (25 °C) is protective: sent with the option off', async (t) => {
  const { gladys, lambda } = await setup(t);
  const dhw = await createDevice(gladys, 'dhw-1');
  assert.deepEqual(await command(gladys, dhw, 'setpoint', 25), { success: true });
  assert.equal(lambda.regs.get(2050), 250);
});

test('a floor not confirmed is written again by the next 3 reads, then given up', async (t) => {
  const clock = testClock();
  const { gladys, lambda, store } = await setup(t, { lambda: { ignoreWrites: true }, clock });
  const hc = await createDevice(gladys, 'hc-1');
  const ack = await command(gladys, hc, 'room-setpoint', 15);
  assert.equal(ack.success, false);
  assert.match(ack.error, /prochaines lectures|next reads/);
  assert.equal(store.data.floors['hc-0'].sends, 0);
  for (let i = 0; i < 5; i += 1) {
    await advance(clock, 30_000);
    await sleep(20);
  }
  assert.deepEqual(writesTo(lambda, 5051), [150, 150, 150, 150]);
  assert.deepEqual(store.data.floors, {});
});

test('a room setpoint: tenths, 15 to 40 °C, success only once read back', async (t) => {
  const { gladys, lambda } = await setup(t, { config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  for (const bad of [14.9, 40.1, 21.55, 'x']) {
    assert.equal((await command(gladys, hc, 'room-setpoint', bad)).success, false, String(bad));
  }
  assert.deepEqual(await command(gladys, hc, 'room-setpoint', 21.5), { success: true });
  assert.equal(lambda.regs.get(5051), 215);
  // Already so: nothing sent.
  const count = lambda.writes().length;
  assert.deepEqual(await command(gladys, hc, 'room-setpoint', '21.5'), { success: true });
  assert.equal(lambda.writes().length, count);
});

test('the previous value read back is "not applied yet", never a success', async (t) => {
  const { gladys } = await setup(t, { config: ALLOW, lambda: { applyAfterMs: 200 } });
  const hc = await createDevice(gladys, 'hc-1');
  const ack = await command(gladys, hc, 'room-setpoint', 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliqué|not applied yet/);
});

test('a write without its answer is "sent, without confirmation"; the next one is sent again', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { config: ALLOW, clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.silent = (r) => r.fn === 16;
  const pending = command(gladys, hc, 'room-setpoint', 22);
  await waitFor(() => lambda.writes().length === 1, 'the write');
  await clock.advance(3_000);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation|without confirmation/);
  lambda.silent = undefined;
  await advance(clock, 25_000);
  // The guard: the same value is written again, never answered "already so".
  lambda.regs.set(5051, 210);
  assert.deepEqual(await command(gladys, hc, 'room-setpoint', 22), { success: true });
  assert.deepEqual(writesTo(lambda, 5051), [220, 220]);
});

test('a command while another one of the same module runs is refused; other modules go on', async (t) => {
  const { gladys, lambda } = await setup(t, { config: ALLOW, lambda: { latencyMs: 30 } });
  const hc = await createDevice(gladys, 'hc-1');
  const dhw = await createDevice(gladys, 'dhw-1');
  const [a, b, c] = await Promise.all([
    command(gladys, hc, 'room-setpoint', 22),
    command(gladys, hc, 'room-setpoint', 23),
    command(gladys, dhw, 'setpoint', 45),
  ]);
  assert.deepEqual(a, { success: true });
  assert.equal(b.success, false);
  assert.deepEqual(c, { success: true });
  assert.equal(lambda.regs.get(2050), 450);
});

test('state of the select follows the request read; manual and screed never shown as an option', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock });
  await createDevice(gladys, 'hc-1');
  lambda.regs.set(5006, 6);
  await advance(clock, 30_000);
  await waitFor(() => state(gladys, 'hc-1', 'mode') === 'summer', 'summer shown');
  lambda.regs.set(5006, 7);
  await advance(clock, 30_000);
  await sleep(20);
  assert.equal(state(gladys, 'hc-1', 'mode'), 'summer');
});

test('a circuit whose write is refused does not stop the others', async (t) => {
  const regs = defaultRegisters();
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
    regs.set(5100 + at, v);
  }
  const { gladys, lambda } = await setup(t, {
    config: { ...ALLOW, heating_circuits: 2 },
    lambda: { regs, writeException: (r) => (r.address === 5051 ? 4 : undefined) },
  });
  const hc1 = await createDevice(gladys, 'hc-1');
  const hc2 = await createDevice(gladys, 'hc-2');
  const [a, b, c] = await Promise.all([
    command(gladys, hc1, 'room-setpoint', 22),
    command(gladys, hc2, 'room-setpoint', 23),
    command(gladys, hc2, 'mode', 'off'),
  ]);
  assert.equal(a.success, false);
  assert.ok(b.success === true || /arrêt|stop/i.test(b.error), JSON.stringify(b));
  assert.deepEqual(c, { success: true });
  assert.equal(lambda.regs.get(5106), 0);
});
