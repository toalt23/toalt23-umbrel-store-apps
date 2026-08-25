//! WASM wrapper around the official Zcash Foundation `equihash` crate
//! (https://crates.io/crates/equihash, from zcash/librustzcash), scoped to
//! exactly the one thing the stratum server needs: verifying a solution.
//! No solving, no consensus logic beyond that — kept deliberately narrow.
//!
//! Compiled as a portable .wasm artifact rather than a native Node addon on
//! purpose: WASM runs identically regardless of host architecture, so this
//! sidesteps the whole class of "native addon doesn't build on this CPU/
//! libc/Node version" problems the old equihashverify addon hit. It's built
//! once (see the repo's README-adjacent build notes) and the output is
//! committed — Zcash's Equihash(200,9) parameters are a fixed consensus
//! rule, this never needs rebuilding unless the wrapper logic itself
//! changes.

use wasm_bindgen::prelude::*;

const EQUIHASH_N: u32 = 200;
const EQUIHASH_K: u32 = 9;
/// version(4) + prevhash(32) + merkleroot(32) + reserved(32) + time(4) + bits(4)
const INPUT_LEN: usize = 108;
const NONCE_LEN: usize = 32;

/// Verifies an Equihash(200,9) solution against a block header.
///
/// `header` is the 140-byte pre-solution block header (version..nonce) —
/// the same slice the stratum server already assembles for hashing. This
/// function splits it into the algorithm's `input` (the first 108 bytes)
/// and `nonce` (the last 32 bytes) itself, matching librustzcash's
/// `equihash::is_valid_solution(n, k, input, nonce, soln)` signature.
///
/// `solution` must NOT include the CompactSize length prefix miners send
/// over the wire — strip that on the JS side first (see readCompactSize in
/// block-header.ts).
#[wasm_bindgen]
pub fn verify(header: &[u8], solution: &[u8]) -> bool {
    if header.len() != INPUT_LEN + NONCE_LEN {
        return false;
    }
    let (input, nonce) = header.split_at(INPUT_LEN);
    equihash::is_valid_solution(EQUIHASH_N, EQUIHASH_K, input, nonce, solution).is_ok()
}
