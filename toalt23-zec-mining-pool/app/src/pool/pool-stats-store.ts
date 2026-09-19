import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

/** One found block — data capture for a future "block found history" UI (not built yet). */
export interface FoundBlockRecord {
  height: number;
  at: string;
  worker?: string;
  achievedDifficulty: number;
}

/** Small JSON file on POOL_CONFIG_DIR so "personal record" stats survive a restart — unlike the per-connection hashrate window, which is fine to reset. */
export interface PersistedPoolStats {
  blocksFound: number;
  lastBlockFoundAt?: string;
  lastBlockFoundHeight?: number;
  bestShareDifficultyEver: number;
  bestShareDifficultyWorker?: string;
  bestShareDifficultyAt?: string;
  /** Cumulative "Pool Effort" for the current round, normalized per-share at submission time (not raw/today's-difficulty). 1.0 == 100%; resets on a found block. */
  effortAccumulator: number;
  /** Every found block, oldest first. No UI yet. Unbounded for now — a solo pool finds too few per year for that to matter. */
  blockHistory: FoundBlockRecord[];
}

const logger = new Logger('PoolStatsStore');
const configDir = process.env.POOL_CONFIG_DIR ?? '/data/pool-config';
const statsFilePath = path.join(configDir, 'pool-stats.json');

// A function, not a constant: blockHistory is an array, and a shared constant's array
// would get mutated by reference the first time a caller pushes a found block onto it.
function emptyStats(): PersistedPoolStats {
  return {
    blocksFound: 0,
    bestShareDifficultyEver: 0,
    effortAccumulator: 0,
    blockHistory: [],
  };
}

export async function loadPoolStats(): Promise<PersistedPoolStats> {
  try {
    const content = await fs.readFile(statsFilePath, 'utf8');
    return {
      ...emptyStats(),
      ...(JSON.parse(content) as Partial<PersistedPoolStats>),
    };
  } catch {
    return emptyStats();
  }
}

// Serializes writes: savePoolStats() is fired-and-forgotten from several unsynchronized
// places, so unordered disk I/O could let an older snapshot clobber a newer one.
let writeQueue: Promise<void> = Promise.resolve();

export async function savePoolStats(stats: PersistedPoolStats): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(statsFilePath, JSON.stringify(stats, null, 2), 'utf8');
    } catch (error) {
      logger.warn(
        `Could not persist pool stats: ${error instanceof Error ? error.message : error}`,
      );
    }
  });
  return writeQueue;
}
