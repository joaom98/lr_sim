# Reference trajectory fixtures

Each `*.json` file here is one case computed by an **independent** ballistic calculator
(e.g. py-ballisticcalc, Hornady 4DOF in point-mass mode, Applied Ballistics, a Kestrel).
`tests/reference.rs` loads every file and checks this solver against it:

- elevation within **0.1 mil** up to 1000 m, **0.2 mil** up to 2000 m
- windage within the same tolerances

Use point-mass settings in the other calculator: no spin drift, no aerodynamic jump, no Coriolis.
Enter values exactly; ranges are line of sight.

```json
{
  "source": "py-ballisticcalc 2.x, 2026-11-08",
  "input": { "...": "a ShotInput, same JSON the WASM API takes (SI units)" },
  "rows": [
    { "rangeM": 500, "elevationMrad": 3.62, "windageMrad": 0.95 },
    { "rangeM": 1000, "elevationMrad": 10.81, "windageMrad": 2.10 }
  ]
}
```

`elevationMrad` = correction up, `windageMrad` = correction right (negative = hold or dial left).
