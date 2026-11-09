// Synthesized range sounds: the shot report and the steel "ding", which reaches the shooter
// after the bullet's flight time plus the time sound takes to travel back.

export class RangeAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.7;

  /** Must be called from a user gesture before sounds can play. */
  resume() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
      const len = this.ctx.sampleRate * 1.2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    void this.ctx.resume();
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Muzzle report. `energyJ` scales loudness and low end. */
  shot(energyJ: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = this.volume * Math.min(1, 0.45 + energyJ / 12000);
    out.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(400, t + 0.35);
    const env = ctx.createGain();
    env.gain.setValueAtTime(1, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(lp).connect(env).connect(out);
    src.start(t);
    src.stop(t + 1);

    const boom = ctx.createOscillator();
    boom.frequency.setValueAtTime(110, t);
    boom.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const be = ctx.createGain();
    be.gain.setValueAtTime(0.9, t);
    be.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    boom.connect(be).connect(out);
    boom.start(t);
    boom.stop(t + 0.45);

    // Valley echo
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.9;
    const eg = ctx.createGain();
    eg.gain.value = 0.18;
    env.connect(delay).connect(eg).connect(out);
  }

  /** Steel plate ring heard `delayS` from now, from `distanceM` away. */
  ding(delayS: number, distanceM: number, plateSizeM: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delayS;
    const f0 = 520 / Math.sqrt(Math.max(0.15, plateSizeM));
    const out = ctx.createGain();
    out.gain.value = this.volume * Math.min(0.8, 60 / Math.max(60, distanceM));
    // Air absorbs high frequencies over distance.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.max(1200, 9000 - distanceM * 4);
    out.connect(lp).connect(ctx.destination);
    for (const [ratio, amp, decay] of [
      [1, 1, 1.4],
      [2.76, 0.5, 0.9],
      [5.4, 0.3, 0.5],
      [8.93, 0.15, 0.3],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f0 * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
  }

  /** Dull thud of a ground strike (only audible fairly close). */
  thud(delayS: number, distanceM: number) {
    const ctx = this.ctx;
    if (!ctx || !this.noise || distanceM > 450) return;
    const t = ctx.currentTime + delayS;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(this.volume * 0.4 * (1 - distanceM / 450), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.3);
  }
}
