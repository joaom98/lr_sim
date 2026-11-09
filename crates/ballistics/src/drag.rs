//! Drag models: standard G1/G7 reference projectiles with a ballistic coefficient (optionally
//! velocity-banded), or a bullet-specific custom Cd-vs-Mach curve.

use serde::{Deserialize, Serialize};

use crate::error::{positive, require, BallisticsError};
use crate::math::Pchip;
use crate::units::BC_LB_IN2_TO_KG_M2;

/// Standard reference projectile drag functions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StandardTable {
    G1,
    G7,
}

/// One ballistic-coefficient band: `bc` applies at and above `min_velocity_mps`
/// (the stepped convention used by bullet makers for multi-BC data).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BcBand {
    pub min_velocity_mps: f64,
    /// BC in lb/in².
    pub bc: f64,
}

/// One point of a drag curve.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MachCd {
    pub mach: f64,
    pub cd: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DragModel {
    /// A standard drag function scaled by a ballistic coefficient in lb/in².
    #[serde(rename_all = "camelCase")]
    Standard {
        table: StandardTable,
        bc: f64,
        /// Optional velocity bands. When non-empty they replace `bc`.
        #[serde(default)]
        bands: Vec<BcBand>,
    },
    /// The bullet's own drag coefficient vs. Mach (referenced to its caliber area).
    #[serde(rename_all = "camelCase")]
    Custom { points: Vec<MachCd> },
}

impl DragModel {
    pub fn g1(bc: f64) -> Self {
        DragModel::Standard { table: StandardTable::G1, bc, bands: Vec::new() }
    }
    pub fn g7(bc: f64) -> Self {
        DragModel::Standard { table: StandardTable::G7, bc, bands: Vec::new() }
    }
}

/// A drag model resolved for fast evaluation during integration.
#[derive(Clone, Debug)]
pub(crate) struct PreparedDrag {
    curve: Pchip,
    /// (min velocity, BC in kg/m²) sorted by descending velocity.
    bands: Vec<(f64, f64)>,
}

impl PreparedDrag {
    /// `bc_scale` multiplies every BC (used for bullet-to-bullet variation).
    pub fn new(model: &DragModel, mass_kg: f64, diameter_m: f64, bc_scale: f64) -> Result<Self, BallisticsError> {
        match model {
            DragModel::Standard { table, bc, bands } => {
                let pts = match table {
                    StandardTable::G1 => G1_TABLE,
                    StandardTable::G7 => G7_TABLE,
                };
                let curve = Pchip::new(pts.iter().map(|p| p.0).collect(), pts.iter().map(|p| p.1).collect());
                let mut b: Vec<(f64, f64)> = if bands.is_empty() {
                    positive(*bc, "ballistic coefficient")?;
                    vec![(0.0, *bc)]
                } else {
                    for band in bands {
                        positive(band.bc, "band ballistic coefficient")?;
                        require(
                            band.min_velocity_mps.is_finite() && band.min_velocity_mps >= 0.0,
                            "band velocity must be >= 0",
                        )?;
                    }
                    bands.iter().map(|x| (x.min_velocity_mps, x.bc)).collect()
                };
                for x in &mut b {
                    x.1 *= BC_LB_IN2_TO_KG_M2 * bc_scale;
                }
                b.sort_by(|a, c| c.0.partial_cmp(&a.0).unwrap());
                Ok(Self { curve, bands: b })
            }
            DragModel::Custom { points } => {
                require(points.len() >= 2, "custom drag curve needs at least two points")?;
                let mut pts = points.clone();
                pts.sort_by(|a, b| a.mach.partial_cmp(&b.mach).unwrap());
                for w in pts.windows(2) {
                    require(w[1].mach > w[0].mach, "custom drag curve Mach values must be distinct")?;
                }
                for p in &pts {
                    require(p.cd.is_finite() && p.cd >= 0.0, "custom drag Cd must be >= 0")?;
                }
                let curve = Pchip::new(pts.iter().map(|p| p.mach).collect(), pts.iter().map(|p| p.cd).collect());
                // With a real Cd the "BC" is simply the sectional density m/d².
                let sd = mass_kg / (diameter_m * diameter_m) * bc_scale;
                Ok(Self { curve, bands: vec![(0.0, sd)] })
            }
        }
    }

    #[inline]
    pub fn cd(&self, mach: f64) -> f64 {
        self.curve.eval(mach)
    }

    /// BC in kg/m² for the current air-relative speed.
    #[inline]
    pub fn bc_si(&self, speed_mps: f64) -> f64 {
        for &(v, bc) in &self.bands {
            if speed_mps >= v {
                return bc;
            }
        }
        self.bands[self.bands.len() - 1].1
    }
}

/// G1 standard drag function (Mach, Cd).
pub const G1_TABLE: &[(f64, f64)] = &[
    (0.00, 0.2629), (0.05, 0.2558), (0.10, 0.2487), (0.15, 0.2413), (0.20, 0.2344),
    (0.25, 0.2278), (0.30, 0.2214), (0.35, 0.2155), (0.40, 0.2104), (0.45, 0.2061),
    (0.50, 0.2032), (0.55, 0.2020), (0.60, 0.2034), (0.70, 0.2165), (0.725, 0.2230),
    (0.75, 0.2313), (0.775, 0.2417), (0.80, 0.2546), (0.825, 0.2706), (0.85, 0.2901),
    (0.875, 0.3136), (0.90, 0.3415), (0.925, 0.3734), (0.95, 0.4084), (0.975, 0.4448),
    (1.00, 0.4805), (1.025, 0.5136), (1.05, 0.5427), (1.075, 0.5677), (1.10, 0.5883),
    (1.125, 0.6053), (1.15, 0.6191), (1.20, 0.6393), (1.25, 0.6518), (1.30, 0.6589),
    (1.35, 0.6621), (1.40, 0.6625), (1.45, 0.6607), (1.50, 0.6573), (1.55, 0.6528),
    (1.60, 0.6474), (1.65, 0.6413), (1.70, 0.6347), (1.75, 0.6280), (1.80, 0.6210),
    (1.85, 0.6141), (1.90, 0.6072), (1.95, 0.6003), (2.00, 0.5934), (2.05, 0.5867),
    (2.10, 0.5804), (2.15, 0.5743), (2.20, 0.5685), (2.25, 0.5630), (2.30, 0.5577),
    (2.35, 0.5527), (2.40, 0.5481), (2.45, 0.5438), (2.50, 0.5397), (2.60, 0.5325),
    (2.70, 0.5264), (2.80, 0.5211), (2.90, 0.5168), (3.00, 0.5133), (3.10, 0.5105),
    (3.20, 0.5084), (3.30, 0.5067), (3.40, 0.5054), (3.50, 0.5040), (3.60, 0.5030),
    (3.70, 0.5022), (3.80, 0.5016), (3.90, 0.5010), (4.00, 0.5006), (4.20, 0.4998),
    (4.40, 0.4995), (4.60, 0.4992), (4.80, 0.4990), (5.00, 0.4988),
];

/// G7 standard drag function (Mach, Cd).
pub const G7_TABLE: &[(f64, f64)] = &[
    (0.00, 0.1198), (0.05, 0.1197), (0.10, 0.1196), (0.15, 0.1194), (0.20, 0.1193),
    (0.25, 0.1194), (0.30, 0.1194), (0.35, 0.1194), (0.40, 0.1193), (0.45, 0.1193),
    (0.50, 0.1194), (0.55, 0.1193), (0.60, 0.1194), (0.65, 0.1197), (0.70, 0.1202),
    (0.725, 0.1207), (0.75, 0.1215), (0.775, 0.1226), (0.80, 0.1242), (0.825, 0.1266),
    (0.85, 0.1306), (0.875, 0.1368), (0.90, 0.1464), (0.925, 0.1660), (0.95, 0.2054),
    (0.975, 0.2993), (1.00, 0.3803), (1.025, 0.4015), (1.05, 0.4043), (1.075, 0.4034),
    (1.10, 0.4014), (1.125, 0.3987), (1.15, 0.3955), (1.20, 0.3884), (1.25, 0.3810),
    (1.30, 0.3732), (1.35, 0.3657), (1.40, 0.3580), (1.50, 0.3440), (1.55, 0.3376),
    (1.60, 0.3315), (1.65, 0.3260), (1.70, 0.3209), (1.75, 0.3160), (1.80, 0.3117),
    (1.85, 0.3078), (1.90, 0.3042), (1.95, 0.3010), (2.00, 0.2980), (2.05, 0.2951),
    (2.10, 0.2922), (2.15, 0.2892), (2.20, 0.2864), (2.25, 0.2835), (2.30, 0.2807),
    (2.35, 0.2779), (2.40, 0.2752), (2.45, 0.2725), (2.50, 0.2697), (2.55, 0.2670),
    (2.60, 0.2643), (2.65, 0.2615), (2.70, 0.2588), (2.75, 0.2561), (2.80, 0.2533),
    (2.85, 0.2506), (2.90, 0.2479), (2.95, 0.2451), (3.00, 0.2424), (3.10, 0.2368),
    (3.20, 0.2313), (3.30, 0.2258), (3.40, 0.2205), (3.50, 0.2154), (3.60, 0.2106),
    (3.70, 0.2060), (3.80, 0.2017), (3.90, 0.1975), (4.00, 0.1935), (4.20, 0.1861),
    (4.40, 0.1793), (4.60, 0.1730), (4.80, 0.1672), (5.00, 0.1618),
];
