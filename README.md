# Long Range Small Arms Simulator

A precision-rifle simulator where the physics are the game. Feature selection and roadmap:
[FEATURES.md](FEATURES.md).

## Layout

| Path | What |
|---|---|
| `crates/ballistics` | Ballistics core in Rust: no graphics or platform code, SI units throughout |
| `crates/ballistics-wasm` | WebAssembly bindings (plain JS objects in and out, camelCase) |
| `data/` | Rifle, ammunition and optic profiles (JSON, in shooter units) |
| `web/` | Browser front end (Vite + TypeScript): currently the ballistic calculator |

## Ballistics core (milestone 1)

- Point-mass (3-DOF) solver, RK4 at 0.5 ms steps
- G1 / G7 drag with a single BC or stepped velocity-banded BCs; custom Cd-vs-Mach curves
- Atmosphere: humidity-corrected density, station vs. barometric pressure, ICAO and Army
  Standard Metro presets, density altitude, ISA lapse along the trajectory
- Wind: multiple downrange zones, head/tail components, deterministic gusts over time and distance
- Miller stability, Litz spin drift and aerodynamic jump, keyholing and transonic warnings
- Full Coriolis (horizontal and Eötvös), Earth curvature, uphill/downhill, rifle cant
- Muzzle velocity from barrel length and powder temperature; zeroing in different conditions
- Seeded shot strings (MV SD, BC spread, aiming error): same seed gives the same group

## Requirements

- Rust (stable) with the `wasm32-unknown-unknown` target
- `wasm-bindgen` CLI **0.2.130** (must match `Cargo.lock`) on `PATH`
- Node.js 20+

## Commands

```bash
cargo test -p ballistics --release
```

```bash
cargo run -p ballistics --release --example table
```

```bash
cd web && npm install && npm run dev
```

`npm run dev` rebuilds the WebAssembly module, then serves the calculator on http://localhost:5173.

## Validation

`crates/ballistics/tests/physics.rs` checks the solver against closed-form solutions (vacuum
trajectory, Coriolis), standard-atmosphere constants, the direction of every effect,
determinism, and the JSON API contract.

`crates/ballistics/tests/reference.rs` compares against trajectories from independent
calculators in `crates/ballistics/tests/reference/*.json` (±0.1 mil to 1000 m, ±0.2 mil to
2000 m). **No fixtures yet.** Add cases from a trusted calculator; the README in that folder
gives the format.
