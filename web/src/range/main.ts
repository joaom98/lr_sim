import * as THREE from "three";
import "./range.css";
import { loadEngine, type Engine, type WindSampler } from "../engine";
import { ammo, optics, rifles } from "../profiles";
import { MRAD_PER_MOA } from "../units";
import { Rand } from "../rng";
import { RangeAudio } from "./audio";
import { clockOf, makeConditions, ranges, weatherPresets, windField, windPresets, type Conditions } from "./conditions";
import { buildInput, clickMrad, fire, freeRecoil, planeCrossing, type Dial, type Loadout, type ShotOutcome } from "./firing";
import { drawNakedEye, drawScope, NAKED_EYE_FOV_DEG, scopeLayout } from "./scope";
import { POSITIONS, Shooter } from "./shooter";
import { groundHeight } from "./terrain";
import { World, type TargetObj } from "./world";

// ---------------------------------------------------------------- settings & records

interface Settings {
  rifleId: string;
  ammoId: string;
  opticId: string;
  weatherId: string;
  windId: string;
  seed: number;
  positionId: string;
}

/** One fired shot. Kept small and stable so a progression system can build on it later. */
export interface ShotRecord {
  at: string;
  session: number;
  shot: number;
  rifleId: string;
  ammoId: string;
  opticId: string;
  position: string;
  targetId: string | null;
  targetRangeM: number | null;
  result: "hit" | "miss";
  /** impact relative to the target centre (mrad, + right / + up) */
  offsetMrad: { x: number; y: number } | null;
  dialMrad: { elevation: number; windage: number };
  timeOfFlightS: number;
  impactVelocityMps: number;
  energyJ: number;
  heldBreath: boolean;
  inPause: boolean;
}

const SETTINGS_KEY = "lrs.range.settings.v1";
const RECORDS_KEY = "lrs.shots.v1";

function loadSettings(): Settings {
  const d: Settings = {
    rifleId: rifles[0].id,
    ammoId: rifles[0].defaultAmmo,
    opticId: optics[0].id,
    weatherId: weatherPresets[0].id,
    windId: "moderate",
    seed: Math.floor(Math.random() * 1e6),
    positionId: POSITIONS[0].id,
  };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return d;
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

function loadRecords(): ShotRecord[] {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

let settings = loadSettings();

// ---------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("view");
const overlay = $<HTMLCanvasElement>("overlay");
const og = overlay.getContext("2d")!;
const hud = $("hud");
const setup = $("setup");
const setupForm = $<HTMLFormElement>("setup-form");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function sel(id: keyof Settings, label: string, opts: [string, string][]) {
  const v = String(settings[id]);
  return `<label class="field"><span>${esc(label)}</span><select data-k="${id}">${opts
    .map(([k, t]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(t)}</option>`)
    .join("")}</select></label>`;
}

function renderSetup() {
  const rifle = rifles.find((r) => r.id === settings.rifleId) ?? rifles[0];
  const loads = ammo.filter((a) => a.caliber === rifle.caliber);
  if (!loads.some((a) => a.id === settings.ammoId)) settings.ammoId = rifle.defaultAmmo;
  setupForm.innerHTML =
    sel("rifleId", "Rifle", rifles.map((r) => [r.id, r.name])) +
    sel("ammoId", "Load", loads.map((a) => [a.id, a.name])) +
    sel("opticId", "Scope", optics.map((o) => [o.id, o.name])) +
    sel("positionId", "Position", POSITIONS.map((p) => [p.id, `${p.key}. ${p.name}`])) +
    sel("weatherId", "Weather", weatherPresets.map((w) => [w.id, w.name])) +
    sel("windId", "Wind", windPresets.map((w) => [w.id, w.name])) +
    `<label class="field"><span>Session seed</span><input type="number" data-k="seed" value="${settings.seed}" step="1"></label>`;
}

setupForm.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const k = t.dataset.k as keyof Settings;
  if (!k) return;
  (settings as any)[k] = k === "seed" ? Math.max(0, Math.round(Number(t.value))) >>> 0 : t.value;
  if (k === "rifleId") settings.ammoId = rifles.find((r) => r.id === t.value)!.defaultAmmo;
  save(SETTINGS_KEY, settings);
  renderSetup();
  if (session) $("setup-note").textContent = "Changes apply when you start a new session.";
});

// ---------------------------------------------------------------- session state

interface Session {
  cond: Conditions;
  lo: Loadout;
  world: World;
  sampler: WindSampler;
  shooter: Shooter;
  dial: Dial;
  mag: number;
  scoped: boolean;
  illum: boolean;
  aimYaw: number;
  aimPitch: number;
  t: number;
  shots: number;
  rounds: number;
  capacity: number;
  nextReadyT: number;
  barrelTempC: number;
  /** recent wind at the shooter for the weather meter (EMA, solver frame) */
  meterWind: [number, number];
  lastRange: { distanceM: number; pitch: number } | null;
  tabletTarget: TargetObj | null;
  impacts: Map<string, { u: number; v: number; hit: boolean }[]>;
  rand: Rand;
  /** calculator solution for the last ranged distance */
  solution?: { elevationClicks: number; windageClicks: number };
  speedOfSound: number;
  densityAltitudeM: number;
}

let engine: Engine;
let session: Session | null = null;
const audio = new RangeAudio();
const records = loadRecords();
const keys = new Set<string>();
const log = $("shots");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
const camera = new THREE.PerspectiveCamera(NAKED_EYE_FOV_DEG, 1, 0.05, 30000);
camera.rotation.order = "YXZ";

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = overlay.style.width = `${w}px`;
  canvas.style.height = overlay.style.height = `${h}px`;
  const dpr = Math.min(2, window.devicePixelRatio);
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  og.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

function startSession() {
  if (session) {
    session.world.scene.clear();
    session.sampler.free();
  }
  const range = ranges[0];
  const weather = weatherPresets.find((w) => w.id === settings.weatherId) ?? weatherPresets[0];
  const wind = windPresets.find((w) => w.id === settings.windId) ?? windPresets[1];
  const cond = makeConditions(settings.seed, range, weather, wind, engine.stationFromBaro);
  const rifle = rifles.find((r) => r.id === settings.rifleId) ?? rifles[0];
  const lo: Loadout = {
    rifle,
    ammo: ammo.find((a) => a.id === settings.ammoId) ?? ammo[0],
    optic: optics.find((o) => o.id === settings.opticId) ?? optics[0],
  };
  const world = new World(range, weather.humidity);
  const shooter = new Shooter();
  shooter.setPosition(POSITIONS.find((p) => p.id === settings.positionId) ?? POSITIONS[0]);
  const info = engine.atmosphereInfo(cond.atmosphere);
  const first = world.targets[0];
  const eye = shooter.position.eyeHeightM;
  const capacity = rifle.action === "semi" ? 10 : 5;
  session = {
    cond,
    lo,
    world,
    sampler: engine.windSampler(windField(cond, range.azimuthDeg)),
    shooter,
    dial: { elevation: 0, windage: 0 },
    mag: Math.round((lo.optic.magMin + lo.optic.magMax) / 2),
    scoped: true,
    illum: false,
    aimYaw: Math.atan2(first.center.x, -first.center.z),
    aimPitch: Math.atan2(first.center.y - eye, -first.center.z),
    t: 0,
    shots: 0,
    rounds: capacity,
    capacity,
    nextReadyT: 0,
    barrelTempC: cond.atmosphere.temperatureC,
    meterWind: [0, 0],
    lastRange: null,
    tabletTarget: first,
    impacts: new Map(),
    rand: new Rand(settings.seed * 7919 + 1),
    speedOfSound: info.speedOfSoundMps,
    densityAltitudeM: info.densityAltitudeM,
  };
  $("scope-name").textContent = lo.optic.name;
  log.innerHTML = "";
  $("group-line").textContent = "";
  message("call", `${range.name}. Zeroed at 100 m. Range a target with R.`, 6);
}

// ---------------------------------------------------------------- helpers

const unit = () => (session!.lo.optic.unit === "mil" ? "mil" : "MOA");
const toOpticUnit = (mrad: number) => (session!.lo.optic.unit === "mil" ? mrad : mrad / MRAD_PER_MOA);
const digits = () => (session!.lo.optic.unit === "mil" ? 1 : 2);

function dir(v: number, pos: string, neg: string, d = digits()): string {
  const a = Math.abs(v);
  if (a < 0.5 * 10 ** -d) return "0";
  return `${a.toFixed(d)} ${v > 0 ? pos : neg}`;
}

const timers: Record<string, number> = {};
function message(id: string, text: string, seconds: number) {
  const el = $(id);
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(timers[id]);
  timers[id] = window.setTimeout(() => el.classList.remove("show"), seconds * 1000);
}

function sightLine(s: Session) {
  const off = s.shooter.offset();
  return { yaw: s.aimYaw + off.x / 1000, pitch: s.aimPitch + off.y / 1000 };
}

/** The target closest to where the rifle points (angularly). */
function intendedTarget(s: Session, yaw: number, pitch: number, eye: number): TargetObj | null {
  let best: TargetObj | null = null;
  let bestD = Infinity;
  for (const tg of s.world.targets) {
    const ty = Math.atan2(tg.center.x, -tg.center.z);
    const tp = Math.atan2(tg.center.y - eye, Math.hypot(tg.center.x, tg.center.z));
    const d = Math.hypot(ty - yaw, tp - pitch);
    if (d < bestD) {
      bestD = d;
      best = tg;
    }
  }
  return bestD < 0.02 ? best : null;
}

// ---------------------------------------------------------------- firing

function shoot() {
  const s = session!;
  if (s.t < s.nextReadyT) return;
  if (s.rounds <= 0) {
    message("call", "Click. Magazine empty: press X to reload.", 2.5);
    return;
  }
  audio.resume();
  const eye = s.shooter.position.eyeHeightM;
  const line = sightLine(s);
  const err = s.shooter.triggerError();
  const lo = s.lo;
  // Cold bore and barrel heat: MV rises a little as the barrel warms.
  const heat = s.barrelTempC - s.cond.atmosphere.temperatureC;
  const coldBore = s.shots === 0 ? -2.5 : 0;
  const mvDelta = s.rand.normal() * lo.ammo.mvSdMps + heat * 0.08 + coldBore;
  const bcScale = 1 + s.rand.normal() * lo.ammo.bcSdFraction;
  const aim = { yaw: line.yaw, pitch: line.pitch, eyeHeightM: eye };
  const intended = intendedTarget(s, line.yaw, line.pitch, eye);
  let out: ShotOutcome;
  try {
    out = fire(engine, lo, s.cond, aim, s.dial, { mvDeltaMps: mvDelta, bcScale, timeS: s.t, errX: err.x, errY: err.y }, s.world.targets);
  } catch (e) {
    message("call", `Engine error: ${(e as Error).message ?? e}`, 5);
    return;
  }
  s.shots++;
  s.rounds--;
  s.nextReadyT = s.t + (lo.rifle.action === "semi" ? 0.35 : 1.4);
  // ~2.5 °C per .308 shot on a heavy barrel, scaled by muzzle energy
  s.barrelTempC += 0.0004 * out.trace.muzzleVelocityMps ** 2 * lo.ammo.massKg;
  s.shooter.fire(freeRecoil(lo));
  audio.shot(0.5 * lo.ammo.massKg * out.trace.muzzleVelocityMps ** 2);

  const humidity = s.cond.atmosphere.humidity;
  const heldBreath = s.shooter.holding;
  const inPause = s.shooter.inRespiratoryPause;
  const dialMrad = { elevation: s.dial.elevation * clickMrad(lo.optic), windage: s.dial.windage * clickMrad(lo.optic) };
  const shotNo = s.shots;
  s.world.launch(out.path, out.times, s.t, 0.12 + humidity * 0.35, () => resolveImpact(s, shotNo, out, intended, dialMrad, heldBreath, inPause));
}

function resolveImpact(
  s: Session,
  shotNo: number,
  out: ShotOutcome,
  intended: TargetObj | null,
  dialMrad: { elevation: number; windage: number },
  heldBreath: boolean,
  inPause: boolean,
) {
  if (session !== s) return;
  const dist = out.point.length();
  const soundDelay = dist / s.speedOfSound;
  const tg = out.target ?? intended;
  let result: "hit" | "miss" = "miss";
  let offset: { x: number; y: number } | null = null;

  if (out.kind === "target" && out.target) {
    const t = out.target;
    result = "hit";
    if (t.def.shape === "paper") s.world.paperHit(t, out.u!, out.v!, s.lo.ammo.diameterM / 2);
    else {
      s.world.steelHit(t, out.u!, out.v!, out.energyJ, s.t);
      audio.ding(soundDelay, dist, t.def.sizeM);
    }
    offset = { x: (out.u! / t.def.rangeM) * 1000, y: (out.v! / t.def.rangeM) * 1000 };
  } else if (out.kind === "ground") {
    const [wd, wr] = s.sampler.at(-out.point.z, s.t);
    s.world.dust(out.point, Math.min(2.5, 0.6 + out.energyJ / 2500), new THREE.Vector3(wr, 0, -wd), s.t);
    audio.thud(soundDelay, dist);
  }
  if (tg && !offset) {
    const c = planeCrossing(out.fullPath, tg);
    if (c) offset = { x: (c.u / tg.def.rangeM) * 1000, y: (c.v / tg.def.rangeM) * 1000 };
  }

  // Spotter call, in the scope's units, relative to the intended target's centre.
  let call: string;
  if (result === "hit") {
    call = `Hit ${tg!.def.name}`;
  } else if (!tg) {
    call = out.kind === "ground" ? "Miss: no target near the reticle" : "Lost: no impact seen";
  } else if (!offset) {
    call = `Miss ${tg.def.name}: short, no splash on the plate line`;
  } else {
    call = `Miss ${tg.def.name}: ${dir(toOpticUnit(offset.y), "high", "low")}, ${dir(toOpticUnit(offset.x), "right", "left")} ${unit()}`;
  }
  window.setTimeout(() => message("call", call, 5), Math.min(1500, 250 + soundDelay * 1000 * 0.3));

  if (tg && offset) {
    const list = s.impacts.get(tg.def.id) ?? [];
    list.push({ u: (offset.x * tg.def.rangeM) / 1000, v: (offset.y * tg.def.rangeM) / 1000, hit: result === "hit" });
    s.impacts.set(tg.def.id, list);
    s.tabletTarget = tg;
  }

  const rec: ShotRecord = {
    at: new Date().toISOString(),
    session: s.cond.seed,
    shot: shotNo,
    rifleId: s.lo.rifle.id,
    ammoId: s.lo.ammo.id,
    opticId: s.lo.optic.id,
    position: s.shooter.position.id,
    targetId: tg?.def.id ?? null,
    targetRangeM: tg?.def.rangeM ?? null,
    result,
    offsetMrad: offset,
    dialMrad,
    timeOfFlightS: out.timeS,
    impactVelocityMps: out.speedMps,
    energyJ: out.energyJ,
    heldBreath,
    inPause,
  };
  records.push(rec);
  if (records.length > 1000) records.splice(0, records.length - 1000);
  save(RECORDS_KEY, records);
  addLogRow(rec, tg);
  drawTablet(s);
}

function addLogRow(r: ShotRecord, tg: TargetObj | null) {
  const li = document.createElement("li");
  li.className = r.result;
  const off = r.offsetMrad
    ? `${dir(toOpticUnit(r.offsetMrad.y), "U", "D")} / ${dir(toOpticUnit(r.offsetMrad.x), "R", "L")}`
    : "n/a";
  li.innerHTML = `<b>#${r.shot}</b> ${esc(tg?.def.name ?? "No target")} · <span class="res">${r.result.toUpperCase()}</span><br>
    <span>${off} ${unit()} · ToF ${r.timeOfFlightS.toFixed(2)} s · ${Math.round(r.impactVelocityMps)} m/s · ${Math.round(r.energyJ)} J${r.inPause ? " · pause" : r.heldBreath ? " · held" : ""}</span>`;
  log.prepend(li);
}

// ---------------------------------------------------------------- electronic target

function drawTablet(s: Session) {
  const tg = s.tabletTarget;
  const c = $<HTMLCanvasElement>("tablet");
  const g = c.getContext("2d")!;
  const W = c.width;
  g.fillStyle = "#101418";
  g.fillRect(0, 0, W, W);
  if (!tg) return;
  $("tablet-title").textContent = `${tg.def.name} · ${tg.def.rangeM} m`;
  const list = s.impacts.get(tg.def.id) ?? [];
  const halfH = tg.halfHeight;
  const extent = Math.max(tg.def.sizeM * 0.9, halfH * 1.8, ...list.map((i) => Math.max(Math.abs(i.u), Math.abs(i.v)) * 1.15));
  const px = (W / 2 - 10) / extent;
  const X = (u: number) => W / 2 + u * px;
  const Y = (v: number) => W / 2 - v * px;
  // grid in reticle units
  const unitMrad = s.lo.optic.unit === "mil" ? 0.5 : MRAD_PER_MOA;
  const gridM = (unitMrad * tg.def.rangeM) / 1000;
  g.strokeStyle = "#24303a";
  g.lineWidth = 1;
  for (let k = -20; k <= 20; k++) {
    const p = k * gridM;
    if (Math.abs(p) > extent) continue;
    g.beginPath();
    g.moveTo(X(p), 0);
    g.lineTo(X(p), W);
    g.moveTo(0, Y(p));
    g.lineTo(W, Y(p));
    g.stroke();
  }
  // target outline
  g.fillStyle = tg.def.shape === "paper" ? "#e9e4d6" : "#d9dbd6";
  g.beginPath();
  const w = tg.def.sizeM;
  if (tg.def.shape === "circle") g.arc(X(0), Y(0), (w / 2) * px, 0, Math.PI * 2);
  else if (tg.def.shape === "ipsc") {
    const h = tg.def.heightM ?? w * 1.6;
    const top = h / 2 - h * 0.25;
    g.moveTo(X(-w / 2), Y(-h / 2));
    g.lineTo(X(w / 2), Y(-h / 2));
    g.lineTo(X(w / 2), Y(top));
    g.lineTo(X(w / 4), Y(top));
    g.lineTo(X(w / 4), Y(h / 2));
    g.lineTo(X(-w / 4), Y(h / 2));
    g.lineTo(X(-w / 4), Y(top));
    g.lineTo(X(-w / 2), Y(top));
    g.closePath();
  } else g.rect(X(-w / 2), Y(w / 2), w * px, w * px);
  g.fill();
  g.strokeStyle = "#6b7680";
  g.beginPath();
  g.moveTo(X(0) - 6, Y(0));
  g.lineTo(X(0) + 6, Y(0));
  g.moveTo(X(0), Y(0) - 6);
  g.lineTo(X(0), Y(0) + 6);
  g.stroke();
  // impacts, newest highlighted
  list.forEach((i, idx) => {
    const last = idx === list.length - 1;
    g.beginPath();
    g.arc(X(i.u), Y(i.v), last ? 5 : 3.5, 0, Math.PI * 2);
    g.fillStyle = i.hit ? (last ? "#3aa0ff" : "#2a78d6") : last ? "#ff8a5c" : "#d9693c";
    g.fill();
    g.strokeStyle = "#101418";
    g.lineWidth = 1.5;
    g.stroke();
  });
  g.fillStyle = "#8a96a0";
  g.font = "11px system-ui, sans-serif";
  g.fillText(`grid ${s.lo.optic.unit === "mil" ? "0.5 mil" : "1 MOA"}`, 8, W - 8);

  if (list.length >= 2) {
    let es = 0;
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) es = Math.max(es, Math.hypot(list[a].u - list[b].u, list[a].v - list[b].v));
    const mu = list.reduce((x, i) => x + i.u, 0) / list.length;
    const mv = list.reduce((x, i) => x + i.v, 0) / list.length;
    const toU = (m: number) => toOpticUnit((m / tg.def.rangeM) * 1000);
    $("group-line").textContent = `${list.length} shots · ES ${toU(es).toFixed(2)} ${unit()} (${(es * 100).toFixed(1)} cm) · centre ${dir(toU(mv), "U", "D", 2)} / ${dir(toU(mu), "R", "L", 2)}`;
  } else $("group-line").textContent = "";
}

// ---------------------------------------------------------------- ranging & solution

function rangefind() {
  const s = session!;
  // Build the beam from the current sight line rather than the last rendered frame.
  const line = sightLine(s);
  const eye = new THREE.Vector3(0, s.shooter.position.eyeHeightM + groundHeight(0, 0), 0);
  const beam = new THREE.Vector3(Math.sin(line.yaw) * Math.cos(line.pitch), Math.sin(line.pitch), -Math.cos(line.yaw) * Math.cos(line.pitch));
  const ray = new THREE.Raycaster(eye, beam);
  ray.far = 2600;
  const hits = ray.intersectObjects(s.world.raycastables, false);
  const h = hits[0];
  if (!h) {
    message("ranging", "Rangefinder: no return", 3);
    return;
  }
  const isTarget = Boolean(h.object.userData.target);
  // Steel returns well; bare ground only to ~1400 m.
  if (!isTarget && h.distance > 1400) {
    message("ranging", "Rangefinder: no return (ground too far)", 3);
    return;
  }
  const d = h.distance + s.rand.normal() * 0.5;
  const pitch = line.pitch;
  s.lastRange = { distanceM: d, pitch };
  message("ranging", `Range ${d.toFixed(0)} m · angle ${((pitch * 180) / Math.PI).toFixed(1)}°`, 8);
  showSolution();
}

/** Calculator solution using what the shooter can measure: range and wind at the firing point. */
function showSolution() {
  const s = session!;
  if (!s.lastRange) return;
  const [wd, wr] = s.meterWind;
  const speed = Math.hypot(wd, wr);
  const fromRel = (Math.atan2(-wr, -wd) * 180) / Math.PI;
  const line = sightLine(s);
  const input = buildInput(s.lo, s.cond, { yaw: line.yaw, pitch: s.lastRange.pitch, eyeHeightM: s.shooter.position.eyeHeightM });
  input.wind = { zones: [{ untilM: null, speedMps: speed, fromDeg: (fromRel + 360) % 360 }], gusts: null };
  try {
    const sol = engine.solve(input, { maxRangeM: s.lastRange.distanceM, stepM: s.lastRange.distanceM });
    const r = sol.rows[sol.rows.length - 1];
    const cm = clickMrad(s.lo.optic);
    s.solution = { elevationClicks: Math.round(r.elevationMrad / cm), windageClicks: Math.round(r.windageMrad / cm) };
    $("solution").textContent = `Calculator (shooter's wind): ${dir(toOpticUnit(r.elevationMrad), "U", "D")} · ${dir(toOpticUnit(r.windageMrad), "R", "L")} ${unit()} = ${s.solution.elevationClicks} / ${s.solution.windageClicks} clicks · press G to dial elevation`;
    $("solution").classList.add("show");
  } catch (e) {
    $("solution").textContent = String((e as Error).message ?? e);
  }
}


// ---------------------------------------------------------------- HUD

function dl(items: [string, string][]): string {
  return items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
}

let hudTimer = 0;
function updateHud(s: Session, dt: number) {
  // Weather meter wind: 3 s moving average at the firing point.
  const [wd, wr] = s.sampler.at(0, s.t);
  const k = Math.min(1, dt / 3);
  s.meterWind = [s.meterWind[0] + (wd - s.meterWind[0]) * k, s.meterWind[1] + (wr - s.meterWind[1]) * k];
  hudTimer += dt;
  const breath = s.shooter;
  const bar = $("breath-bar");
  const pct = breath.holding ? 100 - Math.min(100, (breath.holdTime / 15) * 100) : 100;
  bar.style.width = `${pct}%`;
  bar.className = breath.holding ? (breath.holdTime > 6 ? "debt" : "hold") : breath.inRespiratoryPause ? "pause" : "";
  $("breath-label").textContent = breath.holding ? `Holding ${breath.holdTime.toFixed(1)} s` : breath.inRespiratoryPause ? "Natural pause" : "Breathing";
  if (hudTimer < 0.15) return;
  hudTimer = 0;

  const [md, mr] = s.meterWind;
  const speed = Math.hypot(md, mr);
  const fromRel = (Math.atan2(-mr, -md) * 180) / Math.PI - (sightLine(s).yaw * 180) / Math.PI;
  const a = s.cond.atmosphere;
  $("kestrel").innerHTML = dl([
    ["Wind", `${speed.toFixed(1)} m/s from ${clockOf(fromRel)} o'clock`],
    ["Temperature", `${a.temperatureC.toFixed(1)} °C`],
    ["Station pressure", `${(a.pressurePa / 100).toFixed(1)} hPa`],
    ["Humidity", `${Math.round(a.humidity * 100)} %`],
    ["Density altitude", `${Math.round(s.densityAltitudeM)} m`],
  ]);
  const cm = clickMrad(s.lo.optic);
  $("turrets").innerHTML = dl([
    ["Elevation", `${dir(toOpticUnit(s.dial.elevation * cm), "U", "D")} ${unit()} (${s.dial.elevation})`],
    ["Windage", `${dir(toOpticUnit(s.dial.windage * cm), "R", "L")} ${unit()} (${s.dial.windage})`],
    ["Magnification", s.scoped ? `${s.mag}x ${s.lo.optic.focalPlane.toUpperCase()}` : "Naked eye"],
  ]);
  $("shooter").innerHTML = dl([
    ["Position", s.shooter.position.name],
    ["Heart rate", `${Math.round(s.shooter.heartRate)} bpm`],
    ["Rounds", `${s.rounds} / ${s.capacity}${s.t < s.nextReadyT ? " · cycling" : ""}`],
    ["Barrel", `${Math.round(s.barrelTempC)} °C`],
  ]);
}

// ---------------------------------------------------------------- input

function adjustDial(axis: "elevation" | "windage", clicks: number) {
  const s = session!;
  const o = s.lo.optic;
  const cm = clickMrad(o);
  const maxE = Math.floor((o.unit === "mil" ? o.elevationTravel : o.elevationTravel * MRAD_PER_MOA) / cm);
  const maxW = Math.floor((o.unit === "mil" ? o.windageTravel : o.windageTravel * MRAD_PER_MOA) / 2 / cm);
  if (axis === "elevation") s.dial.elevation = Math.max(o.zeroStop ? 0 : -maxE / 4, Math.min(maxE, s.dial.elevation + clicks));
  else s.dial.windage = Math.max(-maxW, Math.min(maxW, s.dial.windage + clicks));
}

document.addEventListener("keydown", (e) => {
  if (!session || setup.classList.contains("open")) return;
  const s = session;
  keys.add(e.code);
  const step = e.ctrlKey ? 10 : 1;
  switch (e.code) {
    case "KeyW":
    case "ArrowUp":
      adjustDial("elevation", step);
      break;
    case "KeyS":
    case "ArrowDown":
      adjustDial("elevation", -step);
      break;
    case "KeyD":
    case "ArrowRight":
      adjustDial("windage", step);
      break;
    case "KeyA":
    case "ArrowLeft":
      adjustDial("windage", -step);
      break;
    case "KeyZ":
      s.dial = { elevation: 0, windage: 0 };
      break;
    case "KeyR":
      rangefind();
      break;
    case "KeyG":
      if (s.solution) {
        s.dial.elevation = 0;
        adjustDial("elevation", s.solution.elevationClicks);
      }
      break;
    case "KeyV":
      s.scoped = !s.scoped;
      break;
    case "KeyI":
      s.illum = !s.illum;
      break;
    case "KeyX":
      if (s.rounds < s.capacity) {
        s.nextReadyT = s.t + 3;
        s.rounds = s.capacity;
        message("call", "Reloading", 2);
      }
      break;
    case "KeyC":
      s.world.clearMarks();
      s.impacts.clear();
      drawTablet(s);
      message("call", "Targets pasted", 2);
      break;
    case "Tab":
      $("log").classList.toggle("collapsed");
      break;
    default: {
      const p = POSITIONS.find((x) => x.key === e.key);
      if (p) {
        s.shooter.setPosition(p);
        settings.positionId = p.id;
        save(SETTINGS_KEY, settings);
        message("call", p.name, 2);
      }
    }
  }
  if (["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
});
document.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

canvas.addEventListener("click", () => {
  if (session && document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
document.addEventListener("pointerlockchange", () => {
  if (!session) return;
  if (document.pointerLockElement === canvas) {
    setup.classList.remove("open");
    hud.hidden = false;
  } else {
    setup.classList.add("open");
    $<HTMLButtonElement>("start").textContent = "Resume";
  }
});
document.addEventListener("mousemove", (e) => {
  if (!session || document.pointerLockElement !== canvas) return;
  const s = session;
  const fovRad = (camera.fov * Math.PI) / 180;
  const k = (fovRad / window.innerHeight) * 0.9;
  const dx = e.movementX * k;
  const dy = e.movementY * k;
  s.aimYaw += dx;
  s.aimPitch = Math.max(-0.4, Math.min(0.4, s.aimPitch - dy));
  s.shooter.moved(Math.hypot(dx, dy) * 1000);
});
document.addEventListener("mousedown", (e) => {
  if (session && document.pointerLockElement === canvas && e.button === 0) shoot();
});
document.addEventListener(
  "wheel",
  (e) => {
    if (!session || document.pointerLockElement !== canvas) return;
    const o = session.lo.optic;
    session.mag = Math.max(o.magMin, Math.min(o.magMax, session.mag + (e.deltaY < 0 ? 1 : -1)));
  },
  { passive: true },
);

$("start").addEventListener("click", () => {
  audio.resume();
  const resume = session && $<HTMLButtonElement>("start").textContent === "Resume" && !$("setup-note").textContent;
  if (!resume) startSession();
  $("setup-note").textContent = "";
  setup.classList.remove("open");
  hud.hidden = false;
  canvas.requestPointerLock();
});

// ---------------------------------------------------------------- loop

let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const s = session;
  if (!s) return;
  const paused = setup.classList.contains("open");
  if (!paused) {
    s.t += dt;
    s.shooter.update(dt, keys.has("Space"));
    s.barrelTempC += (s.cond.atmosphere.temperatureC - s.barrelTempC) * Math.min(1, dt / 240);
  }
  s.world.update(s.t, (down) => s.sampler.at(down, s.t));

  // With the log open, render beside it so the scope stays centred on the line of sight.
  const full = window.innerWidth;
  const logOpen = !$("log").classList.contains("collapsed") && full > 900;
  const w = logOpen ? full - 292 : full;
  const h = window.innerHeight;
  renderer.setViewport(0, 0, w, h);
  camera.aspect = w / h;
  const eye = s.shooter.position.eyeHeightM;
  const line = sightLine(s);
  camera.position.set(0, eye + groundHeight(0, 0), 0);
  camera.rotation.set(line.pitch, -line.yaw, 0);
  if (s.scoped) {
    const L = scopeLayout(w, h, s.mag);
    camera.fov = L.cameraFovDeg;
    camera.updateProjectionMatrix();
    renderer.render(s.world.scene, camera);
    drawScope(og, w, h, L, { optic: s.lo.optic, mag: s.mag, illuminated: s.illum, eyeOffset: s.shooter.eyeOffset(), dim: 0 });
  } else {
    camera.fov = NAKED_EYE_FOV_DEG;
    camera.updateProjectionMatrix();
    renderer.render(s.world.scene, camera);
    drawNakedEye(og, w, h);
  }
  updateHud(s, dt);
}

async function boot() {
  resize();
  renderSetup();
  setup.classList.add("open");
  try {
    engine = await loadEngine();
  } catch (e) {
    $("setup-note").textContent = `Could not load the ballistics engine: ${String(e)}`;
    return;
  }
  requestAnimationFrame(frame);
}

boot();

// Dev-only hook for automated checks (pointer lock cannot be scripted).
if (import.meta.env.DEV) {
  (window as any).__range = {
    get session() {
      return session;
    },
    start: () => {
      startSession();
      setup.classList.remove("open");
      hud.hidden = false;
    },
    shoot,
    rangefind,
    adjustDial,
    camera,
  };
}
