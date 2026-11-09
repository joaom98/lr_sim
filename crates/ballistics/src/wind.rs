//! Wind: multiple downrange zones, each with speed and direction, plus optional deterministic
//! gusts (smooth noise in time and downrange distance).

use serde::{Deserialize, Serialize};

use crate::error::{require, BallisticsError};
use crate::math::Vec3;
use crate::rng::value_noise;

/// Wind over a stretch of the range.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindZone {
    /// Zone applies up to this horizontal downrange distance (m). `None` = to infinity.
    #[serde(default)]
    pub until_m: Option<f64>,
    pub speed_mps: f64,
    /// Direction the wind blows FROM, relative to the line of fire, clockwise:
    /// 0° = from the target (headwind), 90° = from the right (3 o'clock),
    /// 180° = from behind (tailwind), 270° = from the left (9 o'clock).
    pub from_deg: f64,
}

/// Gust model applied on top of every zone.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gusts {
    /// Speed variation as a fraction of the zone speed (0.3 = ±30 %).
    pub intensity: f64,
    /// Direction variation amplitude (degrees).
    #[serde(default)]
    pub direction_variation_deg: f64,
    /// Typical time between gust peaks (s).
    #[serde(default = "default_period")]
    pub period_s: f64,
    /// Downrange distance over which gusts decorrelate (m).
    #[serde(default = "default_corr")]
    pub correlation_length_m: f64,
    #[serde(default)]
    pub seed: u32,
}

fn default_period() -> f64 {
    6.0
}
fn default_corr() -> f64 {
    250.0
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindField {
    #[serde(default)]
    pub zones: Vec<WindZone>,
    #[serde(default)]
    pub gusts: Option<Gusts>,
}

impl WindField {
    pub fn constant(speed_mps: f64, from_deg: f64) -> Self {
        Self { zones: vec![WindZone { until_m: None, speed_mps, from_deg }], gusts: None }
    }

    pub fn validate(&self) -> Result<(), BallisticsError> {
        for z in &self.zones {
            require(z.speed_mps.is_finite() && z.speed_mps >= 0.0, "wind speed must be >= 0")?;
            require(z.from_deg.is_finite(), "wind direction must be finite")?;
            if let Some(u) = z.until_m {
                require(u.is_finite() && u > 0.0, "wind zone end must be > 0")?;
            }
        }
        if let Some(g) = &self.gusts {
            require(g.intensity.is_finite() && (0.0..=2.0).contains(&g.intensity), "gust intensity must be 0..2")?;
            require(g.period_s.is_finite() && g.period_s > 0.0, "gust period must be > 0")?;
            require(g.correlation_length_m.is_finite() && g.correlation_length_m > 0.0, "gust length must be > 0")?;
            require(g.direction_variation_deg.is_finite(), "gust direction variation must be finite")?;
        }
        Ok(())
    }

    /// Wind velocity vector (solver frame) at horizontal downrange distance `x` and time `t`.
    pub fn at(&self, x: f64, t: f64) -> Vec3 {
        PreparedWind::new(self).at(x, t)
    }
}

/// Wind field with each zone's vector precomputed, for use inside the integrator.
#[derive(Clone, Debug)]
pub struct PreparedWind {
    /// (zone end, base wind vector)
    zones: Vec<(f64, Vec3)>,
    gusts: Option<Gusts>,
    dir_amp_rad: f64,
}

/// Wind vector for a wind blowing FROM `from_rad`: the air moves the opposite way.
#[inline]
fn wind_vector(speed: f64, from_rad: f64) -> Vec3 {
    Vec3::new(-speed * from_rad.cos(), 0.0, -speed * from_rad.sin())
}

impl PreparedWind {
    pub fn new(field: &WindField) -> Self {
        Self {
            zones: field
                .zones
                .iter()
                .map(|z| (z.until_m.unwrap_or(f64::INFINITY), wind_vector(z.speed_mps, z.from_deg.to_radians())))
                .collect(),
            gusts: field.gusts,
            dir_amp_rad: field.gusts.map_or(0.0, |g| g.direction_variation_deg.to_radians()),
        }
    }

    pub fn is_calm(&self) -> bool {
        self.zones.iter().all(|z| z.1 == Vec3::ZERO)
    }

    #[inline]
    pub fn at(&self, x: f64, t: f64) -> Vec3 {
        let n = self.zones.len();
        if n == 0 {
            return Vec3::ZERO;
        }
        let idx = self.zones.iter().position(|z| x < z.0).unwrap_or(n - 1);
        let base = self.zones[idx].1;
        let Some(g) = &self.gusts else { return base };
        let u = t / g.period_s + x / g.correlation_length_m;
        let seed = (g.seed as u64) << 8 | idx as u64;
        let n1 = 0.65 * value_noise(u, seed) + 0.35 * value_noise(u * 2.7 + 13.1, seed ^ 0xA5A5);
        let n2 = 0.65 * value_noise(u + 101.3, seed ^ 0x5A5A) + 0.35 * value_noise(u * 2.3 + 7.7, seed ^ 0x3C3C);
        let scale = (1.0 + g.intensity * n1).max(0.0);
        // Rotate the horizontal wind vector by the direction perturbation.
        let d = self.dir_amp_rad * n2;
        let (s, c) = if d.abs() < 0.3 {
            let d2 = d * d;
            (d * (1.0 - d2 / 6.0 * (1.0 - d2 / 20.0)), 1.0 - d2 / 2.0 * (1.0 - d2 / 12.0))
        } else {
            d.sin_cos()
        };
        Vec3::new((base.x * c - base.z * s) * scale, 0.0, (base.x * s + base.z * c) * scale)
    }
}
