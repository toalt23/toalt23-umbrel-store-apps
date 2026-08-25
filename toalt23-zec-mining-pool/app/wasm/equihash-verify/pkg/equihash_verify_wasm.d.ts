/* tslint:disable */
/* eslint-disable */

/**
 * Verifies an Equihash(200,9) solution against a block header.
 *
 * `header` is the 140-byte pre-solution block header (version..nonce) —
 * the same slice the stratum server already assembles for hashing. This
 * function splits it into the algorithm's `input` (the first 108 bytes)
 * and `nonce` (the last 32 bytes) itself, matching librustzcash's
 * `equihash::is_valid_solution(n, k, input, nonce, soln)` signature.
 *
 * `solution` must NOT include the CompactSize length prefix miners send
 * over the wire — strip that on the JS side first (see readCompactSize in
 * block-header.ts).
 */
export function verify(header: Uint8Array, solution: Uint8Array): boolean;
