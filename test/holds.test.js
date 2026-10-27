// -----------------------------------------------------------------------------
// Review r1: the stop leaves with the controller kept in /data while the
// configuration cannot be read; a held mode lets go (changed elsewhere, 24 h,
// circuit removed, address cleared, device deleted); floors yield to newer
// commands and to the panel; the value read is republished after a command
// not confirmed; the protections that relaunch the heating each have a test.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LambdaApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { HOUR } from '../src/constants.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { fakeLambda } from './fixtures/fakeLambda.js';
import {
  SELECTOR,
  advance,
  command,
  createDevice,
  id,
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

test('B1: the controller kept in /data, getConfig() failing: a stop leaves at once', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  const store = new MemoryStore({
    ...emptyData(),
    target: { host: '127.0.0.1', port: lambda.port, unitId: 1 },
  });
  const gladys = createFakeGladys({ selector: SELECTOR, config: { address: lambda.address } });
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls > 1) throw new Error('busy');
    return {};
  };
  const logger = memoryLogger();
  const app = new LambdaApp({
    gladys,
    logger,
    store,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await app.boot();
  await gladys.connect();
  await waitFor(() => calls >= 2, 'our getConfig() failing');
  assert.match(gladys.fake.connectionStatus.message.en, /could not be read/);
  const device = { external_id: id('hc-1'), features: [] };
  const feature = { external_id: id('hc-1', 'mode') };
  const ack = await gladys.fake.setValue(device, feature, 'off');
  assert.deepEqual(ack, { success: true });
  assert.equal(lambda.regs.get(5006), 0);
  assert.equal(store.data.holds[0].mode, 'off');
  // Still no configuration: written again, and the status says it is held.
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'written again');
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /Heating circuit 1 held off by Gladys since 20\d\d-\d\d-\d\d \d\d:\d\d UTC/,
  );
});

test('I1: a mode asked elsewhere after the stop ends the hold; -1 (lapsed) does not', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 20_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'a lapsed request written again');
  // The panel or another client asks for "automatic".
  lambda.regs.set(5006, 2);
  const count = writesTo(lambda, 5006).length;
  await advance(clock, 40_000);
  await sleep(10);
  assert.equal(writesTo(lambda, 5006).length, count, 'never written over');
  assert.equal(lambda.regs.get(5006), 2);
  assert.equal(app.holds.size, 0);
  assert.deepEqual(store.data.holds, {});
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /no longer held by Gladys \(mode changed elsewhere\)/,
  );
});

test('r2: a stop never ends by time; another mode held ends after 24 h (monotonic)', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  app.holds.get(0).since -= 48 * HOUR;
  app.holds.get(0).sinceMono -= 48 * HOUR;
  lambda.regs.set(5006, 0xffff);
  await advance(clock, 21_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'the stop written again');
  assert.equal(app.holds.get(0).key, 'off');
  assert.deepEqual(await command(gladys, hc, 'mode', 'summer'), { success: true });
  app.holds.get(0).sinceMono -= 24 * HOUR;
  const count = writesTo(lambda, 5006).length;
  await advance(clock, 40_000);
  assert.equal(writesTo(lambda, 5006).length, count);
  assert.equal(app.holds.size, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /the controller takes over/);
});

test('I1: the hold ends when the circuit leaves the configuration, the address is cleared, or the device is deleted', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { clock, config: { heating_circuits: 2 } });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  // Circuit 2 is not on this fake: its stop is held all the same.
  await gladys.fake.setValue(
    { external_id: id('hc-2'), features: [] },
    { external_id: id('hc-2', 'mode') },
    'off',
  );
  assert.equal(app.holds.size, 2);
  await app.configUpdated({ address: lambda.address, heating_circuits: 1 });
  assert.deepEqual([...app.holds.keys()], [0]);
  await gladys.fake.deviceDeleted(hc);
  assert.equal(app.holds.size, 0);
  await command(gladys, hc, 'mode', 'off');
  await app.configUpdated({ address: '' });
  assert.equal(app.holds.size, 0);
  assert.deepEqual(store.data.holds, {});
  assert.equal(store.data.target, undefined);
  lambda.regs.set(5006, 0xffff);
  const count = lambda.writes().length;
  await advance(clock, 40_000);
  assert.equal(lambda.writes().length, count, 'nothing written to the old controller');
});

test('I2: a newer command for the value shown is written while a floor lives, never undone', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.ignoreWrites = true;
  assert.equal((await command(gladys, hc, 'room-setpoint', 15)).success, false);
  lambda.ignoreWrites = false;
  assert.deepEqual(await command(gladys, hc, 'room-setpoint', 21), { success: true });
  assert.deepEqual(writesTo(lambda, 5051), [150, 210]);
  await advance(clock, 60_000);
  assert.equal(lambda.regs.get(5051), 210);
  assert.deepEqual(writesTo(lambda, 5051), [150, 210]);
});

test('I2: a setpoint changed at the panel after a floor is left alone', async (t) => {
  const clock = testClock();
  const { gladys, lambda, store } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.ignoreWrites = true;
  assert.equal((await command(gladys, hc, 'room-setpoint', 15)).success, false);
  assert.equal(store.data.floors['hc-0'].from, 210);
  lambda.ignoreWrites = false;
  lambda.regs.set(5051, 230);
  await advance(clock, 60_000);
  assert.equal(lambda.regs.get(5051), 230);
  assert.deepEqual(store.data.floors, {});
});

test('I2: a floor not applied is still written by the next read when nothing changed', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.ignoreWrites = true;
  await command(gladys, hc, 'room-setpoint', 15);
  lambda.ignoreWrites = false;
  await advance(clock, 30_000);
  await waitFor(() => lambda.regs.get(5051) === 150, 'the floor written again');
});

test('I2: a newer setpoint refused by the controller gives the floor back', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.ignoreWrites = true;
  await command(gladys, hc, 'room-setpoint', 15);
  lambda.ignoreWrites = false;
  lambda.writeException = (r) => (r.values[0] === 220 ? 3 : undefined);
  assert.equal((await command(gladys, hc, 'room-setpoint', 22)).success, false);
  assert.ok(app.floors.has('hc-0'));
  lambda.writeException = undefined;
  await advance(clock, 30_000);
  await waitFor(() => lambda.regs.get(5051) === 150, 'the floor written again');
});

test('I3: after a command not applied, the value read is published again', async (t) => {
  const { gladys, lambda } = await setup(t, { config: ALLOW, lambda: { ignoreWrites: true } });
  const hc = await createDevice(gladys, 'hc-1');
  const before = gladys.fake.states.length;
  const ack = await command(gladys, hc, 'room-setpoint', 23);
  assert.equal(ack.success, false);
  await waitFor(
    () =>
      gladys.fake.states
        .slice(before)
        .some(
          (s) => s.device_feature_external_id === id('hc-1', 'room-setpoint') && s.state === 21,
        ),
    'the real value republished',
  );
  assert.equal(state(gladys, 'hc-1', 'room-setpoint'), 21);
  assert.equal(lambda.regs.get(5051), 210);
});

test('M10: a mode already queued for its write never leaves after a stop', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  const dhw = await createDevice(gladys, 'dhw-1');
  lambda.latencyMs = 60;
  const d = command(gladys, dhw, 'setpoint', 52);
  const summer = command(gladys, hc, 'mode', 'summer');
  // The hot water write is on the wire, the summer write queued behind it.
  await waitFor(() => writesTo(lambda, 2050).length === 1, 'the hot water write');
  const stop = await command(gladys, hc, 'mode', 'off');
  assert.deepEqual(stop, { success: true });
  const [ad, as] = await Promise.all([d, summer]);
  assert.deepEqual(ad, { success: true });
  assert.equal(as.success, false);
  await sleep(100);
  assert.deepEqual(writesTo(lambda, 5006), [0]);
});

test('M25: hot water above 25 °C is never sent without the option', async (t) => {
  const { gladys, lambda } = await setup(t);
  const dhw = await createDevice(gladys, 'dhw-1');
  for (const value of [26, 40, 50]) {
    const ack = await command(gladys, dhw, 'setpoint', value);
    assert.equal(ack.success, false, String(value));
    assert.match(ack.error, /Autoriser les commandes/);
  }
  assert.deepEqual(writesTo(lambda, 2050), []);
});

test('M35: "no request" refused without the option, the stop kept', async (t) => {
  const { gladys, app, store } = await setup(t);
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  const ack = await command(gladys, hc, 'mode', 'release');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser les commandes/);
  assert.equal(app.holds.get(0).key, 'off');
  assert.equal(store.data.holds[0].mode, 'off');
});

test('M14: the option turned off during the fresh read stops the command before the bytes', async (t) => {
  const { gladys, lambda, app } = await setup(t, { config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.latencyMs = 40;
  const ack = command(gladys, hc, 'room-setpoint', 22);
  await waitFor(() => lambda.reads().at(-1)?.address === 5051, 'the fresh read');
  await app.configUpdated({ address: lambda.address });
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /Autoriser les commandes/);
  assert.deepEqual(writesTo(lambda, 5051), []);
});

test('M13: the option turned off while a held mode is being refreshed: not written', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  assert.deepEqual(await command(gladys, hc, 'mode', 'summer'), { success: true });
  const count = writesTo(lambda, 5006).length;
  lambda.latencyMs = 40;
  const reads = lambda.reads().length;
  await clock.advance(20_000);
  await waitFor(() => lambda.reads().length > reads, 'the refresh read');
  await app.configUpdated({ address: lambda.address });
  await sleep(150);
  assert.equal(writesTo(lambda, 5006).length, count);
});

test('M27: a current value that cannot be read sends nothing', async (t) => {
  const { gladys, lambda } = await setup(t, { config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.regs.set(5051, 0x8000);
  const ack = await command(gladys, hc, 'room-setpoint', 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Rien envoyé/);
  assert.deepEqual(writesTo(lambda, 5051), []);
});

test('M22: the ack comes by 3.4 s even when the command waits behind others', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock, config: ALLOW });
  const hc = await createDevice(gladys, 'hc-1');
  const dhw = await createDevice(gladys, 'dhw-1');
  lambda.silent = () => true;
  const first = command(gladys, dhw, 'setpoint', 45);
  await waitFor(() => lambda.reads().at(-1)?.address === 2050, 'the first fresh read');
  const second = command(gladys, hc, 'room-setpoint', 22);
  await clock.advance(3_000);
  await sleep(10);
  await clock.advance(450);
  const ack = await Promise.race([second, sleep(500).then(() => 'late')]);
  assert.deepEqual(ack, { success: true }, 'acked as accepted at 3.4 s');
  lambda.silent = undefined;
  await first;
});

test('M11: a stop not sent (connection failing) is tried again once, 250 ms later', async (t) => {
  let fail = false;
  const socket = (options) => {
    if (fail) {
      fail = false;
      const s = new net.Socket();
      setImmediate(() => s.destroy(new Error('ECONNREFUSED')));
      return s;
    }
    return net.createConnection(options);
  };
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock, socket });
  const hc = await createDevice(gladys, 'hc-1');
  app.client.drop(new Error('test'));
  await waitFor(() => lambda.open === 0, 'closed');
  fail = true;
  const ack = command(gladys, hc, 'mode', 'off');
  await waitFor(() => fail === false, 'the failed dial');
  await sleep(10);
  await clock.advance(300);
  assert.deepEqual(await ack, { success: true });
  assert.equal(lambda.regs.get(5006), 0);
});
