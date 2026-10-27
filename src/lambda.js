// -----------------------------------------------------------------------------
// The Lambda register map, read in the manufacturer's manual ("Modbus-
// Protokoll 1.0", LAMBDA Wärmepumpen GmbH, 2026) and checked against the
// reference, lambda_heat_pumps V2.8.6 (MIT, const_sensor.py):
//
//   register = index * 1000 + subindex * 100 + data point
//   index 0 general (subindex 0) and E-manager (subindex 1), 1 heat pump,
//   2 hot water tank, 3 buffer tank, 4 solar, 5 heating circuit; the
//   subindex is the module number, from 0.
//
// Data points below 50 that are written are Modbus requests the controller
// forgets unless they are written again regularly; from 50 on they are
// stored settings. Every value is one 16-bit register (the 32-bit energy
// statistics, whose word order changed with the firmware, are not read).
// 0x8000 means "register not available", -3000 "sensor not connected"
// (manual and reference V2.8.0): neither is ever a measurement.
// -----------------------------------------------------------------------------

/** The module kinds, their register base and how the configuration counts them. */
export const KINDS = {
  system: { base: 0, step: 0, count: 'system' },
  hp: { base: 1000, step: 100, count: 'heatPumps' },
  dhw: { base: 2000, step: 100, count: 'hotWaterTanks' },
  buffer: { base: 3000, step: 100, count: 'buffers' },
  hc: { base: 5000, step: 100, count: 'heatingCircuits' },
};

export const NOT_AVAILABLE = 0x8000;
export const NOT_CONNECTED = 0x10000 - 3000;

/**
 * The registers shown, by kind: data point, role (the feature external id,
 * frozen), format, scale and the plausible range (outside: not published).
 * `map`: a code whose text comes from src/i18n.js STATE_NAMES.
 */
const t = (min = -50, max = 150) => ({ type: 'i16', scale: 0.1, range: [min, max] });
const t100 = { type: 'i16', scale: 0.01, range: [-50, 150] };
const code = (map) => ({ type: 'u16', scale: 1, range: [0, 0xffff], map });
const errorNumber = { type: 'i16', scale: 1, range: [-32767, 32767] };
const flag = { type: 'i16', scale: 1, range: [0, 1] };

export const REGISTERS = {
  system: [
    { at: 0, role: 'error-number', ...errorNumber },
    { at: 1, role: 'state', ...code('system') },
    { at: 3, role: 'temperature-outdoor-average', ...t(-60, 70) },
    { at: 4, role: 'temperature-outdoor-calculated', ...t(-60, 70) },
    { at: 100, role: 'emanager-error-number', ...errorNumber },
    { at: 101, role: 'emanager-state', ...code('emanager') },
    { at: 103, role: 'power-consumption', type: 'i16', scale: 1, range: [0, 100_000] },
    { at: 104, role: 'power-setpoint', type: 'i16', scale: 1, range: [0, 100_000] },
  ],
  hp: [
    { at: 0, role: 'error-state', ...code('hpError') },
    { at: 1, role: 'error-number', ...errorNumber },
    { at: 2, role: 'state', ...code('hpState') },
    { at: 3, role: 'operating-state', ...code('hpOperating') },
    { at: 4, role: 'temperature-flow', ...t100 },
    { at: 5, role: 'temperature-return', ...t100 },
    { at: 7, role: 'temperature-source-in', ...t100 },
    { at: 8, role: 'temperature-source-out', ...t100 },
    { at: 10, role: 'compressor-rating', type: 'u16', scale: 0.01, range: [0, 100] },
    { at: 11, role: 'heating-capacity', type: 'i16', scale: 0.1, range: [0, 100] },
    { at: 12, role: 'inverter-power', type: 'i16', scale: 1, range: [0, 50_000] },
    { at: 13, role: 'cop', type: 'i16', scale: 0.01, range: [0, 20] },
    { at: 19, role: 'booster', ...flag },
  ],
  dhw: [
    { at: 0, role: 'error-number', ...errorNumber },
    { at: 1, role: 'state', ...code('dhw') },
    { at: 2, role: 'temperature-top', ...t() },
    { at: 3, role: 'temperature-bottom', ...t() },
    { at: 4, role: 'temperature-circulation', ...t() },
    { at: 5, role: 'circulation-pump', ...flag },
    { at: 50, role: 'setpoint', ...t(0, 90) },
  ],
  buffer: [
    { at: 0, role: 'error-number', ...errorNumber },
    { at: 1, role: 'state', ...code('buffer') },
    { at: 2, role: 'temperature-top', ...t() },
    { at: 3, role: 'temperature-bottom', ...t() },
    { at: 50, role: 'max-temperature', ...t(0, 90) },
  ],
  hc: [
    { at: 0, role: 'error-number', ...errorNumber },
    { at: 1, role: 'state', ...code('hc') },
    { at: 2, role: 'temperature-flow', ...t() },
    { at: 3, role: 'temperature-return', ...t() },
    { at: 4, role: 'temperature-room', ...t(-29.9, 99.9) },
    { at: 6, role: 'mode', type: 'mode' },
    { at: 7, role: 'flow-setpoint', ...t(0, 90) },
    { at: 50, role: 'offset', ...t(-10, 10) },
    { at: 51, role: 'room-setpoint', ...t(0, 60) },
    { at: 52, role: 'room-setpoint-cooling', ...t(0, 60) },
  ],
};

/**
 * The reads of a module, in blocks of the data points the manual lists (no
 * undefined data point inside a block). An `optional` block refused with
 * "illegal data address" is marked absent until a restart (an older
 * firmware: 5x07 came with the reference's firmware 3, the E-manager and the
 * E-heater state are not on every controller); its values stay unknown.
 */
export const BLOCKS = {
  system: [
    { at: 0, count: 2, optional: true },
    { at: 3, count: 2, optional: true },
    { at: 100, count: 5, optional: true },
  ],
  hp: [
    { at: 0, count: 14 },
    { at: 19, count: 1, optional: true },
  ],
  dhw: [
    { at: 0, count: 6 },
    { at: 50, count: 1 },
  ],
  buffer: [
    { at: 0, count: 4 },
    { at: 50, count: 1, optional: true },
  ],
  hc: [
    { at: 0, count: 7 },
    { at: 7, count: 1, optional: true },
    { at: 50, count: 3 },
  ],
};

/**
 * Heating circuit operating mode, register 5x06 (a Modbus request): -1 no
 * request (the controller follows its own setting), 0 off, 1 manual (read
 * only), 2 automatic, 3 automatic heating, 4 automatic cooling, 5 frost
 * protection, 6 summer, 7 screed program (read only).
 */
export const HC_MODES = {
  [-1]: 'release',
  0: 'off',
  1: 'manual',
  2: 'automatic',
  3: 'auto-heating',
  4: 'auto-cooling',
  5: 'frost',
  6: 'summer',
  7: 'screed',
};
/** What the select offers, in order: `release` writes nothing (the request lapses). */
export const SELECTABLE_MODES = [
  'release',
  'off',
  'automatic',
  'auto-heating',
  'auto-cooling',
  'frost',
  'summer',
];
export const MODE_CODES = Object.fromEntries(
  Object.entries(HC_MODES)
    .filter(([, key]) => SELECTABLE_MODES.includes(key) && key !== 'release')
    .map(([c, key]) => [key, Number(c)]),
);

/** The register of a data point of a module (`index` from 0). */
export function registerOf(kind, index, at) {
  const { base, step } = KINDS[kind];
  return base + step * index + at;
}

const signed = (word) => (word >= 0x8000 ? word - 0x10000 : word);

/** One register word -> its value, or undefined (unavailable, not connected, implausible). */
export function decodeWord(spec, word) {
  if (!Number.isInteger(word) || word < 0 || word > 0xffff || word === NOT_AVAILABLE) {
    return undefined;
  }
  if (spec.type === 'mode') {
    const value = signed(word);
    return Object.hasOwn(HC_MODES, value) ? { code: value, key: HC_MODES[value] } : { code: value };
  }
  if (spec.type === 'i16' && word === NOT_CONNECTED) {
    return undefined;
  }
  const raw = spec.type === 'i16' ? signed(word) : word;
  if (spec.map) {
    return raw;
  }
  // Rounded to the register's resolution (no 21.900000000000002).
  const digits = spec.scale >= 1 ? 0 : spec.scale >= 0.1 ? 1 : 2;
  const value = Number((raw * spec.scale).toFixed(digits));
  const [min, max] = spec.range;
  return value >= min && value <= max ? value : undefined;
}

/** The words read (Map register -> word) -> the values of a module, by role. */
export function decodeModule(kind, index, words) {
  const values = {};
  for (const spec of REGISTERS[kind]) {
    const word = words.get(registerOf(kind, index, spec.at));
    if (word === undefined) {
      continue;
    }
    const value = decodeWord(spec, word);
    if (value !== undefined) {
      values[spec.role] = value;
    }
  }
  return values;
}

/** A temperature in °C -> the register word (tenths, two's complement). */
export function tenthsWord(celsius) {
  const tenths = Math.round(celsius * 10);
  if (!Number.isInteger(tenths) || tenths < -32768 || tenths > 32767) {
    throw new RangeError('out of the register range');
  }
  return tenths < 0 ? tenths + 0x10000 : tenths;
}
