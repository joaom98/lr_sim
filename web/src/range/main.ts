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
import { analyzeShot, coach, type Breakdown, type ShotContext } from "./analysis";
import { heatFactor, MiragePass } from "./mirage";
import { addRecord, records, save, type ShotRecord } from "./records";
import { career, finishDrill, isUnlocked, nextRank, rank, resetCareer, stats, unlockName, type Award } from "./career";
import { DRILLS, DrillRun, type DrillDef } from "./drills";

// ---------------------------------------------------------------- settings & records

interface Settings {
  rifleId: string;
  ammoId: string;
  opticId: string;
  weatherId: string;
  windId: string;
  seed: number;
  positionId: string;
  /** "free" or a drill id */
  mode: string;
}

/** Parallax settings on the side focus knob (m); the last is infinity. */
const PARALLAX_STEPS = [25, 50, 75, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 1e9];
/** Parallax shift (mrad) per unit of eye offset per (1/m) of focus error. */
const PARALLAX_K = 45;

const SETTINGS_KEY = "lrs.range.settings.v1";

function loadSettings(): Settings {
  const d: Settings = {
    rifleId: rifles[0].id,
    ammoId: rifles[0].defaultAmmo,
    opticId: optics[0].id,
    weatherId: weatherPresets[0].id,
    windId: "moderate",
    seed: Math.floor(Math.random() * 1e6),
    positionId: POSITIONS[0].id,
    mode: "free",
  };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return d;
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

const drillDef = (id = settings.mode): DrillDef | null => DRILLS.find((d) => d.id === id) ?? null;

/** Gear locks apply in drills only; free range is a sandbox. */
function gearLabel(kind: "rifles" | "optics", id: string, name: string): string {
  if (!drillDef() || isUnlocked(kind, id)) return name;
  return `${name} (unlocks at ${unlockName(kind, id)})`;
}

function selLocked(id: "rifleId" | "opticId", label: string, kind: "rifles" | "optics", items: { id: string; name: string }[]) {
  const v = String(settings[id]);
  const locked = (x: { id: string }) => Boolean(drillDef()) && !isUnlocked(kind, x.id);
  return `<label class="field"><span>${esc(label)}</span><select data-k="${id}">${items
    .map(
      (x) =>
        `<option value="${esc(x.id)}" ${x.id === v ? "selected" : ""} ${locked(x) ? "disabled" : ""}>${esc(gearLabel(kind, x.id, x.name))}</option>`,
    )
    .join("")}</select></label>`;
}

function renderCareer() {
  const r = rank();
  const next = nextRank();
  const frac = next ? (career.xp - r.xp) / (next.xp - r.xp) : 1;
  $("career").innerHTML = `<div class="rank">${esc(r.name)}</div>
    <div class="xpbar" role="progressbar" aria-label="XP to next rank" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}"><div style="width:${(frac * 100).toFixed(1)}%"></div></div>
    <div class="xptext">${career.xp} XP${next ? ` · ${next.xp - career.xp} XP to ${esc(next.name)}` : " · top rank"}</div>`;

  const card = (id: string, name: string, line: string, locked: string | null) => {
    const best = career.best[id];
    return `<button type="button" class="mode" role="radio" data-mode="${esc(id)}" aria-checked="${settings.mode === id}" ${locked ? "disabled" : ""}>
      <b>${esc(name)}</b><span>${esc(line)}</span>
      ${locked ? `<span class="lock">Unlocks at ${esc(locked)}</span>` : best ? `<span class="best">Best ${best.score}/${best.max}</span>` : ""}
    </button>`;
  };
  const d = drillDef();
  $("modes").innerHTML =
    card("free", "Free range", "Sandbox: every rifle and scope", null) +
    DRILLS.map((x) => card(x.id, x.name, `${x.xp} XP${x.timeLimitS ? ` · ${x.timeLimitS} s` : ""}`, isUnlocked("drills", x.id) ? null : unlockName("drills", x.id))).join("") +
    `<p class="mode-summary" style="grid-column: 1 / -1">${esc(d ? d.summary + (d.recommended ? ` Recommended: ${d.recommended}.` : "") : "Shoot anything, any way you like. Shots still count toward your statistics.")}</p>`;

  const st = stats();
  const pct = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)} %` : "–");
  $("stats").innerHTML = st.shots
    ? `<dl class="stats-grid">
        <div class="stat"><dt>Shots at targets</dt><dd>${st.shots}</dd></div>
        <div class="stat"><dt>Hit rate</dt><dd>${pct(st.hits, st.shots)}</dd></div>
        ${st.bands.map((b) => `<div class="stat"><dt>${b.label}</dt><dd>${pct(b.hits, b.shots)} <small>(${b.shots})</small></dd></div>`).join("")}
        ${st.topErrors.map((e, i) => `<div class="stat"><dt>${i === 0 ? "Most common error" : "Next"}</dt><dd>${esc(e.label)} ${Math.round(e.share * 100)} %</dd></div>`).join("")}
      </dl>
      <p class="note"><button type="button" id="reset-career" class="ghost-btn">Reset career</button></p>`
    : "<p class='note'>No shots yet. Statistics build up from every shot you fire.</p>";
}

function renderSetup() {
  // In a drill, swap locked gear for the first unlocked choice.
  if (drillDef()) {
    if (!isUnlocked("rifles", settings.rifleId)) settings.rifleId = rifles.find((r) => isUnlocked("rifles", r.id))!.id;
    if (!isUnlocked("optics", settings.opticId)) settings.opticId = optics.find((o) => isUnlocked("optics", o.id))!.id;
  }
  const rifle = rifles.find((r) => r.id === settings.rifleId) ?? rifles[0];
  const loads = ammo.filter((a) => a.caliber === rifle.caliber);
  if (!loads.some((a) => a.id === settings.ammoId)) settings.ammoId = rifle.defaultAmmo;
  renderCareer();
  setupForm.innerHTML =
    selLocked("rifleId", "Rifle", "rifles", rifles) +
    sel("ammoId", "Load", loads.map((a) => [a.id, a.name])) +
    selLocked("opticId", "Scope", "optics", optics) +
    sel("positionId", "Position", POSITIONS.map((p) => [p.id, `${p.key}. ${p.name}`])) +
    sel("weatherId", "Weather", weatherPresets.map((w) => [w.id, w.name])) +
    sel("windId", "Wind", windPresets.map((w) => [w.id, w.name])) +
    `<label class="field"><span>Session seed</span><input type="number" data-k="seed" value="${settings.seed}" step="1"></label>`;
}

$("modes").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
  if (!b || b.disabled) return;
  settings.mode = b.dataset.mode!;
  save(SETTINGS_KEY, settings);
  renderSetup();
  if (session) $("setup-note").textContent = "Start to begin the selected mode.";
});
$("stats").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).id !== "reset-career") return;
  if (!window.confirm("Reset XP, rank and best scores? Shot history is kept.")) return;
  resetCareer();
  renderSetup();
});

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
  parallaxIdx: number;
  /** distance to whatever is under the reticle, refreshed a few times a second */
  focusM: number;
  focusAt: number;
  heat: number;
  lastFlight: { path: THREE.Vector3[]; times: number[] } | null;
  replay: { t: number; bullet: THREE.Mesh } | null;
  drill: DrillRun | null;
  /** scope zero error: where the bore points relative to the reticle at zero dial (mrad) */
  zeroErr: { x: number; y: number };
  /** the zero stop only engages once zero has been set (always, except while zeroing) */
  zeroStopSet: boolean;
}

let engine: Engine;
let session: Session | null = null;
const audio = new RangeAudio();
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
  const def = drillDef();
  let wind = windPresets.find((w) => w.id === settings.windId) ?? windPresets[1];
  // A wind-reading drill needs wind worth reading.
  if (def?.minWind) {
    const need = windPresets.findIndex((w) => w.id === def.minWind);
    if (windPresets.indexOf(wind) < need) wind = windPresets[need];
  }
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
    parallaxIdx: PARALLAX_STEPS.indexOf(100),
    focusM: 100,
    focusAt: -1,
    heat: heatFactor(cond.atmosphere.temperatureC, cond.atmosphere.humidity),
    lastFlight: null,
    replay: null,
    drill: null,
    zeroErr: { x: 0, y: 0 },
    zeroStopSet: !def?.offZero,
  };
  startDrill(session, def);
  $("scope-name").textContent = lo.optic.name;
  for (const id of ["solution", "ranging", "coach", "call"]) {
    $(id).textContent = "";
    $(id).classList.remove("show");
  }
  drawTablet(session);
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

const parallaxM = (s: Session) => PARALLAX_STEPS[s.parallaxIdx];

/** How far the target image sits from the reticle because of focus error (mrad, x right, y up).
 *  Zero when parallax is set to the distance of what is under the reticle, or the eye is centred. */
function parallaxShift(s: Session): { x: number; y: number } {
  if (!s.scoped) return { x: 0, y: 0 };
  const e = s.shooter.eyeOffset();
  const k = PARALLAX_K * (1 / parallaxM(s) - 1 / s.focusM);
  return { x: e.x * k, y: -e.y * k };
}

/** Distance along a sight line to the first target plate or the ground (m). */
function losDistance(s: Session, yaw: number, pitch: number): number {
  const eyeY = s.shooter.position.eyeHeightM + groundHeight(0, 0);
  const origin = new THREE.Vector3(0, eyeY, 0);
  const d = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  let best = 3000;
  for (const tg of s.world.targets) {
    const denom = d.dot(tg.normal);
    if (denom >= 0) continue;
    const dist = origin.clone().sub(tg.center).dot(tg.normal) / -denom;
    const p = d.clone().multiplyScalar(dist).add(origin).sub(tg.center);
    if (Math.abs(p.dot(tg.right)) < tg.def.sizeM && Math.abs(p.y) < tg.halfHeight * 1.5) best = Math.min(best, dist);
  }
  for (let r = 4; r < best; r += r < 200 ? 2 : 8) {
    if (eyeY + d.y * r < groundHeight(-d.z * r, d.x * r)) return r;
  }
  return best;
}

function aimAt(tg: TargetObj, eye: number): { yaw: number; pitch: number } {
  return {
    yaw: Math.atan2(tg.center.x, -tg.center.z),
    pitch: Math.atan2(tg.center.y - eye, Math.hypot(tg.center.x, tg.center.z)),
  };
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
  const cantDeg = s.shooter.cantDeg;
  const aim = { yaw: line.yaw, pitch: line.pitch, eyeHeightM: eye, cantDeg };
  // Where the reticle appeared to be: the rifle's line plus any parallax shift of the image.
  const shift = parallaxShift(s);
  const visual = { yaw: line.yaw + shift.x / 1000, pitch: line.pitch + shift.y / 1000 };
  const intended = intendedTarget(s, visual.yaw, visual.pitch, eye);
  let out: ShotOutcome;
  try {
    out = fire(engine, lo, s.cond, aim, s.dial, { mvDeltaMps: mvDelta, bcScale, timeS: s.t, errX: err.x + s.zeroErr.x, errY: err.y + s.zeroErr.y }, s.world.targets);
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
  const ctx: ShotContext | null = intended
    ? {
        aim,
        visualAim: { ...aim, ...visual },
        intendedAim: { ...aim, ...aimAt(intended, eye) },
        dial: { ...s.dial },
        mvDeltaMps: mvDelta,
        bcScale,
        timeS: s.t,
        trigger: err,
        zero: { ...s.zeroErr },
      }
    : null;
  const coachInfo = { holdTimeS: s.shooter.holdTime, cantDeg, parallaxM: parallaxM(s) };
  s.lastFlight = { path: out.path, times: out.times };
  // The trace shows best in humid air; on very dry days it is faint.
  s.world.launch(out.path, out.times, s.t, 0.22 + humidity * 0.45, () =>
    resolveImpact(s, shotNo, out, intended, dialMrad, heldBreath, inPause, ctx, coachInfo),
  );
}

function resolveImpact(
  s: Session,
  shotNo: number,
  out: ShotOutcome,
  intended: TargetObj | null,
  dialMrad: { elevation: number; windage: number },
  heldBreath: boolean,
  inPause: boolean,
  ctx: ShotContext | null,
  coachInfo: { holdTimeS: number; cantDeg: number; parallaxM: number },
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
  const callDelay = Math.min(1500, 250 + soundDelay * 1000 * 0.3);
  window.setTimeout(() => message("call", call, 5), callDelay);

  // Why the shot went there, and one thing to work on.
  let breakdown: Breakdown | null = null;
  if (ctx && intended) {
    try {
      breakdown = analyzeShot(engine, s.lo, s.cond, intended, ctx);
    } catch {
      breakdown = null;
    }
  }
  if (breakdown && intended) {
    const tip = coach({
      breakdown,
      hit: result === "hit",
      inPause,
      heldBreath,
      holdTimeS: coachInfo.holdTimeS,
      cantDeg: coachInfo.cantDeg,
      parallaxM: coachInfo.parallaxM,
      targetRangeM: intended.def.rangeM,
      fmt: (mrad) => `${toOpticUnit(mrad).toFixed(digits() + 1)} ${unit()}`,
    });
    window.setTimeout(() => message("coach", tip, 9), callDelay + 400);
  }

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
    cantDeg: coachInfo.cantDeg,
    breakdown: breakdown?.parts.map((p) => ({ key: p.key, x: +p.x.toFixed(4), y: +p.y.toFixed(4) })),
    drillId: s.drill?.def.id,
  };
  addRecord(rec);
  addLogRow(rec, tg, breakdown);
  drawTablet(s);
  if (s.drill) drillShot(s, rec, tg);
}

function addLogRow(r: ShotRecord, tg: TargetObj | null, b: Breakdown | null) {
  const li = document.createElement("li");
  li.className = r.result;
  const off = r.offsetMrad
    ? `${dir(toOpticUnit(r.offsetMrad.y), "U", "D")} / ${dir(toOpticUnit(r.offsetMrad.x), "R", "L")}`
    : "n/a";
  li.innerHTML = `<b>#${r.shot}</b> ${esc(tg?.def.name ?? "No target")} · <span class="res">${r.result.toUpperCase()}</span><br>
    <span>${off} ${unit()} · ToF ${r.timeOfFlightS.toFixed(2)} s · ${Math.round(r.impactVelocityMps)} m/s · ${Math.round(r.energyJ)} J${r.inPause ? " · pause" : r.heldBreath ? " · held" : ""}</span>`;
  if (b) {
    // Biggest contributors first; tiny ones are left out.
    const size = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    const parts = b.parts.filter((p) => size(p) >= 0.02).sort((a, c) => size(c) - size(a));
    const fmtPart = (p: { x: number; y: number }) => {
      const out: string[] = [];
      if (Math.abs(p.y) >= 0.02) out.push(dir(toOpticUnit(p.y), "U", "D", 2));
      if (Math.abs(p.x) >= 0.02) out.push(dir(toOpticUnit(p.x), "R", "L", 2));
      return out.join(" ");
    };
    const div = document.createElement("div");
    div.className = "why";
    div.innerHTML = parts.length
      ? parts
          .slice(0, 4)
          .map((p) => `<span>${esc(p.label)} <b>${fmtPart(p)}</b></span>`)
          .join("")
      : "<span>Every error under 0.02 mrad</span>";
    li.append(div);
  }
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
  if (s.drill && !s.drill.def.tools.rangefinder) {
    message("ranging", "No rangefinder in this drill: range with the reticle, then press N", 4);
    return;
  }
  // Build the beam from the current sight line rather than the last rendered frame.
  const line = sightLine(s);
  const eye = new THREE.Vector3(0, s.shooter.position.eyeHeightM + groundHeight(0, 0), 0);
  // The laser beam is about 1.5 x 0.8 mrad wide. Sample it and report the strongest return:
  // steel anywhere in the beam wins (like a first-target mode), otherwise the nearest ground.
  let targetHit = Infinity;
  let groundHit = Infinity;
  const ray = new THREE.Raycaster();
  ray.far = 2600;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      const yaw = line.yaw + (ix * 0.375) / 1000;
      const pitch = line.pitch + (iy * 0.4) / 1000;
      ray.set(eye, new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)));
      const h = ray.intersectObjects(s.world.raycastables, false)[0];
      if (!h) continue;
      if (h.object.userData.target) targetHit = Math.min(targetHit, h.distance);
      else groundHit = Math.min(groundHit, h.distance);
    }
  }
  // Steel returns well; bare ground only to ~1400 m.
  const dist = targetHit < Infinity ? targetHit : groundHit <= 1400 ? groundHit : null;
  if (dist === null) {
    message("ranging", groundHit < Infinity ? "Rangefinder: no return (ground too far)" : "Rangefinder: no return", 3);
    return;
  }
  const d = dist + s.rand.normal() * 0.5;
  const pitch = line.pitch;
  s.lastRange = { distanceM: d, pitch };
  message("ranging", `Range ${d.toFixed(0)} m · angle ${((pitch * 180) / Math.PI).toFixed(1)}°`, 8);
  showSolution();
}

/** Calculator solution using what the shooter can measure: range and wind at the firing point. */
function showSolution() {
  const s = session!;
  if (!s.lastRange) return;
  const calc = s.drill?.def.tools.calculator ?? "full";
  if (calc === "none") return;
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
    const at = `${s.lastRange.distanceM.toFixed(0)} m`;
    $("solution").textContent =
      calc === "elevation"
        ? `Calculator, ${at}: ${dir(toOpticUnit(r.elevationMrad), "U", "D")} ${unit()} = ${s.solution.elevationClicks} clicks · wind is your call · G dials elevation`
        : `Calculator, ${at} (shooter's wind): ${dir(toOpticUnit(r.elevationMrad), "U", "D")} · ${dir(toOpticUnit(r.windageMrad), "R", "L")} ${unit()} = ${s.solution.elevationClicks} / ${s.solution.windageClicks} clicks · G dials elevation`;
    $("solution").classList.add("show");
  } catch (e) {
    $("solution").textContent = String((e as Error).message ?? e);
  }
}


// ---------------------------------------------------------------- drills

function startDrill(s: Session, def: DrillDef | null) {
  $("drill").hidden = !def;
  s.world.setSignsVisible(def ? def.tools.signs : true);
  s.world.setMarker(null);
  if (!def) return;
  s.drill = new DrillRun(def, s.cond.seed, s.world.targets.map((t) => t.def), s.t);
  s.shooter.stress = def.stress ?? 0;
  if (def.offZero) {
    // Knocked off zero: 0.5–1.2 mrad in a random direction.
    const a = s.rand.uniform() * Math.PI * 2;
    const m = 0.5 + s.rand.uniform() * 0.7;
    s.zeroErr = { x: Math.cos(a) * m, y: Math.sin(a) * m };
  }
  enterStage(s);
}

function enterStage(s: Session) {
  const st = s.drill?.stage;
  if (!st) return;
  if (st.position) {
    const p = POSITIONS.find((x) => x.id === st.position)!;
    if (p.id !== s.shooter.position.id) {
      s.shooter.setPosition(p);
      s.shooter.stress = Math.min(1, s.shooter.stress + 0.2);
      message("call", `Move: ${p.name}`, 3);
    }
  }
  const tg = st.targetId ? s.world.targets.find((t) => t.def.id === st.targetId) ?? null : null;
  s.world.setMarker(tg);
  if (tg) s.tabletTarget = tg;
}

function drillShot(s: Session, rec: ShotRecord, tg: TargetObj | null) {
  const run = s.drill!;
  const before = run.stageIndex;
  const half = tg ? (tg.def.sizeM / 2 / tg.def.rangeM) * 1000 : 0.5;
  const pts = run.shot(rec.targetId, rec.result === "hit", rec.offsetMrad, half);
  if (pts > 0) message("ranging", `+${pts} points`, 2.5);
  if (run.done) window.setTimeout(() => endDrill(s), 1600);
  else if (run.stageIndex !== before) enterStage(s);
}

function setZero(s: Session) {
  const cm = clickMrad(s.lo.optic);
  // Re-index: the dial's correction becomes the new zero, turrets read 0.
  s.zeroErr = { x: s.zeroErr.x + s.dial.windage * cm, y: s.zeroErr.y + s.dial.elevation * cm };
  s.dial = { elevation: 0, windage: 0 };
  s.zeroStopSet = true;
  message("call", "Zero set: turrets re-indexed to 0, zero stop engaged", 3);
  if (s.drill?.stage?.kind === "action") {
    s.drill.action();
    enterStage(s);
  }
}

let resultsOpen = false;

function endDrill(s: Session) {
  const run = s.drill;
  if (!run || session !== s || resultsOpen) return;
  if (!run.done) run.finish("quit");
  const award: Award = finishDrill(run.def.id, run.points, run.max, run.def.xp);
  s.world.setMarker(null);
  resultsOpen = true;
  document.exitPointerLock();
  // Biggest error source across this drill's shots.
  const shots = records.filter((r) => r.session === s.cond.seed && r.drillId === run.def.id).slice(-run.results.length);
  const totals = new Map<string, number>();
  for (const r of shots) for (const p of r.breakdown ?? []) totals.set(p.key, (totals.get(p.key) ?? 0) + Math.hypot(p.x, p.y));
  const worst = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  const labels: Record<string, string> = { hold: "hold / sway", trigger: "trigger", parallax: "parallax", cant: "cant", ammo: "ammunition variation", elevation: "elevation data", wind: "wind calls" };
  const reason = run.endReason === "time" ? "Time ran out." : run.endReason === "quit" ? "Stopped early." : "Course of fire complete.";
  const rows = run.results
    .map((r, i) => {
      const tg = s.world.targets.find((t) => t.def.id === r.targetId);
      const off = r.offset ? `${dir(toOpticUnit(r.offset.y), "U", "D", 2)} / ${dir(toOpticUnit(r.offset.x), "R", "L", 2)}` : "–";
      return `<tr><td>${i + 1}</td><td>${esc(tg?.def.name ?? "No target")}</td><td class="${r.hit ? "hit" : "miss"}">${r.hit ? "Hit" : "Miss"}</td><td>${off}</td><td>${r.points}</td></tr>`;
    })
    .join("");
  $("results-title").textContent = run.def.name;
  $("results-body").innerHTML = `<p class="results-score">${run.points} / ${run.max}</p>
    <p>${reason} ${award.newBest ? "<span class='award'>New personal best.</span>" : ""}</p>
    <p class="award">+${award.xp} XP${award.rankedUp ? ` · Promoted to ${esc(award.rankedUp.name)}!` : ""}</p>
    ${worst ? `<p>Biggest source of error this run: <b>${esc(labels[worst[0]] ?? worst[0])}</b>.</p>` : ""}
    <table class="results-table"><thead><tr><th>#</th><th>Target</th><th>Result</th><th>Offset (${unit()})</th><th>Points</th></tr></thead><tbody>${rows}</tbody></table>`;
  $("results").classList.add("open");
  $("drill").hidden = true;
  renderSetup();
}

function updateDrillHud(s: Session) {
  const run = s.drill;
  if (!run) return;
  run.tick(s.t);
  if (run.done && !resultsOpen) {
    endDrill(s);
    return;
  }
  const st = run.stage;
  if (!st) return;
  const left = run.timeLeft(s.t);
  const tg = st.targetId ? s.world.targets.find((t) => t.def.id === st.targetId) : null;
  // Unknown distance: the plate size is all you get for ranging.
  const size =
    tg && !run.def.tools.signs
      ? ` · plate ${tg.def.sizeM.toFixed(2)} m ${tg.def.shape === "circle" ? "circle" : tg.def.shape === "ipsc" ? "wide" : "square"}`
      : "";
  const shotsLine = st.kind === "action" ? "" : ` · shot ${Math.min(run.shotsInStage + 1, st.shots)} of ${st.shots}`;
  $("drill").innerHTML = `<div class="drill-head"><span>${esc(run.def.name)}</span><span>${run.points} / ${run.max} pts</span>${
    left !== null ? `<span class="timer ${left < 15 ? "low" : ""}">${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}</span>` : ""
  }</div>
    <div class="drill-brief">Stage ${run.stageIndex + 1} of ${run.stages.length}: ${esc(st.brief)}${shotsLine}${size}</div>
    <div class="progress"><div style="width:${((run.stageIndex / run.stages.length) * 100).toFixed(0)}%"></div></div>`;
}

// ---------------------------------------------------------------- range entry (N)

let entering = false;

function openRangeEntry() {
  entering = true;
  document.exitPointerLock();
  const f = $<HTMLFormElement>("range-entry");
  f.hidden = false;
  const input = $<HTMLInputElement>("range-input");
  input.value = session?.lastRange ? session.lastRange.distanceM.toFixed(0) : "";
  window.setTimeout(() => input.focus(), 0);
}

function closeRangeEntry() {
  $<HTMLFormElement>("range-entry").hidden = true;
  canvas.requestPointerLock();
  window.setTimeout(() => (entering = false), 300);
}

$<HTMLFormElement>("range-entry").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = session;
  const d = Number($<HTMLInputElement>("range-input").value);
  if (s && Number.isFinite(d) && d >= 25 && d <= 3000) {
    s.lastRange = { distanceM: d, pitch: sightLine(s).pitch };
    message("ranging", `Calculator set to ${d.toFixed(0)} m`, 4);
    showSolution();
  }
  closeRangeEntry();
});
$("range-cancel").addEventListener("click", closeRangeEntry);

$("retry").addEventListener("click", () => {
  $("results").classList.remove("open");
  resultsOpen = false;
  settings.seed = (settings.seed + 1) >>> 0;
  save(SETTINGS_KEY, settings);
  renderSetup();
  startSession();
  setup.classList.remove("open");
  hud.hidden = false;
  canvas.requestPointerLock();
});
$("to-setup").addEventListener("click", () => {
  $("results").classList.remove("open");
  resultsOpen = false;
  setup.classList.add("open");
  $<HTMLButtonElement>("start").textContent = "Go to the range";
});

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
    ["Parallax", parallaxM(s) >= 1e5 ? "∞" : `${parallaxM(s)} m`],
    [
      "Cant",
      `${Math.abs(s.shooter.cantDeg).toFixed(1)}° ${Math.abs(s.shooter.cantDeg) < 0.35 ? "level" : s.shooter.cantDeg > 0 ? "right" : "left"}`,
    ],
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
  if (axis === "elevation") s.dial.elevation = Math.max(o.zeroStop && s.zeroStopSet ? 0 : -maxE / 2, Math.min(maxE, s.dial.elevation + clicks));
  else s.dial.windage = Math.max(-maxW, Math.min(maxW, s.dial.windage + clicks));
}

document.addEventListener("keydown", (e) => {
  if (!session || setup.classList.contains("open") || entering || resultsOpen) return;
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
    case "KeyQ":
      s.shooter.adjustCant(-0.25);
      break;
    case "KeyE":
      s.shooter.adjustCant(0.25);
      break;
    case "BracketLeft":
      s.parallaxIdx = Math.max(0, s.parallaxIdx - 1);
      break;
    case "BracketRight":
      s.parallaxIdx = Math.min(PARALLAX_STEPS.length - 1, s.parallaxIdx + 1);
      break;
    case "KeyB":
      startReplay(s);
      break;
    case "KeyK":
      setZero(s);
      break;
    case "KeyN":
      // Cancel the key's default so the "n" isn't typed into the field that just took focus.
      e.preventDefault();
      openRangeEntry();
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
  } else if (!entering && !resultsOpen) {
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
  if (session?.drill && !session.drill.done && !resume) session.drill.finish("quit");
  if (!resume) startSession();
  $("setup-note").textContent = "";
  setup.classList.remove("open");
  hud.hidden = false;
  canvas.requestPointerLock();
});

// ---------------------------------------------------------------- loop

// ---------------------------------------------------------------- bullet cam

const REPLAY_SPEED = 0.2;

function startReplay(s: Session) {
  if (!s.lastFlight) {
    message("call", "No shot to replay yet", 2);
    return;
  }
  if (s.replay) return;
  const bullet = new THREE.Mesh(
    new THREE.CylinderGeometry(0.004, 0.004, 0.032, 10).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0xb87333, emissive: 0x402010 }),
  );
  s.world.scene.add(bullet);
  s.replay = { t: 0, bullet };
}

/** Follows the last shot at a fifth of real speed. Returns false when the replay has ended. */
function replayFrame(s: Session, dt: number): boolean {
  const r = s.replay!;
  const f = s.lastFlight!;
  r.t += dt * REPLAY_SPEED;
  const end = f.times[f.times.length - 1];
  if (r.t > end + 0.15) {
    s.world.scene.remove(r.bullet);
    r.bullet.geometry.dispose();
    s.replay = null;
    $("replay").classList.remove("show");
    return false;
  }
  const t = Math.min(r.t, end);
  let k = 1;
  while (k < f.times.length - 1 && f.times[k] < t) k++;
  const a = f.path[k - 1];
  const b = f.path[k];
  const u = (t - f.times[k - 1]) / Math.max(1e-6, f.times[k] - f.times[k - 1]);
  const pos = a.clone().lerp(b, Math.min(1, u));
  const dirv = b.clone().sub(a).normalize();
  r.bullet.position.copy(pos);
  r.bullet.lookAt(pos.clone().add(dirv));
  const back = Math.min(2.2, 0.4 + pos.length() * 0.01);
  camera.position.copy(pos).addScaledVector(dirv, -back).add(new THREE.Vector3(0.05, 0.06, 0));
  camera.lookAt(pos.clone().addScaledVector(dirv, 25));
  camera.fov = 40;
  camera.updateProjectionMatrix();
  const speed = b.distanceTo(a) / Math.max(1e-6, f.times[k] - f.times[k - 1]);
  $("replay").textContent = `Bullet cam ×${REPLAY_SPEED} · ${(-pos.z).toFixed(0)} m · ${speed.toFixed(0)} m/s · ${t.toFixed(2)} s`;
  $("replay").classList.add("show");
  return true;
}

const mirage = new MiragePass();

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
  if (!paused && !entering) updateDrillHud(s);

  // With the log open, render beside it so the scope stays centred on the line of sight.
  const full = window.innerWidth;
  const logOpen = !$("log").classList.contains("collapsed") && full > 900;
  const w = logOpen ? full - 292 : full;
  const h = window.innerHeight;
  renderer.setViewport(0, 0, w, h);
  s.world.setViewportHeight(h * renderer.getPixelRatio());
  camera.aspect = w / h;
  const eye = s.shooter.position.eyeHeightM;
  const line = sightLine(s);

  if (s.replay && replayFrame(s, dt)) {
    canvas.style.filter = "";
    renderer.render(s.world.scene, camera);
    og.clearRect(0, 0, full, h);
    updateHud(s, dt);
    return;
  }

  // What is under the reticle, for parallax and mirage.
  if (s.t - s.focusAt > 0.25 || s.focusAt < 0) {
    s.focusM = losDistance(s, line.yaw, line.pitch);
    s.focusAt = s.t;
  }
  const shift = parallaxShift(s);
  camera.position.set(0, eye + groundHeight(0, 0), 0);
  const roll = s.scoped ? -(s.shooter.cantDeg * Math.PI) / 180 : 0;
  camera.rotation.set(line.pitch + shift.y / 1000, -(line.yaw + shift.x / 1000), roll);
  if (s.scoped) {
    const L = scopeLayout(w, h, s.mag);
    camera.fov = L.cameraFovDeg;
    camera.updateProjectionMatrix();
    // Out-of-focus image when the parallax knob is far from the distance being viewed.
    const defocus = Math.abs(1 / parallaxM(s) - 1 / s.focusM) * s.mag * 55;
    canvas.style.filter = defocus > 0.35 ? `blur(${Math.min(5, defocus).toFixed(2)}px)` : "";
    // Mirage runs with the crosswind around the distance in focus; strong wind flattens it.
    const [, cross] = s.sampler.at(Math.min(1500, s.focusM * 0.7), s.t);
    const flatten = 1 - Math.min(0.85, Math.max(0, (Math.abs(cross) - 4) / 5));
    const strengthPx = s.heat * (s.mag / 12) * 1.8 * flatten;
    if (strengthPx > 0.05) {
      const driftPxPerS = (cross / Math.max(50, s.focusM)) * 1000 * L.pxPerMrad * 0.45;
      mirage.render(renderer, s.world.scene, camera, w, h, {
        time: s.t,
        strengthPx,
        driftPxPerS,
        boil: Math.max(0, 1 - Math.abs(cross) / 1.5),
      });
    } else renderer.render(s.world.scene, camera);
    drawScope(og, w, h, L, {
      optic: s.lo.optic,
      mag: s.mag,
      illuminated: s.illum,
      eyeOffset: s.shooter.eyeOffset(),
      dim: 0,
      cantDeg: s.shooter.cantDeg,
    });
  } else {
    canvas.style.filter = "";
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
    startReplay: () => session && startReplay(session),
    camera,
  };
}
