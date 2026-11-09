// Typed wrapper around the WebAssembly ballistics core. All values are SI.
import init, * as wasm from "../pkg/ballistics_wasm.js";

export type StandardTable = "G1" | "G7";

export type DragModel =
  | { kind: "standard"; table: StandardTable; bc: number; bands?: { minVelocityMps: number; bc: number }[] }
  | { kind: "custom"; points: { mach: number; cd: number }[] };

export interface Atmosphere {
  altitudeM: number;
  pressurePa: number;
  temperatureC: number;
  humidity: number;
}

export interface WindZone {
  untilM?: number | null;
  speedMps: number;
  fromDeg: number;
}

export interface Effects {
  spinDrift: boolean;
  aeroJump: boolean;
  coriolis: boolean;
  earthCurvature: boolean;
  atmosphereAlongPath: boolean;
}

export interface ShotInput {
  bullet: { massKg: number; diameterM: number; lengthM: number; drag: DragModel };
  rifle: { sightHeightM: number; twistM: number; twistDirection: "right" | "left"; barrelLengthM: number };
  load: {
    muzzleVelocityMps: number;
    referenceBarrelLengthM?: number | null;
    velocityPerBarrelM?: number;
    powderTempSensitivity?: number;
    referencePowderTempC?: number;
    mvSdMps?: number;
    bcSdFraction?: number;
  };
  atmosphere: Atmosphere;
  powderTempC?: number | null;
  zero: { rangeM: number; offsetM?: number; atmosphere?: Atmosphere | null; powderTempC?: number | null };
  wind?: {
    zones: WindZone[];
    gusts?: {
      intensity: number;
      directionVariationDeg?: number;
      periodS?: number;
      correlationLengthM?: number;
      seed?: number;
    } | null;
  };
  lookAngleDeg?: number;
  azimuthDeg?: number;
  latitudeDeg?: number | null;
  cantDeg?: number;
  effects?: Partial<Effects>;
}

export interface TrajectoryRow {
  rangeM: number;
  horizontalM: number;
  heightM: number;
  timeS: number;
  velocityMps: number;
  mach: number;
  energyJ: number;
  dropM: number;
  windageM: number;
  spinDriftM: number;
  elevationMrad: number;
  windageMrad: number;
}

export interface Solution {
  rows: TrajectoryRow[];
  path: { timeS: number; xM: number; yM: number; zM: number; speedMps: number }[];
  muzzleVelocityMps: number;
  zeroElevationMrad: number;
  stabilitySg: number;
  aeroJumpMrad: number;
  airDensityKgM3: number;
  speedOfSoundMps: number;
  densityAltitudeM: number;
  transonicRangeM: number | null;
  subsonicRangeM: number | null;
  warnings: string[];
}

export interface GroupSpec {
  rangeM: number;
  dialElevationMrad?: number | null;
  dialWindageMrad?: number | null;
  shots: number;
  seed: number;
  aimSdMrad?: number;
  intervalS?: number;
  startTimeS?: number;
}

export interface Impact {
  shot: number;
  verticalM: number;
  horizontalM: number;
  timeS: number;
  velocityMps: number;
  energyJ: number;
  muzzleVelocityMps: number;
  bcScale: number;
}

export interface GroupResult {
  dialElevationMrad: number;
  dialWindageMrad: number;
  impacts: Impact[];
  meanVerticalM: number;
  meanHorizontalM: number;
  extremeSpreadM: number;
  meanRadiusM: number;
}

export interface Engine {
  version: string;
  solve(input: ShotInput, table: { maxRangeM: number; stepM: number; pathStepM?: number }): Solution;
  fireGroup(input: ShotInput, spec: GroupSpec): GroupResult;
  stationFromBaro(altitudeM: number, baroPa: number): number;
  standardAtmosphere(name: "icao" | "asm", altitudeM?: number): Atmosphere;
}

export async function loadEngine(): Promise<Engine> {
  await init();
  return {
    version: wasm.version(),
    solve: (input, table) => wasm.solve(input, table) as Solution,
    fireGroup: (input, spec) => wasm.fireGroup(input, spec) as GroupResult,
    stationFromBaro: (alt, baro) => wasm.stationFromBaro(alt, baro),
    standardAtmosphere: (name, alt = 0) => wasm.standardAtmosphere(name, alt) as Atmosphere,
  };
}
