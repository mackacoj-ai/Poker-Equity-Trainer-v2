// Board texture categorizer (wraps lightweight analysis -> canonical category)

export function categorizeFlop(boardCards) {
  // boardCards: [{rank:'A', suit:'\u2660'}, ...] length 3 on flop
  if (!boardCards || boardCards.length < 3) return 'Other';

  const ranks = boardCards.map(c => c.rank);
  const suits = boardCards.map(c => c.suit);
  const countsByRank = {};
  const countsBySuit = {};
  ranks.forEach(r => countsByRank[r] = (countsByRank[r] ?? 0) + 1);
  suits.forEach(s => countsBySuit[s] = (countsBySuit[s] ?? 0) + 1);

  const isPaired = Object.values(countsByRank).some(v => v >= 2);
  const suitCounts = Object.values(countsBySuit).sort((a,b)=>b-a);
  const monotone = suitCounts[0] === 3;
  const twoTone = suitCounts[0] === 2;

  const R = '23456789TJQKA';
  const vals = ranks.map(r => R.indexOf(r)).sort((a,b)=>a-b);
  const highA = ranks.includes('A');
  const highKQ = ranks.some(r => r === 'K' || r === 'Q');

  // connectedness (simple)
  const gap1 = vals[1]-vals[0];
  const gap2 = vals[2]-vals[1];
  const connectedish = (gap1<=2 && gap2<=2);

  if (highA && !monotone && !isPaired && !connectedish) return 'A-high-dry';
  if (!highA && highKQ && !monotone && !isPaired && !connectedish) return 'KQ-high-dry';
  if (isPaired && !monotone) return 'Paired';
  if (monotone) return 'Monotone';
  if (!connectedish && !twoTone) return 'Low-disconnected';
  if (connectedish && (twoTone || !twoTone)) {
    // choose more dynamic labels for straighty/flushy
    if (twoTone) return 'Low-connected-two-tone';
    return 'Dynamic-straighty';
  }
  return 'Other';
}
