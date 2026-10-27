// -----------------------------------------------------------------------------
// The Modbus client against the fake controller and the kit's raw servers:
// frames, one request at a time, priorities, the cut of a frozen request by
// an urgent one (on a new connection, after the old one closed), deadlines,
// bounded frames, the idle close.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, ModbusClient, PRIORITY } from '../src/modbus/client.js';
import { testClock } from './kit/clock.mjs';
import { tcpServer } from './kit/tcp.mjs';
import { fakeLambda } from './fixtures/fakeLambda.js';
import { sleep, waitFor } from './helpers/setup.js';

async function client(t, server, clock = testClock(), unitId = 1) {
  const c = new ModbusClient({
    host: '127.0.0.1',
    port: server.port,
    unitId,
    timers: clock.timers,
    monotonic: clock.monotonic,
  });
  t.after(() => c.close());
  return { c, clock };
}

test('reads with function 3, writes with function 16 (one register), the echo checked', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c } = await client(t, lambda);
  assert.deepEqual(await c.readHolding(2050, 1), [500]);
  assert.deepEqual(await c.writeRegisters(2050, [450]), [450]);
  assert.equal(lambda.regs.get(2050), 450);
  const write = lambda.writes()[0];
  assert.deepEqual([write.fn, write.address, write.count, write.values], [16, 2050, 1, [450]]);
});

test('an exception is a refusal; the connection stays', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c } = await client(t, lambda);
  await assert.rejects(c.readHolding(1014, 1), {
    kind: ERROR_KINDS.EXCEPTION,
    code: 2,
    sent: true,
  });
  assert.deepEqual(await c.readHolding(0, 2), [0, 1]);
  assert.equal(lambda.connections, 1);
});

test('requests never overlap on the wire, in priority order', async (t) => {
  const lambda = await fakeLambda({ latencyMs: 5 });
  t.after(() => lambda.close());
  const { c } = await client(t, lambda);
  const order = [];
  const jobs = [
    c.readHolding(0, 2, { priority: PRIORITY.POLL }).then(() => order.push('poll1')),
    c.readHolding(3, 2, { priority: PRIORITY.POLL }).then(() => order.push('poll2')),
    c.readHolding(2050, 1, { priority: PRIORITY.COMMAND }).then(() => order.push('command')),
    c.writeRegisters(5006, [0], { priority: PRIORITY.URGENT }).then(() => order.push('urgent')),
  ];
  await Promise.all(jobs);
  // The first one was already on the wire; then urgent, command, poll.
  assert.deepEqual(order, ['poll1', 'urgent', 'command', 'poll2']);
  assert.equal(lambda.glued, 0, 'never two requests in one chunk');
  assert.equal(lambda.peak, 1);
});

test('an urgent write cuts a request frozen for 1 s, then reconnects after the close', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c, clock } = await client(t, lambda);
  await c.readHolding(0, 2);
  lambda.silent = (r) => r.fn === 3;
  const frozen = c.readHolding(5000, 7, { timeoutMs: 60_000 }).catch((err) => err);
  await waitFor(() => lambda.reads().length === 2, 'the frozen read on the wire');
  const urgent = c.writeRegisters(5006, [0], { priority: PRIORITY.URGENT });
  await sleep(20);
  assert.equal(lambda.writes().length, 0, 'not before the request went quiet for 1 s');
  await clock.advance(1_000);
  assert.equal((await frozen).kind, ERROR_KINDS.PREEMPTED);
  assert.equal((await frozen).sent, true);
  await urgent;
  assert.equal(lambda.regs.get(5006), 0);
  assert.equal(lambda.peak, 1, 'never two connections at once');
  assert.equal(lambda.connections, 2);
});

test('an urgent write does not cut a request that is still answering', async (t) => {
  const server = await tcpServer({
    onData: (chunk, conn) => {
      // Answers the read in two halves, 600 ms apart (real time; virtual time follows).
      if (chunk[7] === 3) {
        const answer = Buffer.from([chunk[0], chunk[1], 0, 0, 0, 5, 1, 3, 2, 0, 42]);
        conn.write(answer.subarray(0, 5));
        setTimeout(() => conn.write(answer.subarray(5)), 30);
        return undefined;
      }
      const echo = Buffer.from(chunk.subarray(0, 12));
      echo.writeUInt16BE(6, 4);
      return echo;
    },
  });
  t.after(() => server.close());
  const { c, clock } = await client(t, server);
  const read = c.readHolding(1, 1, { timeoutMs: 60_000 });
  await waitFor(() => server.received.length === 1, 'the read sent');
  await clock.advance(600);
  const urgent = c.writeRegisters(5006, [0], { priority: PRIORITY.URGENT });
  // A byte came within the second: the read completes, then the write.
  assert.deepEqual(await read, [42]);
  await urgent;
  assert.equal(server.connections, 1);
});

test('a request still queued at its deadline is LATE, never sent', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c, clock } = await client(t, lambda);
  lambda.silent = () => true;
  const stuck = c.readHolding(0, 2, { timeoutMs: 5_000 }).catch((err) => err);
  await waitFor(() => lambda.log.length === 1, 'the first read');
  const late = c
    .writeRegisters(2050, [450], {
      priority: PRIORITY.COMMAND,
      startBy: clock.monotonic() + 1_000,
    })
    .catch((err) => err);
  await clock.advance(1_000);
  assert.equal((await late).kind, ERROR_KINDS.LATE);
  assert.equal((await late).sent, false);
  await clock.advance(4_000);
  assert.equal((await stuck).kind, ERROR_KINDS.TIMEOUT);
  assert.equal((await stuck).sent, true);
  assert.equal(lambda.writes().length, 0);
});

test('beforeSend runs right before the bytes; what it throws sends nothing', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c } = await client(t, lambda);
  await assert.rejects(
    c.writeRegisters(2050, [450], {
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (err) => err.beforeSend === true && err.message === 'option off',
  );
  assert.equal(lambda.writes().length, 0);
});

test('an answer that is not ours drops the connection: wrong echo, oversized, unsolicited', async (t) => {
  let mode = 'echo';
  const server = await tcpServer({
    onData: (chunk) => {
      if (mode === 'echo') {
        const out = Buffer.from(chunk.subarray(0, 12));
        out.writeUInt16BE(6, 4);
        out.writeUInt16BE(9, 10); // another quantity
        return out;
      }
      // A frame announcing 300 bytes.
      const out = Buffer.alloc(270);
      chunk.copy(out, 0, 0, 4);
      out.writeUInt16BE(300, 4);
      return out;
    },
  });
  t.after(() => server.close());
  const { c } = await client(t, server);
  await assert.rejects(c.writeRegisters(2050, [450]), { kind: ERROR_KINDS.PROTOCOL, sent: true });
  mode = 'big';
  await assert.rejects(c.readHolding(0, 1), { kind: ERROR_KINDS.PROTOCOL });
  await waitFor(() => server.open === 0, 'the connection dropped');
});

test('the connection is closed after 45 s idle (the controller closes at 60 s)', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const { c, clock } = await client(t, lambda);
  await c.readHolding(0, 2);
  await sleep(5);
  await clock.advance(44_000);
  await sleep(10);
  assert.equal(lambda.open, 1);
  await clock.advance(1_100);
  await waitFor(() => lambda.open === 0, 'the idle close');
  assert.deepEqual(await c.readHolding(0, 2), [0, 1]);
});

test('another unit id is not answered: a timeout, never a value', async (t) => {
  const lambda = await fakeLambda({ unitId: 2 });
  t.after(() => lambda.close());
  const { c, clock } = await client(t, lambda);
  const read = c.readHolding(0, 2).catch((err) => err);
  await waitFor(() => lambda.log.length === 1, 'the read');
  await clock.advance(3_000);
  assert.equal((await read).kind, ERROR_KINDS.TIMEOUT);
});

test('invalid requests are refused before anything is sent', async () => {
  const c = new ModbusClient({ host: '127.0.0.1', port: 1, unitId: 1 });
  await assert.rejects(c.readHolding(0, 126), RangeError);
  await assert.rejects(c.writeRegisters(0, [0x10000]), RangeError);
  await assert.rejects(c.writeRegisters(0, []), RangeError);
  c.close();
});

test('an answer with another transaction id drops the connection', async (t) => {
  const server = await tcpServer({
    onData: (chunk) => {
      const out = Buffer.from([0, 0, 0, 0, 0, 5, 1, 3, 2, 0, 42]);
      out.writeUInt16BE((chunk.readUInt16BE(0) + 1) & 0xffff, 0);
      return out;
    },
  });
  t.after(() => server.close());
  const { c } = await client(t, server);
  await assert.rejects(c.readHolding(1, 1), { kind: ERROR_KINDS.PROTOCOL });
  await waitFor(() => server.open === 0, 'the connection dropped');
});

test('a connection still being opened is joined: never two at once', async (t) => {
  const lambda = await fakeLambda();
  t.after(() => lambda.close());
  const clock = testClock();
  let dials = 0;
  const net = await import('node:net');
  const c = new ModbusClient({
    host: '127.0.0.1',
    port: lambda.port,
    unitId: 1,
    timers: clock.timers,
    monotonic: clock.monotonic,
    connect: (options) => {
      dials += 1;
      return net.createConnection(options);
    },
  });
  t.after(() => c.close());
  const late = c.readHolding(0, 2, { startBy: clock.monotonic() }).catch((err) => err);
  const next = c.readHolding(0, 2);
  await late;
  assert.deepEqual(await next, [0, 1]);
  assert.equal(dials, 1);
  assert.equal(lambda.peak, 1);
});
