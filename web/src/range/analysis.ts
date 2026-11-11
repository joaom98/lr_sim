// "Why did that shot go there?" Re-flies a shot with one error source removed at a time and
// attributes the impact offset (on the intended target's plane) to each source.
import type { Engine } from "../engine";
import type { Conditions } from "./conditions";
import { fire, planeCrossing, type Aim, type Dial, type Loadout } from "./firing";
import type { TargetObj } from "./world";

export type PartKey = "hold" | "trigger" | "parallax" | "cant" | "ammo" | "elevation" | "wind";

export interface Part {
  key: PartKey;
  label: string;
  /** contribution to the impact offset at the target (mrad, x right, y up) */
  x: number;
  y: number;
}

export interface Breakdown {
  parts: Part[];
  /** total offset from the target centre (mrad) */
  x: number;
  y: number;
}

export interface ShotContext {
  /** where the rifle actually pointed when the shot broke */
  aim: Aim;
  /** where the reticle appeared to be (aim plus parallax shift) */
  visualAim: Aim;
  /** line from the eye to the target centre */
  intendedAim: Aim;
  dial: Dial;
  mvDeltaMps: number;
  bcScale: number;
  timeS: number;
  trigger: { x: number; y: number };
  /** scope zero error (mrad): part of the data, present in every variant */
  zero: { x: number; y: number };
}

export const PART_LABELS: Record<PartKey, string> = {
  hold: "Hold / sway",
  trigger: "Trigger",
  parallax: "Parallax",
  cant: "Cant",
  ammo: "Ammo variation",
  elevation: "Elevation data",
  wind: "Wind call",
};

/** Impact offset (mrad) on the target plane for one variant of the shot. */
function offsetFor(
  engine: Engine,
  lo: Loadout,
  cond: Conditions,
  tg: TargetObj,
  aim: Aim,
  ctx: ShotContext,
  opts: { trigger: boolean; ammo: boolean },
): { x: number; y: number } | null {
  const out = fire(
    engine,
    lo,
    cond,
    aim,
    ctx.dial,
    {
      mvDeltaMps: opts.ammo ? ctx.mvDeltaMps : 0,
      bcScale: opts.ammo ? ctx.bcScale : 1,
      timeS: ctx.timeS,
      errX: (opts.trigger ? ctx.trigger.x : 0) + ctx.zero.x,
      errY: (opts.trigger ? ctx.trigger.y : 0) + ctx.zero.y,
    },
    [],
  );
  const c = planeCrossing(out.fullPath, tg);
  return c ? { x: (c.u / tg.def.rangeM) * 1000, y: (c.v / tg.def.rangeM) * 1000 } : null;
}

export function analyzeShot(engine: Engine, lo: Loadout, cond: Conditions, tg: TargetObj, ctx: ShotContext): Breakdown | null {
  const level = (a: Aim): Aim => ({ ...a, cantDeg: 0 });
  // Peel errors off one at a time; each step's difference is that source's share.
  const actual = offsetFor(engine, lo, cond, tg, ctx.aim, ctx, { trigger: true, ammo: true });
  const noTrigger = offsetFor(engine, lo, cond, tg, ctx.aim, ctx, { trigger: false, ammo: true });
  const noParallax = offsetFor(engine, lo, cond, tg, ctx.visualAim, ctx, { trigger: false, ammo: true });
  const noHold = offsetFor(engine, lo, cond, tg, ctx.intendedAim, ctx, { trigger: false, ammo: true });
  const noCant = offsetFor(engine, lo, cond, tg, level(ctx.intendedAim), ctx, { trigger: false, ammo: true });
  const nominal = offsetFor(engine, lo, cond, tg, level(ctx.intendedAim), ctx, { trigger: false, ammo: false });
  if (!actual || !noTrigger || !noParallax || !noHold || !noCant || !nominal) return null;
  const diff = (key: PartKey, a: { x: number; y: number }, b: { x: number; y: number }): Part => ({
    key,
    label: PART_LABELS[key],
    x: a.x - b.x,
    y: a.y - b.y,
  });
  return {
    x: actual.x,
    y: actual.y,
    parts: [
      diff("hold", noParallax, noHold),
      diff("trigger", actual, noTrigger),
      diff("parallax", noTrigger, noParallax),
      diff("cant", noHold, noCant),
      diff("ammo", noCant, nominal),
      // What is left with perfect execution and nominal ammo is the data: dial vs. what was needed.
      { key: "elevation", label: PART_LABELS.elevation, x: 0, y: nominal.y },
      { key: "wind", label: PART_LABELS.wind, x: nominal.x, y: 0 },
    ],
  };
}

export interface CoachInput {
  breakdown: Breakdown;
  hit: boolean;
  inPause: boolean;
  heldBreath: boolean;
  holdTimeS: number;
  cantDeg: number;
  parallaxM: number;
  targetRangeM: number;
  /** formats an angle (mrad) in the scope's unit with a unit label */
  fmt: (mrad: number) => string;
}

const mag = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);

/** One short, specific coaching line for the biggest controllable error. */
export function coach(c: CoachInput): string {
  const parts = [...c.breakdown.parts].sort((a, b) => mag(b) - mag(a));
  const top = parts[0];
  const size = mag(top);
  if (size < 0.08) return c.hit ? "Clean shot: every error was small." : "Small errors everywhere; the target is just small at this range.";
  const amt = c.fmt(size);
  switch (top.key) {
    case "hold":
      if (c.heldBreath && c.holdTimeS > 6)
        return `Hold cost ${amt}: you held your breath ${c.holdTimeS.toFixed(0)} s. Sway grows after about 6 s; fire sooner or breathe and reset.`;
      if (!c.inPause && !c.heldBreath)
        return `Hold cost ${amt}: the shot broke mid-breath. Fire in the natural pause after you exhale.`;
      return `Hold cost ${amt}: the reticle was still moving. Settle into the position before you press.`;
    case "trigger":
      return `Trigger cost ${amt}. Press straight back and keep the mouse still as the shot breaks.`;
    case "parallax": {
      const set = c.parallaxM >= 1e5 ? "infinity" : `${c.parallaxM} m`;
      return `Parallax cost ${amt}: set to ${set} for a ${c.targetRangeM} m target, so head movement shifted the aim. Adjust with [ and ].`;
    }
    case "cant":
      return `Cant cost ${amt}: the rifle was tilted ${Math.abs(c.cantDeg).toFixed(1)}° ${c.cantDeg > 0 ? "right" : "left"}. Level the bubble with Q / E.`;
    case "ammo":
      return `Ammunition variation moved this one ${amt} (velocity spread, cold bore or barrel heat). Not your fault; it is why groups exist.`;
    case "elevation":
      return `Elevation was off by ${c.fmt(Math.abs(top.y))} ${top.y > 0 ? "high" : "low"}. Re-range the target and dial the calculator's solution (R, then G).`;
    case "wind":
      return `Wind call was off by ${c.fmt(Math.abs(top.x))}: the shot drifted ${top.x > 0 ? "right" : "left"}. Read the flags downrange, not only the meter at your feet.`;
  }
}
