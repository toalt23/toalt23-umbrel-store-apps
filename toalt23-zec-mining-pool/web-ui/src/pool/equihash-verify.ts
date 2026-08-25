import { Logger } from '@nestjs/common';

// Zcash's PoW parameters — n=200, k=9. Not configurable, this is consensus.
const EQUIHASH_N = 200;
const EQUIHASH_K = 9;

interface EquihashVerifyBinding {
  verify(header: Buffer, solution: Buffer, n?: number, k?: number): boolean;
}

const logger = new Logger('EquihashVerify');

let binding: EquihashVerifyBinding | null = null;
try {
  // Native addon (node-gyp build, see Dockerfile). Loaded dynamically so a
  // failed native build doesn't crash module resolution for the rest of the
  // app — it's surfaced instead as a loud warning at StratumService startup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  binding = require('equihashverify') as EquihashVerifyBinding;
} catch (error) {
  logger.error(
    'Could not load the native equihashverify module — Equihash solutions cannot be cryptographically ' +
      `verified. Check the Docker build logs for the node-gyp compile step. (${error instanceof Error ? error.message : String(error)})`,
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
 *   — equihashverify expects the bare solution, not what miners actually
 *   submit over the wire.
 */
export function verifyEquihashSolution(
  headerWithoutSolution: Buffer,
  solutionWithoutPrefix: Buffer,
): boolean {
  if (!binding) {
    throw new Error('equihashverify native module is not loaded');
  }
  return binding.verify(
    headerWithoutSolution,
    solutionWithoutPrefix,
    EQUIHASH_N,
    EQUIHASH_K,
  );
}
