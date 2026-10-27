# Lambda heat pump for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for
Lambda heat pumps (EU-L series), over the local Modbus TCP interface of their
controller: no cloud, no account.

> This integration has never been tested with a real device. Not affiliated
> with Lambda Wärmepumpen.

- One device per module: system and energy manager, heat pumps, hot water
  tanks, buffer tanks, heating circuits (temperatures, COP, compressor rating,
  heating output, power drawn, states, errors, setpoints).
- Stopping a heating circuit is always allowed: held, written again every
  20 s, kept across a restart.
- Other modes, the room setpoint and the hot water setpoint only with the
  "Allow the commands" option (off by default); hot water capped at 55 °C by
  default, never above 60 °C.
- Modbus has no password: keep the heat pump on a trusted network.

User guide: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test            # node --test
npm run lint
npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the rules and [TODO.md](TODO.md) for the
status and the decisions.

## Credits and license

Register map from the manufacturer's manual ("Modbus-Protokoll 1.0"),
checked against [lambda_heat_pumps](https://github.com/GuidoJeuken-6512/lambda_heat_pumps)
(MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Licensed under
the Apache License 2.0 ([LICENSE](LICENSE)).
