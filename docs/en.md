# Lambda heat pump

Shows a Lambda heat pump (EU-L series) in Gladys through the Modbus TCP
interface of its controller, on your local network, without any cloud.

> This integration has never been tested with a real device: it follows the
> manufacturer's Modbus manual ("Modbus-Protokoll 1.0") and the Home Assistant
> integration lambda_heat_pumps. Feedback from an owner is welcome. Not
> affiliated with Lambda Wärmepumpen.

## Before you start

- The controller answers Modbus TCP on port 502, unit id 1, as delivered.
  Give it a fixed IP address in your router.
- Modbus has no password: anyone on the network can read and write the heat
  pump. Keep it on a trusted network, never reachable from the Internet.
- The controller closes a connection idle for one minute; Gladys keeps one
  connection and closes it after 45 s without a request. Another Modbus
  client (Home Assistant, an energy manager) may share the controller: each
  one writes its own requests.

## Configuration

| Field                                                       | Meaning                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| IP address of the controller                                | IPv4 address or host name, `:port` if not 502                                        |
| Modbus unit id                                              | 1 unless your installer changed it                                                   |
| Heat pumps, hot water tanks, buffer tanks, heating circuits | how many of each module, as the display shows them (1 to 5, 0 to 5, 0 to 5, 0 to 12) |
| Allow the commands                                          | off by default (see below)                                                           |
| Hot water ceiling                                           | 55 °C by default, 40 to 60 °C, never more than 60 °C                                 |
| Refresh interval                                            | 30 s by default, 10 s to 10 min                                                      |

Save, then add the devices from the Discovery tab. "Test the connection"
shows the state of the last read; it reads again only once the interval has
passed since the last read.

## Devices

One device per module, named as on the display:

- **System**: outdoor temperature (1 h average and the one of the heating
  curve), state and error number, energy manager state, power drawn by the
  heat pumps (W) and its target.
- **Heat pump n**: flow, return and source temperatures, compressor rating
  (%), heating output (kW), inverter power drawn (W), COP, error state and
  number, state, operating state, electric heater relay.
- **Hot water tank n**: top, bottom and circulation temperatures, circulation
  pump, state, error number, hot water setpoint.
- **Buffer tank n**: top and bottom temperatures, state, error number,
  maximum temperature.
- **Heating circuit n**: flow, return and room temperatures, calculated flow
  setpoint, heating curve offset, room setpoints (heating, cooling), state,
  error number, operating mode request.

A feature appears once its register gave a value: 0x8000 ("not available"),
-3000 ("sensor not connected") and values out of a plausible range are never
published. Registers that only some firmware versions serve (E-heater relay,
energy manager, calculated flow setpoint, buffer maximum) are left out when
the controller refuses them. The energy statistics of the heat pumps are not
read (their word order changed with the firmware, and they can be reset): no
energy index.

## Commands

### Stopping a heating circuit (always allowed)

Choosing **Off** in the mode of a heating circuit stops it, whatever the
"Allow the commands" option. The mode is a Modbus request the controller
forgets unless it is written again, so Gladys holds the stop: it is written
at once (before the reads waiting, a read silent for one second is cut),
read back, kept in `/data` and written again every 20 s, also after a
restart of the integration, before Gladys or its configuration are reached.

The stop is not refused for the option, a read or command in progress, a
configuration Gladys cannot read (the controller kept in `/data` is used) or
`/data` that cannot be written (the status says the stop will not survive a
restart). A stop that the controller does not acknowledge, or reads back
otherwise, is answered "not confirmed" and still written every 20 s. It waits
only when no address is known at all (no configuration and nothing in
`/data`): then it is written as soon as the address is.

Holding the stop overrides any other actor that asks for a mode through
Modbus in between, which is why Gladys reads the mode before each new write.
The hold ends, and the controller goes back to its own setting once the last
request lapses, when:

- a read shows another mode than the stop (chosen at the panel or by another
  Modbus client): Gladys never writes over it (a request that only lapsed,
  -1, is written again);
- 24 hours have passed since the click;
- the heating circuit is removed from the configuration (fewer heating
  circuits), its device is deleted, or the address is cleared or changed;
- another mode or **No request** is chosen in Gladys: both start the heating
  again, so both need "Allow the commands".

A command sent before the stop and still waiting is dropped.

### Setpoints at their minimum (always allowed)

A room setpoint of 15 °C or a hot water setpoint of 25 °C is written whatever
the option. When it is not read back, the next three reads (within 15
minutes) write it again, as long as they still show the value it replaced:
a setpoint changed since (at the panel or by a newer command) is left alone.

### Other commands (option "Allow the commands")

- **Mode** of a heating circuit: automatic, automatic heating, automatic
  cooling, frost protection, summer, or "No request". The mode chosen is held
  and written again every 20 s while the option is on; turning the option off
  stops it, and so does a restart (only a stop is kept). "Manual" and "Screed
  program" are shown by the controller but never set.
- **Room setpoint** (heating): 15 to 40 °C, tenths of a degree.
- **Hot water setpoint**: whole degrees, 25 °C up to the ceiling of the
  configuration (55 °C by default, never above 60 °C). The ceiling is checked
  when the command arrives and again right before it is sent.

Each command reads the current value first (nothing is sent when it cannot be
read), one command at a time per module. It succeeds only when the value read
back after the write is the one asked; otherwise Gladys logs "not applied
yet", "sent, without confirmation" or "nothing sent". The answer to Gladys
comes within 3.4 s; a command still waiting behind others then is accepted
and its outcome logged. It is sent within 10 s of the click, or not at all.

## Not done (yet)

- Never tested with a real controller: the register map, the COP scale and
  the delay before a mode request lapses need confirming on a real one.
- No solar module, no energy index, no PV surplus nor buffer requests (they
  must be written regularly and drive the heat pump directly).
