// Unified betting helpers: labels, preview, buckets

import { bucketFromPct, pctForBucket } from '../core/config.js';

export function contextLabels({ toCall }) {
  const facingBet = (toCall ?? 0) > 0;
  return {
    passiveLeft: 'Fold',
    middle: facingBet ? `Call £${toCall.toFixed(0)}` : 'Check',
    agg: facingBet ? 'Raise' : 'Bet',
    facingBet
  };
}

// Derive bucket name from selected %; if user picked a bucket only, choose default % for that bucket
export function resolvePct({ selectedPct, selectedBucket }) {
  if (selectedPct != null) return selectedPct;
  if (!selectedBucket) return null;
  return pctForBucket(selectedBucket);
}

export function bucketOfPct(pct) {
  return bucketFromPct(pct);
}
