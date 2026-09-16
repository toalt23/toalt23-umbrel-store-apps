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
 * Usage: npm run verify:regtest
 * (reads REGTEST_RPC_HOST / REGTEST_RPC_PORT from the environment; defaults
 * assume docker-compose.regtest-test.yml's published port)
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

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await axios.post(
    rpcUrl,
    { jsonrpc: '1.0', id: 'verify-regtest-script', method, params },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  if (response.data.error) throw new Error(response.data.error.message ?? `RPC error calling ${method}`);
  return response.data.result as T;
}

async function main() {
  console.log(`Connecting to Regtest node RPC at ${rpcUrl} ...`);

  let heightBefore = await rpc<number>('getblockcount');
  console.log(`Current height: ${heightBefore}`);

  if (heightBefore === 0) {
    // Zcash requires the reserved header field to be exactly 32 zero bytes
    // at the Heartwood activation block. On a fresh Regtest chain, Heartwood
    // and Canopy both collapse onto height 1, but getblocktemplate's
    // blockcommitmentshash for that specific first block isn't the required
    // all-zero value — a one-off quirk of this activation-height collision
    // that can't happen on Mainnet/Testnet (their upgrades are years apart).
    // Zakura's own `generate` RPC (only available under the disable_pow
    // waiver — see regtest-config/zakura-regtest.toml) uses different block-
    // building logic that handles this correctly, so we use it once here to
    // skip past this one block. Every block after that is built and
    // submitted through our own code below, same as the live pool.
    console.log('Height 0 — generating the one special Heartwood/Canopy-activation block via Zakura\'s own `generate` RPC to skip past it ...');
    await rpc<string[]>('generate', [1]);
    heightBefore = await rpc<number>('getblockcount');
    console.log(`Height after generate: ${heightBefore}`);
  }

  console.log('Fetching block template ...');
  const template = await rpc<BlockTemplateResult>('getblocktemplate', [
    { capabilities: ['coinbasetxn', 'workid', 'coinbase/append'] },
  ]);
  console.log(`Template height ${template.height}, ${template.transactions.length} mempool tx(s).`);

  // Same functions stratum.service.ts's handleSubmit()/submitFoundBlock() use
  // for a real share — only the nonce/solution inputs are placeholders here.
  const fields = extractHeaderFields(template);
  const timeBytes = uint32LE(template.curtime);
  const nonceBytes = Buffer.alloc(32); // all-zero placeholder — PoW is waived on this node
  const headerWithoutSolution = assembleHeaderWithoutSolution(fields, timeBytes, nonceBytes);

  const solutionBody = Buffer.alloc(REGTEST_SOLUTION_BYTES); // shape-valid, not cryptographically valid
  const solutionWithPrefix = Buffer.concat([writeCompactSize(REGTEST_SOLUTION_BYTES), solutionBody]);
  const fullHeader = assembleFullHeader(headerWithoutSolution, solutionWithPrefix);

  const hash = headerHashToBigInt(doubleSha256(fullHeader));
  console.log(`Computed block hash: ${hash.toString(16).padStart(64, '0')}`);

  const coinbaseHex = template.coinbasetxn.data;
  const otherTxHex = template.transactions.map((t) => t.data);
  const blockHex = assembleBlockHex(fullHeader, coinbaseHex, otherTxHex);
  console.log(`Assembled block hex (${blockHex.length / 2} bytes). Submitting via submitblock ...`);

  const rejectReason = await rpc<string | null>('submitblock', [blockHex]);

  if (rejectReason === null) {
    const heightAfter = await rpc<number>('getblockcount');
    console.log('✅ Node accepted the block (result: null).');
    console.log(`   Height ${heightBefore} -> ${heightAfter}.`);
    if (heightAfter > heightBefore) {
      console.log('   Confirms assembleHeaderWithoutSolution()/assembleFullHeader()/assembleBlockHex() produce a block the node actually accepts.');
    } else {
      console.log('   ⚠️  Height did not increase despite acceptance — worth a closer look.');
    }
  } else {
    console.log(`❌ Node rejected the block: "${rejectReason}"`);
    console.log('   Likely points at a byte-order or assembly bug in block-header.ts — compare against the RPC byte-order notes at the top of that file.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('verify-regtest-submit failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
