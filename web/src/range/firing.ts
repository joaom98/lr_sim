// Turns "the rifle points here with this dial" into an engine shot, then finds what the bullet
// hits in the 3-D world: a target plate, the ground, or nothing.
import * as THREE from "three";
import type { Engine, ShotInput, Trace } from "../engine";
import type { AmmoProfile, OpticProfile, RifleProfile } from "../profiles";
import { MRAD_PER_MOA } from "../units";
import { windField, type Conditions } from "./conditions";
import { groundHeight } from "./terrain";
import { insideShape, type TargetObj } from "./world";

export interface Loadout {
  rifle: RifleProfile;
  ammo: AmmoProfile;
  optic: OpticProfile;
}

export interface Aim {
  /** sight-line yaw, rad (+ = right of the range axis) */
  yaw: number;
  /** sight-line pitch, rad (+ = up) */
  pitch: number;
  eyeHeightM: number;
  /** rifle cant, deg clockwise */
  cantDeg?: number;
}

export interface Dial {
  /** turret clicks */
  elevation: number;
  windage: number;
}

export function clickMrad(optic: OpticProfile): number {
  return optic.unit === "mil" ? optic.clickValue : optic.clickValue * MRAD_PER_MOA;
}

export function buildInput(lo: Loadout, c: Conditions, aim: Aim): ShotInput {
  const azimuth = c.range.azimuthDeg + (aim.yaw * 180) / Math.PI;
  const { rifle, ammo } = lo;
  return {
    bullet: { massKg: ammo.massKg, diameterM: ammo.diameterM, lengthM: ammo.lengthM, drag: ammo.drag },
    rifle: { sightHeightM: rifle.sightHeightM, twistM: rifle.twistM, twistDirection: rifle.twistDirection, barrelLengthM: rifle.barrelM },
    load: {
      muzzleVelocityMps: ammo.mvMps,
      referenceBarrelLengthM: ammo.refBarrelM,
      velocityPerBarrelM: ammo.velPerBarrelM,
      powderTempSensitivity: ammo.tempSens,
      referencePowderTempC: ammo.refPowderTempC,
      mvSdMps: ammo.mvSdMps,
      bcSdFraction: ammo.bcSdFraction,
    },
    atmosphere: c.atmosphere,
    zero: { rangeM: 100 },
    wind: windField(c, azimuth),
    lookAngleDeg: (aim.pitch * 180) / Math.PI,
    azimuthDeg: azimuth,
    latitudeDeg: c.range.latitudeDeg,
    cantDeg: aim.cantDeg ?? 0,
  };
}

export type HitKind = "target" | "ground" | "lost";

export interface ShotOutcome {
  trace: Trace;
  /** whole flight in world space (continues past the impact), for spotter calls */
  fullPath: THREE.Vector3[];
  /** world-space path and times up to the impact, for animation */
  path: THREE.Vector3[];
  times: number[];
  kind: HitKind;
  point: THREE.Vector3;
  timeS: number;
  speedMps: number;
  energyJ: number;
  target?: TargetObj;
  /** impact on the plate, metres from centre (u right, v up) */
  u?: number;
  v?: number;
}

/** Converts a solver-frame path point (x downrange along the shot azimuth) to the world. */
function toWorld(x: number, y: number, z: number, aim: Aim, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(aim.yaw);
  const c = Math.cos(aim.yaw);
  const right = x * s + z * c;
  const down = x * c - z * s;
  return out.set(right, aim.eyeHeightM + y, -down);
}

export function fire(
  engine: Engine,
  lo: Loadout,
  cond: Conditions,
  aim: Aim,
  dial: Dial,
  extra: { mvDeltaMps: number; bcScale: number; timeS: number; errX: number; errY: number },
  targets: TargetObj[],
): ShotOutcome {
  const input = buildInput(lo, cond, aim);
  const cm = clickMrad(lo.optic);
  const trace = engine.trace(
    input,
    {
      elevationRad: (dial.elevation * cm + extra.errY) / 1000,
      windageRad: (dial.windage * cm + extra.errX) / 1000,
      mvDeltaMps: extra.mvDeltaMps,
      bcScale: extra.bcScale,
      timeOffsetS: extra.timeS,
    },
    { maxRangeM: 2600, pathStepM: 1, floorM: -aim.eyeHeightM - 80 },
  );
  const path = trace.path.map((p) => toWorld(p.xM, p.yM, p.zM, aim, new THREE.Vector3()));
  const times = trace.path.map((p) => p.timeS);
  const mass = lo.ammo.massKg;
  const result = (k: number, f: number) => {
    const a = trace.path[k - 1];
    const b = trace.path[k];
    const speed = a.speedMps + (b.speedMps - a.speedMps) * f;
    return { timeS: a.timeS + (b.timeS - a.timeS) * f, speedMps: speed, energyJ: 0.5 * mass * speed * speed };
  };

  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    // Targets: segment crossing the plate plane, inside the shape.
    for (const tg of targets) {
      const down = tg.def.rangeM;
      if (-a.z > down + 2 || -b.z < down - 2) continue;
      const da = a.clone().sub(tg.center).dot(tg.normal);
      const db = b.clone().sub(tg.center).dot(tg.normal);
      if (da > 0 && db <= 0) {
        const f = da / (da - db);
        const p = a.clone().lerp(b, f);
        const rel = p.clone().sub(tg.center);
        const u = rel.dot(tg.right);
        const v = rel.y;
        if (insideShape(tg.def, u, v)) {
          return { trace, fullPath: path, path: path.slice(0, k).concat([p]), times: times.slice(0, k).concat([result(k, f).timeS]), kind: "target", point: p, target: tg, u, v, ...result(k, f) };
        }
      }
    }
    // Ground
    const ga = a.y - groundHeight(-a.z, a.x);
    const gb = b.y - groundHeight(-b.z, b.x);
    if (ga > 0 && gb <= 0) {
      const f = ga / (ga - gb);
      const p = a.clone().lerp(b, f);
      return { trace, fullPath: path, path: path.slice(0, k).concat([p]), times: times.slice(0, k).concat([result(k, f).timeS]), kind: "ground", point: p, ...result(k, f) };
    }
  }
  const last = trace.path[trace.path.length - 1];
  return {
    trace,
    fullPath: path,
    path,
    times,
    kind: "lost",
    point: path[path.length - 1],
    timeS: last.timeS,
    speedMps: last.speedMps,
    energyJ: 0.5 * mass * last.speedMps ** 2,
  };
}

/** Where the path crossed a target's plane (u right, v up, metres), for spotter calls on misses. */
export function planeCrossing(path: THREE.Vector3[], tg: TargetObj): { u: number; v: number } | null {
  for (let k = 1; k < path.length; k++) {
    const da = path[k - 1].clone().sub(tg.center).dot(tg.normal);
    const db = path[k].clone().sub(tg.center).dot(tg.normal);
    if (da > 0 && db <= 0) {
      const p = path[k - 1].clone().lerp(path[k], da / (da - db));
      const rel = p.sub(tg.center);
      return { u: rel.dot(tg.right), v: rel.y };
    }
  }
  return null;
}

/** Free recoil velocity (m/s) of the rifle, with a rough powder-gas term. */
export function freeRecoil(lo: Loadout): number {
  const charge = lo.ammo.massKg * 0.3;
  const momentum = lo.ammo.massKg * lo.ammo.mvMps + charge * 1300;
  return momentum / lo.rifle.weightKg;
}
