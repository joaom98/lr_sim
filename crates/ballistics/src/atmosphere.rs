//! Air properties: density (with humidity), speed of sound, standard atmospheres,
//! station vs. barometric pressure, density altitude and the ISA lapse model used to vary
//! the atmosphere along a high trajectory.

use serde::{Deserialize, Serialize};

use crate::error::{finite, require, BallisticsError};
use crate::units::INHG_PA;

/// Specific gas constant of dry air (J/(kg·K)).
const R_DRY: f64 = 287.058;
/// Specific gas constant of water vapour (J/(kg·K)).
const R_VAPOR: f64 = 461.495;
/// Ratio of specific heats for air.
const GAMMA: f64 = 1.4;
/// ISA temperature lapse rate in the troposphere (K/m).
const LAPSE: f64 = 0.0065;
/// ISA sea-level temperature (K) and pressure (Pa).
const T0_K: f64 = 288.15;
const P0_PA: f64 = 101_325.0;
/// ISA sea-level density (kg/m³).
pub const ISA_DENSITY: f64 = 1.225;
/// Barometric exponent g / (R · L).
const BARO_EXP: f64 = 5.255_88;
const KELVIN: f64 = 273.15;

/// Saturation vapour pressure over water (Arden Buck equation), Pa.
pub fn saturation_vapor_pressure_pa(t_c: f64) -> f64 {
    611.21 * ((18.678 - t_c / 234.5) * (t_c / (257.14 + t_c))).exp()
}

/// Local air state at the shooter.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Atmosphere {
    /// Altitude of the shooter above mean sea level (m).
    pub altitude_m: f64,
    /// Station (absolute, uncorrected) pressure at the shooter (Pa).
    pub pressure_pa: f64,
    /// Air temperature (°C).
    pub temperature_c: f64,
    /// Relative humidity, 0..1.
    pub humidity: f64,
}

impl Default for Atmosphere {
    fn default() -> Self {
        Self::icao()
    }
}

impl Atmosphere {
    pub fn new(altitude_m: f64, pressure_pa: f64, temperature_c: f64, humidity: f64) -> Self {
        Self { altitude_m, pressure_pa, temperature_c, humidity }
    }

    /// ICAO / ISA standard atmosphere at sea level: 15 °C, 1013.25 hPa, dry air.
    pub fn icao() -> Self {
        Self::new(0.0, P0_PA, 15.0, 0.0)
    }

    /// ISA standard atmosphere at a given altitude.
    pub fn icao_at_altitude(altitude_m: f64) -> Self {
        let t_k = T0_K - LAPSE * altitude_m;
        let p = P0_PA * (t_k / T0_K).powf(BARO_EXP);
        Self::new(altitude_m, p, t_k - KELVIN, 0.0)
    }

    /// Army Standard Metro: 59 °F, 29.5275 inHg, 78 % RH (≈ 0.0751 lb/ft³).
    /// Many published G1 ballistic coefficients were measured against this atmosphere.
    pub fn army_standard_metro() -> Self {
        Self::new(0.0, 29.5275 * INHG_PA, 15.0, 0.78)
    }

    /// Build from a *barometric* pressure (corrected to sea level, as weather reports give it).
    pub fn from_baro(altitude_m: f64, baro_pressure_pa: f64, temperature_c: f64, humidity: f64) -> Self {
        let station = baro_pressure_pa * (1.0 - LAPSE * altitude_m / T0_K).powf(BARO_EXP);
        Self::new(altitude_m, station, temperature_c, humidity)
    }

    /// The sea-level-corrected (barometric) pressure equivalent to this station pressure.
    pub fn baro_pressure_pa(&self) -> f64 {
        self.pressure_pa / (1.0 - LAPSE * self.altitude_m / T0_K).powf(BARO_EXP)
    }

    pub fn validate(&self) -> Result<(), BallisticsError> {
        finite(self.altitude_m, "altitude")?;
        require(
            self.pressure_pa.is_finite() && self.pressure_pa > 1_000.0 && self.pressure_pa < 200_000.0,
            format!("pressure must be between 1 kPa and 200 kPa (got {} Pa)", self.pressure_pa),
        )?;
        require(
            self.temperature_c.is_finite() && self.temperature_c > -100.0 && self.temperature_c < 80.0,
            format!("temperature must be between -100 and 80 °C (got {})", self.temperature_c),
        )?;
        require(
            self.humidity.is_finite() && (0.0..=1.0).contains(&self.humidity),
            format!("humidity must be between 0 and 1 (got {})", self.humidity),
        )
    }

    #[inline]
    pub fn temperature_k(&self) -> f64 {
        self.temperature_c + KELVIN
    }

    /// Moist air density (kg/m³).
    pub fn density(&self) -> f64 {
        let t = self.temperature_k();
        let pv = self.humidity.clamp(0.0, 1.0) * saturation_vapor_pressure_pa(self.temperature_c);
        (self.pressure_pa - pv) / (R_DRY * t) + pv / (R_VAPOR * t)
    }

    /// Speed of sound (m/s). Humidity has a sub-0.3 % effect and is ignored.
    pub fn speed_of_sound(&self) -> f64 {
        (GAMMA * R_DRY * self.temperature_k()).sqrt()
    }

    /// The atmosphere `dh` metres above (negative: below) this one, following the ISA lapse
    /// rate from the local conditions. Relative humidity is held constant.
    pub fn at_height(&self, dh: f64) -> Atmosphere {
        let t0 = self.temperature_k();
        let t1 = (t0 - LAPSE * dh).max(150.0);
        Atmosphere {
            altitude_m: self.altitude_m + dh,
            pressure_pa: self.pressure_pa * (t1 / t0).powf(BARO_EXP),
            temperature_c: t1 - KELVIN,
            humidity: self.humidity,
        }
    }

    /// Density altitude: the ISA altitude that has the same air density (m).
    pub fn density_altitude_m(&self) -> f64 {
        let ratio = self.density() / ISA_DENSITY;
        T0_K / LAPSE * (1.0 - ratio.powf(1.0 / (BARO_EXP - 1.0)))
    }
}
