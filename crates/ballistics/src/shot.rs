//! Seeded shot strings: muzzle velocity and BC variation, aiming error and gusting wind over
//! time. Same input and seed always give the same group.

use serde::{Deserialize, Serialize};

use crate::error::{finite, positive, require, BallisticsError};
use crate::rng::Rng;
use crate::solver::{ShotInput, ShotParams, Solver};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpec {
    /// Target distance (line of sight, m).
    pub range_m: f64,
    /// Elevation dialed above zero (mrad). `None` = the exact nominal solution.
    #[serde(default)]
    pub dial_elevation_mrad: Option<f64>,
    /// Windage dialed (mrad, + = right). `None` = the exact nominal solution at shot 1.
    #[serde(default)]
    pub dial_windage_mrad: Option<f64>,
    pub shots: u32,
    pub seed: u32,
    /// Shooter aiming error, standard deviation per axis (mrad).
    #[serde(default)]
    pub aim_sd_mrad: f64,
    /// Time between shots, for gusting wind (s).
    #[serde(default = "default_interval")]
    pub interval_s: f64,
    /// Time of the first shot in the wind timeline (s).
    #[serde(default)]
    pub start_time_s: f64,
}

fn default_interval() -> f64 {
    8.0
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Impact {
    pub shot: u32,
    /// Impact relative to the point of aim on the target (m, + = high).
    pub vertical_m: f64,
    /// Impact relative to the point of aim (m, + = right).
    pub horizontal_m: f64,
    pub time_s: f64,
    pub velocity_mps: f64,
    pub energy_j: f64,
    pub muzzle_velocity_mps: f64,
    pub bc_scale: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupResult {
    pub dial_elevation_mrad: f64,
    pub dial_windage_mrad: f64,
    pub impacts: Vec<Impact>,
    pub mean_vertical_m: f64,
    pub mean_horizontal_m: f64,
    /// Largest centre-to-centre distance between two impacts (m).
    pub extreme_spread_m: f64,
    /// Mean distance of impacts from the group centre (m).
    pub mean_radius_m: f64,
}

pub fn fire_group(input: ShotInput, spec: &GroupSpec) -> Result<GroupResult, BallisticsError> {
    positive(spec.range_m, "range")?;
    require(spec.shots >= 1 && spec.shots <= 1000, "shots must be between 1 and 1000")?;
    require(spec.aim_sd_mrad.is_finite() && spec.aim_sd_mrad >= 0.0, "aim SD must be >= 0")?;
    require(spec.interval_s.is_finite() && spec.interval_s >= 0.0, "shot interval must be >= 0")?;
    finite(spec.start_time_s, "start time")?;

    let solver = Solver::new(input)?;
    let (dial_e, dial_w) = match (spec.dial_elevation_mrad, spec.dial_windage_mrad) {
        (Some(e), Some(w)) => (e, w),
        (e, w) => {
            let nominal = ShotParams { time_offset_s: spec.start_time_s, ..ShotParams::default() };
            let row = solver.impact(spec.range_m, &nominal)?.ok_or_else(|| {
                BallisticsError::InvalidInput(format!("the bullet does not reach {} m", spec.range_m))
            })?;
            (e.unwrap_or(row.elevation_mrad), w.unwrap_or(row.windage_mrad))
        }
    };

    let load = solver.input().load;
    let mut rng = Rng::new(spec.seed as u64);
    let mut impacts = Vec::with_capacity(spec.shots as usize);
    for k in 0..spec.shots {
        // Draw every random value for a shot in a fixed order so results stay reproducible.
        let mv_delta = rng.normal() * load.mv_sd_mps;
        let bc_scale = (1.0 + rng.normal() * load.bc_sd_fraction).max(0.5);
        let aim_e = rng.normal() * spec.aim_sd_mrad;
        let aim_w = rng.normal() * spec.aim_sd_mrad;
        let params = ShotParams {
            elevation_rad: (dial_e + aim_e) / 1000.0,
            windage_rad: (dial_w + aim_w) / 1000.0,
            mv_delta_mps: mv_delta,
            bc_scale,
            time_offset_s: spec.start_time_s + k as f64 * spec.interval_s,
        };
        if let Some(row) = solver.impact(spec.range_m, &params)? {
            impacts.push(Impact {
                shot: k + 1,
                vertical_m: row.drop_m,
                horizontal_m: row.windage_m,
                time_s: row.time_s,
                velocity_mps: row.velocity_mps,
                energy_j: row.energy_j,
                muzzle_velocity_mps: solver.muzzle_velocity() + mv_delta,
                bc_scale,
            });
        }
    }

    let n = impacts.len().max(1) as f64;
    let mv = impacts.iter().map(|i| i.vertical_m).sum::<f64>() / n;
    let mh = impacts.iter().map(|i| i.horizontal_m).sum::<f64>() / n;
    let mut es: f64 = 0.0;
    for (a, ia) in impacts.iter().enumerate() {
        for ib in &impacts[a + 1..] {
            es = es.max((ia.vertical_m - ib.vertical_m).hypot(ia.horizontal_m - ib.horizontal_m));
        }
    }
    let mr = impacts.iter().map(|i| (i.vertical_m - mv).hypot(i.horizontal_m - mh)).sum::<f64>() / n;

    Ok(GroupResult {
        dial_elevation_mrad: dial_e,
        dial_windage_mrad: dial_w,
        impacts,
        mean_vertical_m: mv,
        mean_horizontal_m: mh,
        extreme_spread_m: es,
        mean_radius_m: mr,
    })
}
