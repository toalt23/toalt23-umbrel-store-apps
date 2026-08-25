import { Logger } from '@nestjs/common';

interface EquihashVerifyWasmBinding {
  /** n=200, k=9 (Zcash consensus) are baked into the WASM module itself — not parameters here. */
  verify(header: Uint8Array, solution: Uint8Array): boolean;
}

const logger = new Logger('EquihashVerify');

let binding: EquihashVerifyWasmBinding | null = null;
try {
  // WASM build of the official Zcash Foundation `equihash` crate (see
  // wasm/equihash-verify/) — verify-only, wrapped as a local npm package
  // (wasm/equihash-verify/pkg) so it installs like any other dependency.
  // Loaded dynamically so a load failure doesn't crash module resolution
  // for the rest of the app — surfaced instead as a loud warning at
  // StratumService startup, same fallback behavior as before this was WASM.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  binding = require('equihash-verify-wasm') as EquihashVerifyWasmBinding;
} catch (error) {
  logger.error(
    'Could not load the equihash-verify-wasm module — Equihash solutions cannot be cryptographically ' +
      `verified. (${error instanceof Error ? error.message : String(error)})`,
  );
}

export function isEquihashVerifyAvailable(): boolean {
  return binding !== null;
}

/**
 * Verifies an Equihash(200,9) solution against a block header.
 *
 * @param headerWithoutSolution The 140-byte header (version..nonce), NOT
 *   including the solution or its CompactSize length prefix.
 * @param solutionWithoutPrefix The raw solution bytes, with the CompactSize
 *   length prefix already stripped (see readCompactSize in block-header.ts)
 *   — the verifier expects the bare solution, not what miners actually
 *   submit over the wire.
 */
export function verifyEquihashSolution(
  headerWithoutSolution: Buffer,
  solutionWithoutPrefix: Buffer,
): boolean {
  if (!binding) {
    throw new Error('equihash-verify-wasm module is not loaded');
  }
  return binding.verify(headerWithoutSolution, solutionWithoutPrefix);
}
