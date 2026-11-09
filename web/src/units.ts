// Display-unit conversion. The engine is SI; every field and readout converts at the edge.

export const GRAIN_KG = 6.479891e-5;
export const INCH_M = 0.0254;
export const FOOT_M = 0.3048;
export const YARD_M = 0.9144;
export const MPH_MPS = 0.44704;
export const INHG_PA = 3386.389;
export const FTLBF_J = 1.355818;
/** milliradians per MOA */
export const MRAD_PER_MOA = (Math.PI / (180 * 60)) * 1000;

export type System = "metric" | "imperial";
export type Angular = "mil" | "moa";

export interface UnitPrefs {
  system: System;
  angular: Angular;
}

/** A physical quantity kind with its metric and imperial display forms. */
export type Kind =
  | "range"
  | "small"
  | "barrel"
  | "drop"
  | "vel"
  | "wind"
  | "temp"
  | "pressure"
  | "alt"
  | "mass"
  | "energy"
  | "tempSens"
  | "velPerLen"
  | "plain"
  | "pct";

interface Conv {
  label: string;
  to: (si: number) => number;
  from: (shown: number) => number;
  digits: number;
}

const lin = (label: string, factor: number, digits: number): Conv => ({
  label,
  to: (v) => v / factor,
  from: (v) => v * factor,
  digits,
});

const TABLE: Record<Kind, [Conv, Conv]> = {
  range: [lin("m", 1, 0), lin("yd", YARD_M, 0)],
  small: [lin("mm", 0.001, 1), lin("in", INCH_M, 3)],
  barrel: [lin("mm", 0.001, 0), lin("in", INCH_M, 1)],
  drop: [lin("cm", 0.01, 1), lin("in", INCH_M, 1)],
  vel: [lin("m/s", 1, 0), lin("fps", FOOT_M, 0)],
  wind: [lin("m/s", 1, 1), lin("mph", MPH_MPS, 1)],
  temp: [
    { label: "°C", to: (c) => c, from: (c) => c, digits: 1 },
    { label: "°F", to: (c) => (c * 9) / 5 + 32, from: (f) => ((f - 32) * 5) / 9, digits: 0 },
  ],
  pressure: [lin("hPa", 100, 1), lin("inHg", INHG_PA, 2)],
  alt: [lin("m", 1, 0), lin("ft", FOOT_M, 0)],
  mass: [lin("g", 0.001, 2), lin("gr", GRAIN_KG, 1)],
  energy: [lin("J", 1, 0), lin("ft·lbf", FTLBF_J, 0)],
  tempSens: [lin("m/s per °C", 1, 2), lin("fps per °F", (FOOT_M * 9) / 5, 2)],
  velPerLen: [lin("m/s per cm", 100, 2), lin("fps per in", FOOT_M / INCH_M, 1)],
  plain: [lin("", 1, 3), lin("", 1, 3)],
  pct: [lin("%", 0.01, 1), lin("%", 0.01, 1)],
};

export function conv(kind: Kind, prefs: UnitPrefs): Conv {
  return TABLE[kind][prefs.system === "metric" ? 0 : 1];
}

export function show(kind: Kind, si: number, prefs: UnitPrefs, digits?: number): string {
  const c = conv(kind, prefs);
  return c.to(si).toFixed(digits ?? c.digits);
}

export function withUnit(kind: Kind, si: number, prefs: UnitPrefs, digits?: number): string {
  const c = conv(kind, prefs);
  return `${show(kind, si, prefs, digits)} ${c.label}`.trim();
}

/** milliradians → the user's angular unit. */
export function angle(mrad: number, prefs: UnitPrefs): number {
  return prefs.angular === "mil" ? mrad : mrad / MRAD_PER_MOA;
}

export function angleLabel(prefs: UnitPrefs): string {
  return prefs.angular === "mil" ? "mil" : "MOA";
}

export function angleDigits(prefs: UnitPrefs): number {
  return prefs.angular === "mil" ? 2 : 1;
}
