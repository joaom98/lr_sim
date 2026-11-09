// Compiles crates/ballistics-wasm to WebAssembly and generates JS bindings into web/pkg.
// Needs: rustup target wasm32-unknown-unknown, and wasm-bindgen-cli matching Cargo.lock.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cargoBin = join(homedir(), ".cargo", "bin");
const env = { ...process.env, PATH: `${cargoBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });

const profile = process.argv.includes("--debug") ? "debug" : "release";
run("cargo", ["build", "-p", "ballistics-wasm", "--target", "wasm32-unknown-unknown", ...(profile === "release" ? ["--release"] : [])]);
run("wasm-bindgen", [
  join(root, "target", "wasm32-unknown-unknown", profile, "ballistics_wasm.wasm"),
  "--out-dir", join(root, "web", "pkg"),
  "--target", "web",
  "--typescript",
]);
console.log("wasm bindings written to web/pkg");
