//! Point-mass (3-DOF) trajectory solver with RK4 integration.
//!
//! Forces integrated along the path: aerodynamic drag on the air-relative velocity (so head,
//! tail and cross winds and gusts all act naturally), gravity (optionally pointing at the Earth's
//! centre for curvature), and the full Coriolis acceleration (horizontal Coriolis and the
//! vertical Eötvös component). Spin drift and aerodynamic jump use Litz's empirical models,
//! because a point-mass model has no spin axis to compute them from.

use core::f64::consts::PI;

use serde::{Deserialize, Serialize};

use crate::atmosphere::Atmosphere;
use crate::drag::PreparedDrag;
use crate::error::{finite, positive, require, BallisticsError};
use crate::math::Vec3;
use crate::projectile::{aero_jump_rad_per_mps, litz_spin_drift_m, miller_stability, Bullet, Load, Rifle};
use crate::units::{EARTH_RADIUS_M, EARTH_ROTATION_RAD_S, G0};
use crate::wind::{PreparedWind, WindField};

/// Physics effects that can be switched on and off (all on by default).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    pub spin_drift: bool,
    pub aero_jump: bool,
    /// Needs `latitude_deg` on the input; ignored without it.
    pub coriolis: bool,
    pub earth_curvature: bool,
    /// Vary temperature/pressure with height along the path (ISA lapse rate).
    pub atmosphere_along_path: bool,
}

impl Default for Effects {
    fn default() -> Self {
        Self { spin_drift: true, aero_jump: true, coriolis: true, earth_curvature: true, atmosphere_along_path: true }
    }
}

impl Effects {
    pub fn none() -> Self {
        Self { spin_drift: false, aero_jump: false, coriolis: false, earth_curvature: false, atmosphere_along_path: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Integration {
    /// RK4 time step (s).
    pub step_s: f64,
    /// Stop after this flight time (s).
    pub max_time_s: f64,
    /// Stop when the bullet slows below this speed (m/s).
    pub min_speed_mps: f64,
}

impl Default for Integration {
    fn default() -> Self {
        Self { step_s: 0.0005, max_time_s: 20.0, min_speed_mps: 30.0 }
    }
}

/// How the rifle was zeroed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZeroSpec {
    /// Zero distance (m), level shot, no wind.
    pub range_m: f64,
    /// Point of impact above the point of aim at the zero distance (m). Usually 0.
    #[serde(default)]
    pub offset_m: f64,
    /// Conditions at zeroing. `None` = the same as the current shot.
    #[serde(default)]
    pub atmosphere: Option<Atmosphere>,
    /// Powder temperature at zeroing. `None` = zero atmosphere temperature.
    #[serde(default)]
    pub powder_temp_c: Option<f64>,
}

/// Everything needed to compute a trajectory.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotInput {
    pub bullet: Bullet,
    pub rifle: Rifle,
    pub load: Load,
    pub atmosphere: Atmosphere,
    /// Ammunition temperature. `None` = air temperature.
    #[serde(default)]
    pub powder_temp_c: Option<f64>,
    pub zero: ZeroSpec,
    #[serde(default)]
    pub wind: WindField,
    /// Line-of-sight angle to the target: positive uphill, negative downhill (degrees).
    #[serde(default)]
    pub look_angle_deg: f64,
    /// Azimuth of fire, degrees clockwise from true north (for Coriolis).
    #[serde(default)]
    pub azimuth_deg: f64,
    /// Shooter latitude, degrees (+N / -S). Needed for Coriolis.
    #[serde(default)]
    pub latitude_deg: Option<f64>,
    /// Rifle cant, degrees clockwise as seen by the shooter.
    #[serde(default)]
    pub cant_deg: f64,
    #[serde(default)]
    pub effects: Effects,
    #[serde(default)]
    pub integration: Integration,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpec {
    /// Last range in the table (line-of-sight distance, m).
    pub max_range_m: f64,
    /// Row spacing (m).
    pub step_m: f64,
    /// If set, also return the 3-D path sampled every this many metres (for plots/bullet cam).
    #[serde(default)]
    pub path_step_m: Option<f64>,
}

/// One row of a trajectory table. Ranges are line-of-sight (slant) distances.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryRow {
    pub range_m: f64,
    /// Horizontal distance downrange (m).
    pub horizontal_m: f64,
    /// Height above the shooter's eye (m).
    pub height_m: f64,
    pub time_s: f64,
    /// Ground-relative speed (m/s).
    pub velocity_mps: f64,
    /// Air-relative Mach number.
    pub mach: f64,
    pub energy_j: f64,
    /// Bullet position relative to the line of sight, perpendicular to it (m, + = above).
    pub drop_m: f64,
    /// Lateral position relative to the line of sight (m, + = right). Includes spin drift.
    pub windage_m: f64,
    /// Spin-drift part of `windage_m` (m).
    pub spin_drift_m: f64,
    /// Correction to dial or hold: + = up (mrad).
    pub elevation_mrad: f64,
    /// Correction to dial or hold: + = right (mrad).
    pub windage_mrad: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPoint {
    pub time_s: f64,
    pub x_m: f64,
    pub y_m: f64,
    pub z_m: f64,
    pub speed_mps: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Solution {
    pub rows: Vec<TrajectoryRow>,
    pub path: Vec<PathPoint>,
    pub muzzle_velocity_mps: f64,
    /// Bore angle above the line of sight produced by the zero (mrad).
    pub zero_elevation_mrad: f64,
    /// Miller gyroscopic stability at the muzzle.
    pub stability_sg: f64,
    /// Vertical deflection from aerodynamic jump with the current muzzle crosswind (mrad).
    pub aero_jump_mrad: f64,
    pub air_density_kg_m3: f64,
    pub speed_of_sound_mps: f64,
    pub density_altitude_m: f64,
    /// Range where the bullet slows below Mach 1.2 (enters the transonic region).
    pub transonic_range_m: Option<f64>,
    /// Range where the bullet slows below Mach 1.0.
    pub subsonic_range_m: Option<f64>,
    pub warnings: Vec<String>,
}

/// Per-shot parameters on top of the nominal setup (dial, variations, time).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShotParams {
    /// Elevation dialed or held above the zero (rad).
    pub elevation_rad: f64,
    /// Windage dialed or held (rad, + = right).
    pub windage_rad: f64,
    /// Muzzle velocity change from nominal (m/s).
    pub mv_delta_mps: f64,
    /// BC multiplier (1 = nominal).
    pub bc_scale: f64,
    /// Time of the shot within the wind/gust timeline (s).
    pub time_offset_s: f64,
}

impl Default for ShotParams {
    fn default() -> Self {
        Self { elevation_rad: 0.0, windage_rad: 0.0, mv_delta_mps: 0.0, bc_scale: 1.0, time_offset_s: 0.0 }
    }
}

#[derive(Clone, Copy, Debug)]
struct State {
    t: f64,
    p: Vec3,
    v: Vec3,
}

/// Orthonormal frame of the line of sight and the (possibly canted) scope.
#[derive(Clone, Copy, Debug)]
struct Frame {
    los: Vec3,
    /// Up, perpendicular to the LOS, in the vertical plane.
    n: Vec3,
    /// Right, horizontal.
    r: Vec3,
    /// Scope up / right axes after cant.
    up_s: Vec3,
    right_s: Vec3,
}

impl Frame {
    fn new(look_rad: f64, cant_rad: f64) -> Self {
        let los = Vec3::new(look_rad.cos(), look_rad.sin(), 0.0);
        let n = Vec3::new(-look_rad.sin(), look_rad.cos(), 0.0);
        let r = Vec3::new(0.0, 0.0, 1.0);
        let up_s = n * cant_rad.cos() + r * cant_rad.sin();
        let right_s = r * cant_rad.cos() - n * cant_rad.sin();
        Self { los, n, r, up_s, right_s }
    }
}

struct Env {
    rho: f64,
    c: f64,
    wind: Vec3,
}

struct Model {
    drag: PreparedDrag,
    atm: Atmosphere,
    along_path: bool,
    rho: f64,
    sound: f64,
    wind: Option<PreparedWind>,
    time_offset: f64,
    omega: Option<Vec3>,
    curvature: bool,
    earth_r: f64,
}

impl Model {
    #[inline]
    fn air(&self, p: Vec3) -> (f64, f64) {
        if self.along_path {
            let a = self.atm.at_height(p.y);
            (a.density(), a.speed_of_sound())
        } else {
            (self.rho, self.sound)
        }
    }


    /// Air density, speed of sound and wind at a state. Evaluated once per step: across one
    /// 0.5 ms step they change by ~1e-4 relative, far below the solver's error budget.
    #[inline]
    fn env(&self, s: &State) -> Env {
        let (rho, c) = self.air(s.p);
        let wind = match &self.wind {
            Some(w) => w.at(s.p.x, s.t + self.time_offset),
            None => Vec3::ZERO,
        };
        Env { rho, c, wind }
    }

    #[inline]
    fn mach(s: &State, e: &Env) -> f64 {
        (s.v - e.wind).norm() / e.c
    }

    #[inline]
    fn accel(&self, p: Vec3, v: Vec3, env: &Env) -> Vec3 {
        let vr = v - env.wind;
        let speed = vr.norm();
        let k = env.rho * self.drag.cd(speed / env.c) * PI / (8.0 * self.drag.bc_si(speed));
        let mut a = vr * (-k * speed);
        if self.curvature {
            let to_center = Vec3::new(-p.x, -self.earth_r - p.y, -p.z);
            a += to_center.normalized() * G0;
        } else {
            a += Vec3::new(0.0, -G0, 0.0);
        }
        if let Some(om) = self.omega {
            a += om.cross(v) * -2.0;
        }
        a
    }

    fn step(&self, s: &State, env: &Env, dt: f64) -> State {
        let h = dt * 0.5;
        let k1v = self.accel(s.p, s.v, env);
        let k1p = s.v;
        let k2v = self.accel(s.p + k1p * h, s.v + k1v * h, env);
        let k2p = s.v + k1v * h;
        let k3v = self.accel(s.p + k2p * h, s.v + k2v * h, env);
        let k3p = s.v + k2v * h;
        let k4v = self.accel(s.p + k3p * dt, s.v + k3v * dt, env);
        let k4p = s.v + k3v * dt;
        State {
            t: s.t + dt,
            p: s.p + (k1p + k2p * 2.0 + k3p * 2.0 + k4p) * (dt / 6.0),
            v: s.v + (k1v + k2v * 2.0 + k3v * 2.0 + k4v) * (dt / 6.0),
        }
    }
}

struct Crossing {
    range: f64,
    s: State,
    mach: f64,
}

#[derive(Default)]
struct FlightOut {
    crossings: Vec<Crossing>,
    path: Vec<PathPoint>,
    transonic: Option<f64>,
    subsonic: Option<f64>,
}

fn lerp_state(a: &State, b: &State, f: f64) -> State {
    State { t: a.t + (b.t - a.t) * f, p: Vec3::lerp(a.p, b.p, f), v: Vec3::lerp(a.v, b.v, f) }
}

/// Integrate from `start`, recording the state where the projection on the line of sight
/// passes each of the (ascending) `checkpoints`.
fn fly(
    model: &Model,
    frame: &Frame,
    start: State,
    checkpoints: &[f64],
    path_step: Option<f64>,
    integ: &Integration,
) -> FlightOut {
    let mut out = FlightOut::default();
    let mut st = start;
    let mut idx = 0;
    let mut env = model.env(&st);
    let mut mach_prev = Model::mach(&st, &env);
    let mut next_path = 0.0;
    if let Some(_) = path_step {
        out.path.push(path_point(&st));
    }
    while idx < checkpoints.len() {
        if st.t > integ.max_time_s || st.v.norm() < integ.min_speed_mps {
            break;
        }
        let next = model.step(&st, &env, integ.step_s);
        let env_next = model.env(&next);
        let s0 = st.p.dot(frame.los);
        let s1 = next.p.dot(frame.los);
        let mach_next = Model::mach(&next, &env_next);
        if s1 > s0 {
            let inv = 1.0 / (s1 - s0);
            while idx < checkpoints.len() && checkpoints[idx] <= s1 {
                let f = ((checkpoints[idx] - s0) * inv).clamp(0.0, 1.0);
                out.crossings.push(Crossing {
                    range: checkpoints[idx],
                    s: lerp_state(&st, &next, f),
                    mach: mach_prev + (mach_next - mach_prev) * f,
                });
                idx += 1;
            }
            for (limit, slot) in [(1.2, &mut out.transonic), (1.0, &mut out.subsonic)] {
                if slot.is_none() && mach_prev >= limit && mach_next < limit {
                    let f = (mach_prev - limit) / (mach_prev - mach_next);
                    *slot = Some(s0 + (s1 - s0) * f);
                }
            }
            if let Some(ps) = path_step {
                if s1 >= next_path + ps {
                    out.path.push(path_point(&next));
                    next_path = s1;
                }
            }
        } else if next.v.dot(frame.los) <= 0.0 {
            break; // no longer moving downrange
        }
        st = next;
        env = env_next;
        mach_prev = mach_next;
    }
    out
}

fn path_point(s: &State) -> PathPoint {
    PathPoint { time_s: s.t, x_m: s.p.x, y_m: s.p.y, z_m: s.p.z, speed_mps: s.v.norm() }
}

/// A prepared solver: validated input, nominal muzzle velocity, zero angle and stability.
pub struct Solver {
    input: ShotInput,
    muzzle_velocity: f64,
    zero_elevation: f64,
    sg: f64,
    jump_coef: f64,
}

impl Solver {
    pub fn new(input: ShotInput) -> Result<Self, BallisticsError> {
        validate(&input)?;
        let powder_t = input.powder_temp_c.unwrap_or(input.atmosphere.temperature_c);
        let mv = input.load.muzzle_velocity(input.rifle.barrel_length_m, powder_t);
        positive(mv, "muzzle velocity after barrel/temperature corrections")?;
        let sg = miller_stability(&input.bullet, &input.rifle, mv, &input.atmosphere);
        let jump_coef = aero_jump_rad_per_mps(sg, &input.bullet) * input.rifle.twist_direction.sign();
        let mut solver = Self { input, muzzle_velocity: mv, zero_elevation: 0.0, sg, jump_coef };
        solver.zero_elevation = solver.find_zero()?;
        Ok(solver)
    }

    pub fn input(&self) -> &ShotInput {
        &self.input
    }
    pub fn muzzle_velocity(&self) -> f64 {
        self.muzzle_velocity
    }
    pub fn stability(&self) -> f64 {
        self.sg
    }
    /// Bore angle above the line of sight for the zero (rad).
    pub fn zero_elevation(&self) -> f64 {
        self.zero_elevation
    }

    fn earth_r(&self) -> f64 {
        EARTH_RADIUS_M + self.input.atmosphere.altitude_m
    }

    fn find_zero(&self) -> Result<f64, BallisticsError> {
        let z = &self.input.zero;
        let atm = z.atmosphere.unwrap_or(self.input.atmosphere);
        let mv = if z.atmosphere.is_some() || z.powder_temp_c.is_some() {
            let t = z.powder_temp_c.unwrap_or(atm.temperature_c);
            self.input.load.muzzle_velocity(self.input.rifle.barrel_length_m, t)
        } else {
            self.muzzle_velocity
        };
        let b = &self.input.bullet;
        let model = Model {
            drag: PreparedDrag::new(&b.drag, b.mass_kg, b.diameter_m, 1.0)?,
            atm,
            along_path: self.input.effects.atmosphere_along_path,
            rho: atm.density(),
            sound: atm.speed_of_sound(),
            wind: None,
            time_offset: 0.0,
            omega: None,
            curvature: self.input.effects.earth_curvature,
            earth_r: self.earth_r(),
        };
        let frame = Frame::new(0.0, 0.0);
        let r = z.range_m;
        let mut e: f64 = 0.0;
        for _ in 0..50 {
            let dir = (frame.los + frame.up_s * e.tan()).normalized();
            let start = State { t: 0.0, p: frame.up_s * -self.input.rifle.sight_height_m, v: dir * mv };
            let out = fly(&model, &frame, start, &[r], None, &self.input.integration);
            let c = out.crossings.first().ok_or_else(|| {
                BallisticsError::ZeroNotFound(format!("the bullet does not reach the zero range of {r} m"))
            })?;
            let miss = c.s.p.dot(frame.n) - z.offset_m;
            if miss.abs() < 1e-7 {
                return Ok(e);
            }
            e -= (miss / r).atan();
            require(e.abs() < 0.5, "zero angle diverged")
                .map_err(|_| BallisticsError::ZeroNotFound("bore angle diverged".into()))?;
        }
        Err(BallisticsError::ZeroNotFound("zero iteration did not converge".into()))
    }

    fn model(&self, params: &ShotParams) -> Result<Model, BallisticsError> {
        let i = &self.input;
        let b = &i.bullet;
        let omega = match (i.effects.coriolis, i.latitude_deg) {
            (true, Some(lat)) => {
                let (phi, az) = (lat.to_radians(), i.azimuth_deg.to_radians());
                let w = EARTH_ROTATION_RAD_S;
                Some(Vec3::new(w * phi.cos() * az.cos(), w * phi.sin(), -w * phi.cos() * az.sin()))
            }
            _ => None,
        };
        Ok(Model {
            drag: PreparedDrag::new(&b.drag, b.mass_kg, b.diameter_m, params.bc_scale)?,
            atm: i.atmosphere,
            along_path: i.effects.atmosphere_along_path,
            rho: i.atmosphere.density(),
            sound: i.atmosphere.speed_of_sound(),
            wind: Some(PreparedWind::new(&i.wind)).filter(|w| !w.is_calm()),
            time_offset: params.time_offset_s,
            omega,
            curvature: i.effects.earth_curvature,
            earth_r: self.earth_r(),
        })
    }

    /// Aerodynamic jump angle for the muzzle crosswind at the given time (rad, + = up).
    fn aero_jump(&self, time_offset: f64) -> f64 {
        if !self.input.effects.aero_jump {
            return 0.0;
        }
        self.input.wind.at(0.0, time_offset).z * self.jump_coef
    }

    fn fly_shot(
        &self,
        params: &ShotParams,
        checkpoints: &[f64],
        path_step: Option<f64>,
    ) -> Result<(FlightOut, Frame), BallisticsError> {
        let i = &self.input;
        positive(params.bc_scale, "BC scale")?;
        let model = self.model(params)?;
        let frame = Frame::new(i.look_angle_deg.to_radians(), i.cant_deg.to_radians());
        let e = self.zero_elevation + params.elevation_rad;
        let jump = self.aero_jump(params.time_offset_s);
        let dir = (frame.los + frame.up_s * e.tan() + frame.right_s * params.windage_rad.tan() + frame.n * jump.tan())
            .normalized();
        let mv = self.muzzle_velocity + params.mv_delta_mps;
        positive(mv, "muzzle velocity")?;
        let start = State { t: 0.0, p: frame.up_s * -i.rifle.sight_height_m, v: dir * mv };
        Ok((fly(&model, &frame, start, checkpoints, path_step, &i.integration), frame))
    }

    fn row(&self, c: &Crossing, frame: &Frame) -> TrajectoryRow {
        let drift = if self.input.effects.spin_drift {
            litz_spin_drift_m(self.sg, c.s.t) * self.input.rifle.twist_direction.sign()
        } else {
            0.0
        };
        let drop = c.s.p.dot(frame.n);
        let windage = c.s.p.dot(frame.r) + drift;
        let speed = c.s.v.norm();
        let (elev, wind) = if c.range > 0.0 {
            (-(drop / c.range).atan() * 1000.0, -(windage / c.range).atan() * 1000.0)
        } else {
            (0.0, 0.0)
        };
        TrajectoryRow {
            range_m: c.range,
            horizontal_m: c.s.p.x,
            height_m: c.s.p.y,
            time_s: c.s.t,
            velocity_mps: speed,
            mach: c.mach,
            energy_j: 0.5 * self.input.bullet.mass_kg * speed * speed,
            drop_m: drop,
            windage_m: windage,
            spin_drift_m: drift,
            elevation_mrad: elev,
            windage_mrad: wind,
        }
    }

    /// Trajectory table for the nominal shot (no dial, no variation).
    pub fn table(&self, spec: &TableSpec) -> Result<Solution, BallisticsError> {
        positive(spec.max_range_m, "table max range")?;
        positive(spec.step_m, "table step")?;
        require(spec.max_range_m / spec.step_m <= 20_000.0, "table has too many rows")?;
        if let Some(p) = spec.path_step_m {
            positive(p, "path step")?;
        }
        let n = (spec.max_range_m / spec.step_m + 1e-9).floor() as usize;
        let checkpoints: Vec<f64> = (0..=n).map(|k| k as f64 * spec.step_m).collect();
        let params = ShotParams::default();
        let (out, frame) = self.fly_shot(&params, &checkpoints, spec.path_step_m)?;
        let rows: Vec<TrajectoryRow> = out.crossings.iter().map(|c| self.row(c, &frame)).collect();

        let atm = &self.input.atmosphere;
        let mut warnings = Vec::new();
        if self.sg < 1.0 {
            warnings.push(format!(
                "Unstable bullet (Sg = {:.2}): expect tumbling and keyholing. Use a faster twist.",
                self.sg
            ));
        } else if self.sg < 1.4 {
            warnings.push(format!(
                "Marginal stability (Sg = {:.2} < 1.4): expect reduced BC and larger groups.",
                self.sg
            ));
        }
        if rows.len() < checkpoints.len() {
            let last = rows.last().map_or(0.0, |r| r.range_m);
            warnings.push(format!("The bullet stops being tracked after {last:.0} m (too slow or time limit)."));
        }
        if let Some(s) = out.subsonic {
            warnings.push(format!(
                "The bullet goes subsonic at {s:.0} m. Past the transonic zone dispersion grows and data is less reliable."
            ));
        }
        if self.input.effects.coriolis && self.input.latitude_deg.is_none() {
            warnings.push("Coriolis is on but no latitude was given, so it was not applied.".into());
        }

        Ok(Solution {
            rows,
            path: out.path,
            muzzle_velocity_mps: self.muzzle_velocity,
            zero_elevation_mrad: self.zero_elevation * 1000.0,
            stability_sg: self.sg,
            aero_jump_mrad: self.aero_jump(0.0) * 1000.0,
            air_density_kg_m3: atm.density(),
            speed_of_sound_mps: atm.speed_of_sound(),
            density_altitude_m: atm.density_altitude_m(),
            transonic_range_m: out.transonic,
            subsonic_range_m: out.subsonic,
            warnings,
        })
    }

    /// Fly one shot with the given parameters and return the state at `range_m` (line of sight),
    /// or `None` if the bullet never gets there.
    pub fn impact(&self, range_m: f64, params: &ShotParams) -> Result<Option<TrajectoryRow>, BallisticsError> {
        positive(range_m, "range")?;
        let (out, frame) = self.fly_shot(params, &[range_m], None)?;
        Ok(out.crossings.first().map(|c| self.row(c, &frame)))
    }
}

fn validate(i: &ShotInput) -> Result<(), BallisticsError> {
    i.bullet.validate()?;
    i.rifle.validate()?;
    i.load.validate()?;
    i.atmosphere.validate()?;
    if let Some(a) = &i.zero.atmosphere {
        a.validate()?;
    }
    i.wind.validate()?;
    positive(i.zero.range_m, "zero range")?;
    finite(i.zero.offset_m, "zero offset")?;
    require(i.look_angle_deg.is_finite() && i.look_angle_deg.abs() < 80.0, "look angle must be within ±80°")?;
    finite(i.azimuth_deg, "azimuth")?;
    finite(i.cant_deg, "cant")?;
    if let Some(l) = i.latitude_deg {
        require(l.is_finite() && l.abs() <= 90.0, "latitude must be within ±90°")?;
    }
    require(
        i.integration.step_s.is_finite() && i.integration.step_s > 1e-6 && i.integration.step_s <= 0.01,
        "integration step must be between 1 µs and 10 ms",
    )?;
    positive(i.integration.max_time_s, "max flight time")?;
    require(i.integration.min_speed_mps.is_finite() && i.integration.min_speed_mps >= 0.0, "min speed must be >= 0")
}

/// Convenience: build a solver and compute a table in one call.
pub fn solve(input: ShotInput, spec: &TableSpec) -> Result<Solution, BallisticsError> {
    Solver::new(input)?.table(spec)
}
