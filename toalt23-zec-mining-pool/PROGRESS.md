# ZEC Mining Pool — Progress / Continuity Notes

Last updated: 2026-08-25 (session with Claude). Read this before picking the
project back up — saves re-deriving context.

## What this app is

Umbrel app: a Zakura (Zebra fork) full node + a NestJS "app" (dashboard +
API + a hand-rolled ZIP-301 stratum server) for **solo mining** directly to
your own node. Repo root: `toalt23-zec-mining-pool/`. The NestJS project
lives in `app/` (renamed from `web-ui/` once it grew past "just a dashboard").

## Status: core pipeline is proven working end-to-end, no real miner yet

Everything below has been tested against the **live mainnet node** running
on the Umbrel Pi (not simulated):

- ✅ Docker build (no native compile toolchain needed anymore — see WASM note below)
- ✅ Dashboard + stratum server both start, `/api/pool/status`, `/api/pool/config`
- ✅ `getblocktemplate` → the stratum server generates real jobs from the live chain
- ✅ Mining payout address: settable from the UI (Miner tab), auto-restarts
  *just* the zakura container (not the whole app) via a Docker-socket call —
  confirmed working end-to-end
- ✅ Header serialization / byte-order / double-SHA256 — proven correct via
  `npm run verify:header`, which reconstructs an already-mined block and
  confirms our hashing reproduces its real hash exactly
- ✅ Real Equihash(200,9) solution verification — also proven via
  `npm run verify:header` (it now also runs the equihashverify check against
  a real solution and confirms it valid)
- ⏳ **Test 1** (submitblock RPC plumbing, `npm run verify:submit`) — written,
  not yet run on the Pi
- ⏳ **Test 2** (full share→block pipeline via a real solved share) — not
  started, needs either a real miner or a regtest setup (see below)
- ⏳ **Real ASIC miner test** (`mining.subscribe`/`authorize`/`submit` from
  actual hardware) — blocked on the user getting a Z9 mini / Z15 / Z15 Pro

## Key architecture decisions (with reasoning, so we don't re-litigate)

- **Stratum server lives in the same NestJS process as the dashboard**
  (not a separate container). Discussed splitting it out for isolation
  (a stratum bug could crash the dashboard too) — deferred until after
  real miners are connected and it's clear whether that's actually a
  problem in practice.
- **Equihash verification is WASM, not a native Node addon.** The original
  plan used `equihashverify` (an ~2018 native addon) — confirmed on real
  hardware that it cannot compile against Node 22 (V8 API mismatch + forced
  C++11 vs. required C++17). Replaced with a small Rust wrapper
  (`app/wasm/equihash-verify/`) around the *official* Zcash Foundation
  `equihash` crate (from `zcash/librustzcash`, the same one Zebra/Zakura use
  internally), compiled to WebAssembly. WASM sidesteps the whole
  "native addon doesn't build on this arch/libc/Node version" problem class.
  The build output is **committed** (`wasm/equihash-verify/pkg/`, ~56KB) —
  Zcash's PoW parameters never change, so it never needs rebuilding unless
  `src/lib.rs` itself changes. See `app/wasm/equihash-verify/README.md` for
  rebuild instructions. Installed as a local `file:` npm dependency
  (`equihash-verify-wasm`), so `npm ci` picks it up like any other package —
  **no Rust toolchain needed in the app's own Dockerfile.**
- **Mining payout address is configured in the UI, not a fixed compose env
  var.** Written to `${APP_DATA_DIR}/pool-config/zakura.env`, which zakura's
  `env_file:` (with `required: false`) reads at container (re)start. The web
  container auto-restarts *only* the zakura container after a save, via a
  narrow Docker Engine API call (`POST /containers/{name}/restart`) over a
  mounted `/var/run/docker.sock` — **the user explicitly approved this**
  after being told what it grants (full, unrestricted Docker API access to
  anything running in that container, not just this one call). Noted
  hardening option, not implemented: a docker-socket-proxy allowlisting only
  that one endpoint.
- **Difficulty presets are fixed, not vardiff**: `z9mini` (~10 kSol/s),
  `z15` (~420 kSol/s), `z15pro` (~840 kSol/s), selectable via a
  `.<preset>` worker-name suffix. Fine for a personal solo setup with a
  handful of known devices; vardiff would be the next step for arbitrary
  hardware.
- **Best-share-difficulty and blocks-found are persisted** (survive app
  restarts) in `${APP_DATA_DIR}/pool-config/pool-stats.json`. Per-worker
  hashrate/best-share is session-scoped (resets on reconnect) — intentional,
  it's a "personal record" vs. "live session stat" distinction.

## Gotchas hit this session (so we don't repeat them)

1. **`scripts/` outside `src/` broke the Nest build output layout** — with
   no `rootDir` pinned, tsc mirrored the whole project tree under `dist/`
   (`dist/src/main.js` instead of `dist/main.js`), breaking `CMD ["node",
   "dist/main"]`. Fixed by excluding `scripts/` from `tsconfig.build.json`.
2. **Docker bind-mount ownership**: `${APP_DATA_DIR}/pool-config` gets
   created root-owned by the Docker daemon on first mount (host dir didn't
   exist yet), but the app container runs non-root → EACCES writing the
   mining address. Fixed via `docker-entrypoint.sh`: container starts as
   root, chowns the mount, `su-exec`s down to the `node` user before running
   the app. Compose's `user: "1000:1000"` had to be removed for this to work
   (it forced non-root from the very start, no window to fix permissions).
3. **Docker socket + non-root user**: same privilege-drop broke docker.sock
   access (EACCES) once that got mounted for the auto-restart feature.
   First fix attempt (match the `node` user's group to the socket's on-host
   GID) was too fragile — varies rootful vs. rootless Docker and across
   distros. Simplified to just `chmod 666` the socket at startup while still
   root — blunt but reliable everywhere.
4. **Umbrel's own app-store clone is separate from the dev checkout** —
   `git pull` in the working directory doesn't make Umbrel see a new
   version; it has its own internal copy/refresh cycle.
5. **Umbrel shares one Docker network across all apps** (`umbrel_main_network`),
   not a per-app compose network — matters for any throwaway test container
   that needs to reach `toalt23-zec-mining-pool_zakura_1` by name.
6. **`equihashverify` (old native addon) genuinely cannot build on Node 22** —
   don't retry patching it; the WASM replacement is done and proven working.

## Deploy loop (for next session)

On the Pi, from `~/toalt23-umbrel-store-apps/toalt23-zec-mining-pool/app`:

```sh
git pull
sudo docker build -t toalt23/zec-mining-pool-web:latest .
sudo docker push toalt23/zec-mining-pool-web:latest
# then: Umbrel app update
```

`umbrel-app.yml`'s `version:`/`releaseNotes:` get bumped with every
user-visible change (patch bump for fixes, minor for real features) — keep
doing that, the user asked for it explicitly.

For one-off diagnostic scripts (`verify:header`, `verify:submit`) against
the live node without touching the running containers:

```sh
sudo docker build --target builder -t zec-verfiy-tmp .
sudo docker run --rm --network umbrel_main_network \
  -e ZEBRA_RPC_HOST=toalt23-zec-mining-pool_zakura_1 -e ZEBRA_RPC_PORT=8232 \
  zec-verfiy-tmp npm run verify:header   # or verify:submit
```

## Next steps, in order

1. Run `npm run verify:submit` on the Pi (script is written, untested on
   real hardware yet) — validates `NodeService.submitBlock()`'s RPC
   round-trip by resubmitting an already-known block. Safe / no-op for the
   chain (see the script's own doc comment for why). **Does not** exercise
   `assembleBlockHex()` (the header+coinbase+tx concatenation logic) since
   it resubmits the original raw hex unchanged.
2. When the user's miner (Z9 mini / Z15 / Z15 Pro) arrives: point it at
   `<pi-ip>:3333`, confirm `mining.subscribe`/`authorize`/`notify`/`submit`
   round-trip with real hardware, confirm shares get accepted.
3. Set up a **separate, temporary regtest zakura container** (fresh small
   cache dir, `network: Regtest`, no real P2P peers needed) to test the full
   share→block pipeline (`assembleBlockHex()` + `submitBlock()` together)
   against a genuinely-found block, in minutes instead of waiting on
   mainnet solo-mining odds (which for a single ASIC could be a very long
   time). Needs figuring out: the right env var for network selection, and
   a regtest-format mining address (different encoding than mainnet
   t1.../t3...). Not started — figure this out together when we get there,
   don't guess ahead of time.
4. Longer-term / not urgent: consider splitting the stratum server into its
   own container (see architecture note above); consider vardiff instead of
   fixed presets if hardware beyond the three known devices shows up;
   consider a docker-socket-proxy to narrow the Docker API access the app
   container has.
