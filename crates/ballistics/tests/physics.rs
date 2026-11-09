//! Physics checks: analytic solutions, standard-atmosphere constants, the direction and size
//! of every effect, internal consistency, determinism and the JSON API contract.

use ballistics::units::*;
use ballistics::*;

fn approx(a: f64, b: f64, tol: f64, what: &str) {
    assert!((a - b).abs() <= tol, "{what}: got {a}, expected {b} ± {tol}");
}

/// .308-class 175 gr match bullet, 24" 1:10 barrel, 100 m zero, ICAO air, everything off.
fn base() -> ShotInput {
    ShotInput {
        bullet: Bullet {
            mass_kg: 175.0 * GRAIN_KG,
            diameter_m: 0.308 * INCH_M,
            length_m: 1.24 * INCH_M,
            drag: DragModel::g7(0.243),
        },
        rifle: Rifle {
            sight_height_m: 0.04,
            twist_m: 10.0 * INCH_M,
            twist_direction: TwistDirection::Right,
            barrel_length_m: 24.0 * INCH_M,
        },
        load: Load {
            muzzle_velocity_mps: 790.0,
            reference_barrel_length_m: None,
            velocity_per_barrel_m: 0.0,
            powder_temp_sensitivity: 0.0,
            reference_powder_temp_c: 15.0,
            mv_sd_mps: 0.0,
            bc_sd_fraction: 0.0,
        },
        atmosphere: Atmosphere::icao(),
        powder_temp_c: None,
        zero: ZeroSpec { range_m: 100.0, offset_m: 0.0, atmosphere: None, powder_temp_c: None },
        wind: WindField::default(),
        look_angle_deg: 0.0,
        azimuth_deg: 0.0,
        latitude_deg: None,
        cant_deg: 0.0,
        effects: Effects::none(),
        integration: Integration::default(),
    }
}

fn row_at(input: ShotInput, range: f64) -> TrajectoryRow {
    let sol = solve(input, &TableSpec { max_range_m: range, step_m: range, path_step_m: None }).unwrap();
    *sol.rows.last().unwrap()
}

// ---------- atmosphere ----------

#[test]
fn icao_sea_level_constants() {
    let a = Atmosphere::icao();
    approx(a.density(), 1.2250, 0.0005, "ICAO density");
    approx(a.speed_of_sound(), 340.29, 0.05, "ICAO speed of sound");
    approx(a.density_altitude_m(), 0.0, 5.0, "ICAO density altitude");
}

#[test]
fn army_standard_metro_density() {
    // 0.0751 lb/ft³
    approx(Atmosphere::army_standard_metro().density(), 0.0751 * 16.018_46, 0.002, "ASM density");
}

#[test]
fn isa_altitude_and_density_altitude() {
    let a = Atmosphere::icao_at_altitude(2000.0);
    approx(a.pressure_pa, 79_495.0, 30.0, "ISA pressure at 2000 m");
    approx(a.temperature_c, 2.0, 0.01, "ISA temperature at 2000 m");
    approx(a.density_altitude_m(), 2000.0, 10.0, "density altitude of ISA 2000 m");
    // Hot day at sea level has a positive density altitude.
    assert!(Atmosphere::new(0.0, 101_325.0, 35.0, 0.5).density_altitude_m() > 600.0);
}

#[test]
fn station_and_baro_pressure_round_trip() {
    let a = Atmosphere::from_baro(1500.0, 101_325.0, 15.0, 0.0);
    approx(a.pressure_pa, 84_556.0, 60.0, "station pressure at 1500 m");
    approx(a.baro_pressure_pa(), 101_325.0, 0.01, "baro round trip");
}

#[test]
fn humid_air_is_lighter() {
    let dry = Atmosphere::new(0.0, 101_325.0, 30.0, 0.0);
    let wet = Atmosphere::new(0.0, 101_325.0, 30.0, 1.0);
    assert!(wet.density() < dry.density());
}

// ---------- solver correctness ----------

#[test]
fn vacuum_trajectory_matches_closed_form() {
    let mut i = base();
    i.bullet.drag = DragModel::Custom { points: vec![MachCd { mach: 0.0, cd: 0.0 }, MachCd { mach: 5.0, cd: 0.0 }] };
    let solver = Solver::new(i).unwrap();
    let e = solver.zero_elevation();
    let (v, h) = (790.0, 0.04);
    let sol = solver.table(&TableSpec { max_range_m: 1000.0, step_m: 250.0, path_step_m: None }).unwrap();
    for r in &sol.rows[1..] {
        let x = r.range_m;
        let y = -h + x * e.tan() - G0 * x * x / (2.0 * v * v * e.cos() * e.cos());
        approx(r.drop_m, y, 1e-6, "vacuum drop");
        approx(r.time_s, x / (v * e.cos()), 1e-9, "vacuum time");
    }
    // Analytic zero: the parabola passes through (100, 0).
    let y100 = -h + 100.0 * e.tan() - G0 * 1e4 / (2.0 * v * v * e.cos().powi(2));
    approx(y100, 0.0, 1e-6, "vacuum zero");
}

#[test]
fn zero_is_hit_exactly() {
    let r = row_at(base(), 100.0);
    approx(r.drop_m, 0.0, 1e-6, "drop at zero range");
    let mut i = base();
    i.zero.offset_m = 0.05;
    approx(row_at(i, 100.0).drop_m, 0.05, 1e-6, "drop at zero range with offset");
}

#[test]
fn integration_step_has_converged() {
    let mut fine = base();
    fine.integration.step_s = 0.0001;
    let a = row_at(base(), 1500.0);
    let b = row_at(fine, 1500.0);
    approx(a.elevation_mrad, b.elevation_mrad, 0.005, "elevation at 1500 m vs 5x smaller step");
    approx(a.time_s, b.time_s, 1e-4, "time of flight");
}

#[test]
fn custom_curve_equal_to_scaled_g7_matches_g7() {
    // Cd_bullet = i * Cd_G7 with form factor i = SD / BC reproduces the BC model exactly.
    let i_std = base();
    let sd = i_std.bullet.mass_kg / i_std.bullet.diameter_m.powi(2) / BC_LB_IN2_TO_KG_M2;
    let form = sd / 0.243;
    let mut i_custom = base();
    i_custom.bullet.drag = DragModel::Custom {
        points: ballistics::drag::G7_TABLE.iter().map(|&(m, cd)| MachCd { mach: m, cd: cd * form }).collect(),
    };
    let a = row_at(i_std, 1200.0);
    let b = row_at(i_custom, 1200.0);
    approx(a.drop_m, b.drop_m, 1e-6, "custom vs G7 drop");
}

#[test]
fn single_band_equals_plain_bc_and_higher_low_speed_bc_helps() {
    let plain = row_at(base(), 1000.0);
    let mut one_band = base();
    one_band.bullet.drag = DragModel::Standard {
        table: StandardTable::G7,
        bc: 0.0,
        bands: vec![BcBand { min_velocity_mps: 0.0, bc: 0.243 }],
    };
    approx(row_at(one_band, 1000.0).drop_m, plain.drop_m, 1e-9, "single band");
    let mut banded = base();
    banded.bullet.drag = DragModel::Standard {
        table: StandardTable::G7,
        bc: 0.0,
        bands: vec![BcBand { min_velocity_mps: 600.0, bc: 0.243 }, BcBand { min_velocity_mps: 0.0, bc: 0.260 }],
    };
    assert!(row_at(banded, 1000.0).drop_m > plain.drop_m, "higher low-speed BC should drop less");
}

#[test]
fn transonic_and_subsonic_ranges_are_reported_in_order() {
    let sol = solve(base(), &TableSpec { max_range_m: 1500.0, step_m: 100.0, path_step_m: None }).unwrap();
    let (t, s) = (sol.transonic_range_m.unwrap(), sol.subsonic_range_m.unwrap());
    assert!(t < s && s < 1500.0, "transonic {t} subsonic {s}");
    let at = |r: f64| sol.rows.iter().find(|x| x.range_m >= r).unwrap().mach;
    assert!(at(s - 100.0) > 1.0 && at(s + 100.0) < 1.0);
    assert!(sol.warnings.iter().any(|w| w.contains("subsonic")));
}

// ---------- stability, spin and jump ----------

#[test]
fn miller_stability_for_308_175() {
    let s = Solver::new(base()).unwrap().stability();
    assert!((2.2..2.6).contains(&s), "Sg = {s}");
    let mut slow = base();
    slow.rifle.twist_m = 16.0 * INCH_M;
    let sol = solve(slow, &TableSpec { max_range_m: 300.0, step_m: 100.0, path_step_m: None }).unwrap();
    assert!(sol.stability_sg < 1.0);
    assert!(sol.warnings.iter().any(|w| w.contains("Unstable")));
}

#[test]
fn spin_drift_follows_twist_and_litz_formula() {
    let mut i = base();
    i.effects.spin_drift = true;
    let r = row_at(i.clone(), 1000.0);
    let sg = Solver::new(i.clone()).unwrap().stability();
    approx(r.spin_drift_m, 1.25 * (sg + 1.2) * r.time_s.powf(1.83) * INCH_M, 1e-12, "Litz drift");
    assert!(r.windage_m > 0.0 && r.windage_mrad < 0.0, "right twist drifts right, correct left");
    i.rifle.twist_direction = TwistDirection::Left;
    assert!(row_at(i, 1000.0).windage_m < 0.0);
}

#[test]
fn aerodynamic_jump_direction() {
    let mut i = base();
    i.effects.aero_jump = true;
    i.wind = WindField::constant(5.0, 270.0); // from the left
    let from_left = row_at(i.clone(), 600.0);
    i.wind = WindField::constant(5.0, 90.0); // from the right
    let from_right = row_at(i.clone(), 600.0);
    assert!(from_left.drop_m > from_right.drop_m, "right twist: wind from left impacts high");
    let jump = Solver::new(i).unwrap().table(&TableSpec { max_range_m: 100.0, step_m: 100.0, path_step_m: None });
    assert!(jump.unwrap().aero_jump_mrad < 0.0);
}

// ---------- wind ----------

#[test]
fn crosswind_pushes_downwind() {
    let mut i = base();
    i.wind = WindField::constant(4.47, 90.0); // 10 mph from 3 o'clock
    let r = row_at(i, 1000.0);
    assert!(r.windage_m < 0.0 && r.windage_mrad > 0.0, "drifts left, dial right");
    // Classic lag-time rule: deflection = crosswind × (t − R / V0).
    let t = r.time_s;
    approx(-r.windage_m, 4.47 * (t - 1000.0 / 790.0), 0.02, "lag rule");
}

#[test]
fn headwind_drops_more_than_tailwind() {
    let mut i = base();
    i.wind = WindField::constant(10.0, 0.0);
    let head = row_at(i.clone(), 1000.0);
    i.wind = WindField::constant(10.0, 180.0);
    let tail = row_at(i, 1000.0);
    assert!(head.drop_m < tail.drop_m);
    approx(head.windage_m, 0.0, 1e-9, "no lateral drift from a headwind");
}

#[test]
fn near_wind_matters_more_than_far_wind() {
    let zones = |near: f64, far: f64| WindField {
        zones: vec![
            WindZone { until_m: Some(500.0), speed_mps: near, from_deg: 90.0 },
            WindZone { until_m: None, speed_mps: far, from_deg: 90.0 },
        ],
        gusts: None,
    };
    let mut i = base();
    i.wind = zones(4.0, 0.0);
    let near = row_at(i.clone(), 1000.0).windage_m.abs();
    i.wind = zones(0.0, 4.0);
    let far = row_at(i, 1000.0).windage_m.abs();
    assert!(near > far, "near {near} far {far}");
}

#[test]
fn gusts_change_with_time_and_are_deterministic() {
    let mut i = base();
    i.wind = WindField {
        zones: vec![WindZone { until_m: None, speed_mps: 4.0, from_deg: 90.0 }],
        gusts: Some(Gusts { intensity: 0.4, direction_variation_deg: 15.0, period_s: 5.0, correlation_length_m: 300.0, seed: 7 }),
    };
    let s = Solver::new(i).unwrap();
    let at = |t: f64| {
        s.impact(800.0, &ShotParams { time_offset_s: t, ..ShotParams::default() }).unwrap().unwrap().windage_m
    };
    assert_eq!(at(3.0), at(3.0));
    assert!((at(0.0) - at(13.0)).abs() > 0.01, "gusts should move the impact over time");
}

// ---------- earth ----------

#[test]
fn coriolis_direction_and_size() {
    let mut i = base();
    i.effects.coriolis = true;
    i.latitude_deg = Some(45.0);
    let ref_row = row_at(base(), 1000.0);
    let sol = solve(i.clone(), &TableSpec { max_range_m: 1000.0, step_m: 1000.0, path_step_m: Some(1.0) }).unwrap();
    let north = *sol.rows.last().unwrap();
    let dz = north.windage_m - ref_row.windage_m;
    // Point-mass flat fire: drag damps the lateral velocity, so v_z = 2Ω_v·t·v_x exactly and
    // z = 2Ω_v (X·T − ∫x dt). (In vacuum this reduces to the familiar Ω_v·X·T.)
    let path = &sol.path;
    let int_x: f64 = path.windows(2).map(|w| 0.5 * (w[0].x_m + w[1].x_m) * (w[1].time_s - w[0].time_s)).sum();
    let int_x = int_x + path.last().unwrap().x_m * (north.time_s - path.last().unwrap().time_s);
    let om_v = EARTH_ROTATION_RAD_S * 45f64.to_radians().sin();
    let expected = 2.0 * om_v * (north.horizontal_m * north.time_s - int_x);
    approx(dz, expected, expected * 0.02, "horizontal Coriolis, northern hemisphere deflects right");
    assert!(dz < om_v * 1000.0 * north.time_s, "drag makes it smaller than the vacuum value");

    i.azimuth_deg = 90.0;
    assert!(row_at(i.clone(), 1000.0).drop_m > ref_row.drop_m, "shooting east impacts high (Eötvös)");
    i.azimuth_deg = 270.0;
    assert!(row_at(i.clone(), 1000.0).drop_m < ref_row.drop_m, "shooting west impacts low");
    i.azimuth_deg = 0.0;
    i.latitude_deg = Some(-45.0);
    assert!(row_at(i, 1000.0).windage_m < ref_row.windage_m, "southern hemisphere deflects left");
}

#[test]
fn earth_curvature_is_small_but_present_at_extreme_range() {
    let mut i = base();
    i.bullet = Bullet {
        mass_kg: 750.0 * GRAIN_KG,
        diameter_m: 0.510 * INCH_M,
        length_m: 2.42 * INCH_M,
        drag: DragModel::g7(0.52),
    };
    i.rifle.twist_m = 15.0 * INCH_M;
    i.load.muzzle_velocity_mps = 860.0;
    let flat = row_at(i.clone(), 2500.0);
    i.effects.earth_curvature = true;
    let round = row_at(i, 2500.0);
    let d = (round.elevation_mrad - flat.elevation_mrad).abs();
    assert!(d > 0.0 && d < 0.5, "curvature effect {d} mrad");
}

#[test]
fn uphill_and_downhill_need_less_elevation() {
    let level = row_at(base(), 800.0).elevation_mrad;
    let mut up = base();
    up.look_angle_deg = 30.0;
    let mut down = base();
    down.look_angle_deg = -30.0;
    let (u, d) = (row_at(up, 800.0).elevation_mrad, row_at(down, 800.0).elevation_mrad);
    assert!(u < level && d < level, "level {level} up {u} down {d}");
    // Rifleman's rule gets within ~10 % for a modest angle.
    approx(u, level * 30f64.to_radians().cos(), level * 0.1, "rifleman's rule");
}

#[test]
fn atmosphere_along_path_changes_long_high_shots() {
    let mut i = base();
    i.look_angle_deg = 20.0;
    let fixed = row_at(i.clone(), 1500.0);
    i.effects.atmosphere_along_path = true;
    let varying = row_at(i, 1500.0);
    assert!(varying.drop_m > fixed.drop_m, "thinner air higher up means less drag");
}

#[test]
fn cant_moves_impact_toward_the_cant() {
    let mut i = base();
    i.cant_deg = 5.0; // clockwise
    let r = row_at(i, 800.0);
    assert!(r.windage_m > 0.0, "canting right moves impact right");
}

// ---------- loads ----------

#[test]
fn powder_temperature_and_barrel_length_change_velocity() {
    let mut i = base();
    i.load.powder_temp_sensitivity = 0.5;
    i.powder_temp_c = Some(35.0);
    approx(Solver::new(i.clone()).unwrap().muzzle_velocity(), 800.0, 1e-9, "hot ammo");
    i.powder_temp_c = None;
    i.load.reference_barrel_length_m = Some(0.66);
    i.load.velocity_per_barrel_m = 100.0;
    i.rifle.barrel_length_m = 0.56;
    approx(Solver::new(i).unwrap().muzzle_velocity(), 780.0, 1e-9, "short barrel");
}

#[test]
fn zeroing_in_cold_conditions_shifts_point_of_impact_on_a_hot_day() {
    let mut i = base();
    i.load.powder_temp_sensitivity = 0.6;
    i.atmosphere = Atmosphere::new(0.0, 101_325.0, 35.0, 0.3);
    i.zero.atmosphere = Some(Atmosphere::new(0.0, 101_325.0, 0.0, 0.3));
    let r = row_at(i, 100.0);
    assert!(r.drop_m > 0.0, "faster ammo and thinner air hit high at the zero range");
}

// ---------- groups and determinism ----------

fn varied() -> ShotInput {
    let mut i = base();
    i.load.mv_sd_mps = 3.0;
    i.load.bc_sd_fraction = 0.01;
    i
}

#[test]
fn groups_are_reproducible_by_seed() {
    let spec = GroupSpec {
        range_m: 900.0,
        dial_elevation_mrad: None,
        dial_windage_mrad: None,
        shots: 10,
        seed: 42,
        aim_sd_mrad: 0.05,
        interval_s: 8.0,
        start_time_s: 0.0,
    };
    let a = fire_group(varied(), &spec).unwrap();
    let b = fire_group(varied(), &spec).unwrap();
    assert_eq!(a, b);
    let c = fire_group(varied(), &GroupSpec { seed: 43, ..spec }).unwrap();
    assert_ne!(a.impacts, c.impacts);
    assert!(a.extreme_spread_m > 0.0 && a.mean_radius_m > 0.0);
}

#[test]
fn perfect_ammo_and_shooter_hit_the_point_of_aim() {
    let spec = GroupSpec {
        range_m: 900.0,
        dial_elevation_mrad: None,
        dial_windage_mrad: None,
        shots: 5,
        seed: 1,
        aim_sd_mrad: 0.0,
        interval_s: 8.0,
        start_time_s: 0.0,
    };
    let g = fire_group(base(), &spec).unwrap();
    for imp in &g.impacts {
        // Dialing is applied as an angle, so the small-angle approximation leaves ~mm residue.
        assert!(imp.vertical_m.abs() < 0.02 && imp.horizontal_m.abs() < 1e-9, "{imp:?}");
    }
    approx(g.extreme_spread_m, 0.0, 1e-9, "no dispersion");
}

#[test]
fn velocity_spread_shows_up_as_vertical_dispersion() {
    let mut i = base();
    i.load.mv_sd_mps = 5.0;
    let spec = GroupSpec {
        range_m: 1000.0,
        dial_elevation_mrad: None,
        dial_windage_mrad: None,
        shots: 30,
        seed: 9,
        aim_sd_mrad: 0.0,
        interval_s: 0.0,
        start_time_s: 0.0,
    };
    let g = fire_group(i, &spec).unwrap();
    let vs: f64 = g.impacts.iter().map(|x| x.vertical_m.abs()).sum();
    let hs: f64 = g.impacts.iter().map(|x| x.horizontal_m.abs()).sum();
    assert!(vs > 0.05 && hs < 1e-9);
}

// ---------- API contract ----------

#[test]
fn json_input_uses_camel_case_and_defaults() {
    let json = r#"{
        "bullet": { "massKg": 0.01134, "diameterM": 0.00782, "lengthM": 0.0315,
                    "drag": { "kind": "standard", "table": "G7", "bc": 0.243 } },
        "rifle": { "sightHeightM": 0.04, "twistM": 0.254, "twistDirection": "right", "barrelLengthM": 0.61 },
        "load": { "muzzleVelocityMps": 790 },
        "atmosphere": { "altitudeM": 0, "pressurePa": 101325, "temperatureC": 15, "humidity": 0 },
        "zero": { "rangeM": 100 },
        "wind": { "zones": [ { "speedMps": 4, "fromDeg": 90 } ] }
    }"#;
    let input: ShotInput = serde_json::from_str(json).unwrap();
    assert_eq!(input.effects, Effects::default());
    let sol = solve(input, &TableSpec { max_range_m: 500.0, step_m: 100.0, path_step_m: Some(25.0) }).unwrap();
    let out = serde_json::to_value(&sol).unwrap();
    assert!(out["rows"][5]["elevationMrad"].as_f64().unwrap() > 0.0);
    assert!(out["path"].as_array().unwrap().len() > 10);
}

#[test]
fn rejects_bad_input() {
    let mut i = base();
    i.load.muzzle_velocity_mps = -1.0;
    assert!(matches!(Solver::new(i), Err(BallisticsError::InvalidInput(_))));
    let mut i = base();
    i.zero.range_m = 50_000.0;
    assert!(matches!(Solver::new(i), Err(BallisticsError::ZeroNotFound(_))));
}

// ---------- shot tracing (3-D range) ----------

#[test]
fn trace_matches_table_and_stops_at_the_floor() {
    let mut i = base();
    i.effects.spin_drift = true;
    let s = Solver::new(i.clone()).unwrap();
    let tr = s.trace(&ShotParams::default(), 800.0, 1.0, f64::NEG_INFINITY).unwrap();
    let last = tr.path.last().unwrap();
    let row = row_at(i, 800.0);
    // Path ends on the first step past 800 m; compare at matching time within a step.
    assert!(last.x_m >= 800.0 && last.x_m < 801.0);
    approx(last.z_m, row.windage_m, 0.01, "trace spin drift equals table windage");
    assert!(tr.path.windows(2).all(|w| w[1].time_s > w[0].time_s));

    let floor = s.trace(&ShotParams::default(), 2000.0, 1.0, -2.0).unwrap();
    let end = floor.path.last().unwrap();
    assert!(end.y_m < -2.0 && end.y_m > -2.5 && end.x_m < 2000.0, "stops at the floor: {end:?}");
}

#[test]
fn wind_sampler_matches_field() {
    let f = WindField {
        zones: vec![WindZone { until_m: Some(300.0), speed_mps: 3.0, from_deg: 90.0 }, WindZone { until_m: None, speed_mps: 5.0, from_deg: 270.0 }],
        gusts: Some(Gusts { intensity: 0.3, direction_variation_deg: 10.0, period_s: 5.0, correlation_length_m: 200.0, seed: 3 }),
    };
    let p = PreparedWind::new(&f);
    for (x, t) in [(10.0, 0.0), (500.0, 7.5)] {
        assert_eq!(p.at(x, t), f.at(x, t));
    }
    assert!(p.at(10.0, 0.0).z < 0.0 && p.at(500.0, 0.0).z > 0.0);
}
