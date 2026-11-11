#!/usr/bin/env bash
# Build script for Render (static site). Render's build image has Node but no Rust, so this
# installs a minimal Rust toolchain and the prebuilt wasm-bindgen CLI, then builds the site.
# Also works locally: it skips whatever is already installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# wasm-bindgen CLI must match the library version in Cargo.lock exactly.
WBG_VERSION="$(grep -A1 'name = "wasm-bindgen"$' Cargo.lock | grep version | cut -d'"' -f2)"
echo "wasm-bindgen ${WBG_VERSION}"

export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust (minimal profile)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --default-toolchain stable --target wasm32-unknown-unknown
fi
rustup target add wasm32-unknown-unknown

if ! wasm-bindgen --version 2>/dev/null | grep -q "${WBG_VERSION}"; then
  echo "Installing prebuilt wasm-bindgen ${WBG_VERSION}"
  NAME="wasm-bindgen-${WBG_VERSION}-x86_64-unknown-linux-musl"
  mkdir -p "$HOME/.local/wasm-bindgen"
  curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WBG_VERSION}/${NAME}.tar.gz" |
    tar xz -C "$HOME/.local/wasm-bindgen"
  export PATH="$HOME/.local/wasm-bindgen/${NAME}:$PATH"
fi

cd web
npm ci
npm run build
echo "Site built in web/dist"
