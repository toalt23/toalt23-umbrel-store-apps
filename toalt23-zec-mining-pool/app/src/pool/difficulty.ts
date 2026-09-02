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
  { key: 'low', label: 'Low (difficulty 19)', shareDifficulty: 19 },
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

// Bitcoin pools estimate hashrate as difficulty * 2^32 / time because
// Bitcoin's own "difficulty 1" target sits at ~2^224, and 2^256 / 2^224 =
// 2^32. That constant is NOT chain-agnostic — it only holds because of
// where Bitcoin's powLimit happens to sit. Zcash's powLimit (and therefore
// diff1Target, derived live below) is far higher/easier, around 2^243, so
// reusing a hardcoded 2^32 here previously overstated every hashrate
// estimate by roughly 2^(243-224) = 2^19 (~524,288x) — confirmed against a
// real Antminer Z9 mini, which reported GSol/s instead of its real ~12-14
// kSol/s. Deriving the multiplier from the actual diff1Target instead
// keeps this correct regardless of which chain/powLimit is running.
const TWO_POW_256 = 2 ** 256;

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
  diff1Target: bigint,
): number {
  if (windowSeconds <= 0 || diff1Target <= 0n) return 0;
  const multiplier = TWO_POW_256 / Number(diff1Target);
  return (totalShareDifficulty * multiplier) / windowSeconds;
}
