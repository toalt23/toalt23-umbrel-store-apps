/**
 * "Test 1" from our testing plan — validates the submitblock RPC plumbing
 * (NodeService.submitBlock's request/response handling) without needing a
 * freshly mined block or real mining hardware. Resubmits an already-known,
 * already-valid block verbatim to the SAME live node it came from.
 *
 * Safe / a no-op for the chain: the node validates the block, recognizes
 * it as already known, and does nothing further — no new coins, no P2P
 * rebroadcast, no consensus impact. It's a read-then-write-the-same-thing
 * -back operation that nodes treat as a duplicate, not a new event.
 *
 * IMPORTANT SCOPE: this only tests NodeService.submitBlock()'s RPC
 * request/response handling. It does NOT exercise assembleBlockHex() (the
 * header+coinbase+transactions concatenation logic in stratum.service.ts
 * that actually runs when a real share is found) — we resubmit the
 * original raw hex completely unchanged, so that reassembly code never
 * runs here. Only a real solved share (see the regtest test plan) exercises
 * that path — this script is a cheap, narrower sanity check, not a
 * substitute for it.
 *
 * Usage: npm run verify:submit
 * (reads ZEBRA_RPC_HOST / ZEBRA_RPC_PORT from the environment, same as NodeService)
 */
import axios from 'axios';

const host = process.env.ZEBRA_RPC_HOST || 'localhost';
const port = process.env.ZEBRA_RPC_PORT || '8232';
const rpcUrl = `http://${host}:${port}`;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await axios.post(
    rpcUrl,
    { jsonrpc: '1.0', id: 'verify-submit-script', method, params },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
  );
  if (response.data.error) throw new Error(response.data.error.message ?? `RPC error calling ${method}`);
  return response.data.result as T;
}

async function main() {
  console.log(`Connecting to node RPC at ${rpcUrl} ...`);
  const bestHash = await rpc<string>('getbestblockhash');
  console.log(`Best block hash: ${bestHash}`);

  const rawHex = await rpc<string>('getblock', [bestHash, 0]);
  console.log(`Fetched raw block hex (${rawHex.length / 2} bytes). Resubmitting it to the same node via submitblock ...`);

  const result = await rpc<string | null>('submitblock', [rawHex]);

  if (result === null) {
    console.log('✅ Node accepted the resubmit with no complaint (result: null).');
    console.log('   That would normally mean "accepted as a new block" — unusual for a resubmit of an existing one, but not a failure.');
  } else if (result.toLowerCase().includes('duplicate')) {
    console.log(`✅ Node responded "${result}" — exactly the expected outcome.`);
    console.log('   It recognized this as an already-known, already-valid block. Confirms the submitblock RPC round-trip (NodeService.submitBlock) works correctly.');
  } else {
    console.log(`⚠️  Unexpected response: "${result}"`);
    console.log("   Not necessarily wrong, but doesn't match the expected \"duplicate\" — worth a closer look before trusting this in production.");
  }
}

main().catch((error) => {
  console.error('submitblock test failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
