export interface DifficultyPreset {
  key: string;
  label: string;
  shareDifficulty: number;
}

// Selected via the stratum password field (mining.authorize), not a worker-name suffix.
// Fixed difficulty values, not hashrate-derived — simpler to reason about ("password: high").
export const DIFFICULTY_PRESETS: DifficultyPreset[] = [
  { key: 'low', label: 'Low (difficulty 24)', shareDifficulty: 24 },
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

// Bitcoin's hardcoded 2^32 multiplier assumes its own powLimit — wrong for Zcash, previously
// overstated hashrate ~524,288x (confirmed: a real Z9 mini reported GSol/s, not kSol/s).
const TWO_POW_256 = 2 ** 256;

/** diff1Target = currentTarget * currentDifficulty — derived live instead of hardcoding a per-network powLimit constant. */
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

/** Never require a share harder than an actual block (only possible at very low network difficulty) — take the larger/easier of the two targets. */
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
