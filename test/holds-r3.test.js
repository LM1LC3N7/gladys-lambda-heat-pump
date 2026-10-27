// -----------------------------------------------------------------------------
// Review r3: a stop whose request before is unknown (clicked during an
// outage) is never let go before it took; the request a stop overrides
// (`from`) from the read back and from /data; the start-up write of a stop
// kept in /data; the release note; a failure after an "accepted" ack; the
// status in local time, one bounded note for every circuit held.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp } from '../src/app.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { testClock } from './kit/clock.mjs';
import { fakeLambda } from './fixtures/fakeLambda.js';
import { advance, command, createDevice, id, setup, sleep, waitFor } from './helpers/setup.js';

const ALLOW = { allow_commands: true };
const writesTo = (lambda, address) =>
  lambda
    .writes()
    .filter((r) => r.address === address)
    .map((r) => r.values[0]);
const status = (gladys) => gladys.fake.connectionStatus.message;

/** The heat pump stops answering (`which` requests), for longer than the values stay fresh. */
async function outage(clock, lambda, app, which = () => true) {
  lambda.silent = which;
  await advance(clock, 30_000);
  await clock.advance(3_000);
  await waitFor(() => app.online === false, 'offline');
  await advance(clock, 100_000);
  assert.equal(app.fresh(), false, 'nothing read is fresh any more');
}

/** "Off" clicked while the heat pump is silent: the ack, whatever it says. */
async function stopDuringOutage(gladys, clock, hc) {
  const ack = command(gladys, hc, 'mode', 'off');
  for (let i = 0; i < 4; i += 1) {
    await sleep(10);
    await clock.advance(1_500);
  }
  return ack;
}

test('s17: a stop clicked during an outage is written once the heat pump answers, never let go on the request it overrides', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store, logs } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  // Another Modbus client holds "automatic".
  lambda.regs.set(5006, 2);
  await outage(clock, lambda, app);
  await stopDuringOutage(gladys, clock, hc);
  assert.equal(app.holds.get(0).from, undefined, 'the request before the stop is unknown');
  // Back: the reads show 2, the stop never took. In doubt, the stop is written.
  lambda.silent = undefined;
  for (let s = 0; s < 60 && app.holds.get(0)?.from === undefined; s += 1) {
    await advance(clock, 1_000);
  }
  assert.equal(app.holds.get(0).from, 2, 'the request read stands for the one before the stop');
  // Kept in /data at once, not at the next read (minutes away after an outage).
  await sleep(5);
  assert.equal(store.data.holds[0].from, 2);
  await advance(clock, 30_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'the stop written once the heat pump answers');
  assert.ok(app.holds.has(0));
  assert.ok(!logs.some((l) => /no longer held/.test(l)), logs.join('\n'));
  // A newer request, other than that one, read twice in a row: let go.
  lambda.regs.set(5006, 3);
  await advance(clock, 25_000);
  await waitFor(() => app.holds.size === 0, 'let go');
  assert.equal(lambda.regs.get(5006), 3);
});

test('s17: a stop clicked during an outage that the controller never applies is written again, and the status says so', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.regs.set(5006, 2);
  await outage(clock, lambda, app);
  await stopDuringOutage(gladys, clock, hc);
  lambda.silent = undefined;
  lambda.ignoreWrites = true;
  const count = writesTo(lambda, 5006).length;
  await advance(clock, 100_000);
  assert.ok(app.holds.has(0), 'never taken for a change made elsewhere');
  assert.ok(writesTo(lambda, 5006).length >= count + 3);
  assert.match(status(gladys).en, /does not apply the stop of heating circuit 1/);
  lambda.ignoreWrites = false;
  await advance(clock, 45_000);
  assert.equal(lambda.regs.get(5006), 0);
  assert.doesNotMatch(status(gladys).en, /does not apply/);
});

test('a stop whose request before is unknown, once read applied, is let go by another mode read twice', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  // Reads unanswered, writes applied: the stop takes, its read back is lost.
  await outage(clock, lambda, app, (r) => r.fn === 3);
  await stopDuringOutage(gladys, clock, hc);
  assert.equal(lambda.regs.get(5006), 0);
  assert.equal(app.holds.get(0).from, undefined);
  lambda.silent = undefined;
  await advance(clock, 30_000);
  await waitFor(() => app.holds.get(0)?.applied === true, 'the stop read applied');
  // Asked elsewhere after the stop took: a proof.
  lambda.regs.set(5006, 2);
  await advance(clock, 25_000);
  await waitFor(() => app.holds.size === 0, 'let go');
  assert.match(status(gladys).en, /no longer held by Gladys \(mode changed elsewhere\)/);
});

test('P12: the request read back after the stop becomes `from`; a read back that says nothing keeps it', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app, store } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  // Read -1 by the last poll; another client asks "automatic" just before the click.
  lambda.regs.set(5006, 2);
  lambda.ignoreWrites = true;
  assert.equal((await command(gladys, hc, 'mode', 'off')).success, false);
  assert.equal(app.holds.get(0).from, 2);
  assert.equal(store.data.holds[0].from, 2);
  const count = writesTo(lambda, 5006).length;
  await advance(clock, 25_000);
  assert.ok(app.holds.has(0), 'the stop not applied is never a release');
  assert.ok(writesTo(lambda, 5006).length > count);
  // "Off" again, 2 read by the last poll, read back as 0x8000 ("not available"):
  // that says nothing of the request, `from` stays 2.
  await advance(clock, 30_000);
  await sleep(10);
  lambda.regs.set(5006, 0x8000);
  const ack = await command(gladys, hc, 'mode', 'off');
  assert.equal(app.holds.get(0).from, 2);
  assert.equal(ack.success, false);
  assert.match(ack.error, /relit \?/);
  lambda.regs.set(5006, 2);
  await advance(clock, 25_000);
  assert.ok(app.holds.has(0), 'still the stop not applied');
});

test('P13: the request before a stop survives a restart through /data', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  const store = new MemoryStore(
    {
      ...emptyData(),
      target: { host: '127.0.0.1', port: lambda.port, unitId: 1 },
      holds: {
        0: { mode: 'off', at: clock.now() - 60_000, from: 2 },
        1: { mode: 'off', at: clock.now() - 60_000, from: 0 },
      },
    },
    { now: clock.now },
  );
  const { app } = await setup(t, { lambda: false, store, connect: false, clock });
  await app.boot();
  assert.equal(app.holds.get(0).from, 2);
  assert.equal(app.holds.get(0).resumed, true);
  assert.equal(app.holds.get(1).from, undefined, 'the stop itself is not a request before it');
});

test('an unknown code read before the stop, read back or read later, is not the request it overrides', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  lambda.regs.set(5006, 9);
  await advance(clock, 30_000);
  await sleep(10);
  lambda.ignoreWrites = true;
  assert.equal((await command(gladys, hc, 'mode', 'off')).success, false);
  assert.equal(app.holds.get(0).from, undefined);
  // Read again by the refresh: still nothing known.
  const reads = lambda.reads().filter((r) => r.address === 5006 && r.count === 1).length;
  await advance(clock, 21_000);
  await waitFor(
    () => lambda.reads().filter((r) => r.address === 5006 && r.count === 1).length > reads,
    'the refresh read',
  );
  await sleep(10);
  assert.equal(app.holds.get(0).from, undefined);
  // The stop never took; 2 read: the request it overrides, written over.
  lambda.regs.set(5006, 2);
  await advance(clock, 25_000);
  assert.ok(app.holds.has(0));
  assert.equal(app.holds.get(0).from, 2);
});

test('s19: the start-up write of a stop kept in /data overwrites once, once acknowledged; a newer mode is then respected', async (t) => {
  const first = await setup(t, { clock: testClock() });
  const hc = await createDevice(first.gladys, 'hc-1');
  assert.deepEqual(await command(first.gladys, hc, 'mode', 'off'), { success: true });
  first.app.stop();
  const { lambda } = first;
  // While the integration is stopped: "automatic" set elsewhere; at start-up the controller is busy.
  lambda.regs.set(5006, 2);
  lambda.writeException = () => 6;
  const clock = testClock();
  const { app } = await setup(t, {
    lambda: false,
    store: new MemoryStore(first.store.data),
    connect: false,
    clock,
  });
  await app.boot();
  await advance(clock, 25_000);
  assert.equal(lambda.regs.get(5006), 2, 'refused (busy) so far');
  assert.equal(app.holds.get(0).resumed, true, 'still the start-up write, without a read');
  lambda.writeException = undefined;
  await advance(clock, 25_000);
  await waitFor(() => lambda.regs.get(5006) === 0, 'written once accepted');
  assert.ok(app.holds.has(0));
  // A change made after that write: read twice, respected.
  lambda.regs.set(5006, 3);
  await advance(clock, 45_000);
  await waitFor(() => app.holds.size === 0, 'let go');
  assert.equal(lambda.regs.get(5006), 3);
});

test('P11: the note of a release goes once the circuit is stopped again', async (t) => {
  const clock = testClock();
  const { gladys, lambda, app } = await setup(t, { clock });
  const hc = await createDevice(gladys, 'hc-1');
  await command(gladys, hc, 'mode', 'off');
  lambda.regs.set(5006, 2);
  await advance(clock, 25_000);
  await waitFor(() => app.holds.size === 0, 'let go');
  assert.match(status(gladys).en, /no longer held by Gladys/);
  await command(gladys, hc, 'mode', 'off');
  assert.doesNotMatch(status(gladys).en, /no longer held/);
  assert.match(status(gladys).en, /Heating circuit 1 held off by Gladys since/);
});

test('N9: a command acked as accepted that fails later publishes the value read again', async (t) => {
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
  assert.deepEqual(await second, { success: true }, 'acked as accepted');
  await first;
  const before = gladys.fake.states.length;
  // Its fresh read gets no answer: nothing sent, after the ack.
  await clock.advance(3_000);
  await waitFor(
    () =>
      gladys.fake.states
        .slice(before)
        .some(
          (s) => s.device_feature_external_id === id('hc-1', 'room-setpoint') && s.state === 21,
        ),
    'the value read published again',
  );
  assert.deepEqual(writesTo(lambda, 5051), []);
});

test('the status dates in the time zone of Gladys (TZ), UTC said when unknown', () => {
  assert.equal(stamp(Date.UTC(2026, 9, 27, 13, 37), 'Europe/Paris'), '2026-10-27 14:37');
  assert.equal(stamp(Date.UTC(2026, 6, 1, 13, 37), 'Europe/Paris'), '2026-07-01 15:37');
  // The night of the change of time: 02:30 twice, both local.
  assert.equal(stamp(Date.UTC(2026, 9, 25, 0, 30), 'Europe/Paris'), '2026-10-25 02:30');
  assert.equal(stamp(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Paris'), '2026-10-25 02:30');
  // West and east of UTC at midnight.
  assert.equal(stamp(Date.UTC(2026, 9, 27, 3, 5), 'America/New_York'), '2026-10-26 23:05');
  assert.equal(stamp(Date.UTC(2026, 9, 27, 10, 0), 'Pacific/Kiritimati'), '2026-10-28 00:00');
  // A zone that is UTC, or unknown: said so.
  assert.equal(stamp(Date.UTC(2026, 9, 27, 13, 37), 'Etc/UTC'), '2026-10-27 13:37 UTC');
  assert.equal(stamp(Date.UTC(2026, 9, 27, 13, 37), 'Not/A_Zone'), '2026-10-27 13:37 UTC');
  assert.equal(stamp(Number.NaN, 'Europe/Paris'), '?');
});

test('one bounded note for all the circuits held, in local time', async (t) => {
  const { gladys, app } = await setup(t, { config: { heating_circuits: 12 } });
  app.timeZone = 'Europe/Paris';
  for (let n = 1; n <= 12; n += 1) {
    await gladys.fake.setValue(
      { external_id: id(`hc-${n}`), features: [] },
      { external_id: id(`hc-${n}`, 'mode') },
      'off',
    );
  }
  assert.equal(app.holds.size, 12);
  await app.updateStatus();
  const { en, fr } = status(gladys);
  assert.match(en, /Heating circuits held off by Gladys: 1 since 2026-01-01 01:00, 2 since/);
  assert.match(en, /12 since 2026-01-01 01:00 \(to end a stop:/);
  assert.match(
    fr,
    /Circuits de chauffage maintenus à l'arrêt par Gladys : 1 depuis le 2026-01-01 01:00/,
  );
  assert.equal(en.match(/to end/g).length, 1);
  assert.doesNotMatch(en, /UTC/);
  assert.ok(en.length < 900 && fr.length < 1000, `${en.length} / ${fr.length}`);
});
