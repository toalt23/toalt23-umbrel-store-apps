import { createHash } from 'crypto';
import { BlockTemplateResult } from './types';

// Byte-order gotcha: reverse RPC's big-endian hashes/bits to little-endian for the header,
// but NOT version/curtime/stratum fields (already header-encoded). See scripts/verify-header-serialization.ts.

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

/** Reverse-then-parse a raw header hash as the big-endian integer used for target comparisons (standard Bitcoin/Zcash convention). */
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

/** Strips the CompactSize length prefix miners put in front of the Equihash solution — equihashverify expects it bare. */
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

/** Assembles the 140-byte pre-solution header — the PoW input, and what equihashverify expects as `header`. */
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
