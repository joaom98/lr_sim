// Shot records: one entry per fired shot, kept in local storage. Small and stable on purpose,
// so career stats, progression and future analysis can all build on the same data.

export interface ShotRecord {
  at: string;
  session: number;
  shot: number;
  rifleId: string;
  ammoId: string;
  opticId: string;
  position: string;
  targetId: string | null;
  targetRangeM: number | null;
  result: "hit" | "miss";
  /** impact relative to the target centre (mrad, + right / + up) */
  offsetMrad: { x: number; y: number } | null;
  dialMrad: { elevation: number; windage: number };
  timeOfFlightS: number;
  impactVelocityMps: number;
  energyJ: number;
  heldBreath: boolean;
  inPause: boolean;
  /** rifle cant when fired (deg) */
  cantDeg?: number;
  /** what moved the shot (mrad per source), when it was aimed at a target */
  breakdown?: { key: string; x: number; y: number }[];
  /** drill the shot was fired in (absent = free range) */
  drillId?: string;
}

export const RECORDS_KEY = "lrs.shots.v1";
const MAX_RECORDS = 2000;

export function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: progress just won't persist */
  }
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const records: ShotRecord[] = load<ShotRecord[]>(RECORDS_KEY, []);

export function addRecord(r: ShotRecord) {
  records.push(r);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  save(RECORDS_KEY, records);
}
