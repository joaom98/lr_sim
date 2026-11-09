// Analytic terrain so rendering, hit detection and the rangefinder agree exactly.
// Coordinates: `down` = metres downrange from the shooter, `right` = metres to the right.
// Height is metres above the firing-point ground.

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const PAD_LENGTH_M = 30;
export const LANE_HALF_WIDTH_M = 70;

export function groundHeight(down: number, right: number): number {
  const lane = Math.abs(right);
  const outside = smoothstep(LANE_HALF_WIDTH_M, LANE_HALF_WIDTH_M + 160, lane);
  const pad = smoothstep(PAD_LENGTH_M, PAD_LENGTH_M + 80, down);
  // A gentle 0.6 % rise downrange keeps every target visible from a prone position.
  const grade = 0.006 * Math.max(0, down - PAD_LENGTH_M);
  const ripple = 0.18 * Math.sin(down / 97 + 0.4) * Math.cos(right / 53) + 0.1 * Math.sin(down / 41 + right / 37);
  const hills =
    16 * (Math.sin(down / 310 + 1.3) * Math.cos(right / 270) + 0.6 * Math.sin(down / 170 - right / 130) + 1) +
    0.02 * (lane - LANE_HALF_WIDTH_M) * (0.6 + 0.4 * Math.sin(down / 500));
  // Backstop: the valley closes behind the last target.
  const backstop = 55 * smoothstep(1650, 2300, down);
  const behind = down < 0 ? smoothstep(0, -40, down) * 6 : 0;
  return pad * (grade + ripple * (1 - outside)) + outside * hills + backstop + behind;
}
