import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface PoolConfigStatus {
  minerAddress: string | null;
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

const ENV_KEY = 'ZAKURA_MINING__MINER_ADDRESS';

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

  async getStatus(): Promise<PoolConfigStatus> {
    try {
      const content = await fs.readFile(this.envFilePath, 'utf8');
      const match = new RegExp(`^${ENV_KEY}=(.*)$`, 'm').exec(content);
      const address = match?.[1]?.trim();
      return { minerAddress: address || null, configured: !!address };
    } catch {
      return { minerAddress: null, configured: false };
    }
  }

  /**
   * Persists the address to the file zakura's `env_file:` entry reads at
   * container start (see docker-compose.yml). This does NOT restart zakura —
   * env vars are only read at process startup, there's no known hot-reload
   * for this. The caller is responsible for telling the user to restart the
   * app from the Umbrel dashboard.
   */
  async setMinerAddress(address: string): Promise<void> {
    const trimmed = address.trim();
    if (!PoolConfigService.isValidAddress(trimmed)) {
      throw new Error(
        'Does not look like a valid Zcash mainnet address (expected a t1…, t3…, zs1… or u1… address).',
      );
    }
    await fs.mkdir(this.configDir, { recursive: true });
    await fs.writeFile(this.envFilePath, `${ENV_KEY}=${trimmed}\n`, 'utf8');
    this.logger.log(
      'Miner address updated on disk — restart the app for the node to pick it up.',
    );
  }
}
