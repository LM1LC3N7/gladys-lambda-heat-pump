import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dhwCapOf, normalizeConfig, parseAddress } from '../src/config.js';

test('addresses: IPv4 or host name, optional port; never broadcast, multicast, 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 502 });
  assert.deepEqual(parseAddress(' http://lambda.local:5020/ '), {
    host: 'lambda.local',
    port: 5020,
  });
  for (const bad of [
    '0.0.0.0',
    '255.255.255.255',
    '239.1.1.1',
    '1.2.3',
    'a b',
    'x:0',
    'x:70000',
    'h\r\nX: y',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('the hot water ceiling: 55 °C by default, 40 to 60, never above 60, rounded down', () => {
  assert.equal(dhwCapOf(undefined), 55);
  assert.equal(dhwCapOf(''), 55);
  assert.equal(dhwCapOf(null), 55);
  assert.equal(dhwCapOf(99), 60);
  assert.equal(dhwCapOf('59.9'), 59);
  assert.equal(dhwCapOf(10), 40);
});

test('the commands are off unless exactly true; counts and unit within range', () => {
  assert.equal(normalizeConfig({}).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  const c = normalizeConfig({ unit_id: 300, heat_pumps: 0, heating_circuits: '12', buffers: 2.5 });
  assert.equal(c.unitId, 1);
  assert.deepEqual(c.counts, { heatPumps: 1, hotWaterTanks: 1, buffers: 0, heatingCircuits: 12 });
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ gladys_x: 1 }).gladys_x, undefined);
});
