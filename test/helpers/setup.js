// -----------------------------------------------------------------------------
// The app with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store, a fake Lambda controller on the loopback
// interface and the test clock of the kit (it moves 1 µs at every read; its
// timers fire only on `clock.advance()`). Network times are real and short.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LambdaApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { testClock } from '../kit/clock.mjs';
import { fakeLambda } from '../fixtures/fakeLambda.js';

export const SELECTOR = 'lambda-heat-pump';
export const id = (module, role) => `ext:${SELECTOR}:lambda:${module}${role ? `:${role}` : ''}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await sleep(3);
  }
  assert.fail(`timed out waiting for ${what}`);
}

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/**
 * `lambda`: options of the fake controller (or `false` for none); `config`:
 * extra configuration (the fake's address by default).
 */
export async function setup(
  t,
  {
    lambda: options = {},
    config = {},
    store,
    clock = testClock(),
    connect = true,
    devices,
    socket,
  } = {},
) {
  const lambda = options === false ? undefined : await fakeLambda(options);
  t.after(() => lambda?.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { address: lambda?.address ?? '', ...config },
    ...(devices ? { devices } : {}),
  });
  const logger = memoryLogger();
  const app = new LambdaApp({
    gladys,
    logger,
    store: store ?? new MemoryStore(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    ...(socket ? { connect: socket } : {}),
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  if (connect) {
    await gladys.connect();
    await waitFor(() => app.online !== undefined || !app.config.address, 'the first read');
  }
  return { lambda, gladys, app, logs: logger.lines, store: app.store, clock };
}

export const discovered = (gladys, module) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(module));

/** The device of a module, created as the user would from the Discovery tab. */
export async function createDevice(gladys, module) {
  await waitFor(() => discovered(gladys, module), `${module} in the Discovery tab`);
  const device = discovered(gladys, module);
  await gladys.fake.deviceCreated(device);
  gladys.fake.devices.push(device);
  return device;
}

export const featureOf = (device, role) =>
  device.features.find((f) => f.external_id.endsWith(`:${role}`));

export const command = (gladys, device, role, value) =>
  gladys.fake.setValue(device, featureOf(device, role), value);

export const state = (gladys, module, role) => gladys.fake.lastState(id(module, role));

/** Advances the virtual clock by `ms`, letting the real I/O of the loopback settle. */
export async function advance(clock, ms, step = 1_000) {
  for (let done = 0; done < ms; done += step) {
    await clock.advance(Math.min(step, ms - done));
    await sleep(5);
  }
}
