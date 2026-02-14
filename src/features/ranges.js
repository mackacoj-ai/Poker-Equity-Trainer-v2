// Tight/Aggressive open-range “shapes” + checker

const TA_SHAPES = {
  UTG: {
    pairsMin: '77',
    suitedAces: ['ATs+'],
    suitedBroadways: ['KQs','KJs','QJs'],
    offsuit: ['AQo+','KQo'],
    mix: ['A5s','A4s']
  },
  HJ: {
    pairsMin: '66',
    suitedAces: ['ATs+','A5s','A4s'],
    suitedBroadways: ['KQs','KJs','QJs','KTs','QTs','JTs'],
    offsuit: ['AQo+','KQo','KJo'],
    sc: ['T9s','98s']
  },
  CO: {
    pairsMin: '55',
    suitedAces: ['A2s+'],
    suitedBroadways: ['KQs','KJs','QJs','KTs','QTs','JTs'],
    offsuit: ['AQo+','KQo','KJo','QJo'],
    sc: ['T9s','98s','87s','76s'],
    sg: ['T8s','97s']
  },
  BTN: {
    pairsMin: '22',
    suitedAces: ['A2s+'],
    suitedBroadways: ['KQs','KJs','QJs','KTs','QTs','JTs'],
    offsuit: ['AJo+','KQo','KJo','QJo'],
    sc: ['T9s','98s','87s','76s','65s'],
    sg: ['J9s','T8s','97s','86s','75s']
  },
  SB: {
    pairsMin: '66',
    suitedAces: ['A5s+','ATs+'],
    suitedBroadways: ['KQs','KJs','QJs'],
    offsuit: ['AQo+','KQo']
  },
  BB: {
    pairsMin: '66',
    suitedAces: ['A5s+','ATs+'],
    suitedBroadways: ['KQs','KJs','QJs'],
    offsuit: ['AQo+','KQo']
  }
};

// Convert 'A'|'K'...'2' to order index
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
function rankVal(r){ return RANKS.indexOf(r); }

function isPair(combo){ return combo.length===2 && combo[0]===combo[1]; }
function isSuited(combo){ return combo.endsWith('s'); }
function isOffsuit(combo){ return combo.endsWith('o'); }

// combo format examples: 'AA','AKs','AQo','T9s','65s'
export function isInOpenRange(combo, position) {
  const shape = TA_SHAPES[position];
  if (!shape) return false;

  if (isPair(combo)) {
    const min = shape.pairsMin || '99';
    return rankVal(combo[0]) >= rankVal(min[0]);
  }

  if (isSuited(combo)) {
    // Suited broadways/connectors/gappers
    const bare = combo.slice(0,2); // e.g., 'AK'
    const list = [
      ...(shape.suitedAces || []),
      ...(shape.suitedBroadways || []),
      ...(shape.sc || []),
      ...(shape.sg || []),
      ...(shape.mix || [])
    ];

    // handle 'ATs+' pattern
    for (const pat of list) {
      if (pat.endsWith('+') && pat.includes('As')) {
        // Axs+
        if (bare[0]==='A') return true;
      } else if (pat.endsWith('+') && pat.length===4) {
        // like 'ATs+': A + X suited with X >= T
        if (bare[0]==='A' && rankVal(bare[1]) >= rankVal(pat[1])) return true;
      } else {
        // exact like 'KQs','T9s'
        if (pat.slice(0,2) === bare) return true;
      }
    }
    return false;
  }

  if (isOffsuit(combo)) {
    const bare = combo.slice(0,2);
    const list = shape.offsuit || [];
    for (const pat of list) {
      if (pat.endsWith('+')) {
        // e.g., 'AQo+'
        const hi = pat[0]; // 'A'
        const lo = pat[1]; // 'Q'
        if (bare[0] === hi && rankVal(bare[1]) >= rankVal(lo)) return true;
      } else {
        if (pat.slice(0,2) === bare) return true;
      }
    }
    return false;
  }

  // suited/offsuit omitted implies exact match broadway like 'AK' (treat as offsuit block if listed)
  return false;
}

export function rangeShapeFor(position) {
  return TA_SHAPES[position] || {};
}
