// Career: XP from drills, ranks that unlock gear and drills, best scores, and lifetime stats
// computed from the shot records.
import careerData from "../../../data/career.json";
import { PART_LABELS, type PartKey } from "./analysis";
import { load, records, save } from "./records";

export interface Rank {
  id: string;
  name: string;
  xp: number;
  unlocks: { rifles: string[]; optics: string[]; drills: string[] };
}

export const RANKS: Rank[] = careerData.ranks;

export interface DrillBest {
  score: number;
  max: number;
  at: string;
}

export interface Career {
  xp: number;
  best: Record<string, DrillBest>;
  completions: Record<string, number>;
}

const CAREER_KEY = "lrs.career.v1";

export const career: Career = { xp: 0, best: {}, completions: {}, ...load<Partial<Career>>(CAREER_KEY, {}) };

export function rankIndex(xp = career.xp): number {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1].xp) i++;
  return i;
}

export function rank(xp = career.xp): Rank {
  return RANKS[rankIndex(xp)];
}

export function nextRank(xp = career.xp): Rank | null {
  return RANKS[rankIndex(xp) + 1] ?? null;
}

/** The rank that unlocks an item, or null if no rank lists it (always available). */
function unlockRank(kind: keyof Rank["unlocks"], id: string): number | null {
  const i = RANKS.findIndex((r) => r.unlocks[kind].includes(id));
  return i < 0 ? null : i;
}

export function isUnlocked(kind: keyof Rank["unlocks"], id: string): boolean {
  const need = unlockRank(kind, id);
  return need === null || need <= rankIndex();
}

export function unlockName(kind: keyof Rank["unlocks"], id: string): string | null {
  const need = unlockRank(kind, id);
  return need === null ? null : RANKS[need].name;
}

export interface Award {
  xp: number;
  rankedUp: Rank | null;
  newBest: boolean;
}

/** Record a finished drill. XP scales with the score fraction. */
export function finishDrill(drillId: string, score: number, max: number, xpValue: number): Award {
  const before = rankIndex();
  const frac = max > 0 ? Math.max(0, Math.min(1, score / max)) : 0;
  const xp = Math.round(frac * xpValue);
  career.xp += xp;
  career.completions[drillId] = (career.completions[drillId] ?? 0) + 1;
  const prev = career.best[drillId];
  const newBest = !prev || score / max > prev.score / prev.max;
  if (newBest) career.best[drillId] = { score, max, at: new Date().toISOString() };
  save(CAREER_KEY, career);
  const after = rankIndex();
  return { xp, rankedUp: after > before ? RANKS[after] : null, newBest };
}

export function resetCareer() {
  career.xp = 0;
  career.best = {};
  career.completions = {};
  save(CAREER_KEY, career);
}

export interface Stats {
  shots: number;
  hits: number;
  bands: { label: string; shots: number; hits: number }[];
  /** how often each error source was the biggest one */
  topErrors: { key: PartKey; label: string; share: number }[];
}

const BANDS: [string, number, number][] = [
  ["≤ 300 m", 0, 300],
  ["301–600 m", 301, 600],
  ["601–900 m", 601, 900],
  ["> 900 m", 901, Infinity],
];

/** Lifetime statistics from the shot records (shots aimed at a target only). */
export function stats(): Stats {
  const aimed = records.filter((r) => r.targetRangeM !== null);
  const counts = new Map<PartKey, number>();
  let analyzed = 0;
  for (const r of aimed) {
    if (!r.breakdown?.length) continue;
    const top = r.breakdown.reduce((a, b) => (Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y) ? b : a));
    if (Math.hypot(top.x, top.y) < 0.05) continue;
    analyzed++;
    counts.set(top.key as PartKey, (counts.get(top.key as PartKey) ?? 0) + 1);
  }
  return {
    shots: aimed.length,
    hits: aimed.filter((r) => r.result === "hit").length,
    bands: BANDS.map(([label, lo, hi]) => {
      const inBand = aimed.filter((r) => r.targetRangeM! >= lo && r.targetRangeM! <= hi);
      return { label, shots: inBand.length, hits: inBand.filter((r) => r.result === "hit").length };
    }),
    topErrors: [...counts.entries()]
      .map(([key, n]) => ({ key, label: PART_LABELS[key] ?? key, share: n / Math.max(1, analyzed) }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 3),
  };
}
