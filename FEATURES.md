# Long Range Small Arms Simulator — Concept, Requirements & Feature Menu

> How to use this document: every feature has a checkbox. Tick `[x]` the ones you want,
> leave the rest. Each item has a tier tag to help you scope:
> **[MVP]** = core, needed for a credible first version ·
> **[V2]** = strong addition once the core works ·
> **[ADV]** = advanced / high effort / niche.

---

## 1. The Idea

A simulator for precision rifle shooting at long and extreme range (300 m to 3,000+ m) where
**the physics are the game**. The shooter must read the environment, compute or estimate a
firing solution, dial or hold it on a realistic optic, and execute a clean shot — then watch the
bullet fly, see where it lands, and learn why.

Core design pillars:

1. **Physically honest ballistics** — the bullet path is computed from real aerodynamic models and
   atmospheric data, not faked curves. Results should match published ballistic calculators.
2. **The shooter is the weak link** — breathing, heart rate, position, trigger control and
   fatigue produce realistic human error on top of the physics.
3. **Reading conditions is the skill** — wind, mirage, light and terrain must be observed and
   interpreted; the sim should reward good reading, not just good mouse aim.
4. **Learn from every shot** — telemetry, trajectory replay and analysis explain what happened.

Possible audiences (pick one as primary — it shapes everything else):

- [X] **Training tool** for real-world precision shooters (accuracy & data first, visuals second)
- [ ] **Game / hobby sim** for enthusiasts (fun, progression, good visuals, still realistic)
- [ ] **Educational / physics sandbox** (visualise forces, tweak parameters, experiment)
- [ ] **Ballistic calculator with a 3D range** (a "calculator you can shoot")

---

## 2. Ballistics Engine (the heart of the project)

### 2.1 Flight model
- [X] **[MVP]** Point-mass (3-DOF) trajectory solver with numerical integration (RK4 or adaptive RK45)
- [X] **[MVP]** Standard drag models: **G1** and **G7** with ballistic coefficient (BC)
- [ ] **[V2]** Additional standard models: G2, G5, G6, G8, GL, RA4 (rimfire)
- [ ] **[V2]** Custom drag curves (Cd vs. Mach tables) per bullet — far more accurate than a single BC
- [X] **[V2]** Velocity-banded / multiple BCs (BC changes with speed)
- [ ] **[ADV]** Modified point-mass (4-DOF) model including yaw of repose
- [X] **[ADV]** Full 6-DOF rigid-body model (pitch, yaw, precession, nutation) from bullet geometry
- [X] **[ADV]** Transonic instability: dispersion grows / bullet may destabilise passing Mach 1

### 2.2 Spin & stability effects
- [X] **[V2]** Gyroscopic stability factor (Miller formula) from twist rate, bullet length, mass, velocity
- [X] **[V2]** **Spin drift** (gyroscopic drift) — right-twist bullets drift right
- [X] **[V2]** **Aerodynamic jump** — vertical shift caused by crosswind at the muzzle
- [ ] **[ADV]** Stability-dependent BC penalty when the bullet is marginally stable
- [X] **[ADV]** Keyholing / tumbling for under-stabilised bullets

### 2.3 Earth effects
- [X] **[V2]** **Coriolis effect** (horizontal) — depends on latitude and shot azimuth
- [ ] **[V2]** **Eötvös effect** (vertical Coriolis component) — shooting east vs west
- [X] **[V2]** Inclined / declined shots (uphill/downhill) with correct gravity component, not just cosine rule
- [X] **[ADV]** Earth curvature for extreme range (line-of-sight drop)
- [ ] **[ADV]** Gravity variation with latitude and altitude

### 2.4 Atmosphere
- [X] **[MVP]** Air density from temperature, pressure and humidity
- [X] **[MVP]** Standard atmospheres (ICAO / Army Standard Metro) as presets
- [X] **[V2]** Station pressure vs. barometric (sea-level corrected) pressure, density altitude
- [X] **[V2]** Speed of sound varies with temperature (affects Mach number and drag)
- [X] **[ADV]** Atmosphere varies along the trajectory (altitude change on long, high-arc shots)

### 2.5 Wind
- [X] **[MVP]** Constant crosswind with direction and speed
- [X] **[V2]** **Multi-zone wind** — different wind at shooter, mid-range and target
- [X] **[V2]** Gusts and lulls (time-varying wind, e.g. Perlin noise or turbulence model)
- [X] **[V2]** Head/tail-wind effect on drop
- [ ] **[ADV]** Vertical wind (updrafts in valleys, over ridges)
- [ ] **[ADV]** Terrain-driven 3D wind field (wind channeled by hills, trees, buildings)

### 2.6 Internal ballistics / ammunition variation
- [X] **[MVP]** Muzzle velocity (MV) per load
- [X] **[V2]** MV standard deviation (shot-to-shot velocity spread) → vertical dispersion
- [X] **[V2]** Powder temperature sensitivity (MV changes with ammo temperature)
- [X] **[V2]** BC variation lot-to-lot / bullet-to-bullet
- [X] **[ADV]** Barrel length affects MV
- [X] **[ADV]** Barrel heating over a string of fire (MV shift, point-of-impact shift, mirage from barrel)
- [X] **[ADV]** Cold-bore shot behaviour
- [X] **[ADV]** Simplified internal ballistics model from powder charge (handloading sandbox)

### 2.7 Terminal ballistics
- [X] **[MVP]** Impact velocity, energy, time of flight reported per shot
- [X] **[V2]** Steel target reaction (ring, swing, knock-down threshold by energy)
- [X] **[V2]** Ricochet / splash on ground (dust puff sized by soil type)
- [ ] **[ADV]** Penetration of materials (wood, sandbags, water, glass) — optional, keep it target-focused

### 2.8 Validation (requirement, not optional)
- [X] **[MVP]** Ballistics core is a standalone, unit-tested library independent of graphics
- [X] **[MVP]** Automated tests comparing results to published reference tables (e.g. JBM Ballistics,
      manufacturer data) within a defined tolerance (e.g. ≤ 0.1 mil at 1,000 m)
- [X] **[V2]** Determinism: same inputs + same random seed ⇒ identical shot (for replays & multiplayer)

---

## 3. Weapons, Ammunition & Equipment

### 3.1 Rifles
- [X] **[MVP]** Small set of generic rifle archetypes (e.g. .308-class bolt gun, 6.5-class PRS rifle,
      .338-class magnum, .50-class anti-materiel)
- [X] **[V2]** Configurable rifle: barrel length, twist rate, sight height, weight
- [X] **[V2]** Muzzle devices: brake (less recoil, more blast), suppressor (changes MV slightly, less blast/dust)
- [X] **[V2]** Bipod, rear bag, tripod, barricade support — each changes stability
- [X] **[ADV]** Bolt manipulation, magazine changes, malfunctions
- [X] **[ADV]** Semi-auto precision rifles

### 3.2 Ammunition
- [X] **[MVP]** Ammo database: bullet weight, diameter, length, BC (G1/G7), MV, MV SD
- [X] **[V2]** Generic bullet families (match hollow-point, VLD, monolithic, etc.) with custom drag curves
- [X] **[V2]** Rimfire (.22 LR) for short-range training mode
- [X] **[ADV]** Handload editor (powder, charge, seating depth → MV and SD)

### 3.3 Optics
- [X] **[MVP]** Variable magnification scope with realistic field of view
- [X] **[MVP]** **MIL** and **MOA** reticles and turrets (match or mixed)
- [X] **[MVP]** Elevation & windage turret clicks (0.1 mil / 0.25 MOA), zero stop
- [X] **[V2]** **First Focal Plane (FFP)** vs **Second Focal Plane (SFP)** behaviour
- [X] **[V2]** Multiple reticle styles (simple mil-dot, Christmas-tree / grid, hash-mark)
- [X] **[V2]** Parallax adjustment — wrong parallax causes aiming error when the head moves
- [X] **[V2]** Eye box / scope shadow when head position is off
- [X] **[V2]** Canted rifle/reticle error + bubble level
- [ ] **[ADV]** Turret tracking error / mechanical imperfection in cheap optics
- [X] **[ADV]** Illuminated reticle, low-light performance, lens glare
- [ ] **[ADV]** Clip-on thermal / night-vision devices

### 3.4 Support gear
- [X] **[MVP]** Laser rangefinder (with realistic max range and reflectivity limits)
- [X] **[V2]** Spotting scope / binoculars with reticle for range estimation
- [X] **[V2]** Weather meter device (temperature, pressure, humidity, wind at the shooter's position only)
- [X] **[V2]** In-game **ballistic calculator** app (the shooter inputs data and gets a solution)
- [X] **[V2]** DOPE card (data-on-previous-engagements) — printable/editable
- [X] **[ADV]** Angle cosine indicator, compass, map with range lines

---

## 4. Shooter Mechanics (human factors)

- [X] **[MVP]** Reticle sway driven by position stability
- [X] **[MVP]** Breathing cycle (natural respiratory pause = best moment to shoot)
- [X] **[V2]** Heart-rate pulse visible in the reticle; rises with exertion/stress/time
- [X] **[V2]** Shooting positions: prone, kneeling, sitting, standing, supported, barricade
- [X] **[V2]** Trigger control: trigger press speed, jerk/flinch modelled as reticle disturbance
- [X] **[V2]** Natural point of aim — fighting the position causes drift
- [X] **[V2]** Recoil management & **follow-through** (spotting your own impact needs a good position)
- [X] **[ADV]** Fatigue, stamina and hold time limits
- [X] **[ADV]** Time-pressure stress mechanics in competition modes
- [X] **[ADV]** Trigger pull weight and travel as rifle parameters

---

## 5. Environment & World

- [X] **[MVP]** One open range with known distances (100 m – 1,500 m)
- [X] **[V2]** Multiple maps: flat desert, mountain valley, forest edge, coastal, urban outskirts
- [X] **[V2]** Real-world-style terrain from heightmaps (unknown distances, elevation changes)
- [X] **[ADV]** Extreme-range map (2,000 – 4,000 m)

### 5.1 Reading conditions (key gameplay)
- [X] **[MVP]** Wind flags at the range that react to the local wind field
- [X] **[V2]** Vegetation (grass, trees) that sways with local wind
- [X] **[V2]** **Mirage** rendering through the scope — direction & strength indicate wind and heat
- [X] **[V2]** Dust, smoke and rain drifting with wind
- [X] **[ADV]** Bullet **trace** visible in the scope (vapour trail in humid conditions)

### 5.2 Weather & time
- [X] **[V2]** Time of day, sun angle, lighting (affects target visibility and mirage)
- [X] **[V2]** Weather presets: clear, overcast, hot, cold, rain, fog, snow
- [X] **[ADV]** Dynamic weather that changes during a session
- [X] **[ADV]** Seasons and altitude-based environments (shooting at 3,000 m elevation)

---

## 6. Targets & Feedback

- [X] **[MVP]** Paper targets with scoring rings and impact markers
- [X] **[MVP]** Steel plates of various sizes (IPSC-style, circles, squares) with hit/miss feedback
- [X] **[V2]** Audible steel "ding" with correct sound-delay over distance (speed of sound)
- [X] **[V2]** Electronic target system view (exact impact coordinates shown on a tablet)
- [X] **[V2]** Spotter that calls misses ("low left 0.3 mil")
- [X] **[V2]** Reactive targets (spinners, falling plates, swinging gongs)
- [X] **[ADV]** Moving targets (lateral movers on rails) — requires lead calculation
- [ ] **[ADV]** Wildlife / hunting scenarios with vital zones and ethical-shot scoring

---

## 7. Game Modes

- [X] **[MVP]** **Free range** — choose rifle, ammo, distance, conditions; shoot freely
- [ ] **[MVP]** **Zeroing** — zero the rifle at 100 m before using it
- [ ] **[V2]** **Training drills** — dope the wind, known-distance ladder, cold-bore, holdovers
- [ ] **[V2]** **Precision competition** (PRS-style) — time limits, positions, multiple stages
- [ ] **[V2]** **ELR challenge** — progressively farther targets, limited shots
- [ ] **[V2]** **F-Class / benchrest** style — score-focused, prone from rest
- [ ] **[V2]** **Unknown distance** — no rangefinder; estimate with reticle
- [ ] **[ADV]** **Spotter/shooter team** mode (one calls wind, one shoots)
- [X] **[ADV]** Career / progression: unlock gear, ranges and competitions
- [ ] **[ADV]** Scenario editor for custom courses of fire

---

## 8. Analysis, Telemetry & Learning

- [X] **[MVP]** Per-shot log: range, solution used, impact offset, ToF, impact velocity, energy, conditions
- [X] **[MVP]** Group statistics: group size (MOA/mil), mean point of impact, extreme spread
- [X] **[V2]** **Bullet-cam / trajectory replay** — follow the bullet in slow motion
- [X] **[V2]** 2D trajectory charts (drop, drift, velocity, energy vs range)
- [X] **[V2]** **Error breakdown** per shot: how much miss came from wind, MV variation, sway, trigger, wrong data
- [X] **[V2]** Physics overlay mode: visualise forces, wind vectors, and the wind field along the path
- [ ] **[V2]** Export shot data (CSV / JSON)
- [X] **[ADV]** **Truing** workflow — adjust MV/BC from observed impacts, like real shooters do
- [X] **[ADV]** Coaching hints ("you shot during the exhale", "wind changed before your shot")

---

## 9. Multiplayer & Social (optional)
- [ ] **[ADV]** Leaderboards per drill/stage
- [ ] **[ADV]** Online co-op spotter/shooter
- [ ] **[ADV]** Online competitions with identical seeded conditions
- [ ] **[ADV]** Replay sharing

---

## 10. Input & Platforms

- [ ] **[MVP]** Desktop (Windows) with mouse + keyboard
- [ ] **[V2]** Gamepad support
- [ ] **[V2]** Linux / macOS builds
- [ ] **[ADV]** **VR** support (huge for immersion; positions and breathing become physical)
- [ ] **[ADV]** Hardware integration: real trigger/airsoft replica, motion-tracked rifle stock
- [X] **[ADV]** Web version (browser-based, lighter visuals)

---

## 11. Data & Modding

- [X] **[MVP]** Rifles, ammo, optics and maps defined in data files (JSON/YAML), not hardcoded
- [X] **[V2]** User-editable ammo/rifle profiles inside the app
- [ ] **[V2]** Import custom drag curves (CSV)
- [ ] **[ADV]** Mod support: custom maps, reticles, targets
- [X] **[ADV]** Ballistics engine exposed as a separate library / CLI / API for other tools

---

## 12. Technical Options (pick one stack)

| Option | Strengths | Weaknesses |
|---|---|---|
| **Unity (C#)** | Fast iteration, huge asset ecosystem, good VR support, C# fine for physics | Licence considerations, visuals need work for "AAA" look |
| **Unreal Engine 5 (C++/Blueprints)** | Best visuals out of the box (terrain, lighting, foliage), strong VR | Steeper learning curve, heavier builds |
| **Godot 4 (GDScript/C#)** | Free & open source, lightweight, easy to learn | Weaker large-terrain & high-end rendering tools |

This one chosen >>> | **Web: TypeScript + Three.js/Babylon.js** | Runs anywhere, easy to share, quick prototyping | Performance and visual ceiling lower, VR via WebXR only |
| **Python prototype (NumPy + Matplotlib/PyQt)** | Fastest way to build & validate the ballistics core | Not suitable for the final 3D sim |

Recommended architecture regardless of engine:

- [X] **Separate ballistics core library** (e.g. C#, C++ or Rust) with its own tests — the engine only renders and handles input. Make it can be run in WebAssembly together in the same environment as the application
- [ ] Fixed-step simulation (e.g. 1 ms or adaptive step) decoupled from frame rate
- [ ] Seeded random number generation for repeatable shots
- [ ] Unit system internally SI; display in metric or imperial (user choice)

---

## 13. Non-Functional Requirements

- [X] **Accuracy:** trajectory within ±0.1 mil of reference calculators to 1,000 m; ±0.2 mil to 2,000 m
- [X] **Performance:** trajectory solve < 5 ms per shot; 60 FPS (90 FPS for VR) on a mid-range GPU
- [X] **Units:** full metric / imperial support, MIL / MOA, m/s / fps, hPa / inHg
- [X] **Usability:** tutorials for every concept (BC, density altitude, wind reading, etc.)
- [X] **Accessibility:** colour-blind-safe reticles/markers, remappable controls, adjustable sway difficulty
- [ ] **Realism slider:** "arcade" ↔ "simulation" toggles for each physics effect (great for learning)
- [X] **Persistence:** save profiles, DOPE cards, and shot history locally

---

## 14. Suggested Roadmap

**Phase 0 — Ballistics core (2–4 weeks)**
Point-mass solver, G1/G7, atmosphere, constant wind, unit tests vs reference data. CLI or Python
plots to verify.

**Phase 1 — MVP range (1–2 months)**
One range map, one or two rifles, MIL scope with turrets, sway + breathing, steel & paper targets,
wind flags, shot log, zeroing and free-range modes.

**Phase 2 — Realism (2–3 months)**
Spin drift, aerodynamic jump, Coriolis, multi-zone gusting wind, mirage, MV SD, powder temp,
FFP/SFP, parallax, rangefinder, ballistic calculator, trajectory replay & error breakdown.

**Phase 3 — Content & modes**
More maps, PRS/ELR/F-Class modes, drills, unknown-distance, career progression, weather/time of day.

**Phase 4 — Advanced**
6-DOF / transonic effects, terrain wind field, VR, multiplayer, modding, hardware integration.

---

## 15. Decisions to Make First

1. Primary audience (Section 1) — training tool, game, education, or calculator-with-a-range?
2. Engine / stack (Section 12)
3. Realism target for v1 — point-mass + spin drift is usually the sweet spot
4. Units default — metric/MIL or imperial/MOA
5. Platform — desktop only, or VR from the start (VR changes input design fundamentally)
