import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Small JSON file on the shared POOL_CONFIG_DIR volume so blocks-found /
 * best-share-difficulty survive an app restart — these are the "personal
 * record" style stats a solo miner actually cares about keeping, unlike the
 * per-connection rolling hashrate window which is fine to reset.
 */
export interface PersistedPoolStats {
  blocksFound: number;
  lastBlockFoundAt?: string;
  lastBlockFoundHeight?: number;
  bestShareDifficultyEver: number;
  bestShareDifficultyWorker?: string;
  bestShareDifficultyAt?: string;
}

const logger = new Logger('PoolStatsStore');
const configDir = process.env.POOL_CONFIG_DIR ?? '/data/pool-config';
const statsFilePath = path.join(configDir, 'pool-stats.json');

const EMPTY_STATS: PersistedPoolStats = {
  blocksFound: 0,
  bestShareDifficultyEver: 0,
};

export async function loadPoolStats(): Promise<PersistedPoolStats> {
  try {
    const content = await fs.readFile(statsFilePath, 'utf8');
    return {
      ...EMPTY_STATS,
      ...(JSON.parse(content) as Partial<PersistedPoolStats>),
    };
  } catch {
    return { ...EMPTY_STATS };
  }
}

export async function savePoolStats(stats: PersistedPoolStats): Promise<void> {
  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(statsFilePath, JSON.stringify(stats, null, 2), 'utf8');
  } catch (error) {
    logger.warn(
      `Could not persist pool stats: ${error instanceof Error ? error.message : error}`,
    );
  }
}
