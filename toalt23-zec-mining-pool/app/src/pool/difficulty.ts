export interface DifficultyPreset {
  key: string;
  label: string;
  shareDifficulty: number;
}

// Selected via the stratum **password** field on mining.authorize (ZIP-301's
// `mining.authorize("<worker>", "<password>")`), not a worker-name suffix —
// so the worker name a miner reports is shown back exactly as-is, no
// ".<preset>" mangling (see StratumService#parsePasswordPreset). Fixed
// difficulty values rather than hashrate-derived ones: simpler for the user
// to reason about ("set password to high") than picking the ASIC model
// that happens to match a target share interval.
export const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  { key: 'low', label: 'Low (difficulty 16)', shareDifficulty: 16 },
  { key: 'medium', label: 'Medium (difficulty 128)', shareDifficulty: 128 },
  { key: 'high', label: 'High (difficulty 256)', shareDifficulty: 256 },
];

function resolveDefaultPresetKey(): string {
  const fromEnv = process.env.POOL_SHARE_DIFFICULTY_PRESET;
  if (fromEnv && DIFFICULTY_PRESETS.some((p) => p.key === fromEnv))
    return fromEnv;
  return 'medium';
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

// Same difficulty/hashrate relationship SHA256 pools use (time ≈ difficulty
// * 2^32 / hashrate): Zcash's compact-difficulty encoding was deliberately
// kept numerically compatible with Bitcoin's, and existing Equihash pool
// software (z-nomp, miningcore) reuses this same constant for Sol/s. Used
// below to estimate a worker's hashrate from its accepted share difficulties.
const TWO_POW_32 = 2 ** 32;

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
