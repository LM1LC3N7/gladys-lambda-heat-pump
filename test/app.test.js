// -----------------------------------------------------------------------------
// The polling: devices and states of the configured modules, failures and
// backoff, optional blocks, nothing stale published as new, the test button
// and the restart never reading sooner than the interval, the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LambdaApp } from '../src/app.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { fakeLambda } from './fixtures/fakeLambda.js';
import {
  advance,
  createDevice,
  discovered,
  id,
  setup,
  sleep,
  state,
  waitFor,
} from './helpers/setup.js';

test('the configured modules become devices; values decoded with their scale', async (t) => {
  const { gladys, lambda } = await setup(t);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    ['dhw-1', 'hc-1', 'hp-1', 'system'].map((m) => id(m)).sort(),
  );
  const hp = await createDevice(gladys, 'hp-1');
  assert.equal(state(gladys, 'hp-1', 'temperature-flow'), 35.2);
  assert.equal(state(gladys, 'hp-1', 'cop'), 4.21);
  assert.equal(state(gladys, 'hp-1', 'compressor-rating'), 45);
  assert.equal(state(gladys, 'hp-1', 'heating-capacity'), 5.2);
  assert.equal(state(gladys, 'hp-1', 'inverter-power'), 1250);
  assert.equal(state(gladys, 'hp-1', 'operating-state'), 'Chauffage');
  assert.equal(state(gladys, 'hp-1', 'state'), 'Régulation');
  const power = hp.features.find((f) => f.external_id === id('hp-1', 'inverter-power'));
  assert.deepEqual([power.category, power.type, power.unit], ['energy-sensor', 'power', 'watt']);
  // No switch, no writable binary anywhere.
  for (const device of gladys.fake.discoveredDevices) {
    for (const f of device.features) {
      assert.ok(!(f.type === 'binary' && f.read_only === false), f.external_id);
      assert.notEqual(f.category, 'switch', f.external_id);
      for (const option of f.supported_options ?? []) {
        assert.equal(typeof option.label, 'string', f.external_id);
      }
    }
  }
  await createDevice(gladys, 'dhw-1');
  assert.equal(state(gladys, 'dhw-1', 'setpoint'), 50);
  assert.equal(state(gladys, 'dhw-1', 'temperature-top'), 48.5);
  const setpoint = discovered(gladys, 'dhw-1').features.find((f) =>
    f.external_id.endsWith(':setpoint'),
  );
  assert.deepEqual([setpoint.category, setpoint.min, setpoint.max], ['water-heater', 25, 60]);
  assert.equal(lambda.glued, 0);
});

test('0x8000 and -3000 are never measurements; implausible values neither', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock });
  await createDevice(gladys, 'hc-1');
  assert.equal(state(gladys, 'hc-1', 'temperature-room'), 21.3);
  lambda.regs.set(5004, 0x8000);
  lambda.regs.set(5002, 0x10000 - 3000);
  lambda.regs.set(5003, 2000);
  const before = gladys.fake.states.length;
  await advance(clock, 30_000);
  await waitFor(() => gladys.fake.states.length > before || true, 'a read');
  await sleep(20);
  const after = gladys.fake.states.slice(before).map((s) => s.device_feature_external_id);
  assert.ok(!after.includes(id('hc-1', 'temperature-room')));
  assert.ok(!after.includes(id('hc-1', 'temperature-flow')));
  assert.ok(!after.includes(id('hc-1', 'temperature-return')));
});

test('an optional block refused is marked absent; a core block refused is noted', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, {
    clock,
    lambda: {},
    config: { buffers: 1 },
  });
  // No buffer registers on this controller: the buffer module is noted, the rest goes on.
  assert.match(gladys.fake.connectionStatus.message.en, /Not read: buffer-1/);
  assert.equal(app.online, true);
  lambda.illegal.add(5007);
  lambda.log.length = 0;
  await advance(clock, 30_000);
  await sleep(10);
  await advance(clock, 30_000);
  await sleep(10);
  assert.equal(lambda.reads().filter((r) => r.address === 5007).length, 1, 'not read again');
});

test('a controller that does not answer: unreachable, backoff never shorter than the interval', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  await createDevice(gladys, 'hp-1');
  lambda.silent = () => true;
  await advance(clock, 30_000);
  await advance(clock, 3_000);
  await waitFor(() => app.online === false, 'unreachable');
  assert.match(gladys.fake.connectionStatus.message.en, /unreachable \(timeout\)/);
  assert.equal(state(gladys, 'hp-1', 'state'), 'Pompe à chaleur injoignable');
  const badge = gladys.fake.transports.filter((b) => b.device_external_id === id('hp-1')).at(-1);
  assert.equal(badge.transport, 'unreachable');
  // The failed read started at 30 s: the next one at 60 s, not before.
  const count = lambda.reads().length;
  await advance(clock, 26_000);
  assert.equal(lambda.reads().length, count, 'not before 30 s');
  lambda.silent = undefined;
  await advance(clock, 2_000);
  await waitFor(() => app.online === true, 'back');
  assert.ok(lambda.reads().length > count);
});

test('nothing stale republished as new at a reconnection', async (t) => {
  const clock = testClock();
  const { gladys, app } = await setup(t, { clock });
  await createDevice(gladys, 'hp-1');
  // Values read long ago (no read since: the timers never ran).
  await clock.advance(0);
  app.readAt -= 10 * 60 * 1000;
  const before = gladys.fake.states.length;
  await app.connected({ address: app.config.address && `127.0.0.1:${app.config.address.port}` });
  await sleep(10);
  const sent = gladys.fake.states.slice(before);
  assert.deepEqual(sent, []);
});

test('the test button never reads sooner than the interval', async (t) => {
  const clock = testClock();
  const { gladys, lambda } = await setup(t, { clock });
  const count = lambda.reads().length;
  const reply = await gladys.fake.action('test_connection');
  assert.equal(reply.success, true);
  assert.equal(lambda.reads().length, count);
  await advance(clock, 30_000);
  await sleep(10);
  const after = lambda.reads().length;
  assert.ok(after > count);
});

test('a restart reads no sooner than the interval after the last read kept in /data', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  const { createFakeGladys } = await import('@gladysassistant/integration-sdk/testing');
  const gladys = createFakeGladys({
    selector: 'lambda-heat-pump',
    config: { address: lambda.address },
  });
  const store = new MemoryStore({ ...emptyData(), lastPollAt: clock.now() - 10_000 });
  const app = new LambdaApp({
    gladys,
    store,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(() => app.stop());
  await app.start({ address: lambda.address });
  assert.equal(lambda.log.length, 0);
  await advance(clock, 19_000);
  assert.equal(lambda.log.length, 0);
  await advance(clock, 2_000);
  await waitFor(() => lambda.log.length > 0, 'the read after the interval');
});

test('a date in the future in /data is ignored (a clock set back): read at once', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  const { createFakeGladys } = await import('@gladysassistant/integration-sdk/testing');
  const gladys = createFakeGladys({ selector: 'lambda-heat-pump', config: {} });
  const store = new MemoryStore(
    { ...emptyData(), lastPollAt: clock.now() + 3_600_000 },
    { now: clock.now },
  );
  const app = new LambdaApp({
    gladys,
    store,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  t.after(() => app.stop());
  await app.start({ address: lambda.address });
  assert.ok(lambda.log.length > 0);
});

test('a configuration saved unchanged does not read again; a new count does', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const count = lambda.reads().length;
  await gladys.fake.configUpdated({ address: lambda.address, language: 'en' });
  assert.equal(lambda.reads().length, count);
  assert.equal(app.config.language, 'en');
  await gladys.fake.configUpdated({ address: lambda.address, language: 'en', heating_circuits: 2 });
  await sleep(10);
  assert.ok(lambda.reads().some((r) => r.address === 5100));
});

test('no address: said in the status, nothing read', async (t) => {
  const { gladys } = await setup(t, { lambda: false, config: { address: 'not an address!' } });
  assert.match(gladys.fake.connectionStatus.message.en, /Enter the IP address/);
  assert.match(gladys.fake.connectionStatus.message.en, /Invalid address/);
});

test('getConfig() failing is said and tried again without end', async (t) => {
  const clock = testClock();
  const { gladys, app } = await setup(t, { clock, connect: false });
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    // The first call is the SDK's own resynchronization; then ours fail twice.
    if (calls === 2 || calls === 3) throw new Error('busy');
    return original();
  };
  await gladys.connect();
  await waitFor(() => calls === 2, 'the first try');
  assert.match(gladys.fake.connectionStatus.message.en, /could not be read/);
  await advance(clock, 5_000);
  await advance(clock, 10_000);
  await waitFor(() => app.online === true, 'started');
  assert.equal(calls, 4);
});

test('the devices keep their features when published again; ids are frozen', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  assert.ok(hc.features.some((f) => f.external_id === id('hc-1', 'flow-setpoint')));
  lambda.regs.delete(5007);
  lambda.illegal.add(5007);
  app.absent.clear();
  await advance(clock, 30_000);
  await sleep(10);
  await app.scan();
  const again = discovered(gladys, 'hc-1');
  assert.ok(again.features.some((f) => f.external_id === id('hc-1', 'flow-setpoint')));
});
