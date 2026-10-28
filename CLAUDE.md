# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (0.16), its only
runtime dependency (Modbus TCP goes through our own client on `node:net`).
It reads a Lambda heat pump controller (EU-L) over local Modbus TCP and shows
one device per module. Never tested with a real device, not affiliated with
Lambda Wärmepumpen.

## Commands

```bash
npm install
npm test                                  # node --test (gi test on the VM)
node --test test/commands.test.js         # one file
npm run lint
npm run format:check
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
```

## Architecture

```
index.js                  SDK bootstrap; app.boot() writes a held stop from /data at once
src/handlers.js           SDK handlers -> the app; getConfig() retried without end
src/app.js                LambdaApp: polling, devices, states, status, commands, holds, floors
src/lambda.js             register map (manual "Modbus-Protokoll 1.0"), blocks, decoding, modes
src/modbus/client.js      Modbus TCP client (functions 3 and 16), priority queue, frozen cut
src/devices.js            modules -> Gladys devices and states (pure)
src/store.js              /data/lambda.json (target, last read, stops held, floors)
src/publisher.js          states within 300/min (monotonic window)
src/config.js             config_schema normalized
src/constants.js          limits, timings, ceilings
src/i18n.js               runtime texts (en/fr)
test/kit/                 copied from ~/code/ref/gladys-testkit (do not edit)
test/fixtures/fakeLambda.js  the fake controller on the loopback
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: devices `lambda:system`, `lambda:hp-<n>`,
  `lambda:dhw-<n>`, `lambda:buffer-<n>`, `lambda:hc-<n>` (n from 1), feature
  roles of `src/lambda.js` REGISTERS. A republished device never loses a
  feature.
- **Modbus**: function 3 to read, 16 to write (the manual's rule); one request
  on the wire at a time; priorities URGENT (stop, floor) > COMMAND > POLL; an
  urgent request cuts a request quiet for 1 s and opens the new connection
  only after the old one closed. Never the 32-bit statistics.
- **Protective** (never refused by the option, a read, a command, the
  configuration): mode `off` of a heating circuit (held, /data, every 20 s,
  at boot) and setpoints at their floor (room 15 °C, hot water 25 °C).
  The stop never ends by time; it lets go on a documented other mode (2-6,
  not `from`) read twice in a row, the circuit or the address leaving the
  configuration, the device deleted. `from` unknown (clicked during an
  outage): the first documented request read before the stop is read
  applied stands for it, never a proof. Other held modes end after 24 h. A
  floor is written again only while a read shows the value it replaced.
- **Sensitive** (`allow_commands`, off by default, checked on arrival and in
  `beforeSend`): other modes, release, other setpoints. Fresh read first; one
  per module; dropped when a stop of its circuit arrived after it (epoch).
- **Hot water**: never above the configured ceiling (65 °C default) nor 65 °C,
  whole degrees; the ceiling checked again right before the bytes leave.
- **Success** only when the read back shows the value asked.
- Never a switch or a writable binary. Units only from the core's
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`. No energy index.
- Clocks: `monotonic` for every decision, `now` only for /data dates.
- Files UTF-8 without BOM; code and comments in English; `docs/en.md` and
  `docs/fr.md` in sync; every user-visible change under `## [Unreleased]`.
