//! Long-range small-arms exterior ballistics core.
//!
//! Everything in this crate is in SI units (metres, seconds, kilograms, pascals, kelvin/celsius,
//! radians internally). Unit conversion for display belongs in the presentation layer; the
//! constants in [`units`] help with that.
//!
//! The crate has no graphics or platform dependencies, so it can be unit-tested natively and
//! compiled to WebAssembly unchanged (see the `ballistics-wasm` crate).
//!
//! Coordinate frame used by the solver (right-handed):
//! * `x`: horizontal, downrange (along the shot azimuth)
//! * `y`: up (opposite to gravity at the shooter)
//! * `z`: horizontal, to the shooter's right
//!
//! The shooter's eye (scope centre) is the origin.

pub mod atmosphere;
pub mod drag;
pub mod error;
pub mod math;
pub mod projectile;
pub mod rng;
pub mod shot;
pub mod solver;
pub mod units;
pub mod wind;

pub use atmosphere::Atmosphere;
pub use drag::{BcBand, DragModel, MachCd, StandardTable};
pub use error::BallisticsError;
pub use math::Vec3;
pub use projectile::{Bullet, Load, Rifle, TwistDirection};
pub use shot::{fire_group, GroupResult, GroupSpec, Impact};
pub use solver::{
    solve, Effects, Integration, PathPoint, ShotInput, ShotParams, Solution, Solver, TableSpec,
    TrajectoryRow, ZeroSpec,
};
pub use wind::{Gusts, WindField, WindZone};
