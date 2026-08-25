/**
 * Offline sanity check for the header (de)serialization + hashing logic in
 * src/pool/block-header.ts, run against an ALREADY-MINED block instead of a
 * live template. This lets us validate the hashing/target math and the
 * equihashverify wiring without needing a live miner — but it does NOT
 * validate the RPC->header byte-order assumptions made for LIVE
 * getblocktemplate responses (previousblockhash/merkleroot/reserved/bits),
 * since here we slice the header straight out of the raw block hex instead
 * of going through extractHeaderFields(). Treat a pass here as "the core
 * primitives are correct", not "the live template path is correct" — that
 * still needs a real miner submitting real shares against the running pool.
 *
 * Usage: npm run verify:header
 * (reads ZEBRA_RPC_HOST / ZEBRA_RPC_PORT from the environment, same as NodeService)
 */
import axios from 'axios';
import { doubleSha256, headerHashToBigInt, readCompactSize } from '../src/pool/block-header';
import { isEquihashVerifyAvailable, verifyEquihashSolution } from '../src/pool/equihash-verify';

const host = process.env.ZEBRA_RPC_HOST || 'localhost';
const port = process.env.ZEBRA_RPC_PORT || '8232';
const rpcUrl = `http://${host}:${port}`;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await axios.post(
    rpcUrl,
    { jsonrpc: '1.0', id: 'verify-script', method, params },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  if (response.data.error) throw new Error(response.data.error.message ?? `RPC error calling ${method}`);
  return response.data.result as T;
}

const HEADER_LEN_WITHOUT_SOLUTION = 140; // version(4) + prevhash(32) + merkleroot(32) + reserved(32) + time(4) + bits(4) + nonce(32)

async function main() {
  console.log(`Connecting to node RPC at ${rpcUrl} ...`);
  const bestHash = await rpc<string>('getbestblockhash');
  console.log(`Best block hash: ${bestHash}`);

  const rawHex = await rpc<string>('getblock', [bestHash, 0]);
  const raw = Buffer.from(rawHex, 'hex');

  const headerWithoutSolution = raw.subarray(0, HEADER_LEN_WITHOUT_SOLUTION);
  const { value: solutionLen, bytesRead: prefixLen } = readCompactSize(raw, HEADER_LEN_WITHOUT_SOLUTION);
  const solutionStart = HEADER_LEN_WITHOUT_SOLUTION + prefixLen;
  const solutionWithoutPrefix = raw.subarray(solutionStart, solutionStart + solutionLen);
  const fullHeader = raw.subarray(0, solutionStart + solutionLen);

  console.log(`Solution length: ${solutionLen} bytes (expected 1344 for Equihash 200,9)`);

  const hash = doubleSha256(fullHeader);
  const hashBigInt = headerHashToBigInt(hash);
  const hashHexDisplay = hashBigInt.toString(16).padStart(64, '0');

  console.log(`Computed hash (display order): ${hashHexDisplay}`);
  console.log(`Node-reported hash:            ${bestHash}`);
  const hashMatches = hashHexDisplay === bestHash.toLowerCase();
  console.log(hashMatches ? '✅ Hash matches — header assembly + double-SHA256 + byte-order are correct.' : '❌ MISMATCH — see the byte-order note at the top of block-header.ts.');

  if (!isEquihashVerifyAvailable()) {
    console.log('⚠️  equihashverify native module not loaded — skipping solution verification check.');
  } else {
    const valid = verifyEquihashSolution(headerWithoutSolution, solutionWithoutPrefix);
    console.log(valid ? '✅ equihashverify confirms the solution is valid.' : '❌ equihashverify rejected a real, already-mined solution — something is wrong with the binding or parameter order.');
  }

  if (!hashMatches) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Verification script failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
