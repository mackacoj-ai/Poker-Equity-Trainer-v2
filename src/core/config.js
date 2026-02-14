// /src/core/config.js
// Canonical config + helpers used by features/ui modules (sizing, strictness, etc.)

export const TABLE_SIZE = 6; // 6-max

// Size buckets as % of pot (inclusive ranges)
export const SIZE_BUCKETS = {
  small:   { min: 0.25, max: 0.35 },
  medium:  { min: 0.45, max: 0.55 },
  big:     { min: 0.65, max: 1.00 },
  overbet: { min: 1.10, max: 3.00 } // cap at 300% for sanity
};

// UI labels for buckets
export const BUCKET_LABEL = {
  small:   "Small (25–33%)",
  medium:  "Medium (45–55%)",
  big:     "Big (65–100%)",
  overbet: "Overbet (110%+)"
};

// Difficulty → grading strictness
export function strictnessFor(difficulty) {
  return difficulty === 'expert' ? 'strict' : 'forgiving';
}

// Map % → bucket name (or null if outside all ranges)
export function bucketFromPct(pct) {
  if (pct == null || !isFinite(pct)) return null;
  const p = Math.max(0, pct);
  if (p >= SIZE_BUCKETS.overbet.min) return 'overbet';
  if (p >= SIZE_BUCKETS.big.min && p <= SIZE_BUCKETS.big.max) return 'big';
  if (p >= SIZE_BUCKETS.medium.min && p <= SIZE_BUCKETS.medium.max) return 'medium';
  if (p >= SIZE_BUCKETS.small.min && p <= SIZE_BUCKETS.small.max) return 'small';
  return null;
}

// Pick a representative % for a given bucket
export function pctForBucket(bucket) {
  switch (bucket) {
    case 'small':   return 0.33;
    case 'medium':  return 0.50;
    case 'big':     return 0.75;
    case 'overbet': return 1.25;
    default:        return null;
  }
}

// Adjacent-ness used for forgiving modes (Beginner/Intermediate)
const ORDER = ['small','medium','big','overbet'];
export function isAdjacentBucket(a, b) {
  if (!a || !b) return false;
  const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
  return Math.abs(ia - ib) === 1;
}
