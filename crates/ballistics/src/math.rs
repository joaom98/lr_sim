use core::ops::{Add, AddAssign, Mul, Neg, Sub};
use serde::{Deserialize, Serialize};

/// Minimal 3-vector used by the solver.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };

    #[inline]
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    #[inline]
    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    #[inline]
    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    #[inline]
    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    #[inline]
    pub fn normalized(self) -> Vec3 {
        let n = self.norm();
        if n > 0.0 {
            self * (1.0 / n)
        } else {
            self
        }
    }

    #[inline]
    pub fn lerp(a: Vec3, b: Vec3, t: f64) -> Vec3 {
        a + (b - a) * t
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    #[inline]
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl AddAssign for Vec3 {
    #[inline]
    fn add_assign(&mut self, o: Vec3) {
        *self = *self + o;
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    #[inline]
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f64> for Vec3 {
    type Output = Vec3;
    #[inline]
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    #[inline]
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// Monotone piecewise-cubic (Fritsch–Carlson / PCHIP) interpolant over sorted `x`.
/// Values outside the table are clamped to the end points.
#[derive(Clone, Debug)]
pub struct Pchip {
    x: Vec<f64>,
    y: Vec<f64>,
    m: Vec<f64>,
}

impl Pchip {
    pub fn new(x: Vec<f64>, y: Vec<f64>) -> Self {
        let n = x.len();
        assert!(n >= 2 && n == y.len());
        let h: Vec<f64> = (0..n - 1).map(|k| x[k + 1] - x[k]).collect();
        let d: Vec<f64> = (0..n - 1).map(|k| (y[k + 1] - y[k]) / h[k]).collect();
        let mut m = vec![0.0; n];
        m[0] = d[0];
        m[n - 1] = d[n - 2];
        for k in 1..n - 1 {
            if d[k - 1] * d[k] <= 0.0 {
                m[k] = 0.0;
            } else {
                let w1 = 2.0 * h[k] + h[k - 1];
                let w2 = h[k] + 2.0 * h[k - 1];
                m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
            }
        }
        Self { x, y, m }
    }

    pub fn eval(&self, xq: f64) -> f64 {
        let n = self.x.len();
        if xq <= self.x[0] {
            return self.y[0];
        }
        if xq >= self.x[n - 1] {
            return self.y[n - 1];
        }
        // Binary search for interval k with x[k] <= xq < x[k+1].
        let k = match self.x.binary_search_by(|v| v.partial_cmp(&xq).unwrap()) {
            Ok(i) => return self.y[i],
            Err(i) => i - 1,
        };
        let h = self.x[k + 1] - self.x[k];
        let t = (xq - self.x[k]) / h;
        let t2 = t * t;
        let t3 = t2 * t;
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        h00 * self.y[k] + h10 * h * self.m[k] + h01 * self.y[k + 1] + h11 * h * self.m[k + 1]
    }
}
