export interface DifficultyPreset {
  key: string;
  label: string;
  solPerSecond: number;
}

// Real-world Equihash ASICs this pool is expected to see. Add more here if
// needed — the key is what miners select via a ".<key>" worker-name suffix
// (see StratumService#parseWorkerName), e.g. "myworker.z15pro".
export const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  {
    key: 'z9mini',
    label: 'Antminer Z9 mini (~10 kSol/s)',
    solPerSecond: 10_000,
  },
  { key: 'z15', label: 'Antminer Z15 (~420 kSol/s)', solPerSecond: 420_000 },
  {
    key: 'z15pro',
    label: 'Antminer Z15 Pro (~840 kSol/s)',
    solPerSecond: 840_000,
  },
];

function resolveDefaultPresetKey(): string {
  const fromEnv = process.env.POOL_SHARE_DIFFICULTY_PRESET;
  if (fromEnv && DIFFICULTY_PRESETS.some((p) => p.key === fromEnv))
    return fromEnv;
  return 'z15';
}

export const DEFAULT_PRESET_KEY = resolveDefaultPresetKey();

export function presetByKey(key: string): DifficultyPreset | undefined {
  return DIFFICULTY_PRESETS.find((p) => p.key === key);
}

/** Like presetByKey, but always returns something — falls back to the pool default preset, which is always a valid key. */
export function resolvePreset(key: string): DifficultyPreset {
  const found = presetByKey(key) ?? presetByKey(DEFAULT_PRESET_KEY);
  if (!found) {
    // Unreachable unless DIFFICULTY_PRESETS is emptied out — fail loudly rather than silently mining at the wrong difficulty.
    throw new Error(
      `No difficulty preset found for "${key}" and default "${DEFAULT_PRESET_KEY}" is also missing`,
    );
  }
  return found;
}

// How often a worker at its assigned difficulty should, on average, submit a
// share. This reuses the same difficulty/hashrate relationship SHA256 pools
// use (time ≈ difficulty * 2^32 / hashrate): Zcash's compact-difficulty
// encoding was deliberately kept numerically compatible with Bitcoin's, and
// existing Equihash pool software (z-nomp, miningcore) reuses this same
// constant for Sol/s. It's a UX tuning knob, not a consensus rule — getting
// it slightly wrong only changes how chatty a miner is, never correctness.
export const TARGET_SHARE_INTERVAL_SECONDS = 15;
const TWO_POW_32 = 2 ** 32;
export const MIN_SHARE_DIFFICULTY = 0.001;

export function shareDifficultyForPreset(preset: DifficultyPreset): number {
  const diff =
    (preset.solPerSecond * TARGET_SHARE_INTERVAL_SECONDS) / TWO_POW_32;
  return Math.max(diff, MIN_SHARE_DIFFICULTY);
}

/**
 * diff1Target is the target corresponding to "difficulty 1" (i.e. the
 * network's powLimit). We derive it live from the node instead of hardcoding
 * a per-network constant: difficulty = diff1Target / currentTarget, so
 * diff1Target = currentTarget * currentDifficulty.
 */
export function diff1TargetFrom(
  currentTarget: bigint,
  currentDifficulty: number,
): bigint {
  const PRECISION = 1_000_000n;
  const scaledDifficulty = BigInt(Math.round(currentDifficulty * 1_000_000));
  return (currentTarget * scaledDifficulty) / PRECISION;
}

export function shareDifficultyToTarget(
  diff1Target: bigint,
  shareDifficulty: number,
): bigint {
  const PRECISION = 1_000_000n;
  const scaled = BigInt(Math.max(1, Math.round(shareDifficulty * 1_000_000)));
  return (diff1Target * PRECISION) / scaled;
}

/**
 * Never require a share to be harder than an actual block would be — if a
 * worker's preset implies a stricter target than the current network target
 * (only realistically possible at very low network difficulty), fall back to
 * the network target so every share the worker finds is potentially a block.
 * In target terms "harder" means numerically smaller, so this takes the
 * larger (easier) of the two.
 */
export function clampShareTarget(
  desired: bigint,
  networkTarget: bigint,
): bigint {
  return desired > networkTarget ? desired : networkTarget;
}

export function difficultyFromHash(diff1Target: bigint, hash: bigint): number {
  if (hash <= 0n) return Number(diff1Target);
  return Number(diff1Target) / Number(hash);
}

/** Rough hashrate estimate from accepted share difficulties over a window — inverse of the target-interval calc above. */
export function estimateHashrate(
  totalShareDifficulty: number,
  windowSeconds: number,
): number {
  if (windowSeconds <= 0) return 0;
  return (totalShareDifficulty * TWO_POW_32) / windowSeconds;
}
