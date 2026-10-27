// -----------------------------------------------------------------------------
// The modules of the controller -> Gladys devices and their states (pure).
//
// One device per module: `ext:<selector>:lambda:<module>`, the module being
// `system` (general values and energy manager), `hp-<n>` (heat pump),
// `dhw-<n>` (hot water tank), `buffer-<n>` (buffer tank) or `hc-<n>`
// (heating circuit), `n` from 1 as the controller display counts them
// (subindex n - 1 of the manual). Modbus gives no serial number nor MAC
// address and the IP address may change: one controller per integration,
// the module number is the only stable key. The feature roles (the last part
// of their external ids) are published forever: never rename them.
//
// A feature appears once its register gave a value; a device published again
// never loses a feature: those of the created device are kept as they are.
//
// No switch, no writable binary: a "turn everything off" must never reach the
// heat pump. The commands are the heating circuit mode (`text/select`), its
// room setpoint (`thermostat/target-temperature`) and the hot water setpoint
// (`water-heater/target-temperature`) (src/app.js decides what is allowed).
//
// Energy: the 32-bit statistics of the heat pumps (electrical and thermal
// energy since the last reset of the statistics) are not read: their word
// order changed with the firmware, and they can be reset. Never an
// `energy-sensor` index; the power drawn is `energy-sensor/power` in W.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DHW_CAP, DHW_SETPOINT, MODULE_COUNTS, ROOM_SETPOINT } from './constants.js';
import { KINDS, REGISTERS, SELECTABLE_MODES } from './lambda.js';
import {
  DEVICE_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  OFFLINE,
  STATE_NAMES,
  codeText,
  word,
} from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const probe = (min = -50, max = 150) =>
  sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.TEMPERATURE_SENSOR.PROBE,
    unit: U.CELSIUS,
    min,
    max,
  });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const decimal = (min, max) => sensor({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min, max });
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const power = (max) =>
  sensor({ category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.POWER, unit: U.WATT, min: 0, max });

/** The commands, by kind and role. */
export const COMMANDS = {
  dhw: ['setpoint'],
  hc: ['mode', 'room-setpoint'],
};

/** The feature of a role. */
export function definitionOf(kind, role) {
  switch (role) {
    case 'error-number':
    case 'emanager-error-number':
      return sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: -32767, max: 32767 });
    case 'state':
    case 'emanager-state':
    case 'error-state':
    case 'operating-state':
      return text;
    case 'power-consumption':
      return power(100_000);
    case 'inverter-power':
      return power(50_000);
    case 'power-setpoint':
      return decimal(0, 100_000);
    case 'compressor-rating':
    case 'heating-capacity':
      return decimal(0, 100);
    case 'cop':
      return decimal(0, 20);
    case 'booster':
    case 'circulation-pump':
      return binary;
    case 'offset':
      return decimal(-10, 10);
    case 'temperature-room':
      return sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.CELSIUS,
        min: -30,
        max: 100,
      });
    case 'setpoint':
      if (kind === 'dhw') {
        return {
          category: C.WATER_HEATER,
          type: T.WATER_HEATER.TARGET_TEMPERATURE,
          unit: U.CELSIUS,
          // The slider stops at the hard ceiling; the configured one refuses above it.
          min: DHW_SETPOINT.floor,
          max: DHW_CAP.max,
          read_only: false,
          has_feedback: true,
          keep_history: true,
        };
      }
      return probe(0, 90);
    case 'room-setpoint':
      return {
        category: C.THERMOSTAT,
        type: T.THERMOSTAT.TARGET_TEMPERATURE,
        unit: U.CELSIUS,
        min: ROOM_SETPOINT.min,
        max: ROOM_SETPOINT.max,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      };
    case 'mode':
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      };
    case 'max-temperature':
    case 'flow-setpoint':
      return probe(0, 90);
    case 'room-setpoint-cooling':
      return probe(0, 60);
    default:
      return probe();
  }
}

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/** `system`, or `<kind>-<n>` with n from 1. */
export const moduleId = (kind, index) => (kind === 'system' ? 'system' : `${kind}-${index + 1}`);
export const deviceIds = (gladys, kind, index) =>
  gladys.externalIds('lambda', moduleId(kind, index));

const MAX_INDEX = {
  system: 1,
  hp: MODULE_COUNTS.heat_pumps.max,
  dhw: MODULE_COUNTS.hot_water_tanks.max,
  buffer: MODULE_COUNTS.buffers.max,
  hc: MODULE_COUNTS.heating_circuits.max,
};
const MODULE = /:lambda:(system|(hp|dhw|buffer|hc)-(\d{1,2}))(?::([a-z0-9-]+))?$/;

/** `{ kind, index, role? }` of one of our external ids (device or feature), else undefined. */
export function parseId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = MODULE.exec(externalId);
  if (!match) {
    return undefined;
  }
  const kind = match[1] === 'system' ? 'system' : match[2];
  const index = kind === 'system' ? 0 : Number(match[3]) - 1;
  if (index < 0 || index >= MAX_INDEX[kind] || String(index + 1) !== (match[3] ?? '1')) {
    return undefined;
  }
  const role = match[4];
  if (role !== undefined && !REGISTERS[kind].some((spec) => spec.role === role)) {
    return undefined;
  }
  return { kind, index, ...(role ? { role } : {}) };
}

export function modeOptions(language) {
  return SELECTABLE_MODES.map((key, index) => ({
    value: key,
    label: word(MODE_NAMES[key], language),
    sort_order: index,
  }));
}

/** The roles a module's values report. */
export function reportedRoles(kind, values) {
  return new Set(REGISTERS[kind].map((s) => s.role).filter((role) => values?.[role] !== undefined));
}

/**
 * The Gladys device of a module. `roles`: those seen; `created`: the device
 * already created, whose features are kept when the new build lacks them.
 */
export function buildDevice(gladys, kind, index, { roles, language, created }) {
  const ids = deviceIds(gladys, kind, index);
  const built = {
    name: word(DEVICE_NAMES[kind](index + 1), language),
    external_id: ids.device,
    model: 'Lambda EU-L',
    should_poll: false,
    features: REGISTERS[kind]
      .filter((spec) => roles.has(spec.role))
      .map((spec) => ({
        name: word(FEATURE_NAMES[spec.role], language),
        external_id: ids.feature(spec.role),
        ...definitionOf(kind, spec.role),
        ...(spec.role === 'mode' ? { supported_options: modeOptions(language) } : {}),
      })),
    params: [{ name: 'module', value: moduleId(kind, index) }],
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The text of a code. */
export function stateText(map, code, language) {
  const names = STATE_NAMES[map];
  return word(Object.hasOwn(names, code) ? names[code] : codeText(code), language);
}

/**
 * The current values of a module as states. Offline: only the state texts
 * say so; Gladys keeps the last value of the others (nothing stale is sent
 * as new).
 */
export function moduleStates(ids, kind, values, { online, language }) {
  const states = [];
  for (const spec of REGISTERS[kind]) {
    if (!online) {
      if (spec.map) {
        states.push({ role: spec.role, text: word(OFFLINE, language) });
      }
      continue;
    }
    const value = values?.[spec.role];
    if (value === undefined) {
      continue;
    }
    if (spec.type === 'mode') {
      if (value.key && SELECTABLE_MODES.includes(value.key)) {
        states.push({ role: spec.role, text: value.key });
      }
    } else if (spec.map) {
      states.push({ role: spec.role, text: stateText(spec.map, value, language) });
    } else if (Number.isFinite(value)) {
      states.push({ role: spec.role, state: value });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}

/** Every module the configuration counts: [{ kind, index }]. */
export function configuredModules(counts) {
  const list = [{ kind: 'system', index: 0 }];
  for (const kind of ['hp', 'dhw', 'buffer', 'hc']) {
    for (let index = 0; index < counts[KINDS[kind].count]; index += 1) {
      list.push({ kind, index });
    }
  }
  return list;
}
