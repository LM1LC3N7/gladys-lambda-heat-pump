# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-27

### Added

- First version: Lambda heat pumps (EU-L series) over local Modbus TCP. One
  device per module (system and energy manager, heat pumps, hot water tanks,
  buffer tanks, heating circuits): temperatures, COP, compressor rating,
  heating output, power drawn, states and errors, setpoints.
- Stopping a heating circuit, always allowed: held and written again every
  20 s, kept across a restart, never ended by time; let go when a mode other
  than the one requested before the stop is read twice in a row, or when the
  circuit or the address leaves the configuration. A stop chosen during an
  outage is never let go on the request it overrides.
- Optional commands, off by default: heating circuit mode, room setpoint,
  hot water setpoint (55 °C ceiling by default, never above 60 °C).

[Unreleased]: https://github.com/LM1LC3N7/gladys-lambda-heat-pump/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-lambda-heat-pump/releases/tag/v0.1.1
