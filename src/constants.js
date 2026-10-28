// -----------------------------------------------------------------------------
// Constants: Modbus, manifest keys, limits and timings.
//
// A Lambda heat pump controller (EU-L series) is a Modbus TCP server, port
// 502, unit 1 by default, without authentication (Lambda "Modbus-Protokoll
// 1.0", 2026). Reads use function 3 only, writes function 16 only (even for
// one register); the controller closes a connection idle for one minute.
// The register map lives in src/lambda.js.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The Modbus unit (slave) id: 1 by default (Lambda and the reference). */
export const UNIT_ID = { min: 1, max: 247, default: 1 };

/** How many modules of each kind are read (the manual numbers them from 0). */
export const MODULE_COUNTS = {
  heat_pumps: { min: 1, max: 5, default: 1 },
  hot_water_tanks: { min: 0, max: 5, default: 1 },
  buffers: { min: 0, max: 5, default: 0 },
  heating_circuits: { min: 0, max: 12, default: 1 },
};

/** The poll interval of the configuration, in seconds (the reference reads every 30 s). */
export const POLL_INTERVAL = { min: 10, max: 600, default: 30 };

/**
 * The hot water setpoint (register 2x50) the commands may set, in °C
 * (scalding risk). The configuration chooses the ceiling between `min` and
 * `max`, 65 °C by default; nothing above 65 °C is ever written, whatever
 * the configuration says or the controller would accept (the reference
 * also stops at 65 °C). `floor` is the lowest setpoint, which is never refused.
 */
export const DHW_CAP = { min: 40, max: 65, default: 65 };
export const DHW_SETPOINT = { floor: 25 };

/**
 * The room setpoint of a heating circuit in heating (register 5x51): the
 * manual's range, 15 to 40 °C, tenths of a degree. 15 °C is the floor.
 */
export const ROOM_SETPOINT = { min: 15, max: 40 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Modbus TCP: 7 bytes of MBAP header + a PDU of 253 bytes at most. */
  frameBytes: 260,
  /** Registers in one read (Modbus: 125 at most). */
  registersPerRead: 125,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection. */
  connectTimeout: 3 * SECOND,
  /** One Modbus request of the polling. */
  requestTimeout: 3 * SECOND,
  /**
   * The controller closes a connection idle for one minute: ours is closed
   * after 45 s without a request, so a request never meets a connection the
   * controller is closing.
   */
  idleClose: 45 * SECOND,
  /** A request in flight without a byte for this long is cut by a stop. */
  frozen: SECOND,
  /** Waiting for the old socket to close before a new connection (at most). */
  closeWait: 500,
  /** Failed polls: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** A poll cut by a stop starts again after this (not a failure). */
  preemptedRetry: 2 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads the controller at most this often. */
  testCooldown: 10 * SECOND,
  /** getConfig() failing: tried again after 5 s, doubled up to 60 s, without end. */
  configRetry: 5 * SECOND,
  configRetryMax: MINUTE,
  /**
   * A heating circuit mode is a Modbus request (register 5x06, below 50:
   * "must be written regularly"): the request held is written again every
   * 20 s while it is held.
   */
  holdRefresh: 20 * SECOND,
  /** A mode held by Gladys, the stop excepted, is let go after 24 h (monotonic clock). */
  holdMax: 24 * HOUR,
  /** Another mode read before a refresh is read again this much later before letting go. */
  holdConfirm: 2 * SECOND,
  /**
   * Commands. Gladys waits 5 s for the ack: setValue answers by 3.4 s with
   * the outcome, or, when the command is still queued behind others (a
   * scene on several modules of a slow controller), acks it then and logs
   * the outcome. A sensitive command leaves within 10 s of the click or never
   * (its fresh read started by 8 s); a protective one within 20 s. Each
   * request then has 3 s for its answer.
   */
  ack: 3_400,
  freshReadStartBy: 8 * SECOND,
  sendBy: 10 * SECOND,
  protectiveSendBy: 20 * SECOND,
  /** A protective write not sent is tried again once, after this, within its budget. */
  protectiveRetry: 250,
  /** Polls after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sensitive setpoint sent keeps its guard until a read shows it, or 90 s. */
  guard: 90 * SECOND,
  /** A floor setpoint not confirmed is written again by the next reads: 3 times, within 15 min. */
  floorResends: 3,
  floorExpiry: 15 * 60 * SECOND,
  /** Values older than this are never published again as current (2 h at most). */
  freshFor: (interval) => Math.min(2 * HOUR, Math.max(90 * SECOND, 3 * interval)),
};
