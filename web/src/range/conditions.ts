// Range layout, weather and wind for a session. Wind is defined in compass terms (direction it
// blows FROM) and converted to the line-of-fire-relative field the engine expects.
import rangeData from "../../../data/ranges.json";
import type { Atmosphere, ShotInput } from "../engine";
import { Rand } from "../rng";

export type TargetShape = "paper" | "circle" | "square" | "ipsc";

export interface TargetDef {
  id: string;
  name: string;
  rangeM: number;
  rightM: number;
  shape: TargetShape;
  sizeM: number;
  heightM?: number;
  standM: number;
}

export interface RangeDef {
  id: string;
  name: string;
  azimuthDeg: number;
  latitudeDeg: number;
  targets: TargetDef[];
  flags: { rangeM: number; rightM: number }[];
}

export const ranges: RangeDef[] = rangeData.ranges.map((r) => ({
  ...r,
  targets: r.targets.map((t) => ({ ...t, shape: t.shape as TargetShape })),
}));

export interface WeatherPreset {
  id: string;
  name: string;
  altitudeM: number;
  temperatureC: number;
  /** barometric (sea-level corrected) pressure, as a weather report gives it */
  baroPa: number;
  humidity: number;
}

export const weatherPresets: WeatherPreset[] = [
  { id: "temperate", name: "Temperate, near sea level", altitudeM: 150, temperatureC: 16, baroPa: 101_600, humidity: 0.55 },
  { id: "hot-desert", name: "Hot desert, 900 m", altitudeM: 900, temperatureC: 38, baroPa: 101_000, humidity: 0.12 },
  { id: "cold-mountain", name: "Cold mountain, 2,500 m", altitudeM: 2500, temperatureC: -4, baroPa: 102_000, humidity: 0.4 },
  { id: "humid-coast", name: "Humid coast, sea level", altitudeM: 5, temperatureC: 27, baroPa: 100_900, humidity: 0.9 },
];

export interface WindPreset {
  id: string;
  name: string;
  speedMps: [number, number];
  gust: number;
}

export const windPresets: WindPreset[] = [
  { id: "calm", name: "Calm (0–1 m/s)", speedMps: [0, 1], gust: 0.3 },
  { id: "light", name: "Light (1–3 m/s)", speedMps: [1, 3], gust: 0.3 },
  { id: "moderate", name: "Moderate (3–6 m/s)", speedMps: [3, 6], gust: 0.28 },
  { id: "strong", name: "Strong, gusty (6–10 m/s)", speedMps: [6, 10], gust: 0.35 },
];

export interface CompassZone {
  /** horizontal downrange end of the zone (null = to the end of the range) */
  untilM: number | null;
  speedMps: number;
  /** compass direction the wind blows FROM, degrees */
  fromCompassDeg: number;
}

export interface Conditions {
  seed: number;
  range: RangeDef;
  weather: WeatherPreset;
  atmosphere: Atmosphere;
  zones: CompassZone[];
  gust: number;
  gustDirDeg: number;
}

/** Zones: near (shooter), mid-range and far. Each varies around a session base wind. */
export function makeConditions(
  seed: number,
  range: RangeDef,
  weather: WeatherPreset,
  wind: WindPreset,
  stationFromBaro: (alt: number, baro: number) => number,
): Conditions {
  const r = new Rand(seed);
  const base = r.range(wind.speedMps[0], wind.speedMps[1]);
  const dir = r.range(0, 360);
  const zone = (untilM: number | null): CompassZone => ({
    untilM,
    speedMps: Math.max(0, base * r.range(0.7, 1.3)),
    fromCompassDeg: (dir + r.range(-25, 25) + 360) % 360,
  });
  return {
    seed,
    range,
    weather,
    atmosphere: {
      altitudeM: weather.altitudeM,
      pressurePa: stationFromBaro(weather.altitudeM, weather.baroPa),
      temperatureC: weather.temperatureC,
      humidity: weather.humidity,
    },
    zones: [zone(350), zone(900), zone(null)],
    gust: wind.gust,
    gustDirDeg: 14,
  };
}

/** Engine wind field for a shot fired toward `azimuthDeg` (compass). */
export function windField(c: Conditions, azimuthDeg: number): NonNullable<ShotInput["wind"]> {
  return {
    zones: c.zones.map((z) => ({
      untilM: z.untilM,
      speedMps: z.speedMps,
      fromDeg: (((z.fromCompassDeg - azimuthDeg) % 360) + 360) % 360,
    })),
    gusts: c.gust > 0 ? { intensity: c.gust, directionVariationDeg: c.gustDirDeg, periodS: 6, correlationLengthM: 250, seed: c.seed } : null,
  };
}

/** Clock position (1–12) for a wind relative to the line of fire. */
export function clockOf(fromRelDeg: number): number {
  const c = Math.round((((fromRelDeg % 360) + 360) % 360) / 30);
  return c === 0 ? 12 : c;
}
