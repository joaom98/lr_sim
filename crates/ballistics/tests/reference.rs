//! Compares the solver with trajectories from independent calculators stored in
//! `tests/reference/*.json` (format in `tests/reference/README.md`).

use std::path::Path;

use ballistics::{solve, ShotInput, TableSpec};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    range_m: f64,
    elevation_mrad: f64,
    windage_mrad: f64,
}

#[derive(Deserialize)]
struct Case {
    source: String,
    input: ShotInput,
    rows: Vec<Row>,
}

fn tolerance_mrad(range_m: f64) -> f64 {
    if range_m <= 1000.0 {
        0.1
    } else {
        0.2
    }
}

#[test]
fn matches_reference_calculators() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/reference");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    if files.is_empty() {
        eprintln!("no reference fixtures in {} yet; see README.md there", dir.display());
        return;
    }
    let mut failures = Vec::new();
    for f in &files {
        let case: Case = serde_json::from_str(&std::fs::read_to_string(f).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let max = case.rows.iter().map(|r| r.range_m).fold(0.0, f64::max);
        let sol = solve(case.input, &TableSpec { max_range_m: max, step_m: 1.0, path_step_m: None }).unwrap();
        for r in &case.rows {
            let got = sol.rows.iter().find(|x| (x.range_m - r.range_m).abs() < 1e-6).expect("row");
            let tol = tolerance_mrad(r.range_m);
            let (de, dw) = (got.elevation_mrad - r.elevation_mrad, got.windage_mrad - r.windage_mrad);
            if de.abs() > tol || dw.abs() > tol {
                failures.push(format!(
                    "{} ({}) @ {} m: elevation {:.3} vs {:.3}, windage {:.3} vs {:.3} mrad",
                    f.file_name().unwrap().to_string_lossy(),
                    case.source,
                    r.range_m,
                    got.elevation_mrad,
                    r.elevation_mrad,
                    got.windage_mrad,
                    r.windage_mrad
                ));
            }
        }
    }
    assert!(failures.is_empty(), "reference mismatches:\n{}", failures.join("\n"));
}
