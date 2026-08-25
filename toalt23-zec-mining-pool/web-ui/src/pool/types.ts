export interface BlockTemplateTransaction {
  data: string;
  hash: string;
  depends: number[];
  fee: number;
  sigops?: number;
  required?: boolean;
}

export interface BlockTemplateResult {
  version: number;
  previousblockhash: string;
  /** Older/flat form of the reserved header field; prefer defaultroots.blockcommitmentshash when present. */
  blockcommitmentshash?: string;
  defaultroots?: {
    merkleroot: string;
    blockcommitmentshash: string;
  };
  transactions: BlockTemplateTransaction[];
  coinbasetxn: BlockTemplateTransaction;
  /** 256-bit target, "display" hex (big-endian, as in getblockchaininfo/block explorers). */
  target: string;
  mintime: number;
  curtime: number;
  maxtime?: number;
  /** Compact nBits, "display" hex — same byte-order convention as target/previousblockhash. */
  bits: string;
  height: number;
  longpollid?: string;
}
