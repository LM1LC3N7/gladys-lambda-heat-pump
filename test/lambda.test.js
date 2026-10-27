// -----------------------------------------------------------------------------
// The register map against the manual (Modbus-Protokoll 1.0): blocks only
// over listed data points, decoding of the special values, the mode codes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS,
  HC_MODES,
  MODE_CODES,
  REGISTERS,
  SELECTABLE_MODES,
  decodeWord,
  registerOf,
  tenthsWord,
} from '../src/lambda.js';

/** The data points the manual lists, by kind (0002 is write only: never read). */
const MANUAL = {
  system: [0, 1, 3, 4, 100, 101, 102, 103, 104],
  hp: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 19, 20, 21, 22, 23],
  dhw: [0, 1, 2, 3, 4, 5, 50],
  buffer: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 50],
  hc: [0, 1, 2, 3, 4, 5, 6, 7, 50, 51, 52],
};

test('blocks cover only the data points of the manual, and every register shown', () => {
  for (const [kind, blocks] of Object.entries(BLOCKS)) {
    const read = new Set();
    for (const { at, count } of blocks) {
      for (let i = 0; i < count; i += 1) {
        assert.ok(MANUAL[kind].includes(at + i), `${kind} ${at + i} is not in the manual`);
        read.add(at + i);
      }
    }
    for (const spec of REGISTERS[kind]) {
      assert.ok(read.has(spec.at), `${kind} ${spec.role} is never read`);
    }
  }
  // Never the 32-bit statistics (their word order changed with the firmware).
  assert.ok(!BLOCKS.hp.some(({ at, count }) => at + count > 20 && at < 24));
});

test('registers: index * 1000 + subindex * 100 + data point', () => {
  assert.equal(registerOf('hp', 0, 4), 1004);
  assert.equal(registerOf('dhw', 1, 50), 2150);
  assert.equal(registerOf('hc', 11, 6), 6106);
  assert.equal(registerOf('system', 0, 103), 103);
});

test('0x8000 (not available) and -3000 (sensor not connected) are never values', () => {
  const temp = REGISTERS.hc.find((s) => s.role === 'temperature-flow');
  assert.equal(decodeWord(temp, 0x8000), undefined);
  assert.equal(decodeWord(temp, 0x10000 - 3000), undefined);
  assert.equal(decodeWord(temp, 0x10000 - 52), -5.2);
  assert.equal(decodeWord(temp, 2000), undefined, 'implausible');
  assert.equal(decodeWord(temp, 219), 21.9);
  const t100 = REGISTERS.hp.find((s) => s.role === 'temperature-flow');
  assert.equal(decodeWord(t100, 3520), 35.2);
  const cop = REGISTERS.hp.find((s) => s.role === 'cop');
  assert.equal(decodeWord(cop, 421), 4.21);
  assert.equal(decodeWord(cop, 5000), undefined);
  const code = REGISTERS.hp.find((s) => s.role === 'state');
  assert.equal(decodeWord(code, 7), 7);
  assert.equal(decodeWord(code, 0x8000), undefined);
});

test('the mode request: -1 is "no request", 1 and 7 read only, never offered', () => {
  const mode = REGISTERS.hc.find((s) => s.role === 'mode');
  assert.deepEqual(decodeWord(mode, 0xffff), { code: -1, key: 'release' });
  assert.deepEqual(decodeWord(mode, 0), { code: 0, key: 'off' });
  assert.deepEqual(decodeWord(mode, 9), { code: 9 });
  assert.ok(!SELECTABLE_MODES.includes('manual'));
  assert.ok(!SELECTABLE_MODES.includes('screed'));
  assert.deepEqual(MODE_CODES, {
    off: 0,
    automatic: 2,
    'auto-heating': 3,
    'auto-cooling': 4,
    frost: 5,
    summer: 6,
  });
  assert.equal(HC_MODES[7], 'screed');
});

test('tenths written as two-complement words', () => {
  assert.equal(tenthsWord(21.5), 215);
  assert.equal(tenthsWord(-1), 0x10000 - 10);
  assert.throws(() => tenthsWord(5000));
});
