// Small seeded PRNG for repeatable sessions (mulberry32 + Box–Muller).

export class Rand {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  uniform(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.uniform();
  }
  normal(): number {
    const u1 = Math.max(this.uniform(), 1e-12);
    const u2 = this.uniform();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
