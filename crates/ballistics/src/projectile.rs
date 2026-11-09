//! Bullet, rifle and load descriptions plus the empirical stability / spin models.

use serde::{Deserialize, Serialize};

use crate::atmosphere::Atmosphere;
use crate::drag::DragModel;
use crate::error::{finite, positive, require, BallisticsError};
use crate::units::{c_to_f, GRAIN_KG, INCH_M, INHG_PA, MOA_RAD, MPH_MPS};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bullet {
    pub mass_kg: f64,
    pub diameter_m: f64,
    /// Overall bullet length (m), used for the stability estimate.
    pub length_m: f64,
    pub drag: DragModel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TwistDirection {
    Right,
    Left,
}

impl TwistDirection {
    #[inline]
    pub fn sign(self) -> f64 {
        match self {
            TwistDirection::Right => 1.0,
            TwistDirection::Left => -1.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rifle {
    /// Height of the scope's optical axis above the bore axis (m).
    pub sight_height_m: f64,
    /// Barrel twist: distance for one full turn (m).
    pub twist_m: f64,
    pub twist_direction: TwistDirection,
    pub barrel_length_m: f64,
}

/// A cartridge load and how its muzzle velocity responds to conditions.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// Muzzle velocity at the reference barrel length and powder temperature (m/s).
    pub muzzle_velocity_mps: f64,
    /// Barrel length the muzzle velocity was measured with. `None` = rifle's own barrel.
    #[serde(default)]
    pub reference_barrel_length_m: Option<f64>,
    /// Velocity change per metre of barrel length (m/s per m).
    #[serde(default)]
    pub velocity_per_barrel_m: f64,
    /// Powder temperature sensitivity (m/s per °C).
    #[serde(default)]
    pub powder_temp_sensitivity: f64,
    /// Powder temperature at which `muzzle_velocity_mps` was measured (°C).
    #[serde(default = "default_ref_temp")]
    pub reference_powder_temp_c: f64,
    /// Shot-to-shot muzzle velocity standard deviation (m/s).
    #[serde(default)]
    pub mv_sd_mps: f64,
    /// Bullet-to-bullet BC standard deviation as a fraction (0.01 = 1 %).
    #[serde(default)]
    pub bc_sd_fraction: f64,
}

fn default_ref_temp() -> f64 {
    15.0
}

impl Load {
    /// Muzzle velocity for a given barrel length and powder temperature.
    pub fn muzzle_velocity(&self, barrel_length_m: f64, powder_temp_c: f64) -> f64 {
        let ref_len = self.reference_barrel_length_m.unwrap_or(barrel_length_m);
        self.muzzle_velocity_mps
            + self.velocity_per_barrel_m * (barrel_length_m - ref_len)
            + self.powder_temp_sensitivity * (powder_temp_c - self.reference_powder_temp_c)
    }
}

impl Bullet {
    pub fn validate(&self) -> Result<(), BallisticsError> {
        positive(self.mass_kg, "bullet mass")?;
        positive(self.diameter_m, "bullet diameter")?;
        positive(self.length_m, "bullet length")?;
        require(self.diameter_m < 0.03, "bullet diameter must be below 30 mm (small arms)")
    }
}

impl Rifle {
    pub fn validate(&self) -> Result<(), BallisticsError> {
        finite(self.sight_height_m, "sight height")?;
        positive(self.twist_m, "twist rate")?;
        positive(self.barrel_length_m, "barrel length")
    }
}

impl Load {
    pub fn validate(&self) -> Result<(), BallisticsError> {
        positive(self.muzzle_velocity_mps, "muzzle velocity")?;
        finite(self.velocity_per_barrel_m, "velocity per barrel length")?;
        finite(self.powder_temp_sensitivity, "powder temperature sensitivity")?;
        require(self.mv_sd_mps.is_finite() && self.mv_sd_mps >= 0.0, "MV SD must be >= 0")?;
        require(
            self.bc_sd_fraction.is_finite() && (0.0..0.5).contains(&self.bc_sd_fraction),
            "BC SD fraction must be between 0 and 0.5",
        )
    }
}

/// Miller twist-rule gyroscopic stability factor Sg, corrected for velocity and air density.
///
/// Sg < 1: unstable (tumbling/keyholing). 1–1.4: marginal. ≥ 1.5: good.
pub fn miller_stability(bullet: &Bullet, rifle: &Rifle, velocity_mps: f64, atm: &Atmosphere) -> f64 {
    let m_gr = bullet.mass_kg / GRAIN_KG;
    let d_in = bullet.diameter_m / INCH_M;
    let l_cal = bullet.length_m / bullet.diameter_m;
    let t_cal = rifle.twist_m / bullet.diameter_m;
    let sg = 30.0 * m_gr / (t_cal * t_cal * d_in.powi(3) * l_cal * (1.0 + l_cal * l_cal));
    let v_fps = velocity_mps / 0.3048;
    let fv = (v_fps / 2800.0).cbrt();
    let t_f = c_to_f(atm.temperature_c);
    let p_inhg = atm.pressure_pa / INHG_PA;
    let fa = ((t_f + 460.0) / (59.0 + 460.0)) * (29.92 / p_inhg);
    sg * fv * fa
}

/// Litz's empirical spin drift (m) after `time_s` of flight. Positive = in the twist direction.
pub fn litz_spin_drift_m(sg: f64, time_s: f64) -> f64 {
    1.25 * (sg + 1.2) * time_s.max(0.0).powf(1.83) * INCH_M
}

/// Litz's empirical aerodynamic jump coefficient: radians of vertical deflection per m/s of
/// crosswind from the left (for right-hand twist; negate for left twist).
pub fn aero_jump_rad_per_mps(sg: f64, bullet: &Bullet) -> f64 {
    let l_cal = bullet.length_m / bullet.diameter_m;
    let moa_per_mph = (0.01 * sg - 0.0024 * l_cal + 0.032).max(0.0);
    moa_per_mph * MOA_RAD / MPH_MPS
}
