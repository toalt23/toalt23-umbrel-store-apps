import { createHash } from 'crypto';
import { BlockTemplateResult } from './types';

/**
 * Byte-order note (the classic Stratum/GBT gotcha):
 *
 * The node's RPC returns hashes (previousblockhash, merkleroot, the reserved
 * field) and `bits` as "display" hex — big-endian, the same convention used
 * by block explorers — per BIP22's definition of the `bits` field ("bignum
 * in hex, big endian"), which Zcash's getblocktemplate inherited. The actual
 * block header stores these as raw little-endian bytes. So every one of
 * those fields needs a byte reversal when moving from RPC response to header
 * bytes. `version`, `curtime` and the header-encoded stratum fields we send
 * to miners do NOT get this treatment — ZIP-301 defines mining.notify's
 * fields as already being "block header encoding", i.e. exactly the raw
 * bytes a miner drops straight into the header with no further conversion.
 * We do the RPC->header conversion once per template and hand miners the
 * already-correct raw bytes.
 *
 * This is the one part of the pool we can't fully test without a live node
 * (or at least a real block to reconstruct — see scripts/verify-header-serialization.ts,
 * which round-trips this logic against an already-mined block to confirm the
 * hashing/target math independently of live template byte-order).
 */

export function reverseBuffer(buf: Buffer): Buffer {
  return Buffer.from(buf).reverse();
}

export function displayHexToHeaderBytes(hex: string): Buffer {
  return reverseBuffer(Buffer.from(hex, 'hex'));
}

export function headerBytesToDisplayHex(buf: Buffer): string {
  return reverseBuffer(buf).toString('hex');
}

export function int32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value, 0);
  return buf;
}

export function uint32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

export function doubleSha256(data: Buffer): Buffer {
  return createHash('sha256')
    .update(createHash('sha256').update(data).digest())
    .digest();
}

/**
 * Interprets a raw (non-reversed) header hash as the big-endian integer used
 * for target comparisons — reverse-then-parse, the standard Bitcoin/Zcash
 * convention also used by z-nomp/miningcore.
 */
export function headerHashToBigInt(rawHash: Buffer): bigint {
  return BigInt('0x' + reverseBuffer(rawHash).toString('hex'));
}

export function hexToBigInt(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return clean.length === 0 ? 0n : BigInt('0x' + clean);
}

export function bigIntToTargetHex(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length > 64) hex = hex.slice(hex.length - 64);
  return hex.padStart(64, '0');
}

/**
 * Reads a Bitcoin-style CompactSize (varint) prefix. Used to strip the
 * length prefix miners include in front of the Equihash solution before
 * handing the raw solution bytes to equihashverify (which expects the
 * solution WITHOUT that prefix).
 */
export function readCompactSize(
  buf: Buffer,
  offset: number,
): { value: number; bytesRead: number } {
  const first = buf.readUInt8(offset);
  if (first < 0xfd) return { value: first, bytesRead: 1 };
  if (first === 0xfd)
    return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
  if (first === 0xfe)
    return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
  throw new Error('CompactSize value too large for a mining solution');
}

export function writeCompactSize(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf.writeUInt8(0xfd, 0);
    buf.writeUInt16LE(value, 1);
    return buf;
  }
  const buf = Buffer.alloc(5);
  buf.writeUInt8(0xfe, 0);
  buf.writeUInt32LE(value, 1);
  return buf;
}

export interface HeaderFields {
  versionBytes: Buffer;
  prevHashBytes: Buffer;
  merkleRootBytes: Buffer;
  reservedBytes: Buffer;
  bitsBytes: Buffer;
  suggestedTimeBytes: Buffer;
}

export function extractHeaderFields(
  template: BlockTemplateResult,
): HeaderFields {
  const merkleRootHex = template.defaultroots?.merkleroot;
  const reservedHex =
    template.defaultroots?.blockcommitmentshash ??
    template.blockcommitmentshash;
  if (!merkleRootHex || !reservedHex) {
    throw new Error(
      'getblocktemplate response is missing defaultroots.merkleroot / blockcommitmentshash',
    );
  }
  return {
    versionBytes: int32LE(template.version),
    prevHashBytes: displayHexToHeaderBytes(template.previousblockhash),
    merkleRootBytes: displayHexToHeaderBytes(merkleRootHex),
    reservedBytes: displayHexToHeaderBytes(reservedHex),
    bitsBytes: displayHexToHeaderBytes(template.bits),
    suggestedTimeBytes: uint32LE(template.curtime),
  };
}

/**
 * Assembles the 140-byte header (everything up to but excluding the
 * Equihash solution) — the PoW input, and the `header` argument
 * equihashverify expects.
 */
export function assembleHeaderWithoutSolution(
  fields: HeaderFields,
  timeBytes: Buffer,
  nonceBytes: Buffer,
): Buffer {
  if (nonceBytes.length !== 32) {
    throw new Error(
      `Block header nonce must be 32 bytes, got ${nonceBytes.length}`,
    );
  }
  if (timeBytes.length !== 4) {
    throw new Error(
      `Block header time must be 4 bytes, got ${timeBytes.length}`,
    );
  }
  return Buffer.concat([
    fields.versionBytes,
    fields.prevHashBytes,
    fields.merkleRootBytes,
    fields.reservedBytes,
    timeBytes,
    fields.bitsBytes,
    nonceBytes,
  ]);
}

/** Full header+solution, ready to hash or to prefix onto the block body for submitblock. */
export function assembleFullHeader(
  headerWithoutSolution: Buffer,
  solutionWithPrefix: Buffer,
): Buffer {
  return Buffer.concat([headerWithoutSolution, solutionWithPrefix]);
}

export function assembleBlockHex(
  fullHeader: Buffer,
  coinbaseTxHex: string,
  otherTxHex: string[],
): string {
  const txCount = writeCompactSize(1 + otherTxHex.length);
  return [
    fullHeader.toString('hex'),
    txCount.toString('hex'),
    coinbaseTxHex,
    ...otherTxHex,
  ].join('');
}
