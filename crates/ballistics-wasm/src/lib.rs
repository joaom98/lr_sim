//! WebAssembly bindings. Inputs and outputs are plain JS objects with camelCase keys that
//! mirror the `ballistics` crate's serde types (all SI units).

use ballistics::{Atmosphere, GroupSpec, ShotInput, TableSpec};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

fn from_js<T: serde::de::DeserializeOwned>(v: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&format!("bad {what}: {e}")))
}

/// Compute a trajectory table: `solve(shotInput, tableSpec) -> Solution`.
#[wasm_bindgen]
pub fn solve(input: JsValue, table: JsValue) -> Result<JsValue, JsError> {
    let input: ShotInput = from_js(input, "shot input")?;
    let table: TableSpec = from_js(table, "table spec")?;
    let sol = ballistics::solve(input, &table).map_err(|e| JsError::new(&e.to_string()))?;
    to_js(&sol)
}

/// Fire a seeded group: `fireGroup(shotInput, groupSpec) -> GroupResult`.
#[wasm_bindgen(js_name = fireGroup)]
pub fn fire_group(input: JsValue, spec: JsValue) -> Result<JsValue, JsError> {
    let input: ShotInput = from_js(input, "shot input")?;
    let spec: GroupSpec = from_js(spec, "group spec")?;
    let g = ballistics::fire_group(input, &spec).map_err(|e| JsError::new(&e.to_string()))?;
    to_js(&g)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AtmosphereInfo {
    density_kg_m3: f64,
    speed_of_sound_mps: f64,
    density_altitude_m: f64,
    station_pressure_pa: f64,
    baro_pressure_pa: f64,
}

/// Derived air properties for an atmosphere object.
#[wasm_bindgen(js_name = atmosphereInfo)]
pub fn atmosphere_info(atm: JsValue) -> Result<JsValue, JsError> {
    let a: Atmosphere = from_js(atm, "atmosphere")?;
    a.validate().map_err(|e| JsError::new(&e.to_string()))?;
    to_js(&AtmosphereInfo {
        density_kg_m3: a.density(),
        speed_of_sound_mps: a.speed_of_sound(),
        density_altitude_m: a.density_altitude_m(),
        station_pressure_pa: a.pressure_pa,
        baro_pressure_pa: a.baro_pressure_pa(),
    })
}

/// Station pressure (Pa) from a barometric (sea-level corrected) reading at an altitude.
#[wasm_bindgen(js_name = stationFromBaro)]
pub fn station_from_baro(altitude_m: f64, baro_pa: f64) -> f64 {
    Atmosphere::from_baro(altitude_m, baro_pa, 15.0, 0.0).pressure_pa
}

/// Standard atmospheres: "icao", "asm" (Army Standard Metro), or ISA at an altitude.
#[wasm_bindgen(js_name = standardAtmosphere)]
pub fn standard_atmosphere(name: &str, altitude_m: f64) -> Result<JsValue, JsError> {
    let a = match name {
        "icao" if altitude_m == 0.0 => Atmosphere::icao(),
        "icao" => Atmosphere::icao_at_altitude(altitude_m),
        "asm" => Atmosphere::army_standard_metro(),
        _ => return Err(JsError::new("unknown standard atmosphere (use \"icao\" or \"asm\")")),
    };
    to_js(&a)
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
