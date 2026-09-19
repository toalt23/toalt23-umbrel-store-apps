import { Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

/** One found-and-accepted block, kept for a future "block found history" UI (not built yet — this is just the data capture, so nothing is lost between now and when that UI exists). */
export interface FoundBlockRecord {
  height: number;
  at: string;
  worker?: string;
  achievedDifficulty: number;
}

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
  /**
   * Cumulative "Pool Effort" for the current round (since the last found block), already
   * normalized against network difficulty at each share's own submission time — not raw
   * difficulty divided by today's difficulty, so mid-round difficulty retargets don't
   * retroactively distort work already submitted. 1.0 == 100% == the expected amount of
   * work to find one block; resets to 0 the moment a block is found.
   */
  effortAccumulator: number;
  /** Every found-and-accepted block, oldest first. No UI reads this yet — see FoundBlockRecord. Unbounded for now (a solo home pool finds few enough blocks per year that this is a non-issue); revisit a retention cap only if/when the history UI is actually built. */
  blockHistory: FoundBlockRecord[];
}

const logger = new Logger('PoolStatsStore');
const configDir = process.env.POOL_CONFIG_DIR ?? '/data/pool-config';
const statsFilePath = path.join(configDir, 'pool-stats.json');

// A function, not a shared constant object: PersistedPoolStats.blockHistory is an array,
// and `{...EMPTY_STATS}` only shallow-copies it — every caller would otherwise get a
// reference to the *same* array, so pushing a found block onto it (stratum.service.ts)
// would mutate this "empty defaults" template for the whole process.
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

// savePoolStats() is fired-and-forgotten from several places in stratum.service.ts (a 15s
// timer, a new best share, a found block) with no coordination between callers. Without
// serializing the actual disk writes here, two overlapping calls' fs I/O could finish out
// of call order and let an older snapshot silently overwrite a newer one on disk — e.g. a
// just-found block's record getting clobbered by a slightly-delayed periodic save that
// started just before it. Chaining every write onto the same promise guarantees they land
// on disk in the order they were called, so the last call made always wins.
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
