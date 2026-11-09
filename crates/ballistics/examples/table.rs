//! Print a trajectory table: `cargo run -p ballistics --example table`
use ballistics::units::*;
use ballistics::*;

fn main() {
    let input = ShotInput {
        bullet: Bullet { mass_kg: 175.0 * GRAIN_KG, diameter_m: 0.308 * INCH_M, length_m: 1.24 * INCH_M, drag: DragModel::g7(0.243) },
        rifle: Rifle { sight_height_m: 1.5 * INCH_M, twist_m: 10.0 * INCH_M, twist_direction: TwistDirection::Right, barrel_length_m: 24.0 * INCH_M },
        load: Load { muzzle_velocity_mps: 2600.0 * FOOT_M, reference_barrel_length_m: None, velocity_per_barrel_m: 0.0, powder_temp_sensitivity: 0.0, reference_powder_temp_c: 15.0, mv_sd_mps: 0.0, bc_sd_fraction: 0.0 },
        atmosphere: Atmosphere::icao(),
        powder_temp_c: None,
        zero: ZeroSpec { range_m: 100.0 * YARD_M, offset_m: 0.0, atmosphere: None, powder_temp_c: None },
        wind: WindField::constant(10.0 * MPH_MPS, 90.0),
        look_angle_deg: 0.0, azimuth_deg: 0.0, latitude_deg: None, cant_deg: 0.0,
        effects: Effects { spin_drift: false, aero_jump: false, ..Effects::none() },
        integration: Integration::default(),
    };
    let input2 = input.clone();
    split_timing(input.clone());
    let bench = input.clone();
    let t = std::time::Instant::now();
    for _ in 0..100 {
        let _ = solve(bench.clone(), &TableSpec { max_range_m: 1000.0 * YARD_M, step_m: 100.0 * YARD_M, path_step_m: None });
    }
    println!("average solve over 100 runs: {:?}", t.elapsed() / 100);
    let t = std::time::Instant::now();
    let sol = solve(input,&TableSpec { max_range_m: 1000.0 * YARD_M, step_m: 100.0 * YARD_M, path_step_m: None }).unwrap();
    let dt = t.elapsed();
    let t2 = std::time::Instant::now();
    for _ in 0..100 { let _ = solve(input2.clone(), &TableSpec { max_range_m: 1000.0 * YARD_M, step_m: 100.0 * YARD_M, path_step_m: None }).unwrap(); }
    println!("avg over 100: {:?}", t2.elapsed() / 100);
    println!("{:>5} {:>8} {:>8} {:>7} {:>7} {:>6} {:>6}", "yd", "drop in", "wind in", "MOA up", "MOA L", "fps", "s");
    for r in &sol.rows {
        println!("{:>5.0} {:>8.1} {:>8.1} {:>7.2} {:>7.2} {:>6.0} {:>6.3}",
            r.range_m / YARD_M, r.drop_m / INCH_M, r.windage_m / INCH_M, r.elevation_mrad / 1000.0 / MOA_RAD, -r.windage_mrad / 1000.0 / MOA_RAD, r.velocity_mps / FOOT_M, r.time_s);
    }
    println!("Sg {:.2}  subsonic {:?}  solve {:?}", sol.stability_sg, sol.subsonic_range_m.map(|m| m / YARD_M), dt);
}

#[allow(dead_code)]
fn split_timing(input: ShotInput) {
    let t = std::time::Instant::now();
    for _ in 0..100 { let _ = Solver::new(input.clone()).unwrap(); }
    println!("Solver::new avg {:?}", t.elapsed() / 100);
    let s = Solver::new(input).unwrap();
    let t = std::time::Instant::now();
    for _ in 0..100 { let _ = s.table(&TableSpec { max_range_m: 914.4, step_m: 91.44, path_step_m: None }); }
    println!("table avg {:?}", t.elapsed() / 100);
}
