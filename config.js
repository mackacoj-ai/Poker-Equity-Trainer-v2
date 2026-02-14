// Global config & constants used across modules.

export const TABLE_SIZE = 6; // 6-max

export const SIZE_BUCKETS = {
  small:   { min: 0.25, max: 0.33 },
  medium:  { min: 0.45, max: 0.55 },
  big:     { min: 0.65, max: 1.00 },
  overbet: { min: 1.10, max: 3.00 }
};

export const MODE_STRICTNESS = {
  beginner:     { adjacentIsAmber: true },
  intermediate: { adjacentIsAmber: true },
  expert:       { adjacentIsAmber: false }
};

// Utility: map a pct (0.25) to a named bucket.
export function pctToBucket(pct) {
  const p = Math.max(0, pct);
  for (const [name, {min, max}] of Object.entries(SIZE_BUCKETS)) {
    if (p >= min && p <= max) return name;
  }
  // pick nearest
  let best = 'small', bestDelta = Infinity;
  for (const [name, {min, max}] of Object.entries(SIZE_BUCKETS)) {
    const mid = (min + max) / 2;
    const d = Math.abs(p - mid);
    if (d < bestDelta) { bestDelta = d; best = name; }
  }
  return best;
}

export const POSITIONS = ['UTG','HJ','CO','BTN','SB','BB'];