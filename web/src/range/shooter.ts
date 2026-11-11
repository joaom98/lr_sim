// The human in the loop: position stability, breathing (with the natural respiratory pause),
// breath-hold oxygen debt, heart rate and pulse, settling after moving the rifle, trigger
// disturbance and recoil with follow-through. All offsets are in milliradians.
import { Rand } from "../rng";

export type PositionId = "prone-bag" | "prone" | "sitting" | "barricade" | "kneeling" | "standing";

export interface PositionDef {
  id: PositionId;
  name: string;
  key: string;
  /** random sway amplitude (mrad) */
  sway: number;
  /** breathing amplitude (mrad, vertical) */
  breath: number;
  /** pulse kick per heartbeat (mrad) */
  pulse: number;
  /** trigger-press disturbance, 1 SD (mrad) */
  trigger: number;
  /** recoil multiplier (how much the position lets the rifle jump) */
  recoil: number;
  /** eye height above the ground (m) */
  eyeHeightM: number;
  /** typical unnoticed rifle cant when settling into the position (deg, 1 SD) */
  cantSd: number;
  /** head movement in the eye box (fraction of the eye box, amplitude) */
  head: number;
}

export const POSITIONS: PositionDef[] = [
  { id: "prone-bag", name: "Prone, bipod + rear bag", key: "1", sway: 0.05, breath: 0.45, pulse: 0.025, trigger: 0.03, recoil: 0.8, eyeHeightM: 0.32, cantSd: 0.4, head: 0.12 },
  { id: "prone", name: "Prone, bipod", key: "2", sway: 0.14, breath: 0.8, pulse: 0.05, trigger: 0.06, recoil: 1, eyeHeightM: 0.32, cantSd: 0.8, head: 0.18 },
  { id: "sitting", name: "Sitting, tripod", key: "3", sway: 0.35, breath: 1.1, pulse: 0.08, trigger: 0.1, recoil: 1.3, eyeHeightM: 0.95, cantSd: 1.5, head: 0.28 },
  { id: "barricade", name: "Barricade, supported", key: "4", sway: 0.5, breath: 1.2, pulse: 0.1, trigger: 0.14, recoil: 1.5, eyeHeightM: 1.4, cantSd: 2.5, head: 0.3 },
  { id: "kneeling", name: "Kneeling, sling", key: "5", sway: 1.1, breath: 1.8, pulse: 0.18, trigger: 0.25, recoil: 1.8, eyeHeightM: 0.85, cantSd: 2.0, head: 0.4 },
  { id: "standing", name: "Standing, unsupported", key: "6", sway: 2.6, breath: 2.6, pulse: 0.3, trigger: 0.45, recoil: 2.2, eyeHeightM: 1.6, cantSd: 3.0, head: 0.55 },
];

export const BREATH_PERIOD_S = 4.8;
const HOLD_COMFORT_S = 6;

const smooth = (x: number) => x * x * (3 - 2 * x);

export class Shooter {
  position: PositionDef = POSITIONS[0];
  /** 0..1 within the breathing cycle; 0.75..1 is the natural respiratory pause */
  breathPhase = 0.2;
  holding = false;
  holdTime = 0;
  private recovery = 0;
  heartRate = 68;
  private heartPhase = 0;
  private pulseKick = 0;
  /** 0.. extra sway after moving the rifle; decays as the shooter settles */
  settle = 0;
  /** stress raises heart rate (time pressure, exertion) */
  stress = 0;
  private recoilY = 0;
  private recoilX = 0;
  private recoilVy = 0;
  private recoilVx = 0;
  private t = Math.random() * 100;
  private breathLevel = 0;
  private rand = new Rand(7);
  private phases = [0, 1.7, 3.1, 4.4, 5.3, 2.2].map((p) => p + Math.random() * 6);

  /** rifle cant (deg, + = clockwise as seen by the shooter) */
  cantDeg = 0;

  setPosition(p: PositionDef) {
    this.position = p;
    this.settle = 2.5;
    // Settling into a new position leaves an unnoticed cant the shooter has to level out.
    this.cantDeg = this.rand.normal() * p.cantSd;
  }

  /** Level the rifle by hand (Q / E). */
  adjustCant(deg: number) {
    this.cantDeg = Math.max(-15, Math.min(15, this.cantDeg + deg));
    this.settle = Math.min(3, this.settle + 0.15);
  }

  /** Feed rifle movement (mrad of aim change this frame) so moving costs stability. */
  moved(mrad: number) {
    this.settle = Math.min(3, this.settle + mrad * 0.08);
  }

  update(dt: number, holdBreath: boolean) {
    this.t += dt;
    // Breath hold
    if (holdBreath && !this.holding && this.recovery <= 0) {
      this.holding = true;
      this.holdTime = 0;
    }
    if (!holdBreath && this.holding) {
      this.holding = false;
      this.recovery = Math.min(8, this.holdTime * 0.6);
    }
    if (this.holding) this.holdTime += dt;
    this.recovery = Math.max(0, this.recovery - dt);

    const debt = this.holding ? Math.max(0, this.holdTime - HOLD_COMFORT_S) : 0;
    const targetHr = 66 + this.stress * 40 + debt * 3 + this.recovery * 2.5 + this.settle * 3;
    this.heartRate += (targetHr - this.heartRate) * Math.min(1, dt * 0.5);

    if (!this.holding) {
      const period = BREATH_PERIOD_S / (1 + this.recovery * 0.12 + this.stress * 0.4);
      this.breathPhase = (this.breathPhase + dt / period) % 1;
    }
    const level = this.breathCurve(this.breathPhase);
    this.breathLevel = this.holding ? this.breathLevel : level;

    this.heartPhase += (dt * this.heartRate) / 60;
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      this.pulseKick = 1;
    }
    this.pulseKick *= Math.exp(-dt * 14);
    this.settle *= Math.exp(-dt / 0.9);

    // Recoil: damped spring back toward the point of aim.
    const k = 60 / this.position.recoil;
    const c = 2 * Math.sqrt(k) * 0.9;
    this.recoilVy += (-k * this.recoilY - c * this.recoilVy) * dt;
    this.recoilVx += (-k * this.recoilX - c * this.recoilVx) * dt;
    this.recoilY += this.recoilVy * dt;
    this.recoilX += this.recoilVx * dt;
  }

  /** 0 at the bottom of the exhale; 1 at full inhale. */
  private breathCurve(p: number): number {
    if (p < 0.38) return smooth(p / 0.38);
    if (p < 0.75) return 1 - smooth((p - 0.38) / 0.37);
    return 0;
  }

  get inRespiratoryPause(): boolean {
    return !this.holding && this.breathPhase >= 0.75;
  }

  /** Sway multiplier from breath-hold debt and recovery. */
  get stabilityFactor(): number {
    const debt = this.holding ? Math.max(0, this.holdTime - HOLD_COMFORT_S) : 0;
    return Math.min(4, 1 + debt * 0.3 + this.recovery * 0.15 + this.settle + this.stress * 0.8);
  }

  /** Current aim offset from the shooter's intended point (mrad, x right, y up). */
  offset(): { x: number; y: number } {
    const p = this.position;
    const t = this.t;
    const f = this.stabilityFactor;
    const ph = this.phases;
    const nx = Math.sin(t * 0.43 + ph[0]) * 0.5 + Math.sin(t * 1.07 + ph[1]) * 0.3 + Math.sin(t * 2.3 + ph[2]) * 0.2;
    const ny = Math.sin(t * 0.51 + ph[3]) * 0.5 + Math.sin(t * 1.21 + ph[4]) * 0.3 + Math.sin(t * 2.7 + ph[5]) * 0.2;
    const breath = (this.breathLevel - 0.35) * p.breath;
    return {
      x: nx * p.sway * f + breath * 0.15 + this.recoilX,
      y: ny * p.sway * f + breath + this.pulseKick * p.pulse + this.recoilY,
    };
  }

  /** Extra aim error introduced by pressing the trigger (mrad). */
  triggerError(): { x: number; y: number } {
    const sd = this.position.trigger * (1 + this.settle * 0.5);
    return { x: this.rand.normal() * sd, y: this.rand.normal() * sd };
  }

  /** Apply recoil. `freeRecoilMps` is the rifle's free recoil velocity. */
  fire(freeRecoilMps: number) {
    const kick = freeRecoilMps * 9 * this.position.recoil;
    this.recoilVy += kick * 9;
    this.recoilVx += (this.rand.uniform() - 0.35) * kick * 3;
    this.stress = Math.max(0, this.stress - 0.02);
  }

  /** How far the eye sits from the centre of the eye box, roughly -1..1: slow head drift for
   *  the position, plus the jolt of recoil. Drives the scope shadow and parallax error. */
  eyeOffset(): { x: number; y: number } {
    const t = this.t;
    const h = this.position.head * (1 + this.settle * 0.3);
    const hx = (Math.sin(t * 0.21 + 0.7) * 0.6 + Math.sin(t * 0.53 + 2.1) * 0.4) * h;
    const hy = (Math.sin(t * 0.17 + 1.9) * 0.6 + Math.sin(t * 0.47 + 0.3) * 0.4) * h;
    return {
      x: Math.max(-1, Math.min(1, hx + this.recoilX * 0.25)),
      y: Math.max(-1, Math.min(1, hy - this.recoilY * 0.12)),
    };
  }
}
