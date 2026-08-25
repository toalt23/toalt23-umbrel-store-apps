# equihash-verify-wasm

A ~1MB Rust wrapper around the official Zcash Foundation
[`equihash`](https://crates.io/crates/equihash) crate (from
[`zcash/librustzcash`](https://github.com/zcash/librustzcash/tree/main/components/equihash)),
compiled to WebAssembly. Verify-only — no solving, no consensus logic beyond
that.

## Why WASM instead of a native Node addon

The previous approach (`equihashverify`, an ~2018-era native addon) failed to
compile against Node 22 — outdated V8 API calls, forced C++11 in a codebase
that now needs C++17. WASM sidesteps that whole class of problem: it's
architecture- and Node-version-independent, so it doesn't need rebuilding per
target platform (unlike a `.node` addon, which needs a working node-gyp
toolchain matching the exact host CPU/libc/Node ABI).

## Why the build output is committed

Zcash's Equihash(200,9) parameters are a fixed consensus rule — this never
needs rebuilding unless `src/lib.rs` itself changes. Committing `pkg/`
(the compiled `.wasm` + generated JS/TS glue) means the main app's Dockerfile
needs no Rust toolchain at all — `npm ci` picks it up like any other
dependency via the `file:wasm/equihash-verify/pkg` reference in
`package.json`.

## Rebuilding

Only needed if `src/lib.rs` or the `equihash` crate version changes.

```sh
# One-time toolchain setup:
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

# Build:
cd wasm/equihash-verify
wasm-pack build --target nodejs --release
```

Then `npm install` in `app/` to pick up the rebuilt package, and re-run
`npm run verify:header` (see `scripts/verify-header-serialization.ts`)
against a live node to sanity-check nothing broke before committing.
