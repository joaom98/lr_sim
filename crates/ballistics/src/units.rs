//! Physical constants and unit conversion factors (multiply to convert *to* SI).

use core::f64::consts::PI;

pub const GRAIN_KG: f64 = 6.479_891e-5;
pub const INCH_M: f64 = 0.0254;
pub const FOOT_M: f64 = 0.3048;
pub const YARD_M: f64 = 0.9144;
pub const MPH_MPS: f64 = 0.447_04;
pub const INHG_PA: f64 = 3_386.389;
pub const FOOT_POUND_J: f64 = 1.355_818;

/// Ballistic coefficient conversion: lb/in² → kg/m².
pub const BC_LB_IN2_TO_KG_M2: f64 = 703.069_58;

/// One minute of angle in radians.
pub const MOA_RAD: f64 = PI / (180.0 * 60.0);
/// One milliradian in radians.
pub const MIL_RAD: f64 = 0.001;

/// Standard gravity (m/s²).
pub const G0: f64 = 9.806_65;
/// Mean Earth radius (m).
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;
/// Sidereal rotation rate of the Earth (rad/s).
pub const EARTH_ROTATION_RAD_S: f64 = 7.292_115e-5;

#[inline]
pub fn c_to_f(c: f64) -> f64 {
    c * 9.0 / 5.0 + 32.0
}
