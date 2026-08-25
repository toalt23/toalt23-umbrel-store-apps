import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface PoolConfigStatus {
  minerAddress: string | null;
  coinbaseTag: string | null;
  configured: boolean;
}

// Deliberately loose — checks known Zcash mainnet address prefixes plus a
// plausible charset/length, NOT a full base58check/bech32 checksum. Good
// enough to catch typos/garbage pasted into the form; a malformed-but-
// prefix-matching address still just gets rejected by the node itself the
// next time it tries to build a coinbase with it.
const ADDRESS_PATTERNS: RegExp[] = [
  /^t1[a-km-zA-HJ-NP-Z1-9]{33}$/, // transparent P2PKH
  /^t3[a-km-zA-HJ-NP-Z1-9]{33}$/, // transparent P2SH
  /^zs1[a-z0-9]{75,80}$/, // Sapling shielded
  /^u1[a-z0-9]{100,320}$/, // Unified Address
];

const ADDRESS_KEY = 'ZAKURA_MINING__MINER_ADDRESS';
const COINBASE_TAG_KEY = 'ZAKURA_MINING__EXTRA_COINBASE_DATA';
// Zebra's own limit — it appends this after its own emoji marker in the coinbase.
const MAX_COINBASE_TAG_BYTES = 86;
// Rejects the tag rather than sanitizing it: this value gets written as a raw
// "KEY=VALUE" line in zakura.env, so a newline in it would let someone inject
// arbitrary additional env vars into that file. Blank/space/etc. are fine —
// only actual control characters (newlines, tabs, null bytes, ...) are barred.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

@Injectable()
export class PoolConfigService {
  private readonly logger = new Logger(PoolConfigService.name);
  private readonly configDir =
    process.env.POOL_CONFIG_DIR ?? '/data/pool-config';
  private readonly envFilePath = path.join(this.configDir, 'zakura.env');

  static isValidAddress(address: string): boolean {
    const trimmed = address.trim();
    return ADDRESS_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  static isValidCoinbaseTag(tag: string): boolean {
    if (CONTROL_CHAR_PATTERN.test(tag)) return false;
    return Buffer.byteLength(tag, 'utf8') <= MAX_COINBASE_TAG_BYTES;
  }

  private async readEnvFile(): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    try {
      const content = await fs.readFile(this.envFilePath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
      }
    } catch {
      // No file yet — starts empty, that's fine.
    }
    return values;
  }

  private async writeEnvFile(values: Map<string, string>): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const lines = [...values.entries()].map(
      ([key, value]) => `${key}=${value}`,
    );
    await fs.writeFile(
      this.envFilePath,
      lines.length ? lines.join('\n') + '\n' : '',
      'utf8',
    );
  }

  async getStatus(): Promise<PoolConfigStatus> {
    const values = await this.readEnvFile();
    const minerAddress = values.get(ADDRESS_KEY)?.trim() || null;
    const coinbaseTag = values.get(COINBASE_TAG_KEY)?.trim() || null;
    return { minerAddress, coinbaseTag, configured: !!minerAddress };
  }

  /**
   * Persists the mining address (required) and an optional coinbase tag —
   * e.g. "mined by umbrel-zec-pool", shown publicly in the block's coinbase
   * — into the file zakura's `env_file:` entry reads at container start
   * (see docker-compose.yml). This does NOT restart zakura itself — env
   * vars are only read at process startup; PoolController is responsible
   * for triggering that via DockerControlService after this resolves.
   */
  async setConfig(
    address: string,
    coinbaseTag: string | undefined,
  ): Promise<void> {
    const trimmedAddress = address.trim();
    if (!PoolConfigService.isValidAddress(trimmedAddress)) {
      throw new Error(
        'Does not look like a valid Zcash mainnet address (expected a t1…, t3…, zs1… or u1… address).',
      );
    }
    const trimmedTag = (coinbaseTag ?? '').trim();
    if (trimmedTag && !PoolConfigService.isValidCoinbaseTag(trimmedTag)) {
      throw new Error(
        'Coinbase tag must be plain text with no line breaks, at most 86 bytes.',
      );
    }

    const values = await this.readEnvFile();
    values.set(ADDRESS_KEY, trimmedAddress);
    if (trimmedTag) {
      values.set(COINBASE_TAG_KEY, trimmedTag);
    } else {
      values.delete(COINBASE_TAG_KEY);
    }
    await this.writeEnvFile(values);
    this.logger.log(
      'Mining config updated on disk — restart zakura for it to take effect.',
    );
  }
}
