// Riflescope view: true field of view, the eyepiece mask with eye-box shadow, and reticles
// drawn in true angular units, so first-focal-plane reticles stay correct at every
// magnification and second-focal-plane reticles are only true at maximum power.
import type { OpticProfile } from "../profiles";
import { MRAD_PER_MOA } from "../units";

/** Typical riflescope true field of view (rad): about 4.2° at 5x, 0.84° at 25x. */
export function trueFovRad(mag: number): number {
  return ((21 / mag) * Math.PI) / 180;
}

export const NAKED_EYE_FOV_DEG = 55;

export interface ScopeLayout {
  cx: number;
  cy: number;
  r: number;
  /** vertical camera FOV (deg) that makes the circle span the true field of view */
  cameraFovDeg: number;
  /** screen pixels per milliradian at the screen centre */
  pxPerMrad: number;
}

export function scopeLayout(w: number, h: number, mag: number): ScopeLayout {
  const r = Math.min(w, h) * 0.46;
  const half = trueFovRad(mag) / 2;
  const camHalf = Math.atan((Math.tan(half) * (h / 2)) / r);
  const pxPerMrad = h / 2 / Math.tan(camHalf) / 1000;
  return { cx: w / 2, cy: h / 2, r, cameraFovDeg: (camHalf * 2 * 180) / Math.PI, pxPerMrad };
}

export function nakedEyePxPerMrad(h: number): number {
  return h / 2 / Math.tan(((NAKED_EYE_FOV_DEG / 2) * Math.PI) / 180) / 1000;
}

export interface ScopeDraw {
  optic: OpticProfile;
  mag: number;
  illuminated: boolean;
  /** eye position error, roughly -1..1 per axis (0 = centred in the eye box) */
  eyeOffset: { x: number; y: number };
  /** 0..1 dims the image (low light) */
  dim: number;
}

export function drawScope(g: CanvasRenderingContext2D, w: number, h: number, L: ScopeLayout, s: ScopeDraw) {
  g.clearRect(0, 0, w, h);
  const { cx, cy, r } = L;

  // Reticle
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  const sfp = s.optic.focalPlane === "sfp" ? s.optic.magMax / s.mag : 1;
  const unitMrad = s.optic.unit === "mil" ? 1 : MRAD_PER_MOA;
  // pixels per reticle unit (1 mil or 1 MOA as labelled)
  const pu = L.pxPerMrad * unitMrad * sfp;
  const ink = "rgba(12,12,12,0.92)";
  g.strokeStyle = ink;
  g.fillStyle = ink;
  if (s.optic.unit === "mil") drawMilTree(g, cx, cy, r, pu);
  else drawMoaHash(g, cx, cy, r, pu);
  if (s.illuminated) {
    g.fillStyle = "rgba(255,40,30,0.95)";
    g.beginPath();
    g.arc(cx, cy, Math.max(1.6, pu * 0.05), 0, Math.PI * 2);
    g.fill();
  }
  g.restore();

  // Eyepiece mask, edge vignette and eye-box shadow
  g.save();
  g.fillStyle = "#000";
  g.beginPath();
  g.rect(0, 0, w, h);
  g.arc(cx, cy, r, 0, Math.PI * 2, true);
  g.fill("evenodd");
  const sx = cx + s.eyeOffset.x * r * 0.9;
  const sy = cy + s.eyeOffset.y * r * 0.9;
  const off = Math.min(1, Math.hypot(s.eyeOffset.x, s.eyeOffset.y));
  const inner = r * (0.92 - off * 0.55);
  const grad = g.createRadialGradient(sx, sy, Math.max(0, inner), sx, sy, inner + r * (0.18 + off * 0.2));
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  g.beginPath();
  g.arc(cx, cy, r + 1, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();
  if (s.dim > 0) {
    g.fillStyle = `rgba(0,0,0,${s.dim})`;
    g.fill();
  }
  g.restore();
}

function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, wpx: number) {
  g.lineWidth = wpx;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  g.font = `${Math.max(8, Math.min(14, size))}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x, y);
}

/** Mil "tree" reticle: 0.2-mil hashes to ±10, heavy posts beyond, holdover tree below. */
function drawMilTree(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, pu: number) {
  const thin = 1.1;
  const span = 10;
  // heavy posts
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    line(g, cx + dx * span * pu, cy + dy * span * pu, cx + dx * r * 1.2, cy + dy * r * 1.2, 5);
  }
  line(g, cx - span * pu, cy, cx + span * pu, cy, thin);
  line(g, cx, cy - span * pu, cx, cy + span * pu, thin);
  const showFine = pu * 0.2 >= 3;
  for (let i = -span * 5; i <= span * 5; i++) {
    if (i === 0) continue;
    const m = i / 5;
    const major = i % 5 === 0;
    if (!major && !showFine) continue;
    const len = major ? Math.max(5, pu * 0.3) : Math.max(3, pu * 0.15);
    line(g, cx + m * pu, cy - len / 2, cx + m * pu, cy + len / 2, thin);
    line(g, cx - len / 2, cy + m * pu, cx + len / 2, cy + m * pu, thin);
    if (major && Math.abs(m) % 2 === 0 && pu > 14) {
      label(g, String(Math.abs(m)), cx + m * pu, cy - len - 6, pu * 0.35);
      if (m > 0) label(g, String(m), cx - len - 9, cy + m * pu, pu * 0.35);
    }
  }
  // holdover tree: rows every mil from 2 to 10 below, dots every mil
  for (let row = 2; row <= 10; row++) {
    const half = Math.ceil(row / 2);
    for (let c = -half; c <= half; c++) {
      if (c === 0) continue;
      g.beginPath();
      g.arc(cx + c * pu, cy + row * pu, Math.max(1, pu * 0.05), 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** MOA hash reticle: 1-MOA hashes, 5-MOA long marks to ±40, numbered every 10. */
function drawMoaHash(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, pu: number) {
  const thin = 1.1;
  const span = 40;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    line(g, cx + dx * span * pu, cy + dy * span * pu, cx + dx * r * 1.2, cy + dy * r * 1.2, 5);
  }
  line(g, cx - span * pu, cy, cx + span * pu, cy, thin);
  line(g, cx, cy - span * pu, cx, cy + span * pu, thin);
  const fine = pu >= 3;
  for (let m = -span; m <= span; m++) {
    if (m === 0) continue;
    const major = m % 5 === 0;
    if (!major && !fine) continue;
    const len = major ? Math.max(5, pu * 1.2) : Math.max(3, pu * 0.6);
    line(g, cx + m * pu, cy - len / 2, cx + m * pu, cy + len / 2, thin);
    line(g, cx - len / 2, cy + m * pu, cx + len / 2, cy + m * pu, thin);
    if (m % 10 === 0 && pu > 4) {
      label(g, String(Math.abs(m)), cx + m * pu, cy - len - 6, pu * 1.4);
      if (m > 0) label(g, String(m), cx - len - 9, cy + m * pu, pu * 1.4);
    }
  }
}

/** Naked-eye view: a small mark showing where the rifle points. */
export function drawNakedEye(g: CanvasRenderingContext2D, w: number, h: number) {
  g.clearRect(0, 0, w, h);
  g.strokeStyle = "rgba(255,255,255,0.8)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(w / 2, h / 2, 6, 0, Math.PI * 2);
  g.stroke();
}
