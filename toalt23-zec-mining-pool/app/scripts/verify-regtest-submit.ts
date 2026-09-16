/**
 * "Test 2" from PROGRESS.md's next-steps list — exercises the one part of
 * the block-submit pipeline that verify:submit (verify-submit-block.ts)
 * deliberately does NOT touch: assembleHeaderWithoutSolution() +
 * assembleFullHeader() + assembleBlockHex() from src/pool/block-header.ts,
 * the exact functions stratum.service.ts's submitFoundBlock() runs when a
 * real share solves a block. Never exercised end-to-end before, since
 * mainnet solo odds make hitting a real share this-way astronomically rare.
 *
 * Runs against a throwaway Zakura Regtest node (see
 * docker-compose.regtest-test.yml) configured with the network's
 * `disable_pow` waiver, NOT the production node. With PoW disabled, Zakura
 * only checks the Equihash solution's *shape* (byte length for Regtest's
 * trivial (48,5) params — 36 bytes, vs 1344 for Mainnet/Testnet's (200,9)),
 * not cryptographic validity — so this script builds a placeholder
 * (all-zero) solution rather than solving a real one. That's deliberate:
 * this test isn't about proving Equihash-solving works (already proven live
 * on mainnet for weeks) — it's about proving our own header/coinbase byte
 * assembly produces something the node actually accepts via `submitblock`.
 *
 * Deliberately bypasses stratum.service.ts's equihashverify check (which
 * cryptographically validates a solution and would correctly reject our
 * placeholder) — this script calls the block-assembly functions directly
 * instead of going through the stratum protocol.
 *
 * IMPORTANT: builds the ENTIRE chain through this same code, one block at a
 * time, via our own submitBlock() calls — never through Zakura's own
 * `generate` RPC. An earlier version of this script used `generate` to
 * quickly bootstrap a few blocks first, but that produced blocks whose
 * getblocktemplate-reported chain-history-root subsequently disagreed with
 * what submitblock's own validation independently recomputed
 * (InvalidChainHistoryRoot, expected != actual, persisting at every height
 * tried) — most likely because `generate` commits blocks through a
 * different internal path than a genuine submitblock. Building every block
 * through our own code avoids that entirely and is also more representative
 * of the real pool, which never uses `generate`.
 *
 * Usage: npm run verify:regtest
 * (reads REGTEST_RPC_HOST / REGTEST_RPC_PORT from the environment; defaults
 * assume docker-compose.regtest-test.yml's published port. Needs a FRESH
 * regtest node — restart the container between runs, since ephemeral state
 * means `docker compose down && up -d` gives you a clean chain again.)
 */
import axios from 'axios';
import {
  extractHeaderFields,
  assembleHeaderWithoutSolution,
  assembleFullHeader,
  assembleBlockHex,
  uint32LE,
  writeCompactSize,
  doubleSha256,
  headerHashToBigInt,
} from '../src/pool/block-header';
import { BlockTemplateResult } from '../src/pool/types';

const host = process.env.REGTEST_RPC_HOST || 'localhost';
const port = process.env.REGTEST_RPC_PORT || '18232';
const rpcUrl = `http://${host}:${port}`;

// Regtest's trivial Equihash(48, 5) solution length in bytes:
// 2^k indices * (n/(k+1) + 1) bits, packed = 32 * 9 bits = 288 bits = 36 bytes.
const REGTEST_SOLUTION_BYTES = 36;

// This Regtest config's Heartwood/Canopy activation height (see
// zakura-regtest.toml — no custom activation_heights override, so Zakura's
// default collapses every upgrade up to Canopy onto height 1). Zcash
// requires the header's reserved field to be exactly 32 zero bytes at
// this one height; every block after it uses the real chain-history root
// getblocktemplate reports.
const HEARTWOOD_ACTIVATION_HEIGHT = 1;

// How many blocks to mine through our own code before calling it a pass.
const BLOCKS_TO_MINE = Number(process.env.REGTEST_BLOCKS ?? 5);

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await axios.post(
    rpcUrl,
    { jsonrpc: '1.0', id: 'verify-regtest-script', method, params },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  if (response.data.error) throw new Error(response.data.error.message ?? `RPC error calling ${method}`);
  return response.data.result as T;
}

/** Builds, hashes and submits one block from a fresh template — the same functions
 * stratum.service.ts's handleSubmit()/submitFoundBlock() use for a real share. */
async function mineOneBlock(): Promise<void> {
  const template = await rpc<BlockTemplateResult>('getblocktemplate', [
    { capabilities: ['coinbasetxn', 'workid', 'coinbase/append'] },
  ]);
  console.log(`  Template height ${template.height}, ${template.transactions.length} mempool tx(s).`);

  const fields = extractHeaderFields(template);
  if (template.height === HEARTWOOD_ACTIVATION_HEIGHT) {
    console.log('  Height matches the Heartwood activation height — forcing reserved field to 32 zero bytes (protocol requirement), overriding whatever getblocktemplate reported.');
    fields.reservedBytes = Buffer.alloc(32);
  }

  const timeBytes = uint32LE(template.curtime);
  const nonceBytes = Buffer.alloc(32); // all-zero placeholder — PoW is waived on this node
  const headerWithoutSolution = assembleHeaderWithoutSolution(fields, timeBytes, nonceBytes);

  const solutionBody = Buffer.alloc(REGTEST_SOLUTION_BYTES); // shape-valid, not cryptographically valid
  const solutionWithPrefix = Buffer.concat([writeCompactSize(REGTEST_SOLUTION_BYTES), solutionBody]);
  const fullHeader = assembleFullHeader(headerWithoutSolution, solutionWithPrefix);

  const hash = headerHashToBigInt(doubleSha256(fullHeader));
  console.log(`  Computed block hash: ${hash.toString(16).padStart(64, '0')}`);

  const coinbaseHex = template.coinbasetxn.data;
  const otherTxHex = template.transactions.map((t) => t.data);
  const blockHex = assembleBlockHex(fullHeader, coinbaseHex, otherTxHex);

  const rejectReason = await rpc<string | null>('submitblock', [blockHex]);
  if (rejectReason !== null) {
    throw new Error(`Node rejected block at height ${template.height}: "${rejectReason}"`);
  }
  console.log(`  ✅ Accepted at height ${template.height}.`);
}

async function main() {
  console.log(`Connecting to Regtest node RPC at ${rpcUrl} ...`);

  const heightBefore = await rpc<number>('getblockcount');
  console.log(`Current height: ${heightBefore}`);
  if (heightBefore !== 0) {
    throw new Error(
      `Expected a fresh chain at height 0, found height ${heightBefore}. Restart the regtest container ` +
      '(docker compose -p zec-regtest-test -f docker-compose.regtest-test.yml down && ... up -d) for a clean run — ' +
      'ephemeral state means that gives you height 0 again.',
    );
  }

  for (let i = 1; i <= BLOCKS_TO_MINE; i++) {
    console.log(`Mining block ${i}/${BLOCKS_TO_MINE} via our own assembleBlockHex()/submitBlock() code ...`);
    await mineOneBlock();
  }

  const heightAfter = await rpc<number>('getblockcount');
  console.log(`✅ All ${BLOCKS_TO_MINE} blocks accepted. Height ${heightBefore} -> ${heightAfter}.`);
  console.log('Confirms assembleHeaderWithoutSolution()/assembleFullHeader()/assembleBlockHex() produce blocks the node actually accepts, built entirely through our own code.');
}

main().catch((error) => {
  console.error('verify-regtest-submit failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
