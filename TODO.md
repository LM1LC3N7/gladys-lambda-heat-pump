# TODO — Lambda heat pump v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-10-27, lot 17): Modbus TCP read of one
      Lambda controller (system and energy manager, 1–5 heat pumps, 0–5 hot
      water tanks, 0–5 buffer tanks, 0–12 heating circuits), one device per
      module, stop of a heating circuit always allowed (held), floor
      setpoints protective, modes and setpoints behind `allow_commands`,
      hot water ceiling, docs en/fr, cover. Tested against a fake controller
      only.
- [ ] **Milestone 2 — real controller**: run against a real one (see "To
      check"), turn register dumps into fixtures.
- [ ] **Milestone 3 — more**: solar modules (index 4), the buffer maximum and
      the heating curve offset as commands, the energy statistics (32-bit,
      word order per firmware) as an index with the approved guard of
      gladys-p1-monitor, once proven cumulative.

## To check on a real controller

- The COP register (1x13, "Wirkungsgrad", unit "[---]" in the 2026 manual):
  read as COP × 100 as the reference does (421 = 4.21).
- How long a mode request (5x06) lasts when it is not written again: held
  requests are written every 20 s (forum reports: every 4 minutes is enough).
- Whether 5x06 reads back the value written at once (the read back of the
  commands relies on it), and reads -1 once the request lapsed.
- Whether 5x07, 1x19, 0100–0104 and 3x50 are served on the firmware in the
  field (absent blocks are skipped after an "illegal data address").
- How many Modbus clients the controller accepts at once.
- Whether a mode chosen at the panel shows in 5x06 (the hold relies on it to
  let go); until confirmed, another Modbus client is the proven way.

## Decisions

- **Review r3 (2026-10-27)**:
  - B1: a stop whose request before is unknown (clicked during an outage, no
    fresh read; /data without it) is never let go on the request it
    overrides. Of the two fixes asked, both halves are kept, as the safest
    together: until a read shows the stop applied (0), the first documented
    request read (-1 to 7) becomes `from` (in /data) and is written over;
    once the stop was read applied, a request 2 to 6 read twice lets go (a
    change made after it). Requiring 0 alone would write over a newer mode
    set elsewhere while the controller never applied the stop (fiche: the
    resend never targets a newer move) and would never show the "not
    applied" note; adopting alone would also adopt a change made after the
    stop took.
  - Same doubt, found here: a read back that is not a documented request
    (0x8000, -3000, an unknown code) no longer replaces a known `from` (it
    made the stop not applied look like a change); `from` from memory or
    /data is kept only when documented.
  - Status: dates in the time zone of Gladys (TZ, given to the container),
    UTC said only when the zone is unknown; one note for every circuit held
    (12 at most), the way out said once ("a mode other than the one
    requested before the stop").
  - Docs: a mode chosen meanwhile is lost at the start-up write; only a newer
    choice, other than the request before the stop, ends it. Panel exit
    marked as to be confirmed in "Not done".
  - Tests: s17 (both outcomes), the stop read applied then changed, `from`
    from the read back and from /data, an unknown code never kept as `from`,
    the start-up write (s19), the release
    note cleared, a failure after an "accepted" ack, local time, the bounded
    note; the "joined" dial test now holds the dial open (it joined nothing).

- **Review r2 (2026-10-27)**:
  - B1: the stop keeps the request read before it (`from`, in /data). It is
    let go only when two reads in a row, 2 s apart (`holdConfirm`), show a
    documented request 2 to 6 other than 0 and `from`; nothing is written
    between them. An unknown code, -3000, -1, 1 or 7 (read only: kept as not
    a proof, decided by the lot rules), a failed read, or `from` itself (the
    stop not applied: noted in the status after 3 reads) are written over.
  - B2: a floor whose replaced value is unknown is written again in doubt (3
    times, 15 min), dropped only on a value other than a known `from`.
  - Lot rule after the CTC r2: a stop never ends by time. The 24 h limit stays
    for the other modes held, on the monotonic clock. The status says since
    when a stop is held and how to end it.
  - I1: every refusal of a commandable feature, before the queue included,
    publishes the value read again.
  - The start-up write of a stop kept in /data stays without a read (fiche);
    the docs say a panel change made meanwhile is overwritten once, then
    respected from the next refresh. `resumed` is cleared only once that
    write was acknowledged.
  - Minors: `released` cleared by a new hold of the circuit; notices fence
    closed (three backticks on both sides); tests for the failed read, the
    joined dial, another address and the offline notes.

- **Review r1 (2026-10-27)**:
  - B1: the client is created from the controller kept in /data at boot,
    whatever is held; a stop or a floor leaves while getConfig() keeps
    failing (retried 5 s doubling to 60 s, status "could not be read" plus
    the hold note). Test in `test/holds.test.js`.
  - I1 (decided by the lot rules, as for CTC): restarting the heating from
    Gladys ("No request" or another mode) stays sensitive. The hold lets go
    by itself: the mode is read before each refresh write and another mode
    than ours (not -1) ends it; 24 h after the click; circuit removed from
    the configuration, device deleted, address cleared or changed. Said in
    the status, the log and the docs.
  - I2: a floor keeps the value it replaced (`from`, in /data) and is written
    again only while a read shows it or nothing; never "already so" while a
    floor lives; a newer setpoint refused or not sent gives the floor back.
  - I3: any command not confirmed (before or after the ack) publishes the
    value read again (`forgetPublishedStates` of the feature).
  - I4 and minors: tests for the epoch, hot water without the option,
    "No request" without the option, the option in beforeSend (command and
    refresh), the guard, the transaction id, the ack time, the unreadable
    fresh value, the retry of a stop; a dial under way is joined (never two
    connections); the read back of a protective knows the value before; the
    hold notes in every status; a failing refresh warns once per streak;
    notices fence closed.

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-lambda-heat-pump:0.1.0`);
  the first patch release gives 0.1.1. SDK 0.16.0 (latest published,
  2026-10-27).
- **Reference**: the manufacturer's manual "Modbus-Protokoll 1.0" (LAMBDA
  Wärmepumpen GmbH, 2026, lambda-wp.com) for every register, format, unit and
  code; lambda_heat_pumps V2.8.6 (MIT, LICENSE in the name of "Your Name", an
  unfilled template, cited as is) cloned read only in
  `~/code/ref/lot17/lambda_heat_pumps` to check them. Notices in
  `THIRD_PARTY_NOTICES.md`, shipped in the image with `LICENSE`.
- **No firmware choice in the configuration** (the reference has one): the
  firmware only changes the 32-bit word order (not read here) and whether
  5x07 exists (an optional block, skipped once refused). One field less to
  get wrong.
- **Own Modbus client** (as gladys-stiebel-eltron): functions 3 and 16 only
  (the manual forbids function 6), one request on the wire, a priority queue
  (URGENT > COMMAND > POLL), a request quiet for 1 s cut by an urgent one,
  a new connection only after the old one closed (FIN, then 500 ms at most),
  closed after 45 s idle (the controller closes at 60 s). Runtime
  dependency: the SDK only.
- **Module counts typed**, not auto-detected: the reference's detection
  counts a module as present when a register answers, which an absent module
  may also do with 0x8000. A module that refuses its core block is noted in
  the status ("Not read").
- **Values**: 0x8000 and -3000 never published; plausibility ranges; the
  energy statistics (1x20–1x23) never read; `inverter-power` and the system
  `power-consumption` as `energy-sensor/power` (W), never an index.
- **Device ids**: `lambda:system`, `lambda:<kind>-<n>`, n from 1. Modbus has
  no serial nor MAC: one controller per integration.
- **Mode = a held request**: data points below 50 "must be written
  regularly" (manual). A mode set by Gladys is written again every 20 s while
  held. Only the stop (`off`) is kept in /data and resumed at start-up
  (before getConfig, with the target kept in /data); any other mode is
  dropped at a restart and when the option is turned off (lot 16 lesson: no
  command replayed after a restart without a click). "No request"
  (`release`) writes nothing: the request lapses.
- **Protective commands**: `off` (any circuit 1–12, configured or not) and
  the floors (room 15 °C, hot water 25 °C). Independent of the option, a
  fresh read, a command or read in progress (URGENT priority, frozen read
  cut), the configuration (boot), /data (saved without delaying the bytes).
  Tried again once after 250 ms when not sent. A floor not read back is
  written again by the next 3 reads, within 15 min (kept in /data). A stop
  bumps its circuit's epoch: a sensitive command queued before it fails its
  `beforeSend`. A newer mode replaces the stop only from its `beforeSend`
  (it has left); refused by the controller or not sent, the stop is held
  again.
- **/data and the sensitive commands**: none of them keeps anything in /data,
  so a failed `save()` never blocks them. A mode replacing a held stop removes
  the stop from /data after it left; if that save fails, the stop is resumed
  at the next start-up (the safe side), said in the status.
- **Sensitive commands**: option checked on arrival and in `beforeSend`
  (the hold refresh too); fresh read of the register; one at a time per
  module (never per controller); refused while a stop of the circuit is
  being sent. Hot water whole degrees 25 to min(ceiling, 60); room setpoint
  tenths 15–40 (manual range).
- **Ack and deadlines**: the outcome is answered by 3.4 s; a command still
  queued then is acked as accepted and its outcome logged (a scene on five
  circuits of a slow controller sets them all: requests are serialized on
  one connection). A sensitive command leaves within 10 s of the click or
  never (its fresh read started by 8 s); a protective one within 20 s.
  Success only on the read back; the previous value read back = "not
  applied yet"; no answer = "sent, without confirmation" (guard 90 s:
  the same value is sent again, never "already so").
- **Polling**: 30 s by default, 10 s – 10 min; failures 30 s, 1, 2, 5 min,
  never shorter than the interval; the time of each read kept in /data
  first, so a restart never reads sooner (a future date is ignored); the
  test button reads only when the interval allows it; a read cut by a stop
  is not a failure (read again 2 s later).
- **Freshness**: at a reconnection or a device creation only values read
  within max(90 s, 3 × interval) are published.
- **Categories** `climate`, `energy`; transport `local`; `gladys_version
  > =5.1.0`; no `keywords`nor`countries` (store fields left out on purpose).
- **Trusted network**: Modbus has no authentication; said in the manifest,
  the docs and the README.
