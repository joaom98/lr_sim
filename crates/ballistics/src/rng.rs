//! Small deterministic PRNG (SplitMix64). Identical seeds give identical sequences on every
//! platform, including WebAssembly, which keeps shots and replays reproducible.

#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed ^ 0x9E37_79B9_7F4A_7C15 }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Standard normal (Box–Muller).
    pub fn normal(&mut self) -> f64 {
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        (-2.0 * u1.ln()).sqrt() * (core::f64::consts::TAU * u2).cos()
    }
}

/// Stateless hash of an integer lattice point to [-1, 1] (for value noise).
pub(crate) fn hash_unit(i: i64, seed: u64) -> f64 {
    let mut x = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ seed.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 31;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 29;
    ((x >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
}

/// Smooth 1-D value noise in [-1, 1].
pub(crate) fn value_noise(u: f64, seed: u64) -> f64 {
    let i = u.floor();
    let f = u - i;
    let s = f * f * (3.0 - 2.0 * f);
    let a = hash_unit(i as i64, seed);
    let b = hash_unit(i as i64 + 1, seed);
    a + (b - a) * s
}
