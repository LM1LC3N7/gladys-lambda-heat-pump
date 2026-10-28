// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, DHW_CAP, MODULE_COUNTS, POLL_INTERVAL, UNIT_ID } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  unit_id: UNIT_ID.default,
  heat_pumps: MODULE_COUNTS.heat_pumps.default,
  hot_water_tanks: MODULE_COUNTS.hot_water_tanks.default,
  buffers: MODULE_COUNTS.buffers.default,
  heating_circuits: MODULE_COUNTS.heating_circuits.default,
  allow_commands: false,
  dhw_max_temperature: DHW_CAP.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const FORBIDDEN_V4 = (host) => {
  const [a, b, c, d] = host.split('.').map(Number);
  // Never "this network", broadcast, multicast nor reserved.
  return a === 0 || a >= 224 || (a === 255 && b === 255 && c === 255 && d === 255);
};

/**
 * The address of the controller typed by the user: an IPv4 address or a
 * host name, with an optional port (502 by default). A pasted URL is reduced
 * to its host and port.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (/[\x00-\x1f\x7f]/.test(text)) {
    return undefined;
  }
  text = text.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return FORBIDDEN_V4(host) ? undefined : { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A whole number within { min, max }, else the default. */
function integerIn(value, { min, max, default: fallback }) {
  const number = numberOf(value);
  if (number === undefined || !Number.isInteger(number) || number < min || number > max) {
    return fallback;
  }
  return number;
}

/**
 * The hot water ceiling: whole degrees within DHW_CAP, else the default
 * (65 °C). Never above DHW_CAP.max, whatever was typed; rounded down.
 */
export function dhwCapOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return DHW_CAP.default;
  }
  return Math.min(DHW_CAP.max, Math.max(DHW_CAP.min, Math.floor(number)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  const interval = numberOf(c.poll_interval);
  return {
    address,
    /** What was typed, when it is not a valid address (shown in the status, control bytes removed). */
    invalid:
      typed !== '' && !address ? typed.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : undefined,
    unitId: integerIn(c.unit_id, UNIT_ID),
    counts: {
      heatPumps: integerIn(c.heat_pumps, MODULE_COUNTS.heat_pumps),
      hotWaterTanks: integerIn(c.hot_water_tanks, MODULE_COUNTS.hot_water_tanks),
      buffers: integerIn(c.buffers, MODULE_COUNTS.buffers),
      heatingCircuits: integerIn(c.heating_circuits, MODULE_COUNTS.heating_circuits),
    },
    allowCommands: strictTrue(c.allow_commands),
    dhwCap: dhwCapOf(c.dhw_max_temperature),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** The key of the target (address and unit): a new one restarts the polling. */
export const targetKey = (config) =>
  config.address ? `${config.address.host}:${config.address.port}#${config.unitId}` : '';
