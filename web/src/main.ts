import "./style.css";
import { loadEngine, type Effects, type Engine, type GroupResult, type ShotInput, type Solution } from "./engine";
import { ammo, optics, rifles, type AmmoProfile, type RifleProfile } from "./profiles";
import { angle, angleDigits, angleLabel, conv, MRAD_PER_MOA, show, withUnit, YARD_M, type Kind, type UnitPrefs } from "./units";
import { createHoverBus, groupPlot, lineChart } from "./charts";

// ---------------------------------------------------------------- state

interface WindRow {
  untilM: number | null;
  speedMps: number;
  /** clock position the wind blows FROM: 12 = from the target, 3 = from the right */
  clock: number;
}

interface State {
  units: UnitPrefs;
  rifleId: string;
  ammoId: string;
  opticId: string;
  massKg: number;
  diameterM: number;
  lengthM: number;
  dragTable: "G1" | "G7";
  bc: number;
  bands: { minVelocityMps: number; bc: number }[];
  mvMps: number;
  refBarrelM: number;
  velPerBarrelM: number;
  tempSens: number;
  refPowderTempC: number;
  mvSdMps: number;
  bcSdFraction: number;
  sightHeightM: number;
  twistM: number;
  twistDirection: "right" | "left";
  barrelM: number;
  zeroRangeM: number;
  zeroTempC: number | null;
  atmPreset: "custom" | "icao" | "asm";
  altitudeM: number;
  temperatureC: number;
  pressurePa: number;
  pressureMode: "station" | "baro";
  humidity: number;
  powderTempC: number | null;
  wind: WindRow[];
  gustPct: number;
  gustDirDeg: number;
  lookDeg: number;
  azimuthDeg: number;
  latitudeDeg: number;
  cantDeg: number;
  effects: Effects;
  maxRangeM: number;
  stepM: number;
  group: { rangeM: number; shots: number; seed: number; aimSdMrad: number; intervalS: number };
}

const STORAGE_KEY = "lrs.calculator.v1";

function applyRifle(s: State, r: RifleProfile) {
  s.rifleId = r.id;
  s.barrelM = r.barrelM;
  s.twistM = r.twistM;
  s.twistDirection = r.twistDirection;
  s.sightHeightM = r.sightHeightM;
}

function applyAmmo(s: State, a: AmmoProfile) {
  s.ammoId = a.id;
  s.massKg = a.massKg;
  s.diameterM = a.diameterM;
  s.lengthM = a.lengthM;
  if (a.drag.kind === "standard") {
    s.dragTable = a.drag.table;
    s.bc = a.drag.bc;
    s.bands = a.drag.bands ?? [];
  }
  s.mvMps = a.mvMps;
  s.refBarrelM = a.refBarrelM;
  s.velPerBarrelM = a.velPerBarrelM;
  s.tempSens = a.tempSens;
  s.refPowderTempC = a.refPowderTempC;
  s.mvSdMps = a.mvSdMps;
  s.bcSdFraction = a.bcSdFraction;
}

function defaults(): State {
  const s = {
    units: { system: "metric", angular: "mil" },
    opticId: optics[0].id,
    zeroRangeM: 100,
    zeroTempC: null,
    atmPreset: "icao",
    altitudeM: 0,
    temperatureC: 15,
    pressurePa: 101325,
    pressureMode: "station",
    humidity: 0,
    powderTempC: null,
    wind: [{ untilM: null, speedMps: 4, clock: 3 }],
    gustPct: 0,
    gustDirDeg: 10,
    lookDeg: 0,
    azimuthDeg: 0,
    latitudeDeg: 45,
    cantDeg: 0,
    effects: { spinDrift: true, aeroJump: true, coriolis: true, earthCurvature: true, atmosphereAlongPath: true },
    maxRangeM: 1200,
    stepM: 100,
    group: { rangeM: 800, shots: 10, seed: 1, aimSdMrad: 0.05, intervalS: 8 },
  } as unknown as State;
  applyRifle(s, rifles[0]);
  applyAmmo(s, ammo.find((a) => a.id === rifles[0].defaultAmmo) ?? ammo[0]);
  return s;
}

function loadState(): State {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    return { ...base, ...saved, units: { ...base.units, ...saved.units }, effects: { ...base.effects, ...saved.effects }, group: { ...base.group, ...saved.group } };
  } catch {
    return base;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

let state = loadState();
let engine: Engine;

// ---------------------------------------------------------------- form

interface NumField {
  key: string;
  label: string;
  kind: Kind;
  step?: number;
  /** empty input allowed, stored as null */
  nullable?: boolean;
  placeholder?: string;
  title?: string;
}

function get(path: string): unknown {
  return path.split(".").reduce<any>((o, k) => o?.[k], state);
}

function set(path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<any>((o, k) => o[k], state);
  target[last] = value;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function numInput(f: NumField): string {
  const c = conv(f.kind, state.units);
  const v = get(f.key) as number | null;
  const shown = v === null || v === undefined ? "" : String(+c.to(v).toFixed(Math.max(c.digits, 3)));
  const id = `f-${f.key.replace(/\./g, "-")}`;
  return `<label class="field" for="${id}" ${f.title ? `title="${esc(f.title)}"` : ""}>
    <span class="field-label">${esc(f.label)}</span>
    <span class="field-input">
      <input id="${id}" type="number" inputmode="decimal" data-key="${f.key}" data-kind="${f.kind}"
        ${f.nullable ? 'data-nullable="1"' : ""} step="${f.step ?? "any"}" value="${shown}"
        placeholder="${esc(f.placeholder ?? "")}">
      <span class="unit">${esc(c.label)}</span>
    </span>
  </label>`;
}

function select(key: string, label: string, options: [string, string][], value: string): string {
  const id = `f-${key}`;
  return `<label class="field" for="${id}"><span class="field-label">${esc(label)}</span>
    <select id="${id}" data-select="${key}">
      ${options.map(([v, t]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(t)}</option>`).join("")}
    </select></label>`;
}

function check(key: string, label: string, title: string): string {
  return `<label class="check" title="${esc(title)}"><input type="checkbox" data-check="${key}" ${get(key) ? "checked" : ""}> ${esc(label)}</label>`;
}

function section(title: string, body: string, open = true): string {
  return `<details class="section" ${open ? "open" : ""}><summary>${esc(title)}</summary><div class="grid">${body}</div></details>`;
}

function renderForm() {
  const s = state;
  const rifle = rifles.find((r) => r.id === s.rifleId);
  const ammoOpts = ammo.filter((a) => !rifle || a.caliber === rifle.caliber);
  const windRows = s.wind
    .map(
      (w, i) => `<div class="wind-row" data-wind="${i}">
      ${numInput({ key: `wind.${i}.untilM`, label: i === s.wind.length - 1 ? "Zone to (blank = rest)" : "Zone to", kind: "range", nullable: true, placeholder: "∞" })}
      ${numInput({ key: `wind.${i}.speedMps`, label: "Speed", kind: "wind" })}
      ${numInput({ key: `wind.${i}.clock`, label: "From (clock)", kind: "plain", step: 0.5, title: "12 = from the target, 3 = from the right, 6 = from behind, 9 = from the left" })}
      ${s.wind.length > 1 ? `<button type="button" class="ghost small" data-action="remove-wind" data-index="${i}" aria-label="Remove wind zone ${i + 1}">Remove</button>` : ""}
    </div>`,
    )
    .join("");

  form.innerHTML =
    section(
      "Rifle & ammunition",
      select("rifleId", "Rifle", rifles.map((r) => [r.id, r.name]), s.rifleId) +
        select("ammoId", "Load", (ammoOpts.length ? ammoOpts : ammo).map((a) => [a.id, a.name]), s.ammoId) +
        select("opticId", "Scope", optics.map((o) => [o.id, o.name]), s.opticId) +
        numInput({ key: "mvMps", label: "Muzzle velocity (at reference barrel and temperature)", kind: "vel" }) +
        select("dragTable", "Drag model", [["G7", "G7"], ["G1", "G1"]], s.dragTable) +
        numInput({ key: "bc", label: s.bands.length ? `BC (${s.bands.length} velocity bands; editing replaces them)` : "Ballistic coefficient", kind: "plain", step: 0.001 }) +
        numInput({ key: "massKg", label: "Bullet weight", kind: "mass" }) +
        numInput({ key: "diameterM", label: "Bullet diameter", kind: "small" }) +
        numInput({ key: "lengthM", label: "Bullet length", kind: "small" }) +
        numInput({ key: "barrelM", label: "Barrel length", kind: "barrel" }) +
        numInput({ key: "twistM", label: "Twist (one turn in)", kind: "barrel" }) +
        select("twistDirection", "Twist direction", [["right", "Right hand"], ["left", "Left hand"]], s.twistDirection) +
        numInput({ key: "sightHeightM", label: "Sight height", kind: "small" }) +
        numInput({ key: "mvSdMps", label: "MV standard deviation", kind: "vel" }) +
        numInput({ key: "tempSens", label: "Powder temp. sensitivity", kind: "tempSens" }) +
        numInput({ key: "velPerBarrelM", label: "Velocity per barrel length", kind: "velPerLen" }),
    ) +
    section(
      "Zero",
      numInput({ key: "zeroRangeM", label: "Zero range", kind: "range" }) +
        numInput({ key: "zeroTempC", label: "Zeroed at temperature (blank = today)", kind: "temp", nullable: true, placeholder: "same" }),
    ) +
    section(
      "Atmosphere",
      select("atmPreset", "Preset", [["custom", "Custom (measured)"], ["icao", "ICAO standard"], ["asm", "Army Standard Metro"]], s.atmPreset) +
        numInput({ key: "altitudeM", label: "Altitude", kind: "alt" }) +
        numInput({ key: "temperatureC", label: "Air temperature", kind: "temp" }) +
        numInput({ key: "pressurePa", label: "Pressure", kind: "pressure" }) +
        select("pressureMode", "Pressure is", [["station", "Station (absolute)"], ["baro", "Barometric (sea-level corrected)"]], s.pressureMode) +
        numInput({ key: "humidity", label: "Relative humidity", kind: "pct" }) +
        numInput({ key: "powderTempC", label: "Ammo temperature (blank = air)", kind: "temp", nullable: true, placeholder: "air" }),
    ) +
    section(
      "Wind",
      `<div class="wind-zones">${windRows}</div>
       <div class="row-actions"><button type="button" class="ghost small" data-action="add-wind" ${s.wind.length >= 4 ? "disabled" : ""}>Add zone</button></div>` +
        numInput({ key: "gustPct", label: "Gusts (speed variation)", kind: "plain", step: 5, title: "0 = steady. Gusts only affect the group simulator, which fires shots over time." }) +
        numInput({ key: "gustDirDeg", label: "Gust direction swing (°)", kind: "plain", step: 1 }),
    ) +
    section(
      "Shot geometry",
      numInput({ key: "lookDeg", label: "Look angle (+ uphill, °)", kind: "plain", step: 1 }) +
        numInput({ key: "cantDeg", label: "Cant (° clockwise)", kind: "plain", step: 0.5 }) +
        numInput({ key: "azimuthDeg", label: "Azimuth of fire (° from north)", kind: "plain", step: 1 }) +
        numInput({ key: "latitudeDeg", label: "Latitude (° + north)", kind: "plain", step: 1 }),
      false,
    ) +
    section(
      "Effects",
      check("effects.spinDrift", "Spin drift", "Gyroscopic drift in the twist direction (Litz model)") +
        check("effects.aeroJump", "Aerodynamic jump", "Vertical jump caused by crosswind at the muzzle") +
        check("effects.coriolis", "Coriolis & Eötvös", "Earth rotation, using latitude and azimuth") +
        check("effects.earthCurvature", "Earth curvature", "Gravity points to the Earth's centre") +
        check("effects.atmosphereAlongPath", "Atmosphere along path", "Air thins with height on high trajectories"),
      false,
    ) +
    section(
      "Table",
      numInput({ key: "maxRangeM", label: "Maximum range", kind: "range", step: 100 }) +
        numInput({ key: "stepM", label: "Step", kind: "range", step: 25 }),
    );
}

// ---------------------------------------------------------------- compute

function buildInput(s: State): ShotInput {
  const station = s.pressureMode === "baro" ? engine.stationFromBaro(s.altitudeM, s.pressurePa) : s.pressurePa;
  const atmosphere = { altitudeM: s.altitudeM, pressurePa: station, temperatureC: s.temperatureC, humidity: s.humidity };
  return {
    bullet: {
      massKg: s.massKg,
      diameterM: s.diameterM,
      lengthM: s.lengthM,
      drag: s.bands.length
        ? { kind: "standard", table: s.dragTable, bc: s.bc, bands: s.bands }
        : { kind: "standard", table: s.dragTable, bc: s.bc },
    },
    rifle: { sightHeightM: s.sightHeightM, twistM: s.twistM, twistDirection: s.twistDirection, barrelLengthM: s.barrelM },
    load: {
      muzzleVelocityMps: s.mvMps,
      referenceBarrelLengthM: s.refBarrelM,
      velocityPerBarrelM: s.velPerBarrelM,
      powderTempSensitivity: s.tempSens,
      referencePowderTempC: s.refPowderTempC,
      mvSdMps: s.mvSdMps,
      bcSdFraction: s.bcSdFraction,
    },
    atmosphere,
    powderTempC: s.powderTempC,
    zero: {
      rangeM: s.zeroRangeM,
      atmosphere: s.zeroTempC === null ? null : { ...atmosphere, temperatureC: s.zeroTempC },
    },
    wind: {
      zones: s.wind.map((w, i) => ({
        untilM: i === s.wind.length - 1 ? null : w.untilM,
        speedMps: w.speedMps,
        fromDeg: (w.clock % 12) * 30,
      })),
      gusts: s.gustPct > 0 ? { intensity: s.gustPct / 100, directionVariationDeg: s.gustDirDeg, seed: s.group.seed } : null,
    },
    lookAngleDeg: s.lookDeg,
    azimuthDeg: s.azimuthDeg,
    latitudeDeg: s.latitudeDeg,
    cantDeg: s.cantDeg,
    effects: s.effects,
  };
}

let lastSolution: Solution | null = null;

function compute() {
  saveState();
  const s = state;
  let sol: Solution;
  const t0 = performance.now();
  try {
    sol = engine.solve(buildInput(s), { maxRangeM: s.maxRangeM, stepM: s.stepM });
  } catch (e) {
    lastSolution = null;
    errorBox.textContent = String((e as Error).message ?? e);
    errorBox.hidden = false;
    return;
  }
  const ms = performance.now() - t0;
  errorBox.hidden = true;
  lastSolution = sol;
  renderSummary(sol, ms);
  renderCharts(sol);
  renderTable(sol);
  computeGroup();
}

// ---------------------------------------------------------------- output

const optic = () => optics.find((o) => o.id === state.opticId) ?? optics[0];
const toOptic = (mrad: number) => (optic().unit === "mil" ? mrad : mrad / MRAD_PER_MOA);
const clicks = (mrad: number) => Math.round(toOptic(mrad) / optic().clickValue);

function tile(label: string, value: string, note = "", tone = ""): string {
  return `<div class="tile ${tone}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ""}</div>`;
}

function renderSummary(sol: Solution, ms: number) {
  const u = state.units;
  const sg = sol.stabilitySg;
  const sgNote = sg < 1 ? "Unstable" : sg < 1.4 ? "Marginal" : sg < 1.5 ? "Adequate" : "Stable";
  const sgTone = sg < 1 ? "bad" : sg < 1.4 ? "warn" : "";
  const maxElev = Math.max(0, ...sol.rows.map((r) => r.elevationMrad));
  const o = optic();
  const travel = toOptic(maxElev) > o.elevationTravel;
  summary.innerHTML =
    tile("Muzzle velocity", withUnit("vel", sol.muzzleVelocityMps, u), "after barrel and temperature") +
    tile("Stability (Sg)", sg.toFixed(2), sgNote, sgTone) +
    tile("Density altitude", withUnit("alt", sol.densityAltitudeM, u), `${sol.airDensityKgM3.toFixed(3)} kg/m³`) +
    tile("Speed of sound", withUnit("vel", sol.speedOfSoundMps, u)) +
    tile("Transonic from", sol.transonicRangeM ? withUnit("range", sol.transonicRangeM, u) : "beyond table", "Mach 1.2") +
    tile("Subsonic from", sol.subsonicRangeM ? withUnit("range", sol.subsonicRangeM, u) : "beyond table", "Mach 1.0", sol.subsonicRangeM && sol.subsonicRangeM < state.maxRangeM ? "warn" : "") +
    tile("Aero jump", `${angle(sol.aeroJumpMrad, u).toFixed(angleDigits(u))} ${angleLabel(u)}`, "from muzzle crosswind");
  const warnings = [...sol.warnings];
  if (travel) warnings.push(`The ${o.name} has ${o.elevationTravel} ${o.unit.toUpperCase()} of elevation; the table needs ${toOptic(maxElev).toFixed(1)}. Use reticle holdover or a canted base.`);
  warningsBox.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join("");
  warningsBox.hidden = warnings.length === 0;
  timing.textContent = `Solved in ${ms.toFixed(1)} ms · engine ${engine.version}`;
}

const bus = createHoverBus();

function renderCharts(sol: Solution) {
  const u = state.units;
  const rows = sol.rows;
  const xs = rows.map((r) => conv("range", u).to(r.rangeM));
  const xUnit = conv("range", u).label;
  const al = angleLabel(u);
  const sub = sol.subsonicRangeM ? { value: conv("range", u).to(sol.subsonicRangeM), label: "subsonic" } : undefined;
  bus.listeners.length = 0;
  lineChart(chartEls[0], { title: "Elevation", unit: al, xs, ys: rows.map((r) => angle(r.elevationMrad, u)), xUnit, yDigits: angleDigits(u), refX: sub }, bus);
  lineChart(chartEls[1], { title: "Windage", unit: al, xs, ys: rows.map((r) => angle(r.windageMrad, u)), xUnit, yDigits: angleDigits(u), refX: sub }, bus);
  lineChart(
    chartEls[2],
    {
      title: "Velocity",
      unit: conv("vel", u).label,
      xs,
      ys: rows.map((r) => conv("vel", u).to(r.velocityMps)),
      xUnit,
      yDigits: 0,
      refY: { value: conv("vel", u).to(sol.speedOfSoundMps), label: "Mach 1" },
    },
    bus,
  );
  lineChart(chartEls[3], { title: "Energy", unit: conv("energy", u).label, xs, ys: rows.map((r) => conv("energy", u).to(r.energyJ)), xUnit, yDigits: 0, refX: sub }, bus);
}

function signed(v: number, digits: number, pos: string, neg: string): string {
  if (Math.abs(v) < 0.5 * 10 ** -digits) return (0).toFixed(digits);
  return `${v > 0 ? pos : neg} ${Math.abs(v).toFixed(digits)}`;
}

function renderTable(sol: Solution) {
  const u = state.units;
  const al = angleLabel(u);
  const ad = angleDigits(u);
  const o = optic();
  head.innerHTML = `<tr>
    <th scope="col">Range<br><span>${conv("range", u).label}</span></th>
    <th scope="col">Elevation<br><span>${al}</span></th>
    <th scope="col">Clicks<br><span>${o.clickValue} ${o.unit}</span></th>
    <th scope="col">Windage<br><span>${al}</span></th>
    <th scope="col">Clicks<br><span>${o.clickValue} ${o.unit}</span></th>
    <th scope="col">Drop<br><span>${conv("drop", u).label}</span></th>
    <th scope="col">Drift<br><span>${conv("drop", u).label}</span></th>
    <th scope="col">Spin drift<br><span>${conv("drop", u).label}</span></th>
    <th scope="col">Velocity<br><span>${conv("vel", u).label}</span></th>
    <th scope="col">Mach</th>
    <th scope="col">Energy<br><span>${conv("energy", u).label}</span></th>
    <th scope="col">Time<br><span>s</span></th></tr>`;
  body.innerHTML = sol.rows
    .map((r) => {
      const cls = r.mach < 1 ? "subsonic" : r.mach < 1.2 ? "transonic" : "";
      const ec = clicks(r.elevationMrad);
      const wc = clicks(r.windageMrad);
      return `<tr class="${cls}">
        <th scope="row">${show("range", r.rangeM, u)}</th>
        <td>${signed(angle(r.elevationMrad, u), ad, "U", "D")}</td>
        <td>${ec === 0 ? "0" : signed(ec, 0, "U", "D")}</td>
        <td>${signed(angle(r.windageMrad, u), ad, "R", "L")}</td>
        <td>${wc === 0 ? "0" : signed(wc, 0, "R", "L")}</td>
        <td>${show("drop", r.dropM, u)}</td>
        <td>${show("drop", r.windageM, u)}</td>
        <td>${show("drop", r.spinDriftM, u)}</td>
        <td>${show("vel", r.velocityMps, u)}</td>
        <td>${r.mach.toFixed(2)}</td>
        <td>${show("energy", r.energyJ, u)}</td>
        <td>${r.timeS.toFixed(3)}</td></tr>`;
    })
    .join("");
}

// ---------------------------------------------------------------- group simulator

function renderGroupForm() {
  const u = state.units;
  const aimShown = angle(state.group.aimSdMrad, u);
  groupForm.innerHTML =
    numInput({ key: "group.rangeM", label: "Target range", kind: "range", step: 50 }) +
    numInput({ key: "group.shots", label: "Shots", kind: "plain", step: 1 }) +
    `<label class="field" for="f-aim"><span class="field-label">Aiming error (1 SD)</span>
      <span class="field-input"><input id="f-aim" type="number" step="any" data-aim="1" value="${+aimShown.toFixed(3)}"><span class="unit">${angleLabel(u)}</span></span></label>` +
    numInput({ key: "group.intervalS", label: "Time between shots (s)", kind: "plain", step: 1 }) +
    numInput({ key: "group.seed", label: "Seed", kind: "plain", step: 1 }) +
    `<div class="row-actions"><button type="button" data-action="reseed">Fire new string</button></div>`;
}

function computeGroup() {
  const s = state;
  if (!lastSolution) return;
  let g: GroupResult;
  try {
    g = engine.fireGroup(buildInput(s), {
      rangeM: s.group.rangeM,
      shots: Math.max(1, Math.min(100, Math.round(s.group.shots))),
      seed: Math.max(0, Math.round(s.group.seed)) >>> 0,
      aimSdMrad: s.group.aimSdMrad,
      intervalS: s.group.intervalS,
    });
  } catch (e) {
    groupStats.innerHTML = `<p class="error">${esc(String((e as Error).message ?? e))}</p>`;
    groupChart.replaceChildren();
    return;
  }
  const u = state.units;
  const R = s.group.rangeM;
  const toAng = (m: number) => angle((m / R) * 1000, u);
  const ad = angleDigits(u);
  const al = angleLabel(u);
  groupPlot(groupChart, {
    points: g.impacts.map((i) => ({
      x: toAng(i.horizontalM),
      y: toAng(i.verticalM),
      label: `#${i.shot}: ${toAng(i.verticalM).toFixed(ad)} ${al} vertical, ${toAng(i.horizontalM).toFixed(ad)} horizontal, MV ${show("vel", i.muzzleVelocityMps, u)}`,
    })),
    center: { x: toAng(g.meanHorizontalM), y: toAng(g.meanVerticalM) },
    unit: al,
    gridStep: u.angular === "mil" ? 0.5 : 1,
  });
  const mvs = g.impacts.map((i) => i.muzzleVelocityMps);
  const mvMean = mvs.reduce((a, b) => a + b, 0) / Math.max(1, mvs.length);
  const mvSd = Math.sqrt(mvs.reduce((a, b) => a + (b - mvMean) ** 2, 0) / Math.max(1, mvs.length - 1));
  const moa = (m: number) => ((m / R) * 1000) / MRAD_PER_MOA;
  groupStats.innerHTML = `<dl class="stats">
    <div><dt>Dialed</dt><dd>${signed(angle(g.dialElevationMrad, u), ad, "U", "D")}, ${signed(angle(g.dialWindageMrad, u), ad, "R", "L")} ${al}</dd></div>
    <div><dt>Extreme spread</dt><dd>${withUnit("drop", g.extremeSpreadM, u)} · ${moa(g.extremeSpreadM).toFixed(2)} MOA · ${((g.extremeSpreadM / R) * 1000).toFixed(2)} mil</dd></div>
    <div><dt>Mean radius</dt><dd>${withUnit("drop", g.meanRadiusM, u)} · ${toAng(g.meanRadiusM).toFixed(ad)} ${al}</dd></div>
    <div><dt>Mean point of impact</dt><dd>${signed(toAng(g.meanVerticalM), ad, "high", "low")}, ${signed(toAng(g.meanHorizontalM), ad, "right", "left")} ${al}</dd></div>
    <div><dt>Velocity of the string</dt><dd>${withUnit("vel", mvMean, u)}, SD ${withUnit("vel", mvSd, u, 1)}</dd></div>
    <div><dt>Hits</dt><dd>${g.impacts.length} of ${s.group.shots} reached the target</dd></div>
  </dl>`;
}

// ---------------------------------------------------------------- events

let timer = 0;
function scheduleCompute() {
  clearTimeout(timer);
  timer = window.setTimeout(compute, 60);
}

function onNumber(input: HTMLInputElement) {
  const key = input.dataset.key!;
  const raw = input.value.trim();
  if (raw === "" && input.dataset.nullable) {
    set(key, null);
  } else {
    const v = Number(raw);
    if (!Number.isFinite(v) || raw === "") return;
    set(key, conv(input.dataset.kind as Kind, state.units).from(v));
  }
  if (key === "bc") state.bands = [];
  if (["altitudeM", "temperatureC", "pressurePa", "humidity"].includes(key) && state.atmPreset !== "custom") {
    state.atmPreset = "custom";
    const sel = form.querySelector<HTMLSelectElement>('[data-select="atmPreset"]');
    if (sel) sel.value = "custom";
  }
  scheduleCompute();
}

function onSelect(sel: HTMLSelectElement) {
  const key = sel.dataset.select!;
  const v = sel.value;
  if (key === "rifleId") {
    const r = rifles.find((x) => x.id === v)!;
    applyRifle(state, r);
    applyAmmo(state, ammo.find((a) => a.id === r.defaultAmmo) ?? ammo[0]);
    renderForm();
  } else if (key === "ammoId") {
    applyAmmo(state, ammo.find((a) => a.id === v)!);
    renderForm();
  } else if (key === "atmPreset") {
    state.atmPreset = v as State["atmPreset"];
    if (v !== "custom") {
      const a = engine.standardAtmosphere(v as "icao" | "asm");
      Object.assign(state, { altitudeM: a.altitudeM, temperatureC: a.temperatureC, pressurePa: a.pressurePa, humidity: a.humidity, pressureMode: "station" });
    }
    renderForm();
  } else {
    (state as any)[key] = v;
    if (key === "opticId") {
      state.units.angular = optic().unit;
      syncUnitToggles();
      rerenderAll();
      return;
    }
  }
  scheduleCompute();
}

function rerenderAll() {
  renderForm();
  renderGroupForm();
  compute();
}

function syncUnitToggles() {
  document.querySelectorAll<HTMLButtonElement>("[data-unit]").forEach((b) => {
    const [k, v] = b.dataset.unit!.split(":");
    b.setAttribute("aria-pressed", String((state.units as any)[k] === v));
  });
}

// ---------------------------------------------------------------- boot

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("inputs");
const summary = $("summary");
const warningsBox = $<HTMLUListElement>("warnings");
const errorBox = $("error");
const timing = $("timing");
const head = $("table-head");
const body = $("table-body");
const chartEls = [$("chart-elev"), $("chart-wind"), $("chart-vel"), $("chart-energy")];
const groupForm = $("group-form");
const groupChart = $("group-chart");
const groupStats = $("group-stats");

function wire() {
  for (const root of [form, groupForm]) {
    root.addEventListener("input", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.key) onNumber(t);
      if (t instanceof HTMLInputElement && t.dataset.aim) {
        const v = Number(t.value);
        if (Number.isFinite(v) && v >= 0) {
          state.group.aimSdMrad = state.units.angular === "mil" ? v : v * MRAD_PER_MOA;
          scheduleCompute();
        }
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLSelectElement) onSelect(t);
      if (t instanceof HTMLInputElement && t.dataset.check) {
        set(t.dataset.check, t.checked);
        scheduleCompute();
      }
    });
    root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
      if (!b) return;
      const a = b.dataset.action;
      if (a === "add-wind") {
        const last = state.wind[state.wind.length - 1];
        const prevEnd = state.wind.length > 1 ? state.wind[state.wind.length - 2].untilM ?? 0 : 0;
        last.untilM = prevEnd + 400;
        state.wind.push({ untilM: null, speedMps: last.speedMps, clock: last.clock });
        renderForm();
        scheduleCompute();
      } else if (a === "remove-wind") {
        state.wind.splice(Number(b.dataset.index), 1);
        state.wind[state.wind.length - 1].untilM = null;
        renderForm();
        scheduleCompute();
      } else if (a === "reseed") {
        state.group.seed = (state.group.seed + 1) >>> 0;
        renderGroupForm();
        scheduleCompute();
      }
    });
  }
  form.addEventListener("submit", (e) => e.preventDefault());

  document.querySelectorAll<HTMLButtonElement>("[data-unit]").forEach((b) =>
    b.addEventListener("click", () => {
      const [k, v] = b.dataset.unit!.split(":");
      if (k === "system" && v !== state.units.system) {
        // Keep range settings on round numbers in the new unit (100 m zero -> 100 yd zero).
        const f = v === "imperial" ? YARD_M : 1 / YARD_M;
        state.zeroRangeM *= f;
        state.maxRangeM *= f;
        state.stepM *= f;
        state.group.rangeM *= f;
        state.wind.forEach((w) => {
          if (w.untilM !== null) w.untilM *= f;
        });
      }
      (state.units as any)[k] = v;
      syncUnitToggles();
      rerenderAll();
    }),
  );
  $("print").addEventListener("click", () => window.print());
  $("reset").addEventListener("click", () => {
    state = defaults();
    syncUnitToggles();
    rerenderAll();
  });

  let rt = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (lastSolution) {
        renderCharts(lastSolution);
        computeGroup();
      }
    }, 120);
  });
}

async function boot() {
  try {
    engine = await loadEngine();
  } catch (e) {
    errorBox.textContent = `Could not load the ballistics engine: ${String(e)}`;
    errorBox.hidden = false;
    return;
  }
  wire();
  syncUnitToggles();
  rerenderAll();
}

boot();
