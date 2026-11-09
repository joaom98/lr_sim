// Loads the shared data files (../data) and converts them from authoring units to SI.
import rifleData from "../../data/rifles.json";
import ammoData from "../../data/ammo.json";
import opticData from "../../data/optics.json";
import { FOOT_M, GRAIN_KG, INCH_M } from "./units";
import type { DragModel } from "./engine";

export interface RifleProfile {
  id: string;
  name: string;
  caliber: string;
  action: string;
  barrelM: number;
  twistM: number;
  twistDirection: "right" | "left";
  sightHeightM: number;
  weightKg: number;
  defaultAmmo: string;
}

export interface AmmoProfile {
  id: string;
  name: string;
  caliber: string;
  family: string;
  massKg: number;
  diameterM: number;
  lengthM: number;
  drag: DragModel;
  mvMps: number;
  refBarrelM: number;
  velPerBarrelM: number;
  tempSens: number;
  refPowderTempC: number;
  mvSdMps: number;
  bcSdFraction: number;
}

export interface OpticProfile {
  id: string;
  name: string;
  unit: "mil" | "moa";
  clickValue: number;
  focalPlane: "ffp" | "sfp";
  magMin: number;
  magMax: number;
  elevationTravel: number;
  windageTravel: number;
  zeroStop: boolean;
}

export const rifles: RifleProfile[] = rifleData.rifles.map((r) => ({
  id: r.id,
  name: r.name,
  caliber: r.caliber,
  action: r.action,
  barrelM: r.barrelIn * INCH_M,
  twistM: r.twistIn * INCH_M,
  twistDirection: r.twistDirection as "right" | "left",
  sightHeightM: r.sightHeightIn * INCH_M,
  weightKg: r.weightKg,
  defaultAmmo: r.defaultAmmo,
}));

interface RawDrag {
  table: string;
  bc?: number;
  bands?: { minFps: number; bc: number }[];
}

function drag(d: RawDrag): DragModel {
  const table = d.table === "G1" ? "G1" : "G7";
  if (d.bands && d.bands.length) {
    return {
      kind: "standard",
      table,
      bc: d.bands[0].bc,
      bands: d.bands.map((b) => ({ minVelocityMps: b.minFps * FOOT_M, bc: b.bc })),
    };
  }
  return { kind: "standard", table, bc: d.bc ?? 0 };
}

export const ammo: AmmoProfile[] = ammoData.ammo.map((a) => ({
  id: a.id,
  name: a.name,
  caliber: a.caliber,
  family: a.family,
  massKg: a.bulletGr * GRAIN_KG,
  diameterM: a.diameterIn * INCH_M,
  lengthM: a.lengthIn * INCH_M,
  drag: drag(a.drag as RawDrag),
  mvMps: a.mvFps * FOOT_M,
  refBarrelM: a.refBarrelIn * INCH_M,
  velPerBarrelM: (a.fpsPerInch * FOOT_M) / INCH_M,
  tempSens: a.tempSensFpsPerC * FOOT_M,
  refPowderTempC: a.refPowderTempC,
  mvSdMps: a.mvSdFps * FOOT_M,
  bcSdFraction: a.bcSdPct / 100,
}));

export const optics: OpticProfile[] = opticData.optics.map((o) => ({
  ...o,
  unit: o.unit as "mil" | "moa",
  focalPlane: o.focalPlane as "ffp" | "sfp",
}));
