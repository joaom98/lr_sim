# Long Range Small Arms Simulator

A precision-rifle simulator where the physics are the game. Feature selection and roadmap:
[FEATURES.md](FEATURES.md).

## Layout

| Path | What |
|---|---|
| `crates/ballistics` | Ballistics core in Rust: no graphics or platform code, SI units throughout |
| `crates/ballistics-wasm` | WebAssembly bindings (plain JS objects in and out, camelCase) |
| `data/` | Rifle, ammunition and optic profiles (JSON, in shooter units) |
| `web/` | Browser front end (Vite + TypeScript): ballistic calculator (`index.html`) and 3-D range (`range.html`) |

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

## 3-D range (milestone 2)

`web/range.html` is a Three.js known-distance range (100–1500 m, steel and paper) where every
shot is flown by the engine:

- Scope with true field of view per magnification, MIL tree and MOA hash reticles, correct
  first- and second-focal-plane behaviour, eye-box shadow, illumination
- Elevation and windage turrets with click values, travel limits and zero stop
- Shooter model: six positions, breathing with the natural respiratory pause, breath hold with
  oxygen debt, heart rate and pulse, settling after moving, trigger disturbance, recoil
- Three wind zones with gusts; flags and trees show the same wind field the bullets fly through
- Laser rangefinder, weather meter (wind at the firing point only) and an in-game calculator
- Real flight time, steel swing and ring delayed by the speed of sound, dust on misses,
  spotter calls in mil or MOA, electronic target, shot log
- Cold bore, barrel heating, MV and BC spread per shot, magazine and bolt cycling
- Every shot is saved locally as a `ShotRecord` (`lrs.shots.v1`): the basis for progression later

Range layouts live in `data/ranges.json`; each target sits on its own bearing so none hides another.

## Learning from every shot (milestone 3)

- **Why did I miss?** Every shot aimed at a target is re-flown with one error removed at a
  time, splitting the miss exactly into hold/sway, trigger, parallax, cant, ammo variation,
  elevation data and wind call (`web/src/range/analysis.ts`). The parts sum to the real miss.
- **Coaching:** one hint per shot about the biggest error (breathing, trigger, cant, wind…)
- **Cant:** each position leaves a small unnoticed cant; the view rolls, a bubble level sits
  above the eyepiece, Q / E levels the rifle, and the engine flies the canted shot
- **Parallax:** side-focus knob (`[` / `]`). Wrong focus blurs the picture and lets head
  movement in the eye box shift the point of aim
- **Mirage:** heat shimmer that runs with the crosswind near the focus distance, boils in calm
  air and flattens in strong wind; stronger on hot, dry days and at high magnification
- **Bullet cam:** `B` replays the last shot at 0.2× from behind the bullet
- Shot records now include the cant and the error breakdown

## Drills and career (milestone 4)

Pick a mode on the range menu. Free range is a sandbox; drills score you and earn XP.

| Drill | What it trains |
|---|---|
| Zero the rifle | Scope starts 0.5–1.2 mil off. Group, dial the correction, set zero (`K`), confirm |
| Cold bore | One shot, no sighters, 300–700 m |
| Known-distance ladder | 300 → 1000 m, two rounds per plate |
| Wind reading | Calculator gives elevation only; call the wind from flags and mirage |
| Unknown distance | No rangefinder, no signs: mil-range the plate, type the range (`N`) |
| PRS-style stage | 105 s, eight plates, forced move from prone to barricade, raised heart rate |
| Extreme long range | 1000 / 1200 / 1500 m, three rounds per plate |

- **Career** (`data/career.json`): XP scales with the score; five ranks from Novice to Master
  unlock rifles, scopes and harder drills. Locks apply in drills only.
- **Statistics:** lifetime hit rate by distance band and your most common error source,
  computed from the shot records.
- The laser rangefinder now models a ~1.5 × 0.8 mrad beam and reports steel in the beam
  ahead of ground behind it.
- Storage keys: `lrs.shots.v1` (shots, incl. `drillId`), `lrs.career.v1` (XP, best scores).

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

`npm run dev` rebuilds the WebAssembly module, then serves the calculator on http://localhost:5173
and the range on http://localhost:5173/range.html.

## Validation

`crates/ballistics/tests/physics.rs` checks the solver against closed-form solutions (vacuum
trajectory, Coriolis), standard-atmosphere constants, the direction of every effect,
determinism, and the JSON API contract.

`crates/ballistics/tests/reference.rs` compares against trajectories from independent
calculators in `crates/ballistics/tests/reference/*.json` (±0.1 mil to 1000 m, ±0.2 mil to
2000 m). **No fixtures yet.** Add cases from a trusted calculator; the README in that folder
gives the format.
