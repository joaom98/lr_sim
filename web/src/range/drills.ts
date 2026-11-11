// Training drills: a course of fire made of stages, the tools allowed, a time limit and a
// scoring rule. A DrillRun tracks progress through one attempt.
import { Rand } from "../rng";
import type { TargetDef } from "./conditions";
import type { PositionId } from "./shooter";

export interface Tools {
  rangefinder: boolean;
  /** "full" = elevation and wind; "elevation" = wind hidden; "none" = no calculator */
  calculator: "full" | "elevation" | "none";
  /** range distance signs on the targets */
  signs: boolean;
}

export type StageKind = "engage" | "group" | "action";

export interface Stage {
  kind: StageKind;
  /** target for engage / group stages */
  targetId?: string;
  /** shots allowed (engage) or required (group) */
  shots: number;
  /** move on as soon as the target is hit (engage) */
  advanceOnHit?: boolean;
  position?: PositionId;
  /** shown to the shooter */
  brief: string;
}

export interface ShotInfo {
  hit: boolean;
  /** impact offset from the target centre (mrad), when known */
  offset: { x: number; y: number } | null;
  /** half the target's width (mrad), for accuracy scoring */
  halfMrad: number;
  /** 0-based shot number within the stage */
  attempt: number;
}

export interface DrillDef {
  id: string;
  name: string;
  summary: string;
  /** XP for a perfect score */
  xp: number;
  tools: Tools;
  timeLimitS?: number;
  /** heart-rate / stress added by the format (0..1) */
  stress?: number;
  /** minimum wind preset this drill needs to mean anything */
  minWind?: "light" | "moderate";
  /** the rifle starts off zero (zeroing drill) */
  offZero?: boolean;
  recommended?: string;
  stages(r: Rand, targets: TargetDef[]): Stage[];
  points(s: ShotInfo, stage: Stage): number;
  /** score from the shots of a group stage (zeroing); optional */
  groupPoints?(offsets: { x: number; y: number }[], stageIndex: number): number;
  maxPoints(stages: Stage[]): number;
}

const byRange = (targets: TargetDef[], m: number) => targets.find((t) => t.rangeM === m && t.shape !== "paper")!;
const pick = <T>(r: Rand, list: T[], n: number): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r.uniform() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};
const accuracy = (s: ShotInfo, axis: "both" | "x" = "both") => {
  if (!s.offset) return 0;
  const d = axis === "x" ? Math.abs(s.offset.x) : Math.hypot(s.offset.x, s.offset.y);
  return Math.max(0, 1 - d / Math.max(0.05, s.halfMrad));
};

export const DRILLS: DrillDef[] = [
  {
    id: "zeroing",
    name: "Zero the rifle",
    summary: "The scope has been knocked off zero. Fire a group at 100 m, dial the correction, set zero (K), then confirm it.",
    xp: 120,
    tools: { rangefinder: true, calculator: "full", signs: true },
    offZero: true,
    stages: () => [
      { kind: "group", targetId: "p100", shots: 3, position: "prone-bag", brief: "Fire a 3-shot group at the centre of the 100 m paper" },
      { kind: "action", shots: 0, brief: "Dial the group's offset onto the turrets (W/S, A/D), then press K to set zero" },
      { kind: "group", targetId: "p100", shots: 3, brief: "Confirm: 3 shots at the centre" },
    ],
    points: () => 0,
    groupPoints: (offs, stageIndex) => {
      if (stageIndex !== 2 || offs.length === 0) return 0;
      const cx = offs.reduce((a, o) => a + o.x, 0) / offs.length;
      const cy = offs.reduce((a, o) => a + o.y, 0) / offs.length;
      let es = 0;
      for (let i = 0; i < offs.length; i++)
        for (let j = i + 1; j < offs.length; j++) es = Math.max(es, Math.hypot(offs[i].x - offs[j].x, offs[i].y - offs[j].y));
      const centre = Math.max(0, 1 - Math.hypot(cx, cy) / 0.6);
      const tight = Math.max(0, 1 - es / 0.9);
      return Math.round(10 * centre + 5 * tight);
    },
    maxPoints: () => 15,
  },
  {
    id: "cold-bore",
    name: "Cold bore",
    summary: "One shot, no sighters, on a plate between 300 and 700 m. Range it, dial it, make it count.",
    xp: 80,
    tools: { rangefinder: true, calculator: "full", signs: true },
    stages: (r, t) => {
      const tg = pick(r, [300, 400, 500, 600, 700], 1)[0];
      return [{ kind: "engage", targetId: byRange(t, tg).id, shots: 1, brief: `One cold-bore shot on the ${tg} m plate` }];
    },
    points: (s) => (s.hit ? 6 + Math.round(4 * accuracy(s)) : 0),
    maxPoints: () => 10,
  },
  {
    id: "kd-ladder",
    name: "Known-distance ladder",
    summary: "Climb from 300 to 1000 m. Two rounds per plate: 2 points for a first-round hit, 1 for a second.",
    xp: 160,
    tools: { rangefinder: true, calculator: "full", signs: true },
    stages: (_r, t) =>
      [300, 400, 500, 600, 700, 800, 900, 1000].map((m) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 2,
        advanceOnHit: true,
        brief: `${m} m plate: two rounds`,
      })),
    points: (s) => (s.hit ? (s.attempt === 0 ? 2 : 1) : 0),
    maxPoints: (st) => st.length * 2,
  },
  {
    id: "wind-reading",
    name: "Wind reading",
    summary: "Six plates from 400 to 1000 m in real wind. The calculator gives elevation only: call the wind from the flags and mirage.",
    xp: 220,
    tools: { rangefinder: true, calculator: "elevation", signs: true },
    minWind: "moderate",
    stages: (r, t) =>
      pick(r, [400, 500, 600, 700, 800, 900, 1000], 6).map((m) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 1,
        brief: `${m} m plate: one round, your wind call`,
      })),
    points: (s) => (s.hit ? 3 : 0) + Math.round(2 * accuracy(s, "x")),
    maxPoints: (st) => st.length * 5,
  },
  {
    id: "unknown-distance",
    name: "Unknown distance",
    summary: "No rangefinder and no signs. Range each plate with the reticle (size in metres × 1000 ÷ mils), enter it with N, then engage.",
    xp: 240,
    tools: { rangefinder: false, calculator: "full", signs: false },
    stages: (r, t) =>
      pick(r, [300, 400, 500, 600, 700, 800, 900], 5).map((m) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 2,
        advanceOnHit: true,
        brief: "Unknown distance: two rounds",
      })),
    points: (s) => (s.hit ? (s.attempt === 0 ? 2 : 1) : 0),
    maxPoints: (st) => st.length * 2,
  },
  {
    id: "prs-stage",
    name: "PRS-style stage",
    summary: "105 seconds, eight plates, one round each: four from prone, then move to the barricade for four more. Your heart rate is up.",
    xp: 300,
    tools: { rangefinder: true, calculator: "full", signs: true },
    timeLimitS: 105,
    stress: 0.5,
    stages: (_r, t) => [
      ...[300, 500, 600, 800].map((m, i) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 1,
        position: i === 0 ? ("prone" as const) : undefined,
        brief: `Prone: ${m} m`,
      })),
      ...[300, 400, 500, 700].map((m, i) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 1,
        position: i === 0 ? ("barricade" as const) : undefined,
        brief: `Barricade: ${m} m`,
      })),
    ],
    points: (s) => (s.hit ? 1 : 0),
    maxPoints: (st) => st.length,
  },
  {
    id: "elr",
    name: "Extreme long range",
    summary: "1000, 1200 and 1500 m. Three rounds per plate: 3 points for a first-round hit, then 2 and 1. A magnum helps.",
    xp: 400,
    tools: { rangefinder: true, calculator: "full", signs: true },
    recommended: ".338 or .50-class rifle",
    stages: (_r, t) =>
      [1000, 1200, 1500].map((m) => ({
        kind: "engage" as const,
        targetId: byRange(t, m).id,
        shots: 3,
        advanceOnHit: true,
        brief: `${m} m: three rounds`,
      })),
    points: (s) => (s.hit ? 3 - s.attempt : 0),
    maxPoints: (st) => st.length * 3,
  },
];

export interface StageResult {
  stage: number;
  targetId?: string;
  hit: boolean;
  points: number;
  offset: { x: number; y: number } | null;
}

/** Progress through one attempt at a drill. */
export class DrillRun {
  readonly stages: Stage[];
  stageIndex = 0;
  shotsInStage = 0;
  points = 0;
  readonly results: StageResult[] = [];
  private groupOffsets: { x: number; y: number }[] = [];
  done = false;
  endReason: "complete" | "time" | "quit" | null = null;

  constructor(
    readonly def: DrillDef,
    seed: number,
    targets: TargetDef[],
    readonly startT: number,
  ) {
    this.stages = def.stages(new Rand(seed * 31 + 7), targets);
  }

  get stage(): Stage | null {
    return this.done ? null : this.stages[this.stageIndex];
  }

  get max(): number {
    return this.def.maxPoints(this.stages);
  }

  timeLeft(t: number): number | null {
    return this.def.timeLimitS === undefined ? null : Math.max(0, this.def.timeLimitS - (t - this.startT));
  }

  /** Called every frame; ends the drill when time runs out. */
  tick(t: number) {
    const left = this.timeLeft(t);
    if (!this.done && left !== null && left <= 0) this.finish("time");
  }

  /** A shot was resolved. Returns the points it scored. `targetId` is the plate engaged. */
  shot(targetId: string | null, hit: boolean, offset: { x: number; y: number } | null, halfMrad: number): number {
    const st = this.stage;
    if (!st || st.kind === "action") return 0;
    const stageIndex = this.stageIndex;
    const onTarget = targetId === st.targetId;
    const info: ShotInfo = { hit: hit && onTarget, offset: onTarget ? offset : null, halfMrad, attempt: this.shotsInStage };
    this.shotsInStage++;
    let pts = 0;
    if (st.kind === "group") {
      if (onTarget && offset) this.groupOffsets.push(offset);
      if (this.shotsInStage >= st.shots) {
        pts = this.def.groupPoints?.(this.groupOffsets, this.stageIndex) ?? 0;
        this.groupOffsets = [];
        this.advance();
      }
    } else {
      pts = this.def.points(info, st);
      if ((st.advanceOnHit && info.hit) || this.shotsInStage >= st.shots) this.advance();
    }
    this.points += pts;
    this.results.push({ stage: stageIndex, targetId: targetId ?? undefined, hit: info.hit, points: pts, offset });
    return pts;
  }

  /** Complete an action stage (e.g. setting zero). */
  action() {
    if (this.stage?.kind === "action") this.advance();
  }

  private advance() {
    this.stageIndex++;
    this.shotsInStage = 0;
    if (this.stageIndex >= this.stages.length) this.finish("complete");
  }

  finish(reason: "complete" | "time" | "quit") {
    if (this.done) return;
    this.done = true;
    this.endReason = reason;
  }
}
