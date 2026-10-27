# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: Lambda heat pumps (EU-L series) over local Modbus TCP. One
  device per module (system and energy manager, heat pumps, hot water tanks,
  buffer tanks, heating circuits): temperatures, COP, compressor rating,
  heating output, power drawn, states and errors, setpoints.
- Stopping a heating circuit, always allowed: held and written again every
  20 s, kept across a restart; let go when another mode is asked elsewhere,
  after 24 h, or when the circuit or the address leaves the configuration.
- Optional commands, off by default: heating circuit mode, room setpoint,
  hot water setpoint (55 °C ceiling by default, never above 60 °C).

[Unreleased]: https://github.com/LM1LC3N7/gladys-lambda-heat-pump/commits/main
