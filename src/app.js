// -----------------------------------------------------------------------------
// The integration: the Lambda controller typed in the configuration, one
// Modbus read of the configured modules every poll interval, their Gladys
// devices and states, the transport badges, the "Test the connection"
// button, and the commands.
//
// Two clocks: `now` (wall clock) only dates what /data keeps and the last
// read across a restart; `monotonic` paces the reads, the guards, the
// deadlines and the freshness. A decision reads the clock once.
//
// Commands (rules of the previous lots, fiche section 4):
//   - Protective, never refused by the option, a missing read, a read or a
//     command in progress, an unread configuration: the heating circuit
//     "off" request and a setpoint at its floor (hot water 25 °C, room
//     15 °C). Sent at once, before any queued request (a frozen read is
//     cut), tried again once within its budget; the stop is then held: kept
//     in /data and written again every 20 s (the controller forgets a mode
//     request that is not repeated), also after a restart, before the
//     configuration is read. A floor not confirmed is written again by the
//     next 3 reads. Everything queued before a stop for its circuit is
//     dropped (an epoch checked right before the bytes leave).
//   - Sensitive, off by default (`allow_commands`, checked on arrival and
//     right before the bytes leave): the other modes, release, and the other
//     setpoints. Decided on a fresh read, refused when it is missing; one
//     command at a time per module; refused while a stop of that circuit is
//     being sent. A mode replaces the stop held only once it has left.
//   - Hot water: never above the configured ceiling nor 60 °C (checked on
//     arrival and right before the bytes leave), whole degrees only.
//   - Success only when the value read back after the write is the one
//     asked; the previous value read back is "sent, not applied yet"; a
//     write without its echo is "sent, without confirmation"; a write that
//     never left is "nothing sent". Acked within ~3.5 s, never waiting for
//     a publication to Gladys.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, numberOf, targetKey } from './config.js';
import { DHW_CAP, DHW_SETPOINT, ROOM_SETPOINT, SECOND, TIMINGS } from './constants.js';
import {
  COMMANDS,
  buildDevice,
  configuredModules,
  deviceIds,
  moduleId,
  moduleStates,
  parseId,
  reportedRoles,
} from './devices.js';
import { ERRORS, MODE_NAMES, T, age, join, word } from './i18n.js';
import {
  BLOCKS,
  KINDS,
  MODE_CODES,
  REGISTERS,
  SELECTABLE_MODES,
  decodeModule,
  decodeWord,
  registerOf,
  tenthsWord,
} from './lambda.js';
import {
  ERROR_KINDS,
  ILLEGAL_DATA_ADDRESS,
  ModbusClient,
  PRIORITY,
  errorReason,
} from './modbus/client.js';
import { StatePublisher } from './publisher.js';
import { FileStore, emptyData } from './store.js';

/**
 * Modbus exception codes that say a write was not applied: 1 illegal
 * function, 2 illegal data address, 3 illegal data value, 6 busy, 10
 * gateway path unavailable. Any other code is ambiguous.
 */
const REFUSALS = new Set([1, 2, 3, 6, 10]);

const specOf = (kind, role) => REGISTERS[kind].find((s) => s.role === role);

/** A refusal: an Error whose message is the text in the configured language. */
class Refusal extends Error {}

export class LambdaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lambda-heat-pump' }),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = new FileStore({ now }),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    /** The socket factory (tests); node:net otherwise. */
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.timings = TIMINGS;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    this.config = normalizeConfig();
    this.configured = false;
    this.generation = 0;
    this.started = false;
    this.client = undefined;
    this.clientKey = '';
    this.data = emptyData();
    this.loaded = undefined;
    this.storeOk = true;
    /** moduleId -> values of the last read. */
    this.values = new Map();
    /** moduleId -> roles seen while running (a feature never disappears). */
    this.seen = new Map();
    /** Optional blocks refused with "illegal data address": `register`. */
    this.absent = new Set();
    this.failedModules = [];
    this.online = undefined;
    this.failures = 0;
    this.wait = undefined;
    this.error = undefined;
    /** Monotonic time of the last successful read, and of the last read started. */
    this.readAt = -Infinity;
    this.pollStartedAt = -Infinity;
    this.pollTimer = undefined;
    this.running = undefined;
    this.followUps = new Set();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** hc index -> { key, code, protective } : the mode request held (written again every 20 s). */
    this.holds = new Map();
    this.refreshTimer = undefined;
    this.refreshing = undefined;
    /** `dhw-<i>` / `hc-<i>` -> number: a protective command bumps it (what was queued before is dropped). */
    this.epochs = new Map();
    /** target -> sensitive command in flight; target -> protectives being sent. */
    this.inFlight = new Map();
    this.protecting = new Map();
    /** `dhw-<i>` / `hc-<i>` -> { at (wall), sends, register, word, value }: a floor not confirmed yet. */
    this.floors = new Map();
    /** `${target}:${role}` -> { from, expected, moved, until (monotonic) }: a setpoint sent, not seen yet. */
    this.guards = new Map();
    this.connectAttempt = 0;
    /** The first start of the process has run (the last read kept in /data counted). */
    this.restarted = false;
    /** stop() ran (the container stops): nothing is armed again. */
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------------

  /** At process start, before Gladys is reached: a stop kept in /data leaves at once. */
  boot() {
    if (!this.loaded) {
      this.loaded = this.loadStore();
    }
    return this.loaded;
  }

  async loadStore() {
    let data;
    try {
      data = await this.store.load();
    } catch {
      data = emptyData();
      this.store.unavailable = true;
    }
    this.storeOk = !this.store.unavailable;
    this.data = data;
    const at = this.now();
    for (const [key, hold] of Object.entries(data.holds)) {
      if (hold.mode === 'off' && !this.holds.has(Number(key))) {
        this.holds.set(Number(key), { key: 'off', code: MODE_CODES.off, protective: true });
      }
    }
    for (const [target, floor] of Object.entries(data.floors)) {
      const [kind, i] = target.split('-');
      const role = kind === 'dhw' ? 'setpoint' : 'room-setpoint';
      const value = kind === 'dhw' ? DHW_SETPOINT.floor : ROOM_SETPOINT.min;
      if (!this.floors.has(target) && at - floor.at < TIMINGS.floorExpiry) {
        this.floors.set(target, {
          ...floor,
          register: registerOf(kind, Number(i), specOf(kind, role).at),
          word: tenthsWord(value),
          value,
        });
      }
    }
    if (!this.client && data.target && (this.holds.size > 0 || this.floors.size > 0)) {
      this.useClient(data.target);
    }
    if (this.holds.size > 0) {
      this.logger.info(
        `Heating circuits held off from /data: ${[...this.holds.keys()].map((i) => i + 1).join(', ')}`,
      );
      this.armRefresh(0);
    }
    if (this.floors.size > 0) {
      this.resendFloors();
    }
  }

  useClient(target) {
    const key = `${target.host}:${target.port}#${target.unitId}`;
    if (this.client && this.clientKey === key) {
      return;
    }
    this.client?.close();
    this.clientKey = key;
    this.client = new ModbusClient({
      host: target.host,
      port: target.port,
      unitId: target.unitId,
      timers: this.timers,
      monotonic: this.monotonic,
      ...(this.connect ? { connect: this.connect } : {}),
    });
  }

  async start(raw = {}) {
    await this.boot();
    const previous = this.running;
    this.generation += 1;
    this.clearPolling();
    await previous;
    const before = targetKey(this.config);
    const countsBefore = JSON.stringify(this.config.counts);
    this.config = normalizeConfig(raw);
    if (this.configured && JSON.stringify(this.config.counts) !== countsBefore) {
      // Other modules to read: at once.
      this.pollStartedAt = -Infinity;
    }
    this.configured = true;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    const target = this.config.address
      ? { ...this.config.address, unitId: this.config.unitId }
      : undefined;
    if (!target) {
      await this.publishAll();
      return;
    }
    if (targetKey(this.config) !== before && this.clientKey !== targetKey(this.config)) {
      // Another controller: what was read of the first one is dropped.
      this.values.clear();
      this.absent.clear();
      this.readAt = -Infinity;
      this.pollStartedAt = -Infinity;
      this.online = undefined;
      this.failures = 0;
    }
    this.useClient(target);
    if (JSON.stringify(this.data.target) !== JSON.stringify(target)) {
      this.data.target = target;
      this.saveData();
    }
    await this.setStatus(false, T.connecting);
    // Never sooner than the interval, a restart included (the last read is kept in /data).
    const mono = this.monotonic();
    const wall = this.now();
    // The last read kept in /data counts at the first start of the process only.
    const last = this.restarted ? undefined : this.data.lastPollAt;
    this.restarted = true;
    const sinceLast = Number.isFinite(last) && last <= wall ? wall - last : Infinity;
    const wait = Math.max(0, this.dueAt(mono) - mono, this.interval - sinceLast);
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    this.connectAttempt += 1;
    this.clearPolling();
    if (this.refreshTimer !== undefined) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.client?.close();
    this.client = undefined;
    this.clientKey = '';
    this.publisher.stop();
  }

  clearPolling() {
    if (this.pollTimer !== undefined) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
  }

  /** `later(fn, ms)`: for the getConfig() retries of src/handlers.js. */
  later(fn, ms) {
    this.timers.setTimeout(fn, ms);
  }

  /** getConfig() failed: said in the status (the stops held keep going). */
  async configUnread() {
    await this.boot();
    await this.setStatus(false, T.configUnread);
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery list,
   * badges) and the states still fresh. No extra read.
   */
  async connected(raw = {}) {
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      !this.configured ||
      next.pollInterval !== this.config.pollInterval ||
      targetKey(next) !== targetKey(this.config) ||
      next.invalid !== this.config.invalid ||
      JSON.stringify(next.counts) !== JSON.stringify(this.config.counts)
    );
  }

  /** A new address, unit, interval or module count restarts; the rest applies at once. */
  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- /data -------------------------------------------------------------------------

  snapshot() {
    const holds = {};
    for (const [index, hold] of this.holds) {
      if (hold.key === 'off') {
        holds[index] = { mode: 'off', at: this.data.holds[index]?.at ?? this.now() };
      }
    }
    const floors = {};
    for (const [target, floor] of this.floors) {
      floors[target] = { at: floor.at, sends: floor.sends };
    }
    this.data = { ...this.data, holds, floors };
    return this.data;
  }

  /** Saves what is kept; resolves true when written. Never throws. */
  async saveData() {
    try {
      await this.store.save(this.snapshot());
      return true;
    } catch (err) {
      if (this.storeOk) {
        this.logger.warn(`/data not written: ${err.message}`);
      }
      this.storeOk = false;
      return false;
    }
  }

  // --- Polling -------------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** When the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    const spacing = this.online === false ? (this.wait ?? this.interval) : this.interval;
    return Math.min(this.pollStartedAt + spacing, mono + spacing);
  }

  schedule(wait) {
    if (this.pollTimer !== undefined) {
      this.timers.clearTimeout(this.pollTimer);
    }
    const generation = this.generation;
    this.pollTimer = this.timers.setTimeout(
      () => {
        this.pollTimer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Refresh failed: ${err.message}`));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    if (!this.client || !this.config.address) {
      return Promise.resolve();
    }
    if (!this.running) {
      this.running = this.poll().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async poll() {
    const generation = this.generation;
    const client = this.client;
    this.pollStartedAt = this.monotonic();
    // The time of the attempt is kept before the read: a restart loop never reads faster.
    this.data.lastPollAt = this.now();
    await this.saveData();
    if (generation !== this.generation) {
      return;
    }
    let preempted = false;
    try {
      const { values, failed } = await this.readModules(client);
      if (generation !== this.generation || client !== this.client) {
        return;
      }
      this.values = values;
      this.failedModules = failed;
      this.readAt = this.monotonic();
      this.online = true;
      this.failures = 0;
      this.wait = undefined;
      this.error = undefined;
      this.observe();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err.kind === ERROR_KINDS.PREEMPTED) {
        // Cut by a stop: not a failure, read again shortly.
        preempted = true;
      } else {
        this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation !== this.generation) {
      return;
    }
    if (preempted) {
      this.schedule(TIMINGS.preemptedRetry);
    } else {
      const mono = this.monotonic();
      this.schedule(this.dueAt(mono) - mono);
    }
    this.resendFloors();
  }

  /** Every configured module, block by block. A connection-level error fails the read. */
  async readModules(client) {
    const values = new Map();
    const failed = [];
    for (const { kind, index } of configuredModules(this.config.counts)) {
      const words = new Map();
      let moduleFailed = false;
      for (const block of BLOCKS[kind]) {
        const start = registerOf(kind, index, block.at);
        if (this.absent.has(start)) {
          continue;
        }
        try {
          const read = await client.readHolding(start, block.count, { priority: PRIORITY.POLL });
          read.forEach((word, i) => words.set(start + i, word));
        } catch (err) {
          if (err.kind !== ERROR_KINDS.EXCEPTION) {
            throw err;
          }
          if (block.optional && err.code === ILLEGAL_DATA_ADDRESS) {
            this.absent.add(start);
            this.logger.info(`Register ${start} not served: not read again until a restart`);
          } else {
            moduleFailed = true;
          }
        }
      }
      const id = moduleId(kind, index);
      if (moduleFailed) {
        failed.push(id);
      }
      values.set(id, decodeModule(kind, index, words));
    }
    return { values, failed };
  }

  failed(err) {
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.online = false;
    this.wait = wait;
    this.error = reason;
    const address = this.config.address ? addressKey(this.config.address) : '?';
    this.logger.warn(`Heat pump ${address}: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /** Whether the values read are current enough to be published as such. */
  fresh(mono = this.monotonic()) {
    return this.online === true && mono - this.readAt < TIMINGS.freshFor(this.interval);
  }

  rolesFor(kind, index) {
    const id = moduleId(kind, index);
    const seen = this.seen.get(id) ?? new Set();
    for (const role of reportedRoles(kind, this.values.get(id))) {
      seen.add(role);
    }
    this.seen.set(id, seen);
    return seen;
  }

  // --- Gladys ----------------------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, kind, index }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseId(device?.external_id);
      if (
        id &&
        !id.role &&
        deviceIds(this.gladys, id.kind, id.index).device === device.external_id
      ) {
        list.push({ device, ...id });
      }
    }
    return list;
  }

  isConfigured(kind, index) {
    if (kind === 'system') {
      return index === 0;
    }
    return index >= 0 && index < this.config.counts[KINDS[kind].count];
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    if (!this.config.address) {
      return;
    }
    const devices = configuredModules(this.config.counts)
      .map(({ kind, index }) =>
        buildDevice(this.gladys, kind, index, {
          roles: this.rolesFor(kind, index),
          language: this.config.language,
          created: this.createdDevice(deviceIds(this.gladys, kind, index).device),
        }),
      )
      .filter((d) => d.features.length > 0);
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states of our created devices: fresh values only, or "unreachable" texts. */
  queueStates(created = this.createdFeatures()) {
    const mono = this.monotonic();
    const fresh = this.fresh(mono);
    for (const { kind, index } of this.ourDevices()) {
      if (this.online === undefined) {
        continue;
      }
      const online = fresh && this.isConfigured(kind, index);
      if (this.online === true && !online && this.isConfigured(kind, index)) {
        // Read a while ago and not since: nothing republished as new.
        continue;
      }
      const ids = deviceIds(this.gladys, kind, index);
      const states = moduleStates(ids, kind, this.values.get(moduleId(kind, index)), {
        online,
        language: this.config.language,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    const fresh = this.fresh();
    for (const { device, kind, index } of this.ourDevices()) {
      if (this.online === undefined) {
        continue;
      }
      const online = fresh && this.isConfigured(kind, index);
      entries.push({
        external_id: device.external_id,
        transport: online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  withInvalid(message) {
    return this.config.invalid ? join([message, T.invalid(this.config.invalid)]) : message;
  }

  status() {
    if (!this.config.address) {
      return [false, this.withInvalid(T.noAddress)];
    }
    const address = addressKey(this.config.address);
    if (this.online === false) {
      return [false, T.unreachable(address, this.error, age(this.wait))];
    }
    if (this.online === undefined) {
      return [false, T.connecting];
    }
    const notes = [];
    if (this.failedModules.length > 0) {
      notes.push(T.notes.failing(this.failedModules.join(', ')));
    }
    const held = [...this.holds].filter(([, h]) => h.key === 'off').map(([i]) => i + 1);
    if (held.length > 0) {
      notes.push(T.notes.held(held.join(', ')));
    }
    if (!this.storeOk) {
      notes.push(T.notes.storeUnavailable);
    }
    return [true, T.connected(address, notes)];
  }

  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------------

  /** Shows the state; reads only when the interval allows it (a read running is joined). */
  async testConnection() {
    if (!this.config.address) {
      return this.withInvalid(T.noAddress);
    }
    if (this.running) {
      await this.running;
    } else {
      const mono = this.monotonic();
      if (mono >= this.dueAt(mono)) {
        await this.tick();
      }
    }
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- The commands ----------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /**
   * The command a feature asks for, checked strictly: `{ kind, index, role,
   * target, register, word, value, key?, protective }`.
   */
  parseCommand(feature, value) {
    const id = parseId(feature?.external_id);
    if (!id?.role || !COMMANDS[id.kind]?.includes(id.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { kind, index, role } = id;
    const spec = specOf(kind, role);
    const register = registerOf(kind, index, spec.at);
    const target = `${kind}-${index}`;
    if (role === 'mode') {
      if (typeof value !== 'string' || !SELECTABLE_MODES.includes(value)) {
        throw this.refusal(ERRORS.badMode);
      }
      if (value === 'release') {
        return { ...id, target, register, key: value, value, protective: false };
      }
      const code = MODE_CODES[value];
      return {
        ...id,
        target,
        register,
        key: value,
        value,
        word: code < 0 ? code + 0x10000 : code,
        protective: value === 'off',
      };
    }
    const number = typeof value === 'string' && value.trim() === '' ? undefined : numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (kind === 'hc') {
      if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
        throw this.refusal(ERRORS.badStep(0.1));
      }
      const tenths = Math.round(number * 10) / 10;
      if (tenths < ROOM_SETPOINT.min || tenths > ROOM_SETPOINT.max) {
        throw this.refusal(ERRORS.outOfRange(ROOM_SETPOINT.min, ROOM_SETPOINT.max));
      }
      return {
        ...id,
        target,
        register,
        value: tenths,
        word: tenthsWord(tenths),
        protective: tenths === ROOM_SETPOINT.min,
      };
    }
    // Hot water: whole degrees, never above the hard ceiling nor the configured one.
    if (!Number.isInteger(number)) {
      throw this.refusal(ERRORS.badStep(1));
    }
    if (number < DHW_SETPOINT.floor || number > DHW_CAP.max) {
      throw this.refusal(ERRORS.outOfRange(DHW_SETPOINT.floor, DHW_CAP.max));
    }
    if (number > this.config.dhwCap) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
    return {
      ...id,
      target,
      register,
      value: number,
      word: tenthsWord(number),
      protective: number === DHW_SETPOINT.floor,
    };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const command = this.parseCommand(feature, value);
    if (command.protective) {
      return this.acked(this.protective(command, received), command, received);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (!this.client || !this.isConfigured(command.kind, command.index)) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if ((this.protecting.get(command.target) ?? 0) > 0) {
      throw this.refusal(ERRORS.stopRunning);
    }
    if (this.inFlight.has(command.target)) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.sensitive(command, received).finally(() => {
      if (this.inFlight.get(command.target) === promise) {
        this.inFlight.delete(command.target);
      }
    });
    this.inFlight.set(command.target, promise);
    return this.acked(promise, command, received);
  }

  /**
   * The ack to Gladys (which gives up at 5 s): the outcome when known by
   * 3.4 s after the click; otherwise the command is acked as accepted and
   * goes on (queued behind other modules' commands on a slow controller),
   * its outcome logged. Its own deadlines still hold.
   */
  acked(promise, command, received) {
    const name = `${moduleId(command.kind, command.index)} ${command.role}`;
    let timer;
    const ack = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve('pending'),
        Math.max(0, received + TIMINGS.ack - this.monotonic()),
      );
    });
    return Promise.race([promise.then(() => 'done'), ack])
      .then((result) => {
        if (result === 'pending') {
          this.logger.info(`${name}: ${command.value} accepted, still running`);
          promise.catch((err) => this.logger.warn(`${name}: ${command.value}: ${err.message}`));
        }
      })
      .finally(() => this.timers.clearTimeout(timer));
  }

  epochOf(target) {
    return this.epochs.get(target) ?? 0;
  }

  // --- Protective commands: the stop of a circuit, a setpoint at its floor ---------------

  /**
   * Sent at once, whatever the option, the reads or the commands in
   * progress; never refused for a missing read. Kept (the stop held, the
   * floor pending) before the first byte, so a failure is written again.
   */
  async protective(command, received) {
    const { target, kind, index } = command;
    this.epochs.set(target, this.epochOf(target) + 1);
    this.guards.delete(`${target}:${command.role}`);
    if (kind === 'hc' && command.role === 'mode') {
      this.holds.set(index, { key: 'off', code: MODE_CODES.off, protective: true });
      this.data.holds[index] = { mode: 'off', at: this.now() };
    } else {
      this.floors.set(target, {
        at: this.now(),
        sends: 0,
        register: command.register,
        word: command.word,
        value: command.value,
      });
    }
    // Kept in /data without delaying the bytes: a failed write of /data never stops a stop.
    const saved = this.saveData();
    if (!this.client) {
      // No address known yet (configuration unread, nothing in /data): kept in memory.
      this.armRefresh(TIMINGS.holdRefresh);
      await saved;
      const kept = command.role === 'mode' ? ERRORS.holdKept : ERRORS.floorKept;
      throw this.refusal(join([ERRORS.notSent('no address yet'), kept]));
    }
    this.protecting.set(target, (this.protecting.get(target) ?? 0) + 1);
    const client = this.client;
    this.updateStatus().catch(() => {});
    try {
      const outcome = await this.sendProtective(client, command, received);
      this.followUp();
      if (command.role === 'mode') {
        this.armRefresh(TIMINGS.holdRefresh);
      }
      if (outcome.confirmed) {
        if (command.role !== 'mode') {
          this.floors.delete(target);
          this.saveData();
        }
        this.logger.info(`${moduleId(kind, index)} ${command.role}: ${command.value} (confirmed)`);
        return;
      }
      const kept = command.role === 'mode' ? ERRORS.holdKept : ERRORS.floorKept;
      this.logger.warn(`${moduleId(kind, index)} ${command.role}: ${command.value} not confirmed`);
      throw this.refusal(join([outcome.message, kept]));
    } finally {
      this.protecting.set(target, (this.protecting.get(target) ?? 1) - 1);
      await saved;
    }
  }

  /** The write (tried again once within its budget), then the read back. */
  async sendProtective(client, command, received) {
    const options = {
      priority: PRIORITY.URGENT,
      startBy: received + TIMINGS.protectiveSendBy,
      timeoutMs: TIMINGS.requestTimeout,
    };
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.writeRegisters(command.register, [command.word], options);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const mono = this.monotonic();
        const retry =
          attempt === 0 &&
          !err.sent &&
          err.kind !== ERROR_KINDS.LATE &&
          mono + TIMINGS.protectiveRetry < options.startBy;
        if (!retry) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetry));
      }
    }
    if (lastError) {
      return { confirmed: false, message: this.writeFailure(lastError) };
    }
    return this.readBack(client, command, {
      priority: PRIORITY.URGENT,
      timeoutMs: TIMINGS.requestTimeout,
    });
  }

  /** What a failed write means for the user. */
  writeFailure(err) {
    const reason = errorReason(err);
    if (!err.sent) {
      return err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason);
    }
    if (err.kind === ERROR_KINDS.EXCEPTION && REFUSALS.has(err.code)) {
      return ERRORS.refused(reason);
    }
    return ERRORS.sentUnconfirmed(reason);
  }

  /**
   * The register read again after an acknowledged write: confirmed only when
   * it shows the value asked; `before` (when known and different) seen again
   * is "not applied yet".
   */
  async readBack(client, command, options, before) {
    let words;
    try {
      words = await client.readHolding(command.register, 1, options);
    } catch (err) {
      return { confirmed: false, message: ERRORS.sentUnconfirmed(errorReason(err)) };
    }
    const got = words[0];
    if (got === command.word) {
      return { confirmed: true };
    }
    if (before !== undefined && got === before) {
      return { confirmed: false, message: ERRORS.notApplied };
    }
    return { confirmed: false, message: ERRORS.readBack(this.describe(command, got)) };
  }

  describe(command, raw) {
    const value = decodeWord(specOf(command.kind, command.role), raw);
    if (command.role === 'mode') {
      return value?.key ? word(MODE_NAMES[value.key], this.config.language) : `${value?.code}`;
    }
    return value === undefined ? '?' : `${value} °C`;
  }

  // --- Sensitive commands ------------------------------------------------------------------

  /** Checked on arrival and again right before the bytes leave. */
  checkSensitive(command, { generation, epoch, client }) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.epochOf(command.target) !== epoch) {
      throw this.refusal(ERRORS.supersededByStop);
    }
    if (generation !== this.generation || client !== this.client) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // The ceiling may have been lowered since the command arrived.
    if (
      command.kind === 'dhw' &&
      (command.value > this.config.dhwCap || command.value > DHW_CAP.max)
    ) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  async sensitive(command, received) {
    const context = {
      generation: this.generation,
      epoch: this.epochOf(command.target),
      client: this.client,
    };
    this.checkSensitive(command, context);
    const { client } = context;
    if (command.key === 'release') {
      // Nothing written: the request held is no longer repeated and lapses.
      this.holds.delete(command.index);
      delete this.data.holds[command.index];
      await this.saveData();
      this.followUp();
      this.updateStatus().catch(() => {});
      return;
    }
    // The register just before acting, never the value in memory.
    let fresh;
    try {
      [fresh] = await client.readHolding(command.register, 1, {
        priority: PRIORITY.COMMAND,
        startBy: received + TIMINGS.freshReadStartBy,
        timeoutMs: TIMINGS.requestTimeout,
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    this.checkSensitive(command, context);
    const spec = specOf(command.kind, command.role);
    const current = decodeWord(spec, fresh);
    if (current === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    const key = `${command.target}:${command.role}`;
    if (command.role !== 'mode' && fresh === command.word && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    const previousHold = this.holds.get(command.index);
    let installed;
    const beforeSend = () => {
      this.checkSensitive(command, context);
      // From here the command leaves: it replaces what was pending for its target.
      if (command.role === 'mode') {
        installed = { key: command.key, code: MODE_CODES[command.key], protective: false };
        this.holds.set(command.index, installed);
        delete this.data.holds[command.index];
      } else {
        this.floors.delete(command.target);
      }
    };
    this.logger.info(`${moduleId(command.kind, command.index)} ${command.role}: ${command.value}`);
    try {
      await client.writeRegisters(command.register, [command.word], {
        priority: PRIORITY.COMMAND,
        startBy: received + TIMINGS.sendBy,
        timeoutMs: TIMINGS.requestTimeout,
        beforeSend,
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const message = this.writeFailure(err);
      if (!err.sent || (err.kind === ERROR_KINDS.EXCEPTION && REFUSALS.has(err.code))) {
        // Not applied: what was held before is held again.
        this.restoreHold(command, installed, previousHold);
        if (err.sent) {
          this.followUp();
        }
        throw this.refusal(message);
      }
      this.afterSensitive(command, key, fresh);
      throw this.refusal(message);
    }
    this.afterSensitive(command, key, fresh);
    const outcome = await this.readBack(
      client,
      command,
      { priority: PRIORITY.COMMAND, timeoutMs: TIMINGS.requestTimeout },
      fresh === command.word ? undefined : fresh,
    );
    if (!outcome.confirmed) {
      throw this.refusal(outcome.message);
    }
    // Read back as asked: nothing left to guard.
    this.guards.delete(key);
  }

  afterSensitive(command, key, fresh) {
    if (command.role === 'mode') {
      this.armRefresh(TIMINGS.holdRefresh);
    } else {
      this.guard(key, { from: fresh, expected: command.word });
    }
    this.saveData();
    this.followUp();
  }

  restoreHold(command, installed, previousHold) {
    if (command.role !== 'mode' || !installed || this.holds.get(command.index) !== installed) {
      return;
    }
    if (previousHold) {
      this.holds.set(command.index, previousHold);
      if (previousHold.key === 'off') {
        this.data.holds[command.index] = { mode: 'off', at: this.now() };
      }
    } else {
      this.holds.delete(command.index);
    }
    this.saveData();
  }

  /** Reads after a command, spaced: its effect, then a check. */
  followUp() {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUps.delete(handle);
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Refresh failed: ${err.message}`));
        }
      }, delay);
      this.followUps.add(handle);
    }
  }

  // --- The requests held: written again every 20 s -------------------------------------------

  armRefresh(delay) {
    if (this.holds.size === 0 || this.stopped) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      if (delay >= TIMINGS.holdRefresh) {
        return;
      }
      this.timers.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshHolds()
        .catch((err) => this.logger.warn(`Writing the held modes again failed: ${err.message}`))
        .finally(() => this.armRefresh(TIMINGS.holdRefresh));
    }, delay);
  }

  /** Each held request written again: a stop first and urgent; the others only while allowed. */
  async refreshHolds() {
    const client = this.client;
    if (!client) {
      return;
    }
    const writes = [];
    for (const [index, hold] of this.holds) {
      if (!hold.protective && !this.config.allowCommands) {
        // No longer allowed: the request lapses, the controller follows its own setting.
        this.holds.delete(index);
        this.logger.info(
          `Heating circuit ${index + 1}: ${hold.key} no longer written (commands disabled)`,
        );
        continue;
      }
      const register = registerOf('hc', index, specOf('hc', 'mode').at);
      writes.push(
        client
          .writeRegisters(register, [hold.code < 0 ? hold.code + 0x10000 : hold.code], {
            priority: hold.protective ? PRIORITY.URGENT : PRIORITY.COMMAND,
            timeoutMs: TIMINGS.requestTimeout,
            beforeSend: () => {
              if (this.holds.get(index) !== hold || client !== this.client) {
                throw new Error('replaced');
              }
              if (!hold.protective && !this.config.allowCommands) {
                throw new Error('disabled');
              }
            },
          })
          .catch((err) => {
            if (!err.beforeSend) {
              this.logger.warn(
                `Heating circuit ${index + 1}: ${hold.key} not written again (${errorReason(err)})`,
              );
            }
          }),
      );
    }
    await Promise.all(writes);
  }

  // --- Floors not confirmed: written again by the next reads (3 times at most) ---------------

  resendFloors() {
    const client = this.client;
    if (!client || this.floors.size === 0) {
      return;
    }
    const at = this.now();
    let changed = false;
    for (const [target, floor] of this.floors) {
      if ((this.protecting.get(target) ?? 0) > 0) {
        continue;
      }
      const [kind, i] = target.split('-');
      const shown = this.online === true ? this.values.get(moduleId(kind, Number(i))) : undefined;
      const role = kind === 'dhw' ? 'setpoint' : 'room-setpoint';
      if (shown?.[role] === floor.value) {
        this.floors.delete(target);
        changed = true;
        continue;
      }
      if (
        floor.sends >= TIMINGS.floorResends ||
        at < floor.at ||
        at - floor.at >= TIMINGS.floorExpiry
      ) {
        this.floors.delete(target);
        changed = true;
        this.logger.warn(`${target}: floor setpoint not confirmed, no longer written`);
        continue;
      }
      floor.sends += 1;
      changed = true;
      client
        .writeRegisters(floor.register, [floor.word], {
          priority: PRIORITY.URGENT,
          timeoutMs: TIMINGS.requestTimeout,
          beforeSend: () => {
            if (this.floors.get(target) !== floor) {
              throw new Error('replaced');
            }
          },
        })
        .catch((err) => {
          if (!err.beforeSend) {
            this.logger.warn(`${target}: floor setpoint not written (${errorReason(err)})`);
          }
        });
    }
    if (changed) {
      this.saveData();
    }
  }

  // --- Guards ---------------------------------------------------------------------------------

  /**
   * After a setpoint sent, until a read shows it: a new command is always
   * sent, never answered "already so". A read equal to the start value or
   * unknown lifts nothing until a move was seen.
   */
  guard(key, plan) {
    this.guards.set(key, { ...plan, moved: false, until: this.monotonic() + TIMINGS.guard });
  }

  guardActive(key, mono = this.monotonic()) {
    const guard = this.guards.get(key);
    if (guard && mono >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  observe() {
    const mono = this.monotonic();
    for (const [key, guard] of [...this.guards]) {
      if (!this.guardActive(key, mono)) {
        continue;
      }
      const [target, role] = key.split(':');
      const [kind, i] = target.split('-');
      const value = this.values.get(moduleId(kind, Number(i)))?.[role];
      if (value === undefined) {
        continue;
      }
      const shown = tenthsWord(value);
      if (shown !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && shown === guard.expected) {
        this.guards.delete(key);
      }
    }
  }
}
