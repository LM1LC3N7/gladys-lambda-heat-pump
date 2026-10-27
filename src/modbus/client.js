// -----------------------------------------------------------------------------
// A minimal Modbus TCP client on node:net, for a Lambda controller: read
// holding registers (function 3) and write multiple registers (function 16),
// the only two functions the manual allows. Written here rather than taken
// from npm (as gladys-stiebel-eltron, see TODO.md "Decisions"): the rules of
// a local protocol in one place.
//
//   - One request on the wire at a time, never two: an answer is always the
//     answer of the one request in flight (transaction id, protocol 0, unit
//     id, function code, byte count, the echo of a write all checked; any
//     mismatch drops the connection).
//   - Requests wait in a queue by priority: URGENT (a stop, a floor
//     setpoint), COMMAND, then POLL; in order within a priority. An URGENT
//     request never waits behind a frozen one: a request in flight without
//     a byte for a second is cut (it fails PREEMPTED, which the polling does
//     not count as a failure), and the new connection is opened only once
//     the old socket is closed.
//   - Bounded: a frame is 260 bytes at most, a read 125 registers at most; a
//     byte beyond the frame, or with no request in flight, drops the
//     connection; a request that times out drops it too, so a late answer is
//     never taken for the next one.
//   - `sent` says whether the request may have reached the socket: a write
//     that may have left is never reported "not sent".
//   - The controller closes a connection idle for a minute: ours is closed
//     after 45 s without a request.
//   - Deadlines (`startBy`, `answerBy`) are on the monotonic clock.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** No TCP connection could be opened: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time (the connection is dropped). */
  TIMEOUT: 'timeout',
  /** The connection closed while a request was in flight. */
  CLOSED: 'closed',
  /** An answer that does not belong to the request (the connection is dropped). */
  PROTOCOL: 'protocol',
  /** A Modbus exception answer: the controller refused the request. */
  EXCEPTION: 'exception',
  /** Still waiting (queue or connection) at its deadline: nothing was sent. */
  LATE: 'late',
  /** Cut by an urgent request while frozen (sent, no answer). */
  PREEMPTED: 'preempted',
};

export const PRIORITY = { URGENT: 0, COMMAND: 1, POLL: 2 };

/** Modbus exception code 2: the register is not served by this controller. */
export const ILLEGAL_DATA_ADDRESS = 2;

export class ModbusError extends Error {
  constructor(kind, { code, sent = false, detail } = {}) {
    super(code === undefined ? kind : `${kind} ${code}`);
    this.name = 'ModbusError';
    this.kind = kind;
    this.code = code;
    this.sent = sent;
    this.detail = detail;
  }
}

/** A short reason for the logs and the messages: our own words only. */
export function errorReason(err) {
  if (err instanceof ModbusError) {
    return err.kind === ERROR_KINDS.EXCEPTION ? `Modbus exception ${err.code}` : err.kind;
  }
  return 'error';
}

const FUNCTION = { READ_HOLDING: 3, WRITE_MULTIPLE: 16 };
const HEADER = 7;
const isWord = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff;

export class ModbusClient {
  constructor({
    host,
    port,
    unitId,
    connect = (options) => net.createConnection(options),
    timers = globalThis,
    monotonic = () => performance.now(),
  }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.connect = connect;
    this.timers = timers;
    this.monotonic = monotonic;
    this.queue = [];
    this.seq = 0;
    /** The job on the wire (connecting, sending or waiting for its answer). */
    this.current = undefined;
    this.socket = undefined;
    /** Resolves once the last dropped socket is closed. */
    this.closing = undefined;
    this.pending = undefined;
    this.transaction = 0;
    this.closed = false;
    /** The TCP connection being opened, shared by the requests that wait for it. */
    this.connecting = undefined;
    this.idleTimer = undefined;
    this.frozenTimer = undefined;
  }

  // --- Public ------------------------------------------------------------------

  readHolding(address, count, options = {}) {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(count) ||
      address < 0 ||
      count < 1 ||
      count > LIMITS.registersPerRead ||
      address + count > 0x10000
    ) {
      return Promise.reject(new RangeError('Invalid Modbus read'));
    }
    const pdu = Buffer.from([
      FUNCTION.READ_HOLDING,
      address >> 8,
      address & 0xff,
      count >> 8,
      count & 0xff,
    ]);
    return this.enqueue(pdu, options, (answer) => {
      const bytes = answer[1];
      if (answer.length < 2 || bytes !== count * 2 || answer.length !== 2 + bytes) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'byte count' });
      }
      const words = [];
      for (let i = 0; i < count; i += 1) {
        words.push(answer.readUInt16BE(2 + i * 2));
      }
      return words;
    });
  }

  /** Function 16, one register or more; the answer must echo address and quantity. */
  writeRegisters(address, words, options = {}) {
    if (
      !isWord(address) ||
      !Array.isArray(words) ||
      words.length < 1 ||
      words.length > 123 ||
      !words.every(isWord) ||
      address + words.length > 0x10000
    ) {
      return Promise.reject(new RangeError('Invalid Modbus write'));
    }
    const pdu = Buffer.alloc(6 + words.length * 2);
    pdu.writeUInt8(FUNCTION.WRITE_MULTIPLE, 0);
    pdu.writeUInt16BE(address, 1);
    pdu.writeUInt16BE(words.length, 3);
    pdu.writeUInt8(words.length * 2, 5);
    words.forEach((w, i) => pdu.writeUInt16BE(w, 6 + i * 2));
    const echo = pdu.subarray(0, 5);
    return this.enqueue(pdu, options, (answer) => {
      if (!answer.equals(echo)) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'echo' });
      }
      return words;
    });
  }

  /** Drops the connection for good (a stop, another address). */
  close() {
    this.closed = true;
    this.clearIdle();
    this.clearFrozen();
    for (const job of this.queue.splice(0)) {
      this.timers.clearTimeout(job.lateTimer);
      job.reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
    }
    this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
  }

  /** Whether a request is on the wire or waiting. */
  get busy() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  // --- The queue -----------------------------------------------------------------

  enqueue(pdu, options, check) {
    if (this.closed) {
      return Promise.reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
    }
    const priority = options.priority ?? PRIORITY.POLL;
    return new Promise((resolve, reject) => {
      const job = { pdu, options, check, priority, seq: (this.seq += 1), resolve, reject };
      if (options.startBy !== undefined) {
        job.lateTimer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new ModbusError(ERROR_KINDS.LATE));
            }
          },
          Math.max(0, options.startBy - this.monotonic()),
        );
      }
      this.queue.push(job);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      if (priority === PRIORITY.URGENT) {
        this.checkFrozen();
      }
      this.pump();
    });
  }

  pump() {
    if (this.current || this.queue.length === 0 || this.closed) {
      return;
    }
    const job = this.queue.shift();
    this.timers.clearTimeout(job.lateTimer);
    this.clearIdle();
    this.current = job;
    this.run(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.current = undefined;
        this.clearFrozen();
        if (this.queue.length === 0) {
          this.armIdle();
        }
        this.pump();
      });
  }

  /**
   * An urgent request is waiting behind another one: the request in flight
   * is cut once it has gone a second without a byte; checked again then.
   */
  checkFrozen() {
    this.clearFrozen();
    const job = this.current;
    const pending = this.pending;
    if (!job || job.priority === PRIORITY.URGENT || !pending || pending.job !== job) {
      return;
    }
    if (!this.queue.some((queued) => queued.priority === PRIORITY.URGENT)) {
      return;
    }
    const quietFor = this.monotonic() - pending.lastByteAt;
    if (quietFor >= TIMINGS.frozen) {
      this.drop(new ModbusError(ERROR_KINDS.PREEMPTED, { sent: true }));
      return;
    }
    this.frozenTimer = this.timers.setTimeout(
      () => this.checkFrozen(),
      Math.max(1, TIMINGS.frozen - quietFor),
    );
  }

  clearFrozen() {
    if (this.frozenTimer !== undefined) {
      this.timers.clearTimeout(this.frozenTimer);
      this.frozenTimer = undefined;
    }
  }

  armIdle() {
    this.clearIdle();
    if (!this.socket) {
      return;
    }
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.current && this.queue.length === 0) {
        this.drop(new ModbusError(ERROR_KINDS.CLOSED));
      }
    }, TIMINGS.idleClose);
  }

  clearIdle() {
    if (this.idleTimer !== undefined) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  // --- One request -----------------------------------------------------------------

  /**
   * One request and its answer. `timeoutMs`: the whole request (connection
   * included); or `startBy` (the last moment it may leave) and `answerBy`
   * (the last moment to wait for its answer). `beforeSend`: a last check run
   * once connected, right before the bytes leave; what it throws is
   * rethrown with `beforeSend: true`, nothing sent.
   */
  async run(job) {
    const { timeoutMs = TIMINGS.requestTimeout, startBy, answerBy, beforeSend } = job.options;
    const end = answerBy ?? this.monotonic() + timeoutMs;
    const leaveBy = Math.min(startBy ?? end, end);
    await this.open(leaveBy);
    if (this.monotonic() > leaveBy) {
      throw new ModbusError(ERROR_KINDS.LATE);
    }
    const socket = this.socket;
    if (!socket || this.pending || this.closed) {
      throw new ModbusError(ERROR_KINDS.UNREACHABLE);
    }
    // The last check, then the bytes leave in the same turn: nothing runs in between.
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    this.transaction = (this.transaction % 0xffff) + 1;
    const tid = this.transaction;
    const frame = Buffer.alloc(HEADER + job.pdu.length);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(job.pdu.length + 1, 4);
    frame.writeUInt8(this.unitId, 6);
    job.pdu.copy(frame, HEADER);
    return new Promise((resolve, reject) => {
      const pending = {
        job,
        tid,
        fn: job.pdu[0],
        check: job.check,
        buffer: Buffer.alloc(0),
        lastByteAt: this.monotonic(),
        resolve,
        reject,
        timer: undefined,
      };
      pending.timer = this.timers.setTimeout(
        () => this.fail(pending, new ModbusError(ERROR_KINDS.TIMEOUT, { sent: true }), true),
        Math.max(0, end - this.monotonic()),
      );
      this.pending = pending;
      // From here the request may reach the controller: `sent` in every error.
      socket.write(frame);
      if (this.queue.some((queued) => queued.priority === PRIORITY.URGENT)) {
        this.checkFrozen();
      }
    });
  }

  /** The connection, opened when needed (after the old one closed); gives up at `by`. */
  async open(by) {
    if (this.socket && (this.socket.destroyed || this.socket.writable === false)) {
      // Closed by the controller, its 'close' not seen yet: never write into it.
      this.drop(new ModbusError(ERROR_KINDS.CLOSED));
    }
    if (this.socket) {
      return;
    }
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new ModbusError(ERROR_KINDS.LATE)),
        Math.max(0, by - this.monotonic()),
      );
    });
    try {
      if (this.closing) {
        await Promise.race([this.closing, late]);
      }
      // A dial still under way (its first caller gave up) is joined, never doubled.
      if (!this.connecting) {
        const connecting = this.dial().finally(() => {
          if (this.connecting === connecting) {
            this.connecting = undefined;
          }
        });
        connecting.catch(() => {});
        this.connecting = connecting;
      }
      await Promise.race([this.connecting, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  dial() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const timer = this.timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket?.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE, { detail: 'connect timeout' }));
        }
      }, TIMINGS.connectTimeout);
      try {
        socket = this.connect({ host: this.host, port: this.port });
      } catch {
        settled = true;
        this.timers.clearTimeout(timer);
        reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        return;
      }
      socket.on('error', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
      socket.once('connect', () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        this.timers.clearTimeout(timer);
        if (this.closed || this.socket) {
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
          return;
        }
        socket.setNoDelay?.(true);
        this.socket = socket;
        socket.on('data', (chunk) => this.receive(socket, chunk));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
          }
        });
        resolve();
      });
      socket.once('close', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
    });
  }

  receive(socket, chunk) {
    if (socket !== this.socket) {
      return;
    }
    const pending = this.pending;
    if (!pending) {
      // Nothing was asked: not an answer of ours.
      this.drop(new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true }));
      return;
    }
    pending.lastByteAt = this.monotonic();
    pending.buffer = Buffer.concat([pending.buffer, chunk]);
    const fail = (detail) =>
      this.fail(pending, new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail }), true);
    if (pending.buffer.length > LIMITS.frameBytes) {
      fail('too long');
      return;
    }
    if (pending.buffer.length < HEADER) {
      return;
    }
    const buffer = pending.buffer;
    const length = buffer.readUInt16BE(4);
    if (buffer.readUInt16BE(2) !== 0 || length < 2 || length > LIMITS.frameBytes - 6) {
      fail('header');
      return;
    }
    const total = 6 + length;
    if (buffer.length < total) {
      return;
    }
    if (buffer.length > total) {
      fail('trailing bytes');
      return;
    }
    if (buffer.readUInt16BE(0) !== pending.tid || buffer.readUInt8(6) !== this.unitId) {
      fail('transaction');
      return;
    }
    const answer = buffer.subarray(HEADER, total);
    if (answer[0] === (pending.fn | 0x80)) {
      if (answer.length !== 2) {
        fail('exception');
        return;
      }
      // A well-formed refusal: the connection stays.
      this.fail(pending, new ModbusError(ERROR_KINDS.EXCEPTION, { code: answer[1], sent: true }));
      return;
    }
    if (answer[0] !== pending.fn) {
      fail('function');
      return;
    }
    let value;
    try {
      value = pending.check(answer);
    } catch (err) {
      this.fail(pending, err, true);
      return;
    }
    this.settle(pending);
    pending.resolve(value);
  }

  settle(pending) {
    this.timers.clearTimeout(pending.timer);
    if (this.pending === pending) {
      this.pending = undefined;
    }
  }

  fail(pending, err, dropConnection = false) {
    if (this.pending !== pending) {
      return;
    }
    this.settle(pending);
    pending.reject(err);
    if (dropConnection) {
      this.drop(err);
    }
  }

  /**
   * Closes the connection; a request in flight fails with `err`. The socket
   * is ended (FIN) and destroyed once closed, or after `closeWait`: a new
   * connection is opened only then, so the controller never sees two.
   */
  drop(err) {
    const socket = this.socket;
    this.socket = undefined;
    const pending = this.pending;
    if (pending) {
      this.settle(pending);
      pending.reject(err);
    }
    if (!socket) {
      return;
    }
    if (socket.destroyed) {
      return;
    }
    const closing = new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => {
        socket.destroy();
        resolve();
      }, TIMINGS.closeWait);
      socket.once('close', () => {
        this.timers.clearTimeout(timer);
        resolve();
      });
    }).finally(() => {
      if (this.closing === closing) {
        this.closing = undefined;
      }
    });
    this.closing = closing;
    socket.end();
  }
}
