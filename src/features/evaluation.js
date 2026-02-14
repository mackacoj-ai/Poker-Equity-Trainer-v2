// Betting evaluation (cbet/barrel + size) with mode strictness

import { strictnessFor, isAdjacentBucket } from '../core/config.js';

export function gradeSize({ chosenBucket, policyBuckets, difficulty }) {
  if (!chosenBucket) return { grade: 'red', reason: 'No size selected' };
  if (!policyBuckets || policyBuckets.length === 0) return { grade: 'amber', reason: 'No policy for texture' };

  const strict = strictnessFor(difficulty) === 'strict';
  if (policyBuckets.includes(chosenBucket)) {
    return { grade: 'green', reason: 'Size matches policy' };
  }
  // forgiving path: adjacent is Amber unless strict
  const neighbor = policyBuckets.some(b => isAdjacentBucket(chosenBucket, b));
  if (neighbor) return { grade: strict ? 'red' : 'amber', reason: strict ? 'Adjacent size (strict mode)' : 'Adjacent size (ok in this mode)' };

  return { grade: 'red', reason: 'Off-policy size' };
}

// freq: 'high'|'med'|'medlow'|'low'
export function gradeAggression({ actedAggressively, freq, difficulty, street }) {
  const strict = strictnessFor(difficulty) === 'strict';
  const s = street || 'flop';

  const weights = {
    high:   actedAggressively ? 'green' : (strict ? 'red' : 'amber'),
    med:    actedAggressively ? 'green' : 'amber',
    medlow: actedAggressively ? (strict ? 'red' : 'amber') : 'green',
    low:    actedAggressively ? (strict ? 'red' : 'amber') : 'green'
  };

  return { grade: weights[freq] ?? 'amber' };
}
