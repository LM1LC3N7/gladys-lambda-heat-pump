// -----------------------------------------------------------------------------
// A fake Lambda controller on the loopback interface (the kit's tcpServer):
// Modbus TCP, function 3 (read holding registers) and 16 (write multiple
// registers) only, like the manual says; any other function gets exception 1.
// Registers live in `regs` (Map register -> word); a register missing from it
// or listed in `illegal` answers exception 2. Every request is logged.
//
// Options (changeable later on the returned object):
//   unitId (1), latencyMs, silent (fn(request) -> true: no answer),
//   writeException (fn(request) -> code), ignoreWrites (acked, not applied),
//   applyAfterMs (acked at once, applied later).
// -----------------------------------------------------------------------------

import { tcpServer } from '../kit/tcp.mjs';

const w = (value) => (value < 0 ? value + 0x10000 : value);

/** A controller with one heat pump, one hot water tank, one heating circuit. */
export function defaultRegisters() {
  const regs = new Map();
  const set = (start, values) => values.forEach((v, i) => regs.set(start + i, w(v)));
  // General: error 0, mode automatic; 0002 is write only; 1 h average 8.5, calculated 7.9 °C.
  set(0, [0, 1]);
  set(3, [85, 79]);
  // E-manager: error 0, automatic, grid 0, 1450 W drawn, setpoint 2000 W.
  set(100, [0, 1, 0, 1450, 2000]);
  // Heat pump 1: no error, regulation, heating, 35.20/30.10 °C, 1200 l/h... COP 4.21.
  set(1000, [0, 0, 7, 1, 3520, 3010, 1200, 620, 310, 150, 4500, 52, 1250, 421]);
  set(1019, [0]);
  // Hot water tank 1: no error, standby, 48.5/41.0 °C, circulation 38.0 °C, pump off; setpoint 50.0 °C.
  set(2000, [0, 0, 485, 410, 380, 0]);
  set(2050, [500]);
  // Heating circuit 1: no error, heating, 34.0/29.5 °C, room 21.3 °C, flow request 0, no mode request.
  set(5000, [0, 0, 340, 295, 213, 0, -1]);
  set(5007, [345]);
  // Offset 0, room setpoint heating 21.0 °C, cooling 24.0 °C.
  set(5050, [0, 210, 240]);
  return regs;
}

export async function fakeLambda(options = {}) {
  const lambda = {
    unitId: 1,
    regs: defaultRegisters(),
    illegal: new Set(),
    silent: undefined,
    writeException: undefined,
    ignoreWrites: false,
    applyAfterMs: 0,
    /** { fn, address, count, values, conn, at } */
    log: [],
    /** Chunks that held more than one request (pipelining: never expected). */
    glued: 0,
    ...options,
  };
  const exception = (head, fn, code) => {
    const out = Buffer.alloc(9);
    head.copy(out, 0, 0, 4);
    out.writeUInt16BE(3, 4);
    out.writeUInt8(head[6], 6);
    out.writeUInt8(fn | 0x80, 7);
    out.writeUInt8(code, 8);
    return out;
  };
  const answer = (frame, conn) => {
    const unit = frame[6];
    const fn = frame[7];
    const address = frame.readUInt16BE(8);
    const count = frame.readUInt16BE(10);
    const request = { fn, address, count, conn: conn.id, at: performance.now() };
    if (fn === 16) {
      request.values = [];
      for (let i = 0; i < count; i += 1) request.values.push(frame.readUInt16BE(13 + i * 2));
    }
    lambda.log.push(request);
    if (unit !== lambda.unitId || lambda.silent?.(request)) {
      return undefined;
    }
    if (fn === 3) {
      const out = Buffer.alloc(9 + count * 2);
      for (let i = 0; i < count; i += 1) {
        const reg = address + i;
        if (lambda.illegal.has(reg) || !lambda.regs.has(reg)) return exception(frame, fn, 2);
        out.writeUInt16BE(lambda.regs.get(reg), 9 + i * 2);
      }
      frame.copy(out, 0, 0, 4);
      out.writeUInt16BE(3 + count * 2, 4);
      out.writeUInt8(unit, 6);
      out.writeUInt8(3, 7);
      out.writeUInt8(count * 2, 8);
      return out;
    }
    if (fn === 16) {
      const code = lambda.writeException?.(request);
      if (code) return exception(frame, fn, code);
      for (let i = 0; i < count; i += 1) {
        if (lambda.illegal.has(address + i)) return exception(frame, fn, 2);
      }
      const apply = () => request.values.forEach((v, i) => lambda.regs.set(address + i, v));
      if (!lambda.ignoreWrites) {
        if (lambda.applyAfterMs > 0) setTimeout(apply, lambda.applyAfterMs);
        else apply();
      }
      const out = Buffer.alloc(12);
      frame.copy(out, 0, 0, 12);
      out.writeUInt16BE(6, 4);
      return out;
    }
    return exception(frame, fn, 1);
  };
  const device = await tcpServer({
    latencyMs: options.latencyMs ?? 0,
    onData(chunk, conn) {
      const answers = [];
      let offset = 0;
      let frames = 0;
      while (offset + 7 <= chunk.length) {
        const length = chunk.readUInt16BE(offset + 4);
        const frame = chunk.subarray(offset, offset + 6 + length);
        offset += 6 + length;
        frames += 1;
        const out = answer(frame, conn);
        if (out) answers.push(out);
      }
      if (frames > 1) lambda.glued += 1;
      return answers.length > 0 ? Buffer.concat(answers) : undefined;
    },
  });
  Object.assign(lambda, {
    server: device,
    port: device.port,
    address: `127.0.0.1:${device.port}`,
    close: () => device.close(),
    writes: () => lambda.log.filter((r) => r.fn === 16),
    reads: () => lambda.log.filter((r) => r.fn === 3),
  });
  for (const key of ['peak', 'open', 'connections', 'latencyMs']) {
    Object.defineProperty(lambda, key, {
      get: () => device[key],
      set: (value) => {
        device[key] = value;
      },
    });
  }
  return lambda;
}
