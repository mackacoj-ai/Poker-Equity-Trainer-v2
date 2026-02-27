// ==================== Core state ====================
const STAGES = ["preflop", "flop", "turn", "river"];
let deck = [];
let holeCards = [];
let boardCards = [];
let currentStageIndex = 0;
let pot = 0;
let toCall = 0;
let scenario = null;
let timerSeconds = 10;
let timerId = null;
let timeLeft = null;
let difficulty = "beginner";
let handHistory = [];
let sessionHistory = [];

// ==================== Postflop / Preflop Shared Engine State ====================
const ENGINE = {
  survivors: new Set(),
  survivorsByStreet: { flop: [], turn: [], river: [] },
  lastStreetComputed: 'preflop',
  preflop: {
    openerSeat: null,
    threeBetterSeat: null,
    coldCallers: [],       // optional memo for preflop labelling
    participants: [],      // who put money in preflop
    openToBb: null,        // opener raise-to (in BB) – set by preflop engine
    threeBetToBb: null     // 3-bet raise-to (in BB) – set by preflop engine
  },
  // track statuses: "in", "folded_now", "folded_prev"
  statusBySeat: {
    UTG: 'in',
    HJ:  'in',
    CO:  'in',
    BTN: 'in',
    SB:  'in',
    BB:  'in'
  }
};


// ==================== Personalities (session-level) ====================
// Hero is never assigned a sampled personality.
const HERO_LETTER = "H";
const VILLAIN_LETTERS = ["A","B","C","D","E"];      // 5 villains in 6-max
let VILLAIN_LETTERS_RING = null;                    // rotates around seats hand-to-hand

// Frequencies from your doc: TAG≈40, LAG≈15, STATION≈20, NIT≈15, MANIAC≈3 (normalized)
const PERSONALITY_WEIGHTS = { TAG: 40, LAG: 15, STATION: 20, NIT: 15, MANIAC: 3 }; // doc guidance
const PERSONALITY_INFO = {
  TAG:     { label: "TAG — Tight‑Aggressive",    how: "Plays selective ranges, applies pressure; folds when dominated.",  spot: "Small frequent c-bets on A‑high rainbow; disciplined turn barrels." },
  LAG:     { label: "LAG — Loose‑Aggressive",    how: "Wider opens/defends; higher aggression across streets.",          spot: "Expect stabs & double‑barrels; call wider vs large bluffs; 4‑bet selectively." },
  STATION: { label: "Loose‑Passive (Station)",    how: "Too many calls; rarely bluffs or raises.",                        spot: "Value‑bet thinner; avoid big multi‑street bluffs." },
  NIT:     { label: "Nit / Rock",                 how: "Very tight; folds too much; strong when continuing.",            spot: "Steal often; give credit when they show strength." },
  MANIAC:  { label: "Maniac",                     how: "Very high VPIP & aggression; over‑bluffs.",                      spot: "Trap pre; induce; call down with good bluff‑catchers; avoid thin bluffs." }
};

// ===== Hand family helpers for archetype scaling =====
function handCodeFamily(code) {
  // 'AA', 'AKs', 'AQo', etc.
  if (!code || typeof code !== 'string') return 'other';
  const pair = /^[2-9TJQKA]\1$/.test(code);
  if (pair) return 'pairs';
  const suited = code.endsWith('s');
  const offsuit = code.endsWith('o');
  const hi = code[0], lo = code[1];

  // Broadways set
  const BW = new Set(["A","K","Q","J","T"]);
  const isBW = BW.has(hi) && BW.has(lo);

  if (suited && isBW) return 'suited_broadways';
  if (offsuit && isBW) return 'offsuit_broadways';

  // Ax families
  if (hi === 'A' && suited) return 'suited_ax';
  if (hi === 'A' && offsuit) return 'offsuit_ax';

  // Connectors / gappers (rank index diff = 1 or 2, ignoring A-low edge cases)
  const order = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];
  const iHi = order.indexOf(hi), iLo = order.indexOf(lo);
  if (iHi >= 0 && iLo > iHi) {
    const gap = (iLo - iHi) - 1; // e.g., KQ -> 0, KJ -> 1, KT -> 2
    if (suited && gap === 0) return 'suited_connectors';
    if (suited && gap === 1) return 'suited_one_gappers';
  }

  // Junk buckets
  if (suited)  return 'suited_junk';
  if (offsuit) return 'offsuit_junk';
  return 'other';
}

// ===== Archetype numeric modifiers (multipliers applied to base weights) =====
// 1.00 = neutral; >1 widen; <1 tighten.
// Keep conservative to stay stable on mobile with modest trials.
const ARCHETYPE_MODIFIERS = {
  TAG: { // Tight-Aggressive baseline
    pairs:1.05, suited_broadways:1.00, offsuit_broadways:0.95,
    suited_ax:0.95, offsuit_ax:0.90,
    suited_connectors:0.90, suited_one_gappers:0.88,
    suited_junk:0.80, offsuit_junk:0.75, other:0.95
  },
  LAG: { // Loose-Aggressive widens suited/gappers
    pairs:0.98, suited_broadways:1.08, offsuit_broadways:1.05,
    suited_ax:1.10, offsuit_ax:1.00,
    suited_connectors:1.25, suited_one_gappers:1.20,
    suited_junk:1.15, offsuit_junk:1.10, other:1.05
  },
  STATION: { // Calls too much (widen junk/off-broadways)
    pairs:1.00, suited_broadways:1.05, offsuit_broadways:1.12,
    suited_ax:1.05, offsuit_ax:1.10,
    suited_connectors:1.10, suited_one_gappers:1.05,
    suited_junk:1.20, offsuit_junk:1.30, other:1.08
  },
  NIT: { // Very tight except premiums
    pairs:1.12, suited_broadways:1.05, offsuit_broadways:0.80,
    suited_ax:0.80, offsuit_ax:0.70,
    suited_connectors:0.70, suited_one_gappers:0.65,
    suited_junk:0.50, offsuit_junk:0.40, other:0.75
  },
  MANIAC: { // Very wide + aggro; keep preflop still plausible
    pairs:0.95, suited_broadways:1.15, offsuit_broadways:1.20,
    suited_ax:1.15, offsuit_ax:1.10,
    suited_connectors:1.30, suited_one_gappers:1.30,
    suited_junk:1.25, offsuit_junk:1.20, other:1.15
  }
};

// Map seat -> archetype (falls back to TAG if undefined)
function seatArchetype(seat) {
  try {
    const letter = LETTERS_BY_POSITION?.[seat];
    const key = SESSION_PERSONA_BY_LETTER?.[letter]; // 'TAG','LAG','STATION','NIT','MANIAC'
    return (ARCHETYPE_MODIFIERS[key]) ? key : 'TAG';
  } catch(e){ return 'TAG'; }
}

// ===== Range → weight map utilities =====

// 1) Convert class -> base numeric weight
function classToWeight(cls){ // 'open'|'mix'|'fold'
  if (cls === 'open') return 1.0;
  if (cls === 'mix')  return 0.5;
  return 0.0;
}

// 2) JSON frequency -> weight (fallback if you have numeric freq)
function freqToWeight(freq){
  if (freq == null) return 0.0;
  const f = Number(freq);
  if (!Number.isFinite(f)) return 0.0;
  if (f >= 0.67) return 1.0;
  if (f >= 0.15) return 0.5;
  return 0.0;
}

// 3) Build code->class map for OPEN from your existing helpers/JSON
function classMapOpenForSeat(seat){
  // Prefer JSON open if present
  try{
    const buck = RANGES_JSON?.open?.[seat];
    if (buck){
      const m = new Map();
      for (const [code, freq] of Object.entries(buck)){
        const w = freqToWeight(freq);
        m.set(code, (w >= 1.0 ? 'open' : (w >= 0.5 ? 'mix':'fold')));
      }
      return m;
    }
  }catch(e){}

  // Fallback to your explicit/hybrid builder (already in your file)
  try{
    return getClassMapForSeat(seat); // returns Map<code,'open'|'mix'|'fold'>
  }catch(e){}

  return new Map();
}

// 4) Build code->class for 3-bet (seat vs opener), prefer JSON then hybrid tokens
function classMap3Bet(seat, opener){
  // JSON possible key: `${seat}_vs_${opener}`
  try{
    const key = `${seat}_vs_${opener}`;
    const buck = RANGES_JSON?.three_bet?.[key];
    if (buck){
      const m = new Map();
      for (const [code, freq] of Object.entries(buck)){
        const w = freqToWeight(freq);
        m.set(code, (w >= 1.0 ? 'open' : (w >= 0.5 ? 'mix':'fold')));
      }
      return m;
    }
  }catch(e){}

  // Hybrid token fallback from your built-ins
  try{
    const lists = HYBRID_3BET_RANGES?.[seat]?.[opener] ?? null; // {open:[tokens], mix:[tokens]}
    if (lists){
      const openSet = new Set((lists.open ?? []).flatMap(expandToken));
      const mixSet  = new Set((lists.mix  ?? []).flatMap(expandToken));
      const m = new Map();
      // Populate the 169 universe quickly:
      for (let i=0;i<RANKS_ASC.length;i++){
        for (let j=0;j<RANKS_ASC.length;j++){
          let code;
          if (i===j) code = RANKS_ASC[i]+RANKS_ASC[j];
          else if (i<j){ code = RANKS_ASC[i]+RANKS_ASC[j]+'s'; }
          else { code = RANKS_ASC[j]+RANKS_ASC[i]+'o'; }
          if (openSet.has(code)) m.set(code,'open');
          else if (mixSet.has(code)) m.set(code,'mix');
          else m.set(code,'fold');
        }
      }
      return m;
    }
  }catch(e){}

  return new Map();
}

// 5) Build code->class for DEFEND/CALL (seat vs opener), prefer JSON then hybrid defend
function classMapDefend(seat, opener){
  // JSON BB defend uses defend[`BB_vs_${opener}`]; others may be vs_open key
  try{
    if (seat === 'BB'){
      const key = `BB_vs_${opener}`;
      const buck = RANGES_JSON?.defend?.[key];
      if (buck){
        const m = new Map();
        for (const [code, freq] of Object.entries(buck)){
          const w = freqToWeight(freq);
          m.set(code, (w >= 1.0 ? 'open' : (w >= 0.5 ? 'mix':'fold')));
        }
        return m;
      }
    } else {
      const key = `${seat}_vs_${opener}`;
      const callObj = RANGES_JSON?.vs_open?.[key]?.call;
      if (callObj){
        const m = new Map();
        for (const [code, freq] of Object.entries(callObj)){
          const w = freqToWeight(freq);
          m.set(code, (w >= 1.0 ? 'open' : (w >= 0.5 ? 'mix':'fold')));
        }
        return m;
      }
    }
  }catch(e){}

  // Hybrid defend fallback keyed by opener seat
  try{
    const lists = HYBRID_DEFEND_RANGES?.[opener] ?? null; // {open:[tokens], mix:[tokens]}
    if (lists){
      const openSet = new Set((lists.open ?? []).flatMap(expandToken));
      const mixSet  = new Set((lists.mix  ?? []).flatMap(expandToken));
      const m = new Map();
      for (let i=0;i<RANKS_ASC.length;i++){
        for (let j=0;j<RANKS_ASC.length;j++){
          let code;
          if (i===j) code = RANKS_ASC[i]+RANKS_ASC[j];
          else if (i<j){ code = RANKS_ASC[i]+RANKS_ASC[j]+'s'; }
          else { code = RANKS_ASC[j]+RANKS_ASC[i]+'o'; }
          if (openSet.has(code)) m.set(code,'open');
          else if (mixSet.has(code)) m.set(code,'mix');
          else m.set(code,'fold');
        }
      }
      return m;
    }
  }catch(e){}

  return new Map();
}

// 6) Build a seat's PRE-FLOP code->weight map based on its role this hand
function buildPreflopWeightMapForSeat(seat){
  const role = (() => {
    const op  = ENGINE?.preflop?.openerSeat ?? null;
    const thb = ENGINE?.preflop?.threeBetterSeat ?? null;
    const ccs = new Set(ENGINE?.preflop?.coldCallers ?? []);
    if (seat === op)  return 'opener';
    if (seat === thb) return 'three_better';
    if (ccs.has(seat)) return 'cold_caller';
    // unopened pot: use open map for the seat
    return 'unopened';
  })();

  let classMap = new Map();
  const opener = ENGINE?.preflop?.openerSeat ?? null;

  if (role === 'opener' || role === 'unopened'){
    classMap = classMapOpenForSeat(seat);
  } else if (role === 'three_better'){
    classMap = classMap3Bet(seat, opener);
  } else if (role === 'cold_caller'){
    classMap = classMapDefend(seat, opener);
  }

  // Convert class -> base weight
  const base = new Map();
  for (const [code, cls] of classMap.entries()) {
    base.set(code, classToWeight(cls));
  }

  // Apply archetype multipliers by hand family
  const archKey = seatArchetype(seat);
  const mods = ARCHETYPE_MODIFIERS[archKey] ?? ARCHETYPE_MODIFIERS.TAG;
  const out = new Map();
  for (const [code, w] of base.entries()){
    if (w <= 0) { out.set(code, 0); continue; }
    const fam = handCodeFamily(code);
    const mult = (mods[fam] ?? 1.0);
    out.set(code, Math.max(0, w * mult));
  }
  return out;
}

// ===== Weighted sampler (code-level alias) + combo instantiation =====

// Count available suit-combos for a code after blocking hero+board cards
function availableComboCountForCode(code, blockedCards){
  // pairs: 6 combos; suited non-pair: 4; offsuit non-pair: 12
  // But remove any combos using blocked cards.
  const combos = enumerateCombosForCode(code);
  let cnt = 0;
  for (const [c1,c2] of combos){
    if (!containsCard(blockedCards, c1) && !containsCard(blockedCards, c2)) cnt++;
  }
  return cnt;
}

// Enumerate all 2-card combos for a given code (e.g., 'AKs','AKo','AA')
function enumerateCombosForCode(code){
  // Uses global SUITS and RANKS_ASC from your file
  const r1 = code[0], r2 = code[1];
  const suited = code.endsWith('s');
  const offsuit = code.endsWith('o');
  const pair = (r1 === r2);

  const makeCard = (rank,suit) => ({ rank, suit });

  const res = [];
  if (pair){
    // Choose any 2 distinct suits out of 4: 6 combos
    for (let i=0;i<SUITS.length;i++){
      for (let j=i+1;j<SUITS.length;j++){
        res.push([ makeCard(r1, SUITS[i]), makeCard(r1, SUITS[j]) ]);
      }
    }
    return res;
  }
  if (suited){
    // Same suit: 4 combos
    for (let s=0;s<SUITS.length;s++){
      res.push([ makeCard(r1, SUITS[s]), makeCard(r2, SUITS[s]) ]);
    }
    return res;
  }
  // Offsuit distinct suits: 12 combos
  for (let sa=0; sa<SUITS.length; sa++){
    for (let sb=0; sb<SUITS.length; sb++){
      if (sa === sb) continue;
      res.push([ makeCard(r1, SUITS[sa]), makeCard(r2, SUITS[sb]) ]);
    }
  }
  return res;
}

// Simple alias table for codes
function buildAliasTable(codeWeightsMap, blockedCards){
  // Build arrays of codes and adjusted weights = baseWeight * availableCombos
  const codes = [];
  const weights = [];
  for (const [code, w] of codeWeightsMap.entries()){
    if (w <= 0) continue;
    const count = availableComboCountForCode(code, blockedCards);
    if (count <= 0) continue;
    codes.push(code);
    weights.push(w * count);
  }
  if (codes.length === 0) return null;

  // Normalize
  const total = weights.reduce((a,b)=>a+b,0);
  const probs = weights.map(w=>w/Math.max(1e-12,total));

  // Vose alias setup
  const n = probs.length;
  const scaled = probs.map(p => p * n);
  const small = [], large = [];
  const alias = new Array(n).fill(0);
  const prob  = new Array(n).fill(0);

  for (let i=0;i<n;i++) (scaled[i] < 1 ? small : large).push(i);
  while (small.length && large.length){
    const l = small.pop(), g = large.pop();
    prob[l] = scaled[l];
    alias[l] = g;
    scaled[g] = (scaled[g] + scaled[l]) - 1;
    (scaled[g] < 1 ? small : large).push(g);
  }
  while (large.length){ prob[large.pop()] = 1; }
  while (small.length){ prob[small.pop()] = 1; }

  return { codes, prob, alias };
}

function aliasPick(tbl){
  const n = tbl.prob.length;
  const i = Math.floor(Math.random()*n);
  const u = Math.random();
  return (u < tbl.prob[i]) ? tbl.codes[i] : tbl.codes[tbl.alias[i]];
}

// Pick a concrete 2-card combo for a code, avoiding collisions with 'used' cards
function pickComboForCode(code, usedCards){
  const combos = enumerateCombosForCode(code);
  // Shuffle small array for fairness
  for (let i=combos.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  for (const [c1,c2] of combos){
    if (!containsCard(usedCards, c1) && !containsCard(usedCards, c2)){
      return [c1,c2];
    }
  }
  return null;
}

// ===== New range-aware Monte Carlo equity engine =====

// Determine street from board length
function streetFromBoardLen(n){ return (n===0?'preflop':(n===3?'flop':(n===4?'turn':'river'))); }

// Live villain seats for this board (preflop uses participants when available)
function liveVillainSeats(board){
  const hero = currentPosition();
  const n = board.length;
  if (n === 0){
    const parts = ENGINE?.preflop?.participants ?? [];
    const seats = parts.filter(s => s !== hero);
    if (seats.length > 0) return seats;
    // Fallback: pick next seat in order (one opponent) to avoid 5-way bias
    const order = ["UTG","HJ","CO","BTN","SB","BB"];
    const iHero = order.indexOf(hero);
    for (let k=1;k<order.length;k++){
      const s = order[(iHero+k) % order.length];
      if (s !== hero) return [s];
    }
    return ["BB"];
  }
  // Flop/turn/river: use survivors set (exclude hero)
  try{
    if (ENGINE.lastStreetComputed !== streetFromBoardLen(n)){
      engineRecomputeSurvivorsForStreet(board); // keep in sync
    }
  }catch(e){}
  const inSet = new Set(ENGINE?.survivors ?? []);
  const out = [...inSet].filter(s => s !== hero);
  return (out.length ? out : ["BB"]);
}

// Build per-seat alias tables once per street
function buildSeatAliases(board){
  const blocked = [...board, ...holeCards]; // hero+board blocked
  const seats = liveVillainSeats(board);
  const aliasBySeat = {};
  const weightMapBySeat = {};
  for (const seat of seats){
  let wm = buildPreflopWeightMapForSeat(seat); // role-aware preflop

// --- NEW: post-flop narrowing ---
if (board.length >= 3){
  wm = narrowPostflopWeights(wm, holeCards, board);
}

// Build alias table
const tbl = buildAliasTable(wm, blocked);
    if (tbl && tbl.codes.length){
      aliasBySeat[seat] = tbl;
      weightMapBySeat[seat] = wm;
    }
  }
  return { seats, aliasBySeat, weightMapBySeat };
}

// Sample one concrete villain hand for a seat
function sampleSeatHand(seat, tbl, used, debugSamples){
  if (!tbl) return null;
  const MAX_TRIES = 40;
  for (let t=0;t<MAX_TRIES;t++){
  const code = aliasPick(tbl);
// Debug stats
if (SHOW_SAMPLER_DEBUG){
    if (!debugSamples[seat]) debugSamples[seat] = {};
    debugSamples[seat][code] = (debugSamples[seat][code] ?? 0) + 1;
}

const picked = pickComboForCode(code, used);
    if (picked){
      return picked;
    }
  }
  return null;
}

function newEquityEngineCompute(hole, board){

// Track how often each code is sampled per seat
  const debugSamples = {};  
  const stage = streetFromBoardLen(board.length);
  const trialsPreset = SETTINGS?.trialsByStage?.[stage] ?? 4000;
  const trials = Math.max(250, trialsPreset); // keep a sane floor

  let wins=0, ties=0, losses=0, equityAcc=0;
  const catCount = new Map();
  const { seats, aliasBySeat } = buildSeatAliases(board);

  for (let t=0; t<trials; t++){
    // Build used set per iteration
    const used = [...hole, ...board];

    // 1) Sample each live villain
    const villains = [];
    for (const seat of seats){
      const tbl = aliasBySeat[seat];
      const vh = sampleSeatHand(seat, tbl, used, debugSamples);
      if (vh){
        villains.push(vh);
        used.push(vh[0], vh[1]);
      }
    }
    if (villains.length === 0){
      // Keep at least one opponent for training feedback
      // Fallback: random two cards from remaining deck
      const simDeck = createDeck().filter(c => !containsCard(used, c));
      if (simDeck.length >= 2){
        const i = Math.floor(Math.random()*simDeck.length);
        let j = Math.floor(Math.random()*simDeck.length);
        if (j===i) j = (j+1)%simDeck.length;
        villains.push([simDeck[i], simDeck[j]]);
        used.push(simDeck[i], simDeck[j]);
      }
    }

    // 2) Complete the board uniformly
    const rest = createDeck().filter(c => !containsCard(used, c));
    const need = 5 - board.length;
    const simBoard = [...board];
    for (let k=0;k<need;k++){
      const idx = Math.floor(Math.random()*rest.length);
      simBoard.push(rest.splice(idx,1)[0]);
    }

    // 3) Evaluate
    const heroScore = evaluate7(hole, simBoard);
    let better=0, equal=0;
    for (const v of villains){
      const vs = evaluate7(v, simBoard);
      const cmp = compareScores(heroScore, vs);
      if (cmp < 0) better++;
      else if (cmp === 0) equal++;
    }

    if (better > 0) { losses++; }
    else if (equal > 0) { ties++; equityAcc += 1/(equal+1); }
    else { wins++; equityAcc += 1; }

    // Track hero's category distribution (optional UI)
    const name = CAT_NAME[heroScore.cat] ?? 'High Card';
    catCount.set(name, (catCount.get(name) ?? 0) + 1);
  }

  const catBreakdown = [];
  for (const [k,v] of catCount.entries()){
    catBreakdown.push({ name:k, pct:(v/trials)*100 });
  }
  // Keep same sort order you use today
  const catOrder = ['Straight Flush','Four of a Kind','Full House','Flush','Straight','Three of a Kind','Two Pair','One Pair','High Card'];
  catBreakdown.sort((a,b)=> {
    const oi = catOrder.indexOf(a.name)-catOrder.indexOf(b.name);
    return (oi!==0?oi:(b.pct-a.pct));
  });

  const equity = (equityAcc/trials)*100;

if (SHOW_SAMPLER_DEBUG){
  console.group("Sampler Debug — Top 10 Codes per Seat");
  for (const seat of Object.keys(debugSamples)){
    const entries = Object.entries(debugSamples[seat])
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10);
    console.log(seat, entries);
  }
  console.groupEnd();
}
  return {
    equity,
    winPct: (wins/trials)*100,
    tiePct: (ties/trials)*100,
    losePct:(losses/trials)*100,
    trials,
    catBreakdown,
    numOpp: Math.max(1, seats.length)
  };
}

// ===== Post-flop range narrowing =====
// Remove weight from hands that are extremely unlikely to continue
// given the board texture (cheap, mobile-safe narrowing).
function narrowPostflopWeights(weightMap, hole, board){
  const tex = analyzeBoard(board, hole); 
  // detectStraightDrawFromAllCards(...) also available
  const { openEnder, gutshot } = detectStraightDrawFromAllCards([...hole, ...board]);

  // Keep families that plausibly continue:
  const keepFamilies = new Set();
  keepFamilies.add('pairs');
  keepFamilies.add('suited_broadways');
  keepFamilies.add('offsuit_broadways');
  keepFamilies.add('suited_ax'); 
  if (openEnder) keepFamilies.add('suited_connectors');
  if (gutshot && tex.moistureBucket !== 'Dry') keepFamilies.add('suited_one_gappers');
  if (tex.paired) keepFamilies.add('pairs');

  const newMap = new Map();
  for (const [code, w] of weightMap.entries()){
    if (w <= 0){ newMap.set(code, 0); continue; }
    const fam = handCodeFamily(code);
    if (!keepFamilies.has(fam)){
      newMap.set(code, w * 0.25);  // softly trim unlikely hands
    } else {
      newMap.set(code, w);
    }
  }
  return newMap;
}

// Session-scoped state
let SESSION_PERSONA_BY_LETTER = null;  // e.g., { A:'TAG', B:'STATION', ... } (villains only)
let LETTERS_BY_POSITION = null;        // e.g., { UTG:'A', HJ:'H', CO:'C', BTN:'E', SB:'B', BB:'D' }

// ---- helpers ----
function normalizeWeights(obj){
  const total = Object.values(obj).reduce((a,b)=>a+b,0) || 1;
  return Object.fromEntries(Object.entries(obj).map(([k,v]) => [k, v/total]));
}
function weightedPick(weightMap){
  const r = Math.random(); let acc=0;
  for (const [k,p] of Object.entries(weightMap)) { acc += p; if (r <= acc) return k; }
  return Object.keys(weightMap).slice(-1)[0];
}

// Sample personalities for villains only (A–E), with 0–1 maniac table control (~30% chance).
function sampleVillainPersonalities(){
  const p = normalizeWeights(PERSONALITY_WEIGHTS);
  const personaByLetter = {};
  let poolLetters = VILLAIN_LETTERS.slice();

  // 0–1 maniac control (≈30% tables have exactly one)
  const hasManiac = Math.random() < 0.30;
  if (hasManiac) {
    const i = Math.floor(Math.random()*poolLetters.length);
    personaByLetter[poolLetters[i]] = 'MANIAC';
    poolLetters.splice(i,1);
  }
  const nonManiacWeights = normalizeWeights({ TAG:p.TAG, LAG:p.LAG, STATION:p.STATION, NIT:p.NIT });
  for (const L of poolLetters) personaByLetter[L] = weightedPick(nonManiacWeights);
  return personaByLetter; // only villains get entries
}

// First load per browser session
function initSessionPersonalities(){
  const savedRaw = sessionStorage.getItem('trainer_personas_v1');

  if (savedRaw){
    const saved = JSON.parse(savedRaw) || {};
    SESSION_PERSONA_BY_LETTER = saved.personaByLetter || null;
    LETTERS_BY_POSITION       = saved.lettersByPosition || null;
    VILLAIN_LETTERS_RING      = saved.villainRing || null;

    // MIGRATION: if no ring saved (older sessions), reconstruct or reseed it
    if (!Array.isArray(VILLAIN_LETTERS_RING) || VILLAIN_LETTERS_RING.length !== 5) {
      const order = ["UTG","HJ","CO","BTN","SB","BB"];
      const maybe = order
        .map(pos => LETTERS_BY_POSITION?.[pos])
        .filter(L => L && L !== HERO_LETTER);

      VILLAIN_LETTERS_RING = (maybe.length === 5)
        ? maybe
        : VILLAIN_LETTERS.slice().sort(() => Math.random() - 0.5);

      sessionStorage.setItem('trainer_personas_v1', JSON.stringify({
        personaByLetter: SESSION_PERSONA_BY_LETTER,
        villainRing: VILLAIN_LETTERS_RING,
        lettersByPosition: LETTERS_BY_POSITION
      }));
    }
  } else {
    // First-time this session
    SESSION_PERSONA_BY_LETTER = sampleVillainPersonalities();
    VILLAIN_LETTERS_RING = VILLAIN_LETTERS.slice().sort(() => Math.random() - 0.5);
    LETTERS_BY_POSITION = { UTG:"A", HJ:"B", CO:"C", BTN:"D", SB:"E", BB:HERO_LETTER };
    sessionStorage.setItem('trainer_personas_v1', JSON.stringify({
      personaByLetter: SESSION_PERSONA_BY_LETTER,
      villainRing: VILLAIN_LETTERS_RING,
      lettersByPosition: LETTERS_BY_POSITION
    }));
  }
}

// ==================== Hero metrics & classification ====================
let HERO_STATS = {
  hands:0,
  vpip:0,   // voluntarily put $ in preflop (call/raise)
  pfr:0,    // raised preflop first-in
  threeBet:0,
  flopCbetOpp:0, flopCbet:0,
  bet:0, raise:0, call:0,
  sawFlop:0, sawTurn:0, sawRiver:0, showdown:0, folded:0
};

// Call each new hand
function heroNewHand(){ HERO_STATS.hands++; }

// Mark street reached (call when a new street is dealt)
function markStreetReached(stage){
  if (stage==='flop') HERO_STATS.sawFlop++;
  if (stage==='turn') HERO_STATS.sawTurn++;
  if (stage==='river') HERO_STATS.sawRiver++;
}

// Preflop update: decision + price context

function updateHeroPreflop(decision /*, _toCall */){
// VPIP counts both opens and calls
 if (decision === 'call' || decision === 'raise') HERO_STATS.vpip++;

if (decision === 'raise') {
 const opener      = ENGINE?.preflop?.openerSeat ?? null;
 const threeBetter = ENGINE?.preflop?.threeBetterSeat ?? null;
// First-in raise (RFI) → PFR
 if (!opener) {
  HERO_STATS.pfr++;
  }
  // Raise vs open (first re-raise) → 3-bet
   else if (opener && !threeBetter) {
      HERO_STATS.threeBet++;
  }

   }
 }

// Postflop update: action label from determinePostflopAction(decision, toCall)
function updateHeroPostflop(stage, actionLabel){
  if (actionLabel === 'bet') HERO_STATS.bet++;
  else if (actionLabel === 'raise') HERO_STATS.raise++;
  else if (actionLabel === 'call') HERO_STATS.call++;

  // Flop c-bet: only when hero was PFR preflop and chooses 'bet' on flop
  if (stage === 'flop' && preflopAggressor === 'hero') {
    HERO_STATS.flopCbetOpp++;
    if (actionLabel === 'bet') HERO_STATS.flopCbet++;
  }
}

// End-of-hand markers
function markHeroShowdown(){ HERO_STATS.showdown++; }
function markHeroFolded(){ HERO_STATS.folded++; }

// Derive numbers safely
function pct(n,d){ return (d>0) ? (100*n/d) : 0; }

// Simple rules-of-thumb mapping → style bucket (Nit / TAG / LAG / Station / Maniac)
function classifyHeroStyle(stats){
  const vpip = pct(stats.vpip, stats.hands);
  const pfr  = pct(stats.pfr,  stats.hands);
  const threeBet = pct(stats.threeBet, stats.hands);
  const postActs = (stats.bet + stats.raise + stats.call);
  const af   = (stats.call > 0) ? ( (stats.bet + stats.raise) / stats.call ) : (stats.bet + stats.raise > 0 ? 3.0 : 0);
  const cbet = pct(stats.flopCbet, stats.flopCbetOpp);

  // Heuristics:
  // Nit: very tight (low VPIP/PFR), passive (low AF)
  if (vpip < 18 && pfr < 12 && af < 1.2)        return { key:'NIT',     label:'Nit / Rock' };

  // TAG: moderate VPIP, healthy PFR, moderate AF
  if (vpip >= 18 && vpip <= 26 && pfr >= 14 && pfr <= 22 && af >= 1.2 && af <= 2.5)
                                                  return { key:'TAG',     label:'TAG — Tight‑Aggressive' };

  // LAG: high VPIP & PFR, reasonably aggressive
  if (vpip > 26 && pfr > 20 && af >= 2.0)         return { key:'LAG',     label:'LAG — Loose‑Aggressive' };

  // Station: high VPIP but low aggression (calls a lot)
  if (vpip > 28 && af < 1.0)                      return { key:'STATION', label:'Loose‑Passive (Station)' };

  // Maniac: very high VPIP & PFR and very high AF
  if (vpip > 35 && pfr > 28 && af > 3.0)          return { key:'MANIAC',  label:'Maniac' };

  // Fallbacks
  if (pfr < 10)                                   return { key:'NIT',     label:'Nit / Rock' };
  if (af > 2.8 && vpip > 28)                      return { key:'LAG',     label:'LAG — Loose‑Aggressive' };
  return { key:'TAG', label:'TAG — Tight‑Aggressive' };
}

// Popover for hero (H)
function openHeroEvaluationPopover(){
  const s = HERO_STATS;
  const vpip = pct(s.vpip, s.hands).toFixed(1);
  const pfr  = pct(s.pfr,  s.hands).toFixed(1);
  const t3b  = pct(s.threeBet, s.hands).toFixed(1);
  const af   = (s.call > 0) ? ((s.bet + s.raise) / s.call).toFixed(2) : ((s.bet + s.raise)>0 ? "3.00" : "0.00");
  const cbet = pct(s.flopCbet, s.flopCbetOpp).toFixed(1);

  const bucket = classifyHeroStyle(s); // { key, label }
  const info = PERSONALITY_INFO[bucket.key] || { label: bucket.label, how:'', spot:'' };

  const html = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>You (H) are currently playing like:</strong> ${info.label}</div>
      <div><strong>How this style plays:</strong> ${info.how || '—'}</div>
      <div><strong>Exploits / tells:</strong> ${info.spot || '—'}</div>
      <hr/>
      <div><strong>Your metrics (session):</strong></div>
      <div>VPIP: <strong>${vpip}%</strong> · PFR: <strong>${pfr}%</strong> · 3‑bet: <strong>${t3b}%</strong></div>
      <div>Aggression factor (bets+raises / calls): <strong>${af}</strong></div>
      <div>Flop c‑bet (as PFR): <strong>${cbet}%</strong> (${s.flopCbet}/${s.flopCbetOpp} opp.)</div>
      <div class="muted" style="opacity:.85">This is a heuristic classification that will refine as you play more hands.</div>
    </div>
  `;
  personaModal.open("Your current style", html);
}

// Build mapping for this hand: put H on hero seat; rotate villain ring over other seats.
function rotateLettersForNewHand(){
  const order = ["UTG","HJ","CO","BTN","SB","BB"];
  const heroSeat = currentPosition();

  // Guard: ensure ring is a valid 5-letter array
  if (!Array.isArray(VILLAIN_LETTERS_RING) || VILLAIN_LETTERS_RING.length !== VILLAIN_LETTERS.length) {
    VILLAIN_LETTERS_RING = VILLAIN_LETTERS.slice();
  }

  // Rotate the ring (e.g., A,B,C,D,E -> E,A,B,C,D)
  VILLAIN_LETTERS_RING.unshift(VILLAIN_LETTERS_RING.pop());

  // Assign letters to seats (villains only); hero seat gets H
  const out = {};
  const villainSeats = order.filter(pos => pos !== heroSeat);
  villainSeats.forEach((pos, idx) => { out[pos] = VILLAIN_LETTERS_RING[idx]; });
  out[heroSeat] = HERO_LETTER;

  LETTERS_BY_POSITION = out;

  // Persist
  const saved = JSON.parse(sessionStorage.getItem('trainer_personas_v1') || '{}');
  saved.villainRing = VILLAIN_LETTERS_RING;
  saved.lettersByPosition = LETTERS_BY_POSITION;
  sessionStorage.setItem('trainer_personas_v1', JSON.stringify(saved));
}

// ====== Blinds & schedule (tournament-friendly) ======
let BLINDS = { sb: 5, bb: 10 };   // always rounded via toStep5 on use
const BLIND_SCHEDULE = [
  [5,10],[10,20],[15,30],[20,40],[25,50],[30,60],[40,80],
  [50,100],[75,150],[100,200],[150,300],[200,400]
];
let blindScheduleIdx = 0;

// ==================== DOM (existing) ====================
const holeCardsEl = document.getElementById("holeCards");
const boardCardsEl = document.getElementById("boardCards");
const potSizeEl = document.getElementById("potSize");
const toCallEl = document.getElementById("toCall");
const stageLabelEl = document.getElementById("stageLabel");
const scenarioLabelEl = document.getElementById("scenarioLabel");
const timerCountdownEl = document.getElementById("timerCountdown");
const difficultySelect = document.getElementById("difficulty");
const timerRange = document.getElementById("timerRange");
const timerValueEl = document.getElementById("timerValue");
const newHandBtn = document.getElementById("newHandBtn");
const inputForm = document.getElementById("inputForm");
const hintsEl = document.getElementById("hints");
const feedbackEl = document.getElementById("feedback");
const summaryPanel = document.getElementById("summaryPanel");
const summaryContent = document.getElementById("summaryContent");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");
const closeSummaryBtn = document.getElementById("closeSummaryBtn");
const sessionStatsEl = document.getElementById("sessionStats");
const submitStageBtn = document.getElementById("submitStageBtn");
const nextStageBtn = document.getElementById("nextStageBtn");
const resetStatsBtn = document.getElementById("resetStatsBtn");
const kpiBlindsEl = document.getElementById("kpiBlinds");
const blindsLabelEl = document.getElementById("blindsLabel");

// Mobile KPI bar
const kpiStageEl = document.getElementById("kpiStage");
const kpiPotEl = document.getElementById("kpiPot");
const kpiCallEl = document.getElementById("kpiToCall");
const kpiTimerEl = document.getElementById("kpiTimer");
// Optional chip (will be null if you didn't add it in HTML; code no-ops then)
const kpiEquitySwingEl = document.getElementById("kpiEquitySwing");
const kpiScenarioEl = document.getElementById("kpiScenario");

const bottomBar = document.getElementById("bottomBar");
const barPotOdds = document.getElementById("barPotOdds");
const barSubmit = document.getElementById("barSubmitBtn");
const barNext = document.getElementById("barNextBtn");

const hintDetails = document.getElementById("hintDetails");
const hintsDetailBody = document.getElementById("hintsDetailBody");

// ===== Advanced Toggle for Sampler Debug =====
let SHOW_SAMPLER_DEBUG = false;
document.getElementById('advToggleSampler')?.addEventListener('change', e=>{
  SHOW_SAMPLER_DEBUG = e.target.checked;
});


// ==================== Cards & deck ====================
const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"]; // ♠ ♥ ♦ ♣
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RANK_TO_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

function createDeck(){
  const d = [];
  for (let s=0;s<SUITS.length;s++){
    for (let r=0;r<RANKS.length;r++){
      d.push({ rank: RANKS[r], suit: SUITS[s] });
    }
  }
  return d;
}
function shuffle(array){
  for (let i=array.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [array[i],array[j]] = [array[j],array[i]];
  }
}
function dealCard(){ return deck.pop(); }
function containsCard(list, card){ return list.some(c => c.rank===card.rank && c.suit===card.suit); }

// ==================== Betting normalization ====================
function toStep5(value){ return Math.round((Number(value) ?? 0)/5)*5; }
function clampNonNegative(v){ return Math.max(0, Number.isFinite(v) ? v : 0); }
function computeRoundedBetAndPot(potBefore, factor){
  const rawBet = clampNonNegative(potBefore*factor);
  let bet = toStep5(rawBet);
  if (bet===0 && rawBet>0) bet=5;
  const newPot = toStep5(potBefore + bet);
  return { bet, newPot };
}

// ==================== Rendering cards ====================
function createCardEl(card){
  const div = document.createElement("div");
  div.className = "card";
  if (card.suit === "\u2665" || card.suit === "\u2666") div.classList.add("red");
  const rankTop = document.createElement("div"); rankTop.className="rank"; rankTop.textContent = card.rank;
  const suitMid = document.createElement("div"); suitMid.className="suit"; suitMid.textContent = card.suit;
  const rankBottom = document.createElement("div"); rankBottom.className="rank"; rankBottom.textContent = card.rank;
  div.append(rankTop, suitMid, rankBottom);
  return div;
}
function renderCards(){
  holeCardsEl.innerHTML = ""; boardCardsEl.innerHTML = "";
  holeCards.forEach(c => holeCardsEl.appendChild(createCardEl(c)));
  boardCards.forEach(c => boardCardsEl.appendChild(createCardEl(c)));
}

// ==================== Pot / KPI ====================
function computePotOdds(pot, callAmount){ if (callAmount<=0) return 0; return (callAmount/(pot+callAmount))*100; }
function updatePotInfo(){
  pot = toStep5(pot); toCall = toStep5(toCall);
  const stageName = STAGES[currentStageIndex].toUpperCase();
  if (potSizeEl) potSizeEl.textContent = pot.toFixed(0);
  if (toCallEl) toCallEl.textContent = toCall.toFixed(0);
  if (stageLabelEl) stageLabelEl.textContent = stageName;
  if (scenarioLabelEl) scenarioLabelEl.textContent = scenario ? scenario.label : "—";
  if (kpiStageEl) kpiStageEl.textContent = `Stage: ${stageName}`;
  if (kpiPotEl) kpiPotEl.textContent = `Pot: £${pot.toFixed(0)}`;
  if (kpiCallEl) kpiCallEl.textContent = `To Call: £${toCall.toFixed(0)}`;
  const tl = (timeLeft==null) ? "—" : `${Math.max(0,timeLeft)}s`;
  if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${tl}`;
  if (kpiBlindsEl) kpiBlindsEl.textContent =
  `Blinds: £${toStep5(BLINDS.sb)} / £${toStep5(BLINDS.bb)}`;
  if (blindsLabelEl) blindsLabelEl.textContent =
  `£${toStep5(BLINDS.sb)} / £${toStep5(BLINDS.bb)}`;
  const pOdds = computePotOdds(pot, toCall);
  if (barPotOdds) barPotOdds.textContent = isFinite(pOdds) ? `Pot odds ${pOdds.toFixed(1)}%` : 'Pot odds —';
  // Keep Bet/Raise label + size rows in sync
// Scenario → Mobile KPI chip (safe even if scenario is null)
if (kpiScenarioEl) {
  const label = (scenario && scenario.label) ? String(scenario.label) : "—";
  kpiScenarioEl.textContent = `📜 ${label}`;
  kpiScenarioEl.title = label;            // tooltip for truncated text
  kpiScenarioEl.setAttribute('aria-label', `Scenario: ${label}`);
}
  updateDecisionLabels();
}

// ==================== Timer ====================
function startTimer(){
  clearTimer();
  timeLeft = timerSeconds;
  if (timerCountdownEl) timerCountdownEl.textContent = `${timeLeft}s`;
  if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${Math.max(0,timeLeft)}s`;
  timerId = setInterval(()=>{
    timeLeft -= 1;
    if (timeLeft<=0){
      if (timerCountdownEl) timerCountdownEl.textContent = "0s";
      clearInterval(timerId); timerId = null;
    } else {
      if (timerCountdownEl) timerCountdownEl.textContent = `${timeLeft}s`;
    }
    if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${Math.max(0,timeLeft)}s`;
  }, 1000);
}
function clearTimer(){
  if (timerId){ clearInterval(timerId); timerId = null; }
  if (timerCountdownEl) timerCountdownEl.textContent = "—";
  if (kpiTimerEl) kpiTimerEl.textContent = "Time: —";
}
function maybeStartTimer(){
  if (difficulty==="beginner"){
    clearTimer();
    if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
  } else {
    startTimer();
  }
}

// ==================== Board texture analyzer ====================
function analyzeBoard(board, hole){
  function longestBoardRunRanks(boardCards){
    const idxs = [...new Set(boardCards.map(c=>RANKS.indexOf(c.rank)))].sort((a,b)=>a-b);
    if (idxs.length===0) return 0;
    let run=1, best=1;
    for (let i=1;i<idxs.length;i++){
      if (idxs[i]===idxs[i-1]) continue;
      if (idxs[i]===idxs[i-1]+1){ run++; best=Math.max(best,run); }
      else run=1;
    }
    return best;
  }
  // Local helper: ≥2 broadways on board?
  function boardHasManyBroadwaysLocal(boardCards){
    const BW = new Set(["T","J","Q","K","A"]);
    let cnt = 0;
    boardCards.forEach(c => { if (BW.has(c.rank)) cnt++; });
    return cnt >= 2;
  }

  const boardRanksCount = {}; const boardSuitsCount = {};
  board.forEach(c => { boardRanksCount[c.rank]=(boardRanksCount[c.rank]??0)+1; boardSuitsCount[c.suit]=(boardSuitsCount[c.suit]??0)+1; });

  const paired = Object.values(boardRanksCount).some(v=>v>=2);
  const suitCounts = Object.values(boardSuitsCount);
  const maxSuitOnBoard = suitCounts.length ? Math.max(...suitCounts) : 0;
  const suitKinds = Object.keys(boardSuitsCount).length;

  const mono = maxSuitOnBoard>=3;
  const twoTone = (board.length>=3 && suitKinds===2 && !mono);
  const rainbow = (board.length>=3 && suitKinds>=3 && !mono);

  const boardRun = longestBoardRunRanks(board);
  const isFlop = board.length===3, isTurn = board.length===4, isRiver = board.length===5;

  let connected=false, semiConnected=false, fourToStraight=false, straightOnBoard=false;
  if (isFlop){
    connected = (boardRun>=3);
    if (!connected){
      const vals = [...new Set(board.map(c=>RANKS.indexOf(c.rank)))].sort((a,b)=>a-b);
      if (vals.length===3){
        const gaps = [vals[1]-vals[0], vals[2]-vals[1]];
        semiConnected = (gaps.includes(2) && gaps.includes(1));
      }
    }
  } else {
    const rv = new Set(board.map(c=>RANK_TO_VAL[c.rank]));
    if (rv.has(14)) rv.add(1); // wheel
    const ordered = [...rv].sort((a,b)=>a-b);
    let run=1, maxRun=1;
    for (let i=1;i<ordered.length;i++){
      if (ordered[i]===ordered[i-1]) continue;
      if (ordered[i]===ordered[i-1]+1){ run++; maxRun=Math.max(maxRun,run); }
      else run=1;
    }
    straightOnBoard = (isRiver && maxRun>=5);
    run=1; maxRun=1;
    for (let i=1;i<ordered.length;i++){
      if (ordered[i]===ordered[i-1]+1){ run++; maxRun=Math.max(maxRun,run); }
      else if (ordered[i]!==ordered[i-1]) { run=1; }
    }
    fourToStraight = (maxRun>=4);
    connected = (!isRiver && (fourToStraight || boardRun>=3));
  }

  // Hero flush draw among 7 cards
  const all = [...board, ...hole];
  const heroSuitCounts = {}; all.forEach(c => { heroSuitCounts[c.suit]=(heroSuitCounts[c.suit]??0)+1; });
  const heroFlushDraw = Object.values(heroSuitCounts).some(v=>v===4);

  const tags = [];
  if (paired) tags.push({label:"Paired", sev:"amber"});
  if (mono) tags.push({label:"Monotone", sev:"amber"});
  if (twoTone) tags.push({label:"Two‑tone", sev:"amber"});
  if (rainbow) tags.push({label:"Rainbow", sev:"green"});
  if (isFlop && twoTone) tags.push({label:"Flush Possible", sev:"amber"});
  if ((isTurn || isRiver) && maxSuitOnBoard>=3){
    tags.push({label: isRiver ? "Flushy Board" : "Flush Possible", sev: isRiver ? "red" : "amber"});
  }
  // Turn-only "Two to a Flush" teaching tag (front-door FDs live for suited starts)
  if (isTurn && maxSuitOnBoard === 2) {
    tags.push({ label: "Two to a Flush", sev: "amber" });
  }
  if (straightOnBoard) tags.push({label:"Straight on Board", sev:"red"});
  if (fourToStraight && !straightOnBoard) tags.push({label:"4‑Straight", sev:"amber"});
  if (connected && !fourToStraight && !straightOnBoard) tags.push({label:"Connected", sev:"amber"});
  if (!connected && semiConnected) tags.push({label:"Semi‑Connected", sev:"amber"});

  const warnings = [];
  if (paired) warnings.push("Paired board – full house / trips possible.");
  if (mono) warnings.push("Monotone board – flush possible.");
  if (fourToStraight || connected || semiConnected) warnings.push("Straight possibilities present.");
  if (heroFlushDraw) warnings.push("You have a flush draw.");

  // ===== Moisture / Wetness scoring =====
  let wetnessScore = 0;
  if (mono) wetnessScore += 3.0;
  if (twoTone) wetnessScore += 1.5;
  // small nudge if on turn exactly two to a suit (real FDs for suited hands)
  if (isTurn && maxSuitOnBoard === 2) wetnessScore += 0.25;
  if (fourToStraight) wetnessScore += 2.0;
  if (connected) wetnessScore += 1.0;
  if (semiConnected) wetnessScore += 0.5;
  if (boardHasManyBroadwaysLocal(board)) wetnessScore += 0.5;
  if (paired){
    const lowPaired = Object.entries(boardRanksCount).some(([r,v]) => v>=2 && "23456789".includes(r));
    if (lowPaired) wetnessScore += 0.5;
  }
  // Ace‑high dryness adjustment (rainbow + static only)
  const hasAce = board.some(c => c.rank === "A");
  const suitsSet = new Set(board.map(c => c.suit));
  const isRainbow = (board.length >= 3) && (suitsSet.size >= 3);
  const isStatic = !connected && !fourToStraight;
  if (hasAce && isRainbow && isStatic) wetnessScore -= 0.75;

  let moistureBucket;
  if (wetnessScore >= 3.5) moistureBucket = "Wet";
  else if (wetnessScore >= 2.0) moistureBucket = "Semi‑wet";
  else if (wetnessScore >= 1.0) moistureBucket = "Semi‑dry";
  else moistureBucket = "Dry";

  const moistureBadgeColor =
    moistureBucket === "Wet" ? "red" :
    (moistureBucket === "Semi‑wet" ? "amber" : "green");
  tags.push({ label: moistureBucket, sev: moistureBadgeColor });

  let drawStrength="green";
  if (paired || mono || fourToStraight || connected || semiConnected) drawStrength="amber";
  if ((paired && mono) || straightOnBoard) drawStrength="red";

  return {
    warnings, heroFlushDraw, drawStrength, tags,
    paired, mono, connected, fourToStraight,
    wetnessScore, moistureBucket
  };
}

// ==================== Hand descriptors ====================
function countRankIn(hole, board, rank){
  let n=0; hole.forEach(c=>{ if (c.rank===rank) n++; }); board.forEach(c=>{ if (c.rank===rank) n++; }); return n;
}
function remainingOfRank(hole, board, rank){ return Math.max(0, 4 - countRankIn(hole,board,rank)); }
function describeMadeHand(hole, board){
  const score = evaluate7(hole, board);
  if (score.cat===1){
    const pairRank = score.ranks[0];
    const n = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===pairRank);
    return { cat: score.cat, label: `One Pair (${n})` };
  }
  if (score.cat===2){
    const r1 = score.ranks[0], r2 = score.ranks[1];
    const n1 = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r1);
    const n2 = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r2);
    return { cat: score.cat, label: `Two Pair (${n1}s & ${n2}s)` };
  }
  if (score.cat===3){
    const r = score.ranks[0];
    const n = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r);
    return { cat: score.cat, label: `Trips (${n}s)` };
  }
  if (score.cat===4) return { cat: score.cat, label: "Straight" };
  if (score.cat===5) return { cat: score.cat, label: "Flush" };
  if (score.cat===6) return { cat: score.cat, label: "Full House" };
  if (score.cat===7) return { cat: score.cat, label: "Quads" };
  if (score.cat===8) return { cat: score.cat, label: "Straight Flush" };
  return { cat: score.cat, label: "High Card" };
}

// ===== Nuts detection =====
function evaluate7(hole, board){
  const cards = [...hole, ...board];
  const byRank = new Map(); const bySuit = new Map();
  for (const c of cards){ byRank.set(c.rank, (byRank.get(c.rank)??0)+1); bySuit.set(c.suit, (bySuit.get(c.suit)??0)+1); }
  const rankValsDesc = [...new Set(cards.map(c=>RANK_TO_VAL[c.rank]))].sort((a,b)=>b-a);
  const rankSet = new Set(rankValsDesc);

  // Straight flush?
  const suitWith5 = [...bySuit.entries()].find(([,cnt]) => cnt>=5)?.[0];
  if (suitWith5){
    const suited = cards.filter(c => c.suit===suitWith5);
    const suitedSet = new Set([...new Set(suited.map(c=>RANK_TO_VAL[c.rank]))].sort((a,b)=>b-a));
    const sfHigh = highestStraightHigh(suitedSet);
    if (sfHigh) return { cat:8, ranks:[sfHigh] };
  }
  // Quads
  const quads = [...byRank.entries()].filter(([,c])=>c===4).map(([r])=>RANK_TO_VAL[r]).sort((a,b)=>b-a);
  if (quads.length){
    const quad = quads[0];
    const kicker = rankValsDesc.find(v=>v!==quad);
    return { cat:7, ranks:[quad, kicker] };
  }
  // Trips / Pairs
  const trips = [...byRank.entries()].filter(([,c])=>c===3).map(([r])=>RANK_TO_VAL[r]).sort((a,b)=>b-a);
  const pairs = [...byRank.entries()].filter(([,c])=>c===2).map(([r])=>RANK_TO_VAL[r]).sort((a,b)=>b-a);

  // Full house
  if (trips.length && (pairs.length || trips.length>=2)){
    const topTrips = trips[0];
    const bestPair = (trips.length>=2) ? trips[1] : pairs[0];
    return { cat:6, ranks:[topTrips, bestPair] };
  }

  // Flush
  if (suitWith5){
    const flushVals = [...cards.filter(c=>c.suit===suitWith5).map(c=>RANK_TO_VAL[c.rank])].sort((a,b)=>b-a).slice(0,5);
    return { cat:5, ranks:flushVals };
  }

  // Straight
  const straightHigh = highestStraightHigh(rankSet);
  if (straightHigh) return { cat:4, ranks:[straightHigh] };

  if (trips.length){
    const t = trips[0];
    const kickers = rankValsDesc.filter(v=>v!==t).slice(0,2);
    return { cat:3, ranks:[t, ...kickers] };
  }
  if (pairs.length>=2){
    const [p1,p2] = pairs.slice(0,2);
    const kicker = rankValsDesc.find(v=>v!==p1 && v!==p2);
    return { cat:2, ranks:[p1,p2,kicker] };
  }
  if (pairs.length===1){
    const p = pairs[0];
    const kickers = rankValsDesc.filter(v=>v!==p).slice(0,3);
    return { cat:1, ranks:[p, ...kickers] };
  }
  return { cat:0, ranks:rankValsDesc.slice(0,5) };
}
function highestStraightHigh(rankValsSet){
  const vals = [...rankValsSet];
  if (rankValsSet.has(14)) vals.push(1);
  vals.sort((a,b)=>a-b);
  let run=1, best=0;
  for (let i=1;i<vals.length;i++){
    if (vals[i]===vals[i-1]) continue;
    if (vals[i]===vals[i-1]+1){ run++; if (run>=5) best = Math.max(best, vals[i]); }
    else run=1;
  }
  return best;
}
function compareScores(a,b){
  if (a.cat!==b.cat) return a.cat>b.cat ? 1 : -1;
  const L = Math.max(a.ranks.length, b.ranks.length);
  for (let i=0;i<L;i++){
    const av = a.ranks[i] ?? 0;
    const bv = b.ranks[i] ?? 0;
    if (av!==bv) return av>bv ? 1 : -1;
  }
  return 0;
}

// ==================== STRAIGHT DRAW DETECTION ====================
function detectStraightDrawFromAllCards(allCards){
  const vals = new Set(allCards.map(c=>RANK_TO_VAL[c.rank]));
  const has = v=>vals.has(v);
  // Open-ender
  let openEnder=false;
  for (let r=2;r<=10;r++){
    if (has(r)&&has(r+1)&&has(r+2)&&has(r+3)){ openEnder=true; break; }
  }
  if (openEnder) return { openEnder:true, gutshot:false };
  // Gutshot: any 5-window with exactly 4 ranks present
  let gutshot=false;
  for (let r=2;r<=10;r++){
    let count=0; for (let k=0;k<5;k++) if (has(r+k)) count++;
    if (count===4){ gutshot=true; break; }
  }
  // Wheel A-2-3-4 missing 5
  if (!gutshot && has(14) && has(2) && has(3) && has(4) && !has(5)) gutshot = true;
  return { openEnder:false, gutshot };
}

// ==================== Outs & Hints ====================

// ---- Simple tentative-outs weight by board moisture ----
// Uses the moisture bucket you already compute in analyzeBoard(...):
//   Dry / Semi‑dry  → tentative weight = 0.50
//   Semi‑wet / Wet  → tentative weight = 0.33
function simpleTentativeWeight(texture) {
  const bucket = texture.moistureBucket || "Dry";
  if (bucket === "Wet" || bucket === "Semi‑wet") return 0.33;
  return 0.50;
}

function estimateOuts(hole, board){
  const stage = STAGES[currentStageIndex];
  const texture = analyzeBoard(board, hole);
  if (stage==="river"){ return { strong:0, tentative:0, outsDetail:[], texture }; }

  let strong=0, tentative=0, outsDetail=[];
  const all = [...hole, ...board];

  // Flush draws (hero-specific)
  const suitCounts = {}; all.forEach(c=>{ suitCounts[c.suit]=(suitCounts[c.suit]??0)+1; });
  const flushSuit = Object.keys(suitCounts).find(s => suitCounts[s]===4);
  if (flushSuit){
    const flushOuts = 9;
    if (texture.mono){ tentative+=flushOuts; outsDetail.push("Flush draw – 9 tentative outs (monotone board)."); }
    else if (texture.paired){ strong+=flushOuts; outsDetail.push("Flush draw – 9 strong outs. Note: paired board (boat/quads risk)."); }
    else { strong+=flushOuts; outsDetail.push("Flush draw – 9 strong outs."); }
  }

  // Straights
  const { openEnder, gutshot } = detectStraightDrawFromAllCards(all);
  if (openEnder){
    const outs = 8;
    if (texture.mono){ tentative+=outs; outsDetail.push("Open‑ended straight draw – 8 tentative outs (monotone board)."); }
    else if (texture.paired){ strong+=outs; outsDetail.push("Open‑ended straight draw – 8 strong outs. Note: paired board."); }
    else { strong+=outs; outsDetail.push("Open‑ended straight draw – 8 strong outs."); }
  } else if (gutshot){
    const outs=4;
    if (texture.mono){ tentative+=outs; outsDetail.push("Gutshot – 4 tentative outs (monotone board)."); }
    else if (texture.paired){ strong+=outs; outsDetail.push("Gutshot – 4 strong outs. Note: paired board."); }
    else { strong+=outs; outsDetail.push("Gutshot – 4 strong outs."); }
  }

  // Pairs improvement / boats, etc.
  const r1 = hole[0].rank, r2 = hole[1].rank;
  const holePair = (r1===r2);
  const boardCount = {}; board.forEach(c=>{ boardCount[c.rank]=(boardCount[c.rank]??0)+1; });
  const r1On = boardCount[r1]??0, r2On = boardCount[r2]??0;
  const havePair = holePair || r1On>0 || r2On>0;

  if (!havePair){
    const outsR1 = Math.max(0, 3 - r1On);
    const outsR2 = Math.max(0, 3 - r2On);
    if (outsR1>0){ tentative+=outsR1; outsDetail.push(`Overcard ${r1} pair – ${outsR1} tentative outs.`); }
    if (outsR2>0){ tentative+=outsR2; outsDetail.push(`Overcard ${r2} pair – ${outsR2} tentative outs.`); }
  }
  if (havePair){
    const pairedRank = holePair ? r1 : (r1On>0 ? r1 : r2);
    const seenOnBoard = boardCount[pairedRank]??0;
    const holeCount = holePair ? 2 : 1;
    const trips = Math.max(0, 4 - holeCount - seenOnBoard);
    if (trips>0){
      if (texture.mono || texture.fourToStraight || texture.connected || texture.paired){
        tentative += trips; outsDetail.push(`Trips (${pairedRank}) – ${trips} tentative outs (board danger).`);
      } else {
        strong += trips; outsDetail.push(`Trips (${pairedRank}) – ${trips} strong outs.`);
      }
    }
    if (!holePair){
      const kickerRank = (pairedRank===r1 ? r2 : r1);
      const seenKick = boardCount[kickerRank]??0;
      const kickerOuts = Math.max(0, 3 - seenKick);
      if (kickerOuts>0){ tentative+=kickerOuts; outsDetail.push(`Two‑pair via ${kickerRank} – ${kickerOuts} tentative outs.`); }
    }
    if ((Object.values(boardCount).some(v=>v>=2)) && board.length>=4){
      const boardPairedRank = Object.keys(boardCount).find(k => (boardCount[k]??0)>=2);
      if (boardPairedRank){
        const heroPairRank = pairedRank;
        const heroBoatOuts = remainingOfRank(hole, board, heroPairRank);
        if (heroBoatOuts>0){ strong+=heroBoatOuts; outsDetail.push(`Full House via ${heroPairRank} – ${heroBoatOuts} strong outs.`); }
        const boardBoatOuts = remainingOfRank(hole, board, boardPairedRank);
        if (boardBoatOuts>0){ tentative+=boardBoatOuts; outsDetail.push(`Full House via ${boardPairedRank} – ${boardBoatOuts} tentative outs.`); }
      }
    }
  }
// ===== Effective outs using simple weights =====
        const wTent = simpleTentativeWeight(texture);
       const strongOuts = strong;
      const tentativeOuts = tentative;
      const effectiveOuts = strongOuts + (wTent * tentativeOuts);

  return {
    strong: strongOuts,
    tentative: tentativeOuts,
    effectiveOuts,
    tentativeWeight: wTent,
    outsDetail,
    texture
  };
}

function updateHintsImmediate(){
  const stage = STAGES[currentStageIndex];
  const outsInfo = estimateOuts(holeCards, boardCards);
  const texture = outsInfo.texture;
  const boardTags = (texture.tags ?? []).map(t=>`<span class="badge ${t.sev}">${t.label}</span>`).join(' ');
  const made = describeMadeHand(holeCards, boardCards);

  let nutsBadge = "";
  if (boardCards.length===5){
    const nuts = isAbsoluteNutsOnRiver(holeCards, boardCards);
    nutsBadge = nuts.abs ? `<span class="badge green">NUTS</span>` : `<span class="badge amber">Not nuts</span>`;
  } else if (boardCards.length>=3){
    const prob = isProbableNutsPreRiver(holeCards, boardCards, 800);
    nutsBadge = prob.likely ? `<span class="badge green">Likely Nuts</span>` : `<span class="badge amber">Beatable</span>`;
  }

 const effectiveOuts = outsInfo.effectiveOuts ?? (outsInfo.strong + outsInfo.tentative);
let approxEquity = null;
if (stage === "flop") approxEquity = effectiveOuts * 4;
if (stage === "turn") approxEquity = effectiveOuts * 2;

 const outsLines = [];
outsLines.push(`<div><strong>Strong outs:</strong> ${outsInfo.strong}</div>`);
outsLines.push(
  `<div><strong>Tentative outs:</strong> ${outsInfo.tentative}` +
  (outsInfo.tentative > 0 ? ` (×${(outsInfo.tentativeWeight ?? 0.5).toFixed(2)})` : ``) +
  `</div>`
);
outsLines.push(
  `<div><strong>Effective outs:</strong> ${(effectiveOuts ?? 0).toFixed(2)}</div>`
);

if (approxEquity !== null && (effectiveOuts ?? 0) > 0){
  outsLines.push(`<div>4 & 2 rule (discounted) → approx <strong>${approxEquity.toFixed(1)}%</strong></div>`);
}

if (outsInfo.outsDetail.length > 0){
  outsLines.push(`<div style="opacity:.9">${outsInfo.outsDetail.join(" ")}</div>`);
} 

  const examplePotOdds = computePotOdds(pot, toCall);
  const potLine = (stage!=="river")
    ? `<div>£${toCall.toFixed(0)} to call into £${pot.toFixed(0)} → Pot odds <strong>${examplePotOdds.toFixed(1)}%</strong></div>`
    : ``;

 const boardLine = `<span id="boardBadgeBar" class="board-badges" title="Tap for c-bet guide">${
  boardTags || '<span class="badge green">Stable</span>'
}</span>`;
  const summaryHtml = `
           <div><strong>Board:</strong> ${boardLine}</div>
           <div><strong>Made:</strong> ${made.label} ${nutsBadge}</div>
          <div><strong>Outs:</strong> ${outsInfo.strong} strong${outsInfo.tentative?`, ${outsInfo.tentative} tentative`:''}${(approxEquity!=null && (effectiveOuts ?? 0) > 0)?` · ~        ${approxEquity.toFixed(1)}%`:""}</div>
`;
  const detailsHtml = `
    <div style="display:flex;flex-direction:column;gap:6px">
      ${outsLines.join("")}
      ${potLine}
    </div>
  `;

  if (difficulty==="beginner" || difficulty==="intermediate"){
    hintsEl.innerHTML = summaryHtml;
    if (hintsDetailBody) hintsDetailBody.innerHTML = detailsHtml;
    if (hintDetails) hintDetails.open = false;
  } else {
    hintsEl.innerHTML = "";
    if (hintsDetailBody) hintsDetailBody.innerHTML = "";
    if (hintDetails) hintDetails.open = false;
  }
}

function isAbsoluteNutsOnRiver(hole, board){
  if (board.length!==5) return { abs:false, beaters:0 };
  const rest = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
  const heroScore = evaluate7(hole, board);
  let beaters=0;
  for (let i=0;i<rest.length;i++){
    for (let j=i+1;j<rest.length;j++){
      const villainScore = evaluate7([rest[i], rest[j]], board);
      if (compareScores(heroScore, villainScore)<0){ beaters++; if (beaters>0) break; }
    }
    if (beaters>0) break;
  }
  return { abs: beaters===0, beaters };
}
function isProbableNutsPreRiver(hole, board, samples=800){
  if (board.length===5) return isAbsoluteNutsOnRiver(hole,board);
  const rest = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
  const heroScore = evaluate7(hole,board);
  let beaters=0;
  for (let s=0;s<samples;s++){
    const i = Math.floor(Math.random()*rest.length);
    let j = Math.floor(Math.random()*rest.length);
    if (j===i) j = (j+1)%rest.length;
    const villainScore = evaluate7([rest[i],rest[j]], board);
    if (compareScores(heroScore, villainScore)<0){ beaters++; break; }
  }
  return { abs:false, beaters, likely: beaters===0 };
}


// ==================== Villain betting engine settings ====================
const VILLAIN = {
  // Betting frequencies by guide bucket (c-bet / probe)
  betFreq:  { High: 0.70, Med: 0.45, Low: 0.25 },   // PFR on flop/turn/river
  probeFreq:{ High: 0.55, Med: 0.40, Low: 0.20 },   // Non-PFR stab (flop/turn)
  raiseOverBetFreq: 0.12,                            // chance to raise over an existing bet pre-hero
  sizeJitter: 0.15,                                  // ±15% jitter on preset sizes
  // After hero bets into field, fraction of alive villains that flat-call
  callFracAfterHeroBet: 0.35,
  // Fold propensity facing a bet when weak
  foldFracFacingBetWeak: 0.65
};

// Small per-street context (used to settle after hero acts)
let STREET_CTX = {
  stage: '',           // 'flop' | 'turn' | 'river'
  potAtStart: 0,       // pot before any villain/hero action this street
  openBettor: null,    // first villain who bet before hero (if any)
  openSizePct: null    // their nominal size (for UI / logs if you want later)
};

// Canonical postflop order (first to act is SB postflop)
const POSTFLOP_ORDER = ["SB","BB","UTG","HJ","CO","BTN"];

// ==================== Equity simulation ====================
const CAT_NAME = {
  8:'Straight Flush', 7:'Four of a Kind', 6:'Full House',
  5:'Flush', 4:'Straight', 3:'Three of a Kind',
  2:'Two Pair', 1:'One Pair', 0:'High Card'
};
const SETTINGS = {
  sim: {
    playersBaseline: 5,
    minShowdownOpponents: 1
  },
  pot: {
    addHeroCallBetweenStreets: true,
    treatRaiseAsCall: true,
    endHandOnFold: true
  },
  simQualityPreset: 'Balanced',
  trialsByStage: { preflop: 4000, flop: 6000, turn: 8000, river: 12000 }
};

const TRIALS_PRESETS = {
  Mobile:   { preflop: 2000, flop: 4000, turn: 6000, river: 8000 },
  Balanced: { preflop: 4000, flop: 6000, turn: 8000, river: 12000 },
  Accurate: { preflop: 8000, flop: 12000, turn: 16000, river: 20000 }
};

// ===== Feature flags =====
const FEATURE_FLAGS = {
  // Route computeEquityStats(...) through the new range-aware MC engine
  // (can flip to false to revert to legacy in one line)
  equityEngineV2: true
};

function popRandomCard(arr){ const i=Math.floor(Math.random()*arr.length); return arr.splice(i,1)[0]; }

// ==================== Preflop Engine — JSON‑driven, GTO‑accurate (Option 1A) ====================
// Uses only RANGES_JSON (open / three_bet / defend / vs_open) for all pre‑flop actions.
// One pass BEFORE Hero, one pass AFTER Hero — no wrap-around, no second turns (no cycling).

// --- JSON freq → class ('open' | 'mix' | 'fold') consistent with freqToWeight thresholds ---
function freqToClassLocal(freq){
  if (freq == null) return 'fold';
  const f = Number(freq);
  if (!Number.isFinite(f)) return 'fold';
  if (f >= 0.67) return 'open';
  if (f >= 0.15) return 'mix';
  return 'fold';
}
function jsonIn(bucket, code){
  if (!bucket) return false;
  const freq = bucket[code];
  const cls = freqToClassLocal(freq);
  return (cls === 'open' || cls === 'mix');
}

// --- JSON lookups ---
function jsonWouldOpen(seat, code){
  const b = RANGES_JSON?.open?.[seat];
  return jsonIn(b, code);
}
function jsonWould3Bet(seat, opener, code){
  const key = `${seat}_vs_${opener}`;
  const b = RANGES_JSON?.three_bet?.[key];
  return jsonIn(b, code);
}
// Defend call vs open: BB uses 'defend', others use 'vs_open.<seat>_vs_<opener>.call'
function jsonWouldCallVsOpen(seat, opener, code){
  if (seat === 'BB'){
    const key = `BB_vs_${opener}`;
    const b = RANGES_JSON?.defend?.[key];
    return jsonIn(b, code);
  }
  const key = `${seat}_vs_${opener}`;
  const b = RANGES_JSON?.vs_open?.[key]?.call;
  return jsonIn(b, code);
}

// --- Seat/turn helpers ---
function idxOfSeat(seat){ return ACTION_ORDER.indexOf(seat); } // "UTG","HJ","CO","BTN","SB","BB"
function forSeatsBeforeHero(heroSeat){
  const out = [];
  for (const s of ACTION_ORDER){ if (s === heroSeat) break; out.push(s); }
  return out;
}
function forSeatsAfterHero(heroSeat){
  const i = idxOfSeat(heroSeat);
  return ACTION_ORDER.slice(i+1); // no wrap-around
}

// --- Shared string label for UI coaching ---
function buildPreflopLabel(openerSeat, openToBb, threeBetterSeat, threeBetToBb, coldCallers){
  if (openerSeat && threeBetterSeat){
    return `${openerSeat} opened ${openToBb?.toFixed?.(1) ?? '—'}x · ${threeBetterSeat} 3‑bet ${threeBetToBb?.toFixed?.(1) ?? '—'}x`;
  }
  if (openerSeat){
    const cc = (Array.isArray(coldCallers) && coldCallers.length) ? ' · cold call' : '';
    return `${openerSeat} opened ${openToBb?.toFixed?.(1) ?? '—'}x${cc}`;
  }
  return 'Preflop';
}

// --- NEW: Pre‑flop simulate BEFORE hero (pure JSON) ---
function preflopSimulateBeforeHero(){
  const heroSeat = currentPosition();
  const sb = toStep5(BLINDS.sb), bb = toStep5(BLINDS.bb);
  let potLocal = toStep5(sb + bb);
  let openerSeat = null, openToBb = null;
  let threeBetterSeat = null, threeBetToBb = null;
  const coldCallers = [];

  // reset statuses
  Object.keys(ENGINE.statusBySeat).forEach(seat => { ENGINE.statusBySeat[seat] = "in"; });

  for (const s of forSeatsBeforeHero(heroSeat)){
    const h = seatHand(s);
    if (!h || !h.length) { ENGINE.statusBySeat[s] = "folded_now"; continue; }
    const code = handToCode(h);

    // No opener yet → seat may open (use canOpen → JSON or explicit/hybrid)
    if (!openerSeat){
      if (canOpen(s, code)){
        openerSeat = s;
        openToBb = standardOpenSizeBb(s);
        const raiseTo = toStep5(openToBb * bb);
        potLocal = contributeRaiseTo(potLocal, raiseTo, s);
      } else {
        ENGINE.statusBySeat[s] = "folded_now";
      }
      continue;
    }

    // opener exists, no 3-bettor yet → 3-bet or flat using hybrid-aware helpers
    if (!threeBetterSeat){
      if (inThreeBetBucket(s, openerSeat, code)){
        threeBetterSeat = s;
        threeBetToBb = threeBetSizeBb(openerSeat, s, openToBb);
        const rTo = toStep5(threeBetToBb * bb);
        potLocal = contributeRaiseTo(potLocal, rTo, s);
      } else if (inCallBucket(s, openerSeat, code)){
        const rTo = toStep5(openToBb * bb);
        potLocal = contributeCallTo(potLocal, rTo, s);
        coldCallers.push(s);
      } else {
        ENGINE.statusBySeat[s] = "folded_now";
      }
      continue;
    }

    // opener + 3-bettor already exist → allow flats vs 3-bet using hybrid-aware helper
    if (inCallBucket(s, openerSeat, code)){
      const rTo = toStep5(threeBetToBb * bb);
      potLocal = contributeCallTo(potLocal, rTo, s);
      coldCallers.push(s);
    } else {
      ENGINE.statusBySeat[s] = "folded_now";
    }
  }

  // Compute hero's price to call
  const heroPostedBlind = postedBlindFor(heroSeat);
  let toCallLocal = 0;
  if (!openerSeat){
    toCallLocal = (heroSeat === 'BB') ? 0 : (heroSeat === 'SB' ? Math.max(0, bb - sb) : bb);
  } else if (threeBetterSeat){
    const rTo = toStep5(threeBetToBb * bb);
    toCallLocal = Math.max(0, rTo - heroPostedBlind);
  } else {
    const rTo = toStep5(openToBb * bb);
    toCallLocal = Math.max(0, rTo - heroPostedBlind);
  }

  // Record preflop context
  ENGINE.preflop.openerSeat     = openerSeat ?? null;
  ENGINE.preflop.threeBetterSeat= threeBetterSeat ?? null;
  ENGINE.preflop.coldCallers    = Array.from(new Set(coldCallers));
  ENGINE.preflop.openToBb       = (openToBb == null ? null : Number(openToBb));
  ENGINE.preflop.threeBetToBb   = (threeBetToBb == null ? null : Number(threeBetToBb));
  ENGINE.preflop.participants   = (() => {
    const p = new Set();
    if (openerSeat) p.add(openerSeat);
    if (threeBetterSeat) p.add(threeBetterSeat);
    coldCallers.forEach(x => p.add(x));
    return Array.from(p);
  })();

  const label = buildPreflopLabel(openerSeat, openToBb, threeBetterSeat, threeBetToBb, coldCallers);
  return { potLocal, toCallLocal, openerSeat, openToBb, threeBetterSeat, threeBetToBb, coldCallers, label };
}


// --- LAST‑AGGRESSOR policy (no cycling) ---
// We DO NOT wrap back around the table. After Hero acts, we scan seats AFTER Hero.
// If a NEW aggressor appears after Hero, we allow seats after them to respond once, then end.
// If the prior aggressor (before Hero) must respond (e.g., after‑Hero squeeze), we resolve exactly one required response // and end.

function preflopResolveAfterHero(decision){
  const hero = currentPosition();
  const sb = toStep5(BLINDS.sb), bb = toStep5(BLINDS.bb);
  let opener = ENGINE.preflop.openerSeat ?? null;
  let threeBetter = ENGINE.preflop.threeBetterSeat ?? null;
  let openToBb = ENGINE.preflop.openToBb ?? null;
  let threeBetToBb = ENGINE.preflop.threeBetToBb ?? null;

  function keepIn(seat){ ENGINE.statusBySeat[seat] = "in"; }
  function noteParticipant(seat){
    ENGINE.preflop.participants = Array.from(new Set([...(ENGINE.preflop.participants ?? []), seat]));
  }

  // Track last aggressor before hero
  let lastAggressor = threeBetter ?? opener ?? null;

  // Special: if Hero 4-bet over an existing 3-bet (villain), resolve one defender decision and end
  if (decision === 'raise' && opener && threeBetter && threeBetter !== hero){
    const h = seatHand(threeBetter);
    const code = h ? handToCode(h) : null;
    const canDefend4b = code ? inThreeBetBucket(threeBetter, opener, code) : false;
    const threeTo = toStep5((threeBetToBb ?? ((openToBb ?? 2.2) * ((idxOfSeat(threeBetter)>idxOfSeat(opener)) ? 3.0 : 4.0))) * bb);
    const heroMult = (heroActions?.preflop?.sizeMult != null) ? Number(heroActions.preflop.sizeMult) : 2.4;
    const fourTo = toStep5(heroMult * (threeTo / bb) * bb);

    if (canDefend4b){
      pot = contributeCallTo(pot, fourTo, threeBetter);
      keepIn(threeBetter); noteParticipant(threeBetter);
    } else {
      ENGINE.statusBySeat[threeBetter] = "folded_now";
    }
    toCall = 0; updatePotInfo();
    scenario = { label: `${opener} opened ${openToBb?.toFixed?.(1) ?? '—'}x · ${threeBetter} 3‑bet · Hero 4‑bet`, potFactor: 0 };
    return;
  }

  // Seats after Hero, single pass, no wrap
  const tail = forSeatsAfterHero(hero);
  let needsPriorAggressorResolve = false;
  let priorAggressorToResolve = null;

  let currentPriceTo = 0;
  if (opener && threeBetter){
    currentPriceTo = toStep5((threeBetToBb ?? 0) * bb);
  } else if (opener){
    currentPriceTo = toStep5((openToBb ?? 0) * bb);
  } else {
    currentPriceTo = 0;
  }

  for (const s of tail){
    if (s === lastAggressor) break;
    const h = seatHand(s);
    if (!h || !h.length) { ENGINE.statusBySeat[s] = "folded_now"; continue; }
    const code = handToCode(h);

    // No opener yet (Hero may have limped/checked) — allow opens after Hero
    if (!opener){
      if (canOpen(s, code)){
        opener = s; lastAggressor = s;
        openToBb = standardOpenSizeBb(s);
        const raiseTo = toStep5(openToBb * bb);
        pot = contributeRaiseTo(pot, raiseTo, s);
        scenario = { label: `${s} opened ${openToBb.toFixed(1)}x`, potFactor: 0 };
        currentPriceTo = raiseTo;
        keepIn(s); noteParticipant(s);
      } else {
        ENGINE.statusBySeat[s] = "folded_now";
      }
      continue;
    }

    // Opener exists, no 3-bettor yet → 3-bet (squeeze) or call (hybrid-aware)
    if (opener && !threeBetter){
      if (inThreeBetBucket(s, opener, code)){
        threeBetter = s; lastAggressor = s;
        threeBetToBb = threeBetSizeBb(opener, s, openToBb);
        const rTo = toStep5(threeBetToBb * bb);
        pot = contributeRaiseTo(pot, rTo, s);
        scenario = { label: `${opener} opened ${openToBb.toFixed(1)}x · ${s} 3‑bet ${threeBetToBb.toFixed(1)}x`, potFactor: 0 };
        needsPriorAggressorResolve = true; priorAggressorToResolve = opener;
        currentPriceTo = rTo;
        keepIn(s); noteParticipant(s);
      } else if (inCallBucket(s, opener, code)){
        const rTo = toStep5(openToBb * bb);
        pot = contributeCallTo(pot, rTo, s);
        keepIn(s); noteParticipant(s);
      } else {
        ENGINE.statusBySeat[s] = "folded_now";
      }
      continue;
    }

    // Opener + 3-bettor exist → tail seats can flat vs 3-bet (no 4-bets by villains here)
    if (opener && threeBetter){
      if (inCallBucket(s, opener, code)){
        const rTo = toStep5(threeBetToBb * bb);
        pot = contributeCallTo(pot, rTo, s);
        keepIn(s); noteParticipant(s);
      } else {
        ENGINE.statusBySeat[s] = "folded_now";
      }
      continue;
    }
  }

  // Resolve one decision for the prior aggressor after a squeeze
  if (needsPriorAggressorResolve && priorAggressorToResolve){
    const s = priorAggressorToResolve;
    const h = seatHand(s);
    const code = h ? handToCode(h) : null;
    const canDefend = code ? (inThreeBetBucket(s, opener, code) || inCallBucket(s, opener, code)) : false;
    if (canDefend){
      const rTo = toStep5(threeBetToBb * bb);
      pot = contributeCallTo(pot, rTo, s);
      keepIn(s); noteParticipant(s);
    } else {
      ENGINE.statusBySeat[s] = "folded_now";
    }
  }

  // End preflop with no price for Hero
  toCall = 0; updatePotInfo();

  const finalP = new Set(ENGINE.preflop.participants ?? []);
  if (!handHistory.some(h => h.stage === 'preflop' && h.decision === 'fold')) finalP.add(hero);
  ENGINE.preflop.participants = Array.from(finalP);
}

// ==================== END — Preflop Engine (JSON‑driven) ====================


// Convenience lookup for a villain seat's actual cards
function seatHand(seat){
  const s = TABLE.seats.find(x => x.seat === seat);
  return s ? s.hand : null;
}

// --- Hand strength / connectivity rules (deterministic) ---
// Uses evaluate7(..), detectStraightDrawFromAllCards(..), and analyzeBoard(..) already in your file.
function villainHasPairPlus(hole, board){
  const score = evaluate7(hole, board);
  return (score.cat >= 1); // 1=one pair, 2=two pair, ...
}
function villainHasFlushOrOESD(hole, board){
  const all = [...hole, ...board];
  const suitCounts = {}; all.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit]??0)+1; });
  const hasFD = Object.values(suitCounts).some(v => v >= 4);
  const { openEnder } = detectStraightDrawFromAllCards(all);
  return hasFD || openEnder;
}
function villainHasGutshotOnWet(hole, board){
  const all = [...hole, ...board];
  const texture = analyzeBoard(board, hole); // you already compute Wet/Semi-wet/etc
  const wet = (texture.moistureBucket === 'Wet' || texture.moistureBucket === 'Semi‑wet');
  const { gutshot } = detectStraightDrawFromAllCards(all);
  return wet && gutshot;
}

// Deterministic continue rule per street
// FLOP: continue if Pair+ OR (FD/OESD) OR (Gutshot on Wet/Semi-wet) OR (board paired and we have overcards + bdfd)
// TURN: continue if still Pair+ OR (now FD/OESD) OR (picked up 2nd pair / trips / strong draw)
// RIVER: all current survivors go to showdown
function engineContinueOnStreet(seat, board){
  const hole = seatHand(seat);
  if (!hole || board.length < 3) return false; // shouldn't happen
  if (board.length === 3){
    if (villainHasPairPlus(hole, board)) return true;
    if (villainHasFlushOrOESD(hole, board)) return true;
    if (villainHasGutshotOnWet(hole, board)) return true;
    // light extra: if board is paired and we have 2 overs (A/K/Q) we may peel once
    const ranks = new Set(hole.map(c => c.rank));
    const twoOvers = (ranks.has('A') && (ranks.has('K') || ranks.has('Q'))) ||
                     (ranks.has('K') && ranks.has('Q'));
    const bCounts = {}; board.forEach(c => { bCounts[c.rank]=(bCounts[c.rank]??0)+1; });
    const paired = Object.values(bCounts).some(v => v >= 2);
    if (paired && twoOvers) return true;
    return false;
  }
  if (board.length === 4){
    if (villainHasPairPlus(hole, board)) return true;
    if (villainHasFlushOrOESD(hole, board)) return true;
    // Small allowance: if we had a strong draw on flop and picked up extra equity, continue
    const tex = analyzeBoard(board, hole);
    if (tex.fourToStraight || tex.mono) return true;
    return false;
  }
  // river: always continue to showdown if we got here
  return true;
}

// Recompute survivors at beginning of each street
function engineRecomputeSurvivorsForStreet(board){
  const street = (board.length===3) ? 'flop'
               : (board.length===4) ? 'turn'
               : (board.length===5) ? 'river'
               : 'preflop';
  if (street === 'preflop') { ENGINE.survivors.clear(); ENGINE.lastStreetComputed = 'preflop'; return; }

  const prev = new Set(ENGINE.survivors);

if (street === 'flop'){
  ENGINE.survivors.clear();

  if (ENGINE.preflop.openerSeat) {
    // Raised pot: keep existing behavior (opener / 3-bettor / cold callers)
    ENGINE.survivors.add(ENGINE.preflop.openerSeat);
    if (ENGINE.preflop.threeBetterSeat) ENGINE.survivors.add(ENGINE.preflop.threeBetterSeat);
    (ENGINE.preflop.coldCallers ?? []).forEach(seat => ENGINE.survivors.add(seat));
  } else {
    // *** Unopened pot → it checks through preflop ***
    // Seed blinds so they never appear folded on the flop.
    ENGINE.survivors.add('SB');
    ENGINE.survivors.add('BB');

    // Optionally include the hero if they did not fold preflop.
    try {
      const heroSeat = currentPosition();
      const heroFoldedPre = handHistory.some(h => h.stage === 'preflop' && h.decision === 'fold');
      if (!heroFoldedPre) ENGINE.survivors.add(heroSeat);
    } catch (e) { /* keep robust */ }
  }

  // Deterministic continue filter for flop
  ENGINE.survivors = new Set([...ENGINE.survivors].filter(seat => engineContinueOnStreet(seat, board)));

  // (Optional) Soft guarantee: never show empty survivors in no-raise pots
  // You may keep or remove this; keeping adds resilience.
  if (ENGINE.survivors.size === 0 && !ENGINE.preflop.openerSeat) {
    ENGINE.survivors.add('BB');
  }
  
  } else if (street === 'turn') {
    // Re-evaluate currently alive villains
    ENGINE.survivors = new Set([...ENGINE.survivors].filter(seat => engineContinueOnStreet(seat, board)));
  } else if (street === 'river') {
    // Keep survivors as-is
  }

  ENGINE.survivorsByStreet[street] = [...ENGINE.survivors];

  // Update status flags for discs
  if (board.length >= 3) {
    const allSeats = ["UTG","HJ","CO","BTN","SB","BB"];
    const alive = ENGINE.survivors;
    allSeats.forEach(seat => {
      if (alive.has(seat)) {
        ENGINE.statusBySeat[seat] = "in";
      } else {
        ENGINE.statusBySeat[seat] = (ENGINE.statusBySeat[seat] === "in") ? "folded_now" : "folded_prev";
      }
    });
  }

  ENGINE.lastStreetComputed = street;
}

// Helper for equity code to fetch current survivors
function engineCurrentOpponents(board){
  const street = (board.length===0) ? 'preflop' : (board.length===3 ? 'flop' : (board.length===4 ? 'turn' : 'river'));
  if (street !== ENGINE.lastStreetComputed) engineRecomputeSurvivorsForStreet(board);
  const hands = [...ENGINE.survivors].map(seat => seatHand(seat)).filter(Boolean);
  return hands;
}

// Count how many opponents are still "in" without using their cards
function countOpponentsInPlay(board){
  try{
    const hero = currentPosition();
    const street = stageFromBoard(board);               // you already have this helper
    if (street === 'preflop'){
      // Use preflop participants if available; else fall back to baseline
      const parts = ENGINE.preflop?.participants ?? []; // e.g., opener, 3-bettor, cold callers
      const n = parts.filter(s => s !== hero).length;
      return (n > 0) ? n : SETTINGS.sim.playersBaseline;
    }
    // Flop/turn/river – keep survivors up to date, then count them (excluding hero)
    if (street !== ENGINE.lastStreetComputed) engineRecomputeSurvivorsForStreet(board);
    const n = [...ENGINE.survivors].filter(s => s !== hero).length;
    return Math.max(0, n);
  } catch(e){
    // Safe fallback
    return SETTINGS.sim.playersBaseline;
  }
}

// Small hook from Phase 1 to remember opener / 3-bettor
function engineSetPreflopContext(openerSeat, threeBetterSeat, coldCallers, openToBb){
  ENGINE.preflop.openerSeat = openerSeat ?? null;
  ENGINE.preflop.threeBetterSeat = threeBetterSeat ?? null;
  ENGINE.preflop.coldCallers = Array.isArray(coldCallers) ? coldCallers.slice() : [];
  ENGINE.preflop.openToBb = (openToBb == null ? null : Number(openToBb)); // NEW: opener raise-to (in BB)
  // Keep a flat list of preflop participants — used if the hand ends preflop
  const parts = [];
  if (ENGINE.preflop.openerSeat) parts.push(ENGINE.preflop.openerSeat);
  if (ENGINE.preflop.threeBetterSeat) parts.push(ENGINE.preflop.threeBetterSeat);
  (ENGINE.preflop.coldCallers ?? []).forEach(s => parts.push(s));
  ENGINE.preflop.participants = [...new Set(parts)];
  ENGINE.survivors.clear();
  ENGINE.survivorsByStreet = { flop: [], turn: [], river: [] };
  ENGINE.lastStreetComputed = 'preflop';
}


// Mark only the preflop participants (plus hero) as "in" when we get to the flop
function applyPreflopParticipantsToStatuses(){
  try {
    const hero = currentPosition();
    const parts = new Set(ENGINE.preflop?.participants || []);
    // If the hero reaches the flop, hero must be in
    parts.add(hero);

    ["UTG","HJ","CO","BTN","SB","BB"].forEach(seat => {
      if (seat === hero) return; // hero handled above
      ENGINE.statusBySeat[seat] = parts.has(seat) ? "in" : "folded_prev";
    });
  } catch(e) {
    // Fail-safe: do nothing if anything unexpected happens
  }
}

// Reveal helper for end-of-hand
function describeVillainHand(h){
  if (!h || h.length<2) return '';
  return `${h[0].rank}${h[0].suit} ${h[1].rank}${h[1].suit}`;
}

function stageFromBoard(board){
  if (!board || board.length===0) return "preflop";
  if (board.length===3) return "flop";
  if (board.length===4) return "turn";
  return "river";
}
function villainConnected(hole, boardAtStreet){
  const all = [...hole, ...boardAtStreet];
  const suitCounts = {}; all.forEach(c=>{ suitCounts[c.suit]=(suitCounts[c.suit]??0)+1; });
  const hasFD = Object.values(suitCounts).some(v=>v===4);

  const byRankB = {}; boardAtStreet.forEach(c=>{ byRankB[c.rank]=(byRankB[c.rank]??0)+1; });
  const pairWithBoard = byRankB[hole[0].rank]>0 || byRankB[hole[1].rank]>0 || (hole[0].rank===hole[1].rank);

  const vals = new Set(all.map(c=>RANK_TO_VAL[c.rank])); if (vals.has(14)) vals.add(1);
  let oesd=false;
  for (let start=1; start<=10; start++){
    const w=[start,start+1,start+2,start+3,start+4];
    const present = w.map(v=>vals.has(v));
    const cnt = present.filter(Boolean).length;
    if (cnt===4 && (!present[0] || !present[4])) { oesd=true; break; }
    if (cnt>=5) break;
  }
  return pairWithBoard || hasFD || oesd;
}


// TRAINING MODE: compute equity via new range-aware engine
// V2‑ONLY: permanent range‑aware Monte Carlo engine

function computeEquityStats(hole, board){
    return newEquityEngineCompute(hole, board);
}

// ==================== Scoring & decisions ====================
function bandForError(error){
  const absErr=Math.abs(error);
  if (absErr<=5) return "green";
  if (absErr<=12) return "amber";
  return "red";
}


function decisionBand(equity, potOdds, decision){
  const diff = equity - potOdds;
  const margin = 4;
  let correctDecision;
  if (diff>margin){ correctDecision = decision==="call" || decision==="raise"; }
  else if (diff<-margin){ correctDecision = decision==="fold"; }
  else { return "amber"; }
  return correctDecision ? "green" : "red";
}

// ==================== Phase 1: Position, PFR, preflop heatmap ====================
const POSITIONS6 = ["UTG","HJ","CO","BTN","SB","BB"];
let heroPosIdx = 0;
let preflopAggressor = null;
let dealtHandStr = "";
const heroActions = {
  preflop: { action:null, sizeBb:null },
  flop: { action:null, sizePct:null, cbet:null },
  turn: { action:null, sizePct:null, barrel:null },
  river: { action:null, sizePct:null, barrel:null }
};

// DOM for Phase 1/2/4
const positionDisc = document.getElementById('positionDisc');
const preflopRangeBadge = document.getElementById('preflopRangeBadge');
const sizePresetRow = document.getElementById('sizePresetRow');
const sizePresetRowPost = document.getElementById('sizePresetRowPost');

const rangeModalOverlay = document.getElementById('rangeModalOverlay');
const rangeModalClose = document.getElementById('rangeModalClose');
const rangeModalBody = document.getElementById('rangeModalBody');

const guideModalOverlay = document.getElementById('guideModalOverlay');
const guideModalClose = document.getElementById('guideModalClose');
const guideModalBody = document.getElementById('guideModalBody');

// ==================== Personality Popover ====================
const personaModal = (() => {
  const overlay = document.createElement('div');
  overlay.id = 'personaOverlay';
  overlay.className = 'modal-overlay hidden';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div id="personaTitle" style="font-weight:800"></div>
        <button id="personaClose" class="btn" aria-label="Close">✕</button>
      </div>
      <div id="personaBody" class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  overlay.querySelector('#personaClose').addEventListener('click', () => overlay.classList.add('hidden'));
  return {
    open(title, html){ 
      overlay.querySelector('#personaTitle').textContent = title;
      overlay.querySelector('#personaBody').innerHTML = html;
      overlay.classList.remove('hidden');
    }
  };
})();

function openPersonalityPopover(letter){
  const personaKey = SESSION_PERSONA_BY_LETTER[letter];
  if (!personaKey) return;
  const info = PERSONALITY_INFO[personaKey] || { label: personaKey, how:'', spot:'' };
  const html = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Assigned to:</strong> Player ${letter}</div>
      <div><strong>How they play:</strong> ${info.how}</div>
      <div><strong>How to exploit / spot:</strong> ${info.spot}</div>
      <div class="muted" style="opacity:.85">
        (Assigned for this session; positions will rotate each hand.)
      </div>
    </div>
  `;
  personaModal.open(info.label, html);
}

const posPopover = document.getElementById('posPopover');
const POS_ONE_LINERS = {
  UTG: "Under The Gun — earliest preflop, often out of position postflop.",
  HJ: "Hi-Jack — mid-late seat; stronger than UTG, weaker than CO/BTN.",
  CO: "Cutoff — late position; play wider, pressure blinds.",
  BTN: "Button — last to act postflop; biggest positional edge.",
  SB: "Small Blind — invested but out of position; tighten up opens.",
  BB: "Big Blind — closes preflop action; defend wide vs small opens."
};

// Hybrid ranges (Open)
const RANKS_ASC = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];
const RANK_INDEX = Object.fromEntries(RANKS_ASC.map((r,i)=>[r,i]));
const HYBRID_RANGES = {
  UTG: { open:["TT+","AQs+","AKo","KQs"], mix:["AJs","99"] },
  HJ:  { open:["99+","AJs+","AQo+","ATs-A5s","KQs","KJs","QJs","T9s","98s","KQo"], mix:[] },
  CO:  { open:["88+","A9s-A2s","KTs+","QTs+","JTs-T8s","97s","AJo","KJo","KQo","QJo"], mix:[] },
  BTN: { open:["22+","A2s+","K9s+","Q9s+","J9s+","T9s-54s","A2o+","KTo+","QTo+","JTo"], mix:[] },
  SB:  { open:["22+","A2s+","K9s+","Q9s+","J9s+","T9s-65s","A2o+","KTo+","QTo+","JTo"], mix:[] }
};

function hasNonEmptySeatBucket(obj, seat) {
  const b = obj?.[seat];
  return b && typeof b === 'object' && Object.keys(b).length > 0;
}

// ===== EXPLICIT OPEN RANGES =====


// **** MODIFIED to prefer JSON frequencies when loaded ****

function getClassMapForSeat(seat){
 // 1) Prefer imported JSON only if the seat bucket is non-empty
try{
  if (hasNonEmptySeatBucket(RANGES_JSON?.open, seat)){
    return mapFromFreqBucket(RANGES_JSON.open[seat]);
  }
}catch(e){/* fallback */ }

  // 2) Your explicit-first logic
  const exp = (typeof EXPLICIT_OPEN !== 'undefined') ? EXPLICIT_OPEN[seat] : undefined;
  if (exp && (exp.OPEN_GREEN?.size || exp.OPEN_AMBER?.size)) {
    const map = new Map();
    for (let i = 0; i < RANKS_ASC.length; i++) {
      for (let j = 0; j < RANKS_ASC.length; j++) {
        const r1 = RANKS_ASC[i], r2 = RANKS_ASC[j];
        let code;
        if (i === j) code = r1 + r2;
        else if (i < j) code = r1 + r2 + 's';
        else code = r2 + r1 + 'o';
        let cls = 'fold';
        if (exp.OPEN_GREEN?.has(code)) cls = 'open';
        else if (exp.OPEN_AMBER?.has(code)) cls = 'mix';
        map.set(code, cls);
      }
    }
    return map;
  }
  // 3) Fallback to hybrid tokens
  return buildClassMapForPos(seat);
}


// ... (keep your EXPLICIT_OPEN block exactly as you have it) ...
// Use explicit open sets first; if a seat isn't explicitly defined, fall back to hybrid tokens.

// ---------- Helpers for explicit block (keep your existing helper functions) ----------
// ... (keep addPairs/addAllSuitedBroadways/... etc) ...

/* ============================================================
   EXPLICIT OPEN RANGES (RFI • 6-max • ~100bb) — GREEN / AMBER
   - GREEN = pure/mostly-pure opens
   - AMBER = mixed / low-frequency opens (kept from earlier suggestion)
   - Built with deterministic helpers (no regex/token parsing).
   Paste this right under your // Hybrid ranges (Open) section.
   ============================================================ */

// ---------- Helpers (deterministic) ----------
const BW = ["A","K","Q","J","T"]; // broadway ranks
function rIdx(r){ return RANKS_ASC.indexOf(r); } // smaller index = stronger (A=0 ... 2=12)

// Add AA..minPair (e.g., minPair='2' or '22' -> down to 22)
function addPairs(set, minPair="22"){
  const min = (minPair.length===2 ? minPair[0] : minPair);
  const stop = rIdx(min);
  for (let i=0; i<=stop; i++) {
    const rr = RANKS_ASC[i];
    set.add(rr+rr);
  }
}

// Add all suited broadways (AKs, AQs, ..., KQs, KJs, ..., QJs, QTs, JTs)
function addAllSuitedBroadways(set){
  for (let i=0;i<BW.length;i++){
    for (let j=i+1;j<BW.length;j++){
      set.add(BW[i] + BW[j] + 's');
    }
  }
}
// Add all offsuit broadways (AKo, AQo, ..., JTo)
function addAllOffsuitBroadways(set){
  for (let i=0;i<BW.length;i++){
    for (let j=i+1;j<BW.length;j++){
      set.add(BW[i] + BW[j] + 'o');
    }
  }
}
// Add specific offsuit broadway minima, e.g., KTo+, QTo+, JTo (used for SB/BB text)
function addMostOffsuitBroadways_KTo_QTo_JTo(set){
  set.add("KTo"); set.add("KJo"); set.add("KQo");
  set.add("QTo"); set.add("QJo");
  set.add("JTo");
}
// Add offsuit ATo+ (ATo, AJo, AQo, AKo)
function addAToPlus(set){
  set.add("ATo"); set.add("AJo"); set.add("AQo"); set.add("AKo");
}
// Add offsuit A2o+ up to AKo
function addA2oPlus(set){
  for (let i=rIdx("K"); i<=rIdx("2"); i++){ // K..2 (descending indices)
    const lo = RANKS_ASC[i];
    set.add("A" + lo + "o");
    if (lo==="K") break; // stops at AKo
  }
}
// Add offsuit A8o+ (A8o..AKo)
function addA8oPlus(set){
  for (let i=rIdx("K"); i<=rIdx("8"); i++){
    const lo = RANKS_ASC[i];
    set.add("A" + lo + "o");
    if (lo==="K") break;
  }
}
// Add suited A2s..A5s
function addA2s_to_A5s(set){
  ["5","4","3","2"].forEach(lo => set.add("A"+lo+"s"));
}
// Add all suited Axs (A2s..AKs)
function addAllAxs(set){
  for (let i=rIdx("K"); i<=rIdx("2"); i++){
    const lo = RANKS_ASC[i];
    set.add("A" + lo + "s");
    if (lo==="K") break; // done at AKs
  }
}

// Suited connectors inclusive range, e.g., T9s–54s; or down to 32s
function addSuitedConnectorsRange(set, start="T9", end="54"){
  const sHi = start[0], sLo = start[1];
  const eHi = end[0],   eLo = end[1];
  // Validate adjacency (connector = next rank down)
  let iStart = rIdx(sHi), iEnd = rIdx(eHi);
  for (let i=iStart; i<=rIdx("3"); i++){ // walk down until 32
    const hi = RANKS_ASC[i], lo = RANKS_ASC[i+1];
    if (!lo) break;
    set.add(hi + lo + 's');
    if (hi===eHi && lo===eLo) break;
  }
}
// Suited gappers inclusive range, e.g., 97s–64s (one-gap)
function addSuitedGappersRange(set, startHi="9", endHi="6"){
  let iStart = rIdx(startHi), iEnd = rIdx(endHi);
  for (let i=iStart; i<=iEnd; i++){
    const hi = RANKS_ASC[i], mid = RANKS_ASC[i+1], lo = RANKS_ASC[i+2];
    if (!lo) break;
    set.add(hi + lo + 's'); // e.g., 9 & 7 => "97s"
  }
}
// Suited connectors down to a low pair like "32s" (T9s..32s)
function addSuitedConnectorsDownTo(set, end="32"){
  const eHi = end[0], eLo = end[1];
  for (let i=rIdx("T"); i<=rIdx("3"); i++){
    const hi = RANKS_ASC[i], lo = RANKS_ASC[i+1];
    if (!lo) break;
    set.add(hi + lo + 's');
    if (hi===eHi && lo===eLo) break;
  }
}
// Convenience: add explicit offsuit connectors list
function addOffsuitConnectorsList(set, codes=["T9o","98o","87o"]){
  codes.forEach(c => set.add(c));
}

// ---------- Build explicit GREEN/AMBER per seat from your spec ----------
// We keep the AMBER suggestions we used earlier, then remove any overlap with GREEN.
const EXPLICIT_OPEN = {
  UTG: {
    OPEN_GREEN: (()=>{ // ~14–16%
      const g = new Set();
      addPairs(g, "22");                         // 22+
      // Broadways (offsuit): AJo+, KQo
      g.add("AJo"); g.add("AQo"); g.add("AKo"); g.add("KQo");
      // Suited broadways: ATs+, KTs+, QTs+, JTs
      ["T","J","Q","K"].forEach(lo => g.add("A"+lo+"s")); // ATs..AKs
      g.add("KTs"); g.add("KJs"); g.add("KQs");
      g.add("QTs"); g.add("QJs");
      g.add("JTs");
      // Suited Aces: A2s–A5s
      addA2s_to_A5s(g);
      // Suited connectors: 98s, 87s, 76s
      ["98s","87s","76s"].forEach(c=>g.add(c));
      return g;
    })(),
    OPEN_AMBER: new Set(["A5s","A4s","KJs","QJs","KQo"]) // earlier amber (dup will be removed below)
  },

  HJ: {
    OPEN_GREEN: (()=>{ // ~18–20%
      const g = new Set();
      addPairs(g, "22");
      // Broadways
      addAToPlus(g);                 // ATo+
      g.add("KJo"); g.add("KQo");    // KJo+
      g.add("QJo");                  // QJo
      ["T","J","Q","K"].forEach(lo => g.add("A"+lo+"s")); // ATs+
      g.add("KTs"); g.add("KJs"); g.add("KQs");
      g.add("QTs"); g.add("QJs");
      g.add("JTs");
      // Suited Aces: A2s–A5s
      addA2s_to_A5s(g);
      // Suited connectors: T9s–65s
      addSuitedConnectorsRange(g, "T9", "65");
      // Suited gappers: 97s, 86s
      ["97s","86s"].forEach(c=>g.add(c));
      return g;
    })(),
    OPEN_AMBER: new Set(["A4s","A3s","A2s","KTs","QTs","JTs","97s","87s","76s","AJo"])
  },

  CO: {
    OPEN_GREEN: (()=>{ // ~26–28%
      const g = new Set();
      addPairs(g, "22");
      // Broadways: ATo+, KTo+, QTo+, JTo; all suited broadways
      addAToPlus(g);
      g.add("KTo"); g.add("KJo"); g.add("KQo");
      g.add("QTo"); g.add("QJo");
      g.add("JTo");
      addAllSuitedBroadways(g);
      // Suited Aces: A2s–A5s
      addA2s_to_A5s(g);
      // Suited connectors: T9s–54s
      addSuitedConnectorsRange(g, "T9", "54");
      // Suited gappers: 97s–64s
      addSuitedGappersRange(g, "9", "6");
      // Offsuit Aces: A8o+
      addA8oPlus(g);
      return g;
    })(),
    OPEN_AMBER: new Set(["AJo","ATo","KTo","QTo","J9s","T8s","97s","54s"])
  },

  BTN: {
    OPEN_GREEN: (()=>{ // ~45–50%
      const g = new Set();
      addPairs(g, "22");
      // Broadways: ALL offsuit & suited
      addAllOffsuitBroadways(g);
      addAllSuitedBroadways(g);
      // Offsuit Aces: A2o+
      addA2oPlus(g);
      // Suited Aces: ALL Axs
      addAllAxs(g);
      // Suited connectors: T9s–32s
      addSuitedConnectorsDownTo(g, "32");
      // Suited gappers: 97s–42s
      addSuitedGappersRange(g, "9", "4");
      // Offsuit connectors: T9o, 98o, 87o
      addOffsuitConnectorsList(g, ["T9o","98o","87o"]);
      return g;
    })(),
    OPEN_AMBER: new Set(["K8s","Q8s","J7s","T7s","A9o","K9o","Q9o"])
  },

  SB: {
    OPEN_GREEN: (()=>{ // ~35–40% (raise-or-fold; modern)
      const g = new Set();
      addPairs(g, "22");
      // Aces
      addA2oPlus(g);     // A2o+
      addAllAxs(g);      // all Axs
      // Suited broadways: ALL
      addAllSuitedBroadways(g);
      // Most offsuit broadways: KTo+, QTo+, JTo
      addMostOffsuitBroadways_KTo_QTo_JTo(g);
      // Suited connectors: T9s–54s
      addSuitedConnectorsRange(g, "T9", "54");
      // Suited gappers: 97s–64s
      addSuitedGappersRange(g, "9", "6");
      // Offsuit connectors: T9o, 98o
      addOffsuitConnectorsList(g, ["T9o","98o"]);
      return g;
    })(),
    OPEN_AMBER: new Set(["AJo","KJo","QJo","J9s","T8s","76s"]) // kept from earlier
  },

  BB: {
    // If everyone folds to BB & you raise (rare), use a wide but slightly tighter than SB set.
    OPEN_GREEN: (()=>{ 
      const g = new Set();
      addPairs(g, "22");
      addAllSuitedBroadways(g);
      addMostOffsuitBroadways_KTo_QTo_JTo(g); // "most offsuit broadways"
      addA2oPlus(g);      // A2o+
      addAllAxs(g);       // all Axs
      addSuitedConnectorsRange(g, "T9", "54");
      addSuitedGappersRange(g, "9", "6");
      return g;
    })(),
    OPEN_AMBER: new Set(["A9s","A8s","KJs","QTs","J9s","98s"])
  }
};

// Ensure AMBER doesn’t duplicate GREEN (for cleaner coloring)
(function deDupeAmber(){
  Object.values(EXPLICIT_OPEN).forEach(seat=>{
    if (!seat || !seat.OPEN_GREEN || !seat.OPEN_AMBER) return;
    for (const code of seat.OPEN_GREEN) {
      if (seat.OPEN_AMBER.has(code)) seat.OPEN_AMBER.delete(code);
    }
  });
})();

// ===== 3-bet & Defend masks (hybrid) =====
const HYBRID_3BET_RANGES = {
  BTN: {
    CO: { open:["QQ+","AKo","AQs+","KQs","AJo"], mix:["TT-JJ","ATs"] },
    HJ: { open:["QQ+","AKo","AQs+","KQs"], mix:["JJ","ATs","KJs"] },
    UTG:{ open:["QQ+","AKo","AQs+"], mix:["JJ","KQs"] },
    SB:  { open:["JJ+","AKo","AQs+"], mix:["AJo","KQs"] }
  },
  SB: {
    BTN: { open:["JJ+","AKo","AQs+","KQs","AJo"], mix:["TT","ATs","KJs"] },
    CO:  { open:["QQ+","AKo","AQs+","KQs"], mix:["JJ","ATs"] },
    HJ:  { open:["QQ+","AKo","AQs+"], mix:["JJ","KQs"] },
    UTG: { open:["QQ+","AKo","AQs+"], mix:["JJ"] }
  },
  CO: {
    HJ:  { open:["QQ+","AKo","AQs+","KQs"], mix:["JJ","ATs"] },
    UTG: { open:["QQ+","AKo","AQs+"], mix:["JJ"] }
  },
  HJ: {
    UTG: { open:["QQ+","AKo","AQs+"], mix:["JJ"] }
  },
  BB: {
    BTN: { open:["JJ+","AKo","AQs+","KQs"], mix:["TT","ATs","KJs"] },
    CO:  { open:["QQ+","AKo","AQs+"], mix:["JJ","KQs"] },
    HJ:  { open:["QQ+","AKo","AQs+"], mix:["JJ"] },
    UTG: { open:["QQ+","AKo","AQs+"], mix:["JJ"] },
    SB:  { open:["JJ+","AKo","AQs+"], mix:["TT","KQs"] }
  }
};
const HYBRID_DEFEND_RANGES = {
  BTN: { open:["22+","A2s+","K7s+","Q8s+","J8s+","T8s+","98s-54s","A2o+","KTo+","QTo+","JTo"], mix:["K9o","Q9o"] },
  CO:  { open:["22+","A2s+","K8s+","Q9s+","J9s+","T9s-65s","A8o+","KJo+","QJo"], mix:["KTo","QTo"] },
  HJ:  { open:["22+","A2s+","K9s+","QTs+","JTs-76s","A9o+","KQo"], mix:["KJo","QJo"] },
  UTG: { open:["22+","A3s+","KTs+","QJs","JTs-87s","AJo+","KQo"], mix:["ATo","KJo"] },
  SB:  { open:["—"], mix:["—"] } // SB defend special; often 3-bet/fold vs late opens
};

// Normalize a token -> explicit hand codes (keep your expandToken implementation)
// Normalize a token (e.g., "ATs-A5s", "A2o+", "TT+") into explicit hand codes.
// Works with:
//  - Pairs:  "TT+", "99"
//  - Suited: "AQs+", "ATs-A5s", "T9s-54s", "KQs"
//  - Offsuit:"A2o+", "KQo"
// Notes:
//  - RANKS_ASC = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"] (high -> low)
//  - RANK_INDEX maps rank -> index in that array (smaller index = stronger rank).
function expandToken(token){
  token = token.replace(/[–—]/g, '-').trim();

  // ---------- 1) PAIRS with "+" e.g., "TT+" ----------
  if (/^([2-9TJQKA])\1\+$/.test(token)) {
    const hi = token[0];                 // e.g., 'T'
    const startIdx = RANKS_ASC.indexOf(hi);
    // From AA down to TT: indices 0..startIdx inclusive
    return RANKS_ASC.slice(0, startIdx + 1).map(r => r + r);
  }

  // ---------- 2) Single PAIR e.g., "99" ----------
  if (/^([2-9TJQKA])\1$/.test(token)) {
    return [token];
  }

  // ---------- 3) SUITED / OFFSUIT with "+" e.g., "A2o+", "K9s+" ----------
  // Meaning: fix the first rank (hi) and sweep the second rank from 'lo' up to just below 'hi'.
  if (/^[2-9TJQKA]{2}[so]\+$/.test(token)) {
    const hi  = token[0];
    const lo0 = token[1];
    const sfx = token[2]; // 's' or 'o'
    const hiIdx = RANK_INDEX[hi];      // e.g., 'A' -> 0
    const loIdx0 = RANK_INDEX[lo0];    // e.g., '2' -> 12
    const stopAt = hiIdx + 1;          // sweep down to just under 'hi' (e.g., A -> stop at K (idx 1))
    const out = [];
    // Walk indices DOWN: lo0, then stronger kickers approaching 'hi', but NOT past stopAt
    for (let i = loIdx0; i >= stopAt; i--) {
      const kicker = RANKS_ASC[i];
      out.push(hi + kicker + sfx);
    }
    return out;
  }

  // ---------- 4) RANGED SUITED AX/Broadway e.g., "ATs-A5s" ----------
  if (/^[2-9TJQKA]{2}s-[2-9TJQKA]{2}s$/.test(token)) {
    const hi      = token[0];          // 'A' in "ATs-A5s"
    const loStart = token[1];          // 'T'
    const loEnd   = token[4];          // '5'
    const startIdx = RANKS_ASC.indexOf(loStart);
    const endIdx   = RANKS_ASC.indexOf(loEnd);
    const out = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const lo = RANKS_ASC[i];
      if (RANK_INDEX[hi] < RANK_INDEX[lo]) out.push(hi + lo + 's');
    }
    return out;
  }

  // ---------- 5) RANGED SUITED CONNECTORS e.g., "T9s-54s" ----------
  if (/^[2-9TJQKA][2-9TJQKA]s-[2-9TJQKA][2-9TJQKA]s$/.test(token)) {
    const a = token.slice(0, 3);   // e.g., T9s
    const b = token.slice(4, 7);   // e.g., 54s
    const seq = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"]; // high -> low

    // Find start like "T9s" in the descending chain; then move down until we hit "54s"
    let out = [];
    let startFound = false;
    for (let i = 0; i < seq.length - 1; i++) {
      const hi = seq[i], lo = seq[i+1];
      const code = hi + lo + 's';
      if (!startFound) {
        if (code === a) { startFound = true; out.push(code); }
      } else {
        out.push(code);
        if (code === b) break;
      }
    }
    return out;
  }

  // ---------- 6) Single suited/offsuit like "KQs", "QJo" ----------
  if (/^[2-9TJQKA]{2}[so]$/.test(token)) {
    const hi = token[0], lo = token[1];
    if (RANK_INDEX[hi] < RANK_INDEX[lo]) return [token]; // ensure hi > lo by rank strength
    return [];
  }

  // ---------- 7) Edge fallback: raw two-rank "AK" (rare) ----------
  if (/^[2-9TJQKA]{2}$/.test(token)) return [token];

  return [];
}

function buildClassMapForPos(pos){
  const def = HYBRID_RANGES[pos] || {open:[], mix:[]};
  const openSet = new Set(def.open.flatMap(expandToken));
  const mixSet = new Set(def.mix.flatMap(expandToken));
  return buildClassMapFromSets(openSet, mixSet);
}
function buildClassMapFromSets(openSet, mixSet){
  const map = new Map();
  for (let i=0;i<RANKS_ASC.length;i++){
    for (let j=0;j<RANKS_ASC.length;j++){
      const r1=RANKS_ASC[i], r2=RANKS_ASC[j];
      if (i===j){
        const code=r1+r2;
        map.set(code, openSet.has(code)?'open':(mixSet.has(code)?'mix':'fold'));
      } else if (i<j){
        const sCode=r1+r2+'s', oCode=r1+r2+'o';
        map.set(sCode, openSet.has(sCode)?'open':(mixSet.has(sCode)?'mix':'fold'));
        map.set(oCode, openSet.has(oCode)?'open':(mixSet.has(oCode)?'mix':'fold'));
      }
    }
  }
  return map;
}

// ===== Fallbacks when RANGES_JSON is missing (Explicit / Hybrid) =====
function explicitOpenClassFor(seat, code){
  try{
    const exp = (typeof EXPLICIT_OPEN !== 'undefined') ? EXPLICIT_OPEN[seat] : undefined;
    if (!exp) return 'fold';
    if (exp.OPEN_GREEN?.has(code)) return 'open';
    if (exp.OPEN_AMBER?.has(code)) return 'mix';
  }catch(e){}
  return 'fold';
}
function hybridOpenClassFor(seat, code){
  try{
    const map = buildClassMapForPos(seat);  // already defined in your file
    return map.get(code) || 'fold';
  }catch(e){}
  return 'fold';
}
function listToClassMap(lists){
  // lists: {open:[tokens], mix:[tokens]}
  if (!lists) return null;
  const openSet = new Set((lists.open ?? []).flatMap(expandToken));
  const mixSet  = new Set((lists.mix  ?? []).flatMap(expandToken));
  return { openSet, mixSet };
}
function classFromLists(listMap, code){
  if (!listMap) return 'fold';
  if (listMap.openSet.has(code)) return 'open';
  if (listMap.mixSet.has(code))  return 'mix';
  return 'fold';
}

// ==================== Preflop Engine v1 (deterministic) ====================
// Uses RANGES_JSON + built-ins to simulate villain actions up to hero's turn.
// Priority: 3-bet > call > fold. Sizing: simple, deterministic (see below).

// -- Table snapshot for this hand
let TABLE = { seats: [] }; // [{ seat:'UTG', role:'hero'|'villain', hand:[c1,c2] }]

// -- Helpers: codes, bucket tests, sizes
function handToCode(h){
  const [a,b] = h; const rA=a.rank, rB=b.rank, sA=a.suit, sB=b.suit;
  if (rA===rB) return rA+rB;
  const hi = (RANK_INDEX[rA] < RANK_INDEX[rB]) ? rA : rB;
  const lo = (hi===rA) ? rB : rA;
  return hi + lo + (sA===sB ? 's' : 'o');
}

// freqToClass is defined below in your ranges loader; use same thresholds
function inBucket(bucketObj, code){
  if (!bucketObj) return false;
  const cls = freqToClass(bucketObj[code]);
  return (cls==='open' || cls==='mix');
}
function canOpen(seat, code){
  // 1) JSON if available
  const jsonBucket = RANGES_JSON?.open?.[seat];
  if (jsonBucket && inBucket(jsonBucket, code)) return true;
  // 2) Explicit fallback
  const expCls = explicitOpenClassFor(seat, code);
  if (expCls === 'open' || expCls === 'mix') return true;
  // 3) Hybrid fallback
  const hybCls = hybridOpenClassFor(seat, code);
  return (hybCls === 'open' || hybCls === 'mix');
}
function inThreeBetBucket(seat, opener, code){
  // 1) JSON if available
  const key = `${seat}_vs_${opener}`;
  const json = RANGES_JSON?.three_bet?.[key];
  if (json && inBucket(json, code)) return true;
  // 2) Hybrid fallback (token lists)
  const lists = HYBRID_3BET_RANGES?.[seat]?.[opener] ?? null;
  const lm = listToClassMap(lists);
  const cls = classFromLists(lm, code);
  return (cls==='open' || cls==='mix');
}
function inCallBucket(seat, opener, code){
  if (seat === 'BB'){
    // 1) JSON BB defend
    const key = `BB_vs_${opener}`;
    const json = RANGES_JSON?.defend?.[key];
    if (json && inBucket(json, code)) return true;
    // 2) Hybrid defend fallback (by opener)
    const lists = HYBRID_DEFEND_RANGES?.[opener] ?? null;
    const lm = listToClassMap(lists);
    const cls = classFromLists(lm, code);
    return (cls==='open' || cls==='mix');
  } else {
    // 1) JSON non-BB call
    const key = `${seat}_vs_${opener}`;
    const call = RANGES_JSON?.vs_open?.[key]?.call;
    if (call && inBucket(call, code)) return true;
    // 2) Hybrid defend fallback (by opener)
    const lists = HYBRID_DEFEND_RANGES?.[opener] ?? null;
    const lm = listToClassMap(lists);
    const cls = classFromLists(lm, code);
    return (cls==='open' || cls==='mix');
  }
}

// Open sizes (raise-to) by seat: midpoint of your guidance
function standardOpenSizeBb(seat){
  if (seat === 'SB') return 3.5;
  // UTG/HJ/CO/BTN
  return 2.2;
}
// 3-bet size (raise-to) vs an open size (in BB)
function threeBetSizeBb(openerSeat, threeBetterSeat, openToBb){
  // Heuristic IP/OOP
  const ipSeats = new Set(['BTN','CO']); // rough IP heuristic for training
  const threeBetterIP = ipSeats.has(threeBetterSeat) && !ipSeats.has(openerSeat);
  const mult = threeBetterIP ? 3.0 : 4.0;
  return Math.max(2.0 * openToBb, mult * openToBb);
}

// -- Action order (preflop always UTG → ... → BB)
const ACTION_ORDER = ["UTG","HJ","CO","BTN","SB","BB"];

// -- Seating for a new hand: hero seat rotates per your code; deal everyone
function initTableForNewHand(){
  TABLE.seats = ACTION_ORDER.map(seat => ({ seat, role:'villain', hand:null }));
  const heroSeat = currentPosition();
  // Mark hero
  const idx = TABLE.seats.findIndex(s => s.seat === heroSeat);
  if (idx >= 0) TABLE.seats[idx].role = 'hero';

  // Hero already has holeCards; attach them and deal others from deck
  TABLE.seats.forEach(s => {
    if (s.role === 'hero'){
      s.hand = [ holeCards[0], holeCards[1] ];
    } else {
      s.hand = [ dealCard(), dealCard() ];
    }
  });
}

// -- Compute pot contributions (trainer-simple, 'raise-to' contributions)
function postedBlindFor(seat){
  if (seat === 'SB') return toStep5(BLINDS.sb);
  if (seat === 'BB') return toStep5(BLINDS.bb);
  return 0;
}

// Add a "raise-to" (open/3-bet) contribution to pot (trainer-simple)
function contributeRaiseTo(pot, raiseTo, seat){
  const already = postedBlindFor(seat); // SB/BB -> 5/10; others -> 0
  const putIn = Math.max(0, toStep5(raiseTo) - toStep5(already));
  return toStep5(pot + putIn);
}

// Add a "call" contribution to pot
function contributeCallTo(pot, targetTo, seat){
  const already = postedBlindFor(seat);
  const callAmt = Math.max(0, toStep5(targetTo) - toStep5(already));
  return toStep5(pot + callAmt);
}


function currentPosition(){ return POSITIONS6[heroPosIdx % POSITIONS6.length]; }
function heroHandCode(){
  const [c1,c2]=holeCards;
  const rA=c1.rank, rB=c2.rank, sA=c1.suit, sB=c2.suit;
  if (rA===rB) return rA+rB;
  const hi = (RANK_INDEX[rA] < RANK_INDEX[rB]) ? rA : rB;
  const lo = (hi===rA) ? rB : rA;
  const suited = (sA===sB);
  return hi + lo + (suited?'s':'o');
}
function classifyHeroHandAtPosition(){
  const code = heroHandCode();
  const seat = currentPosition();
  const clsMap = getClassMapForSeat(seat);
  const cls = clsMap.get(code) || 'fold';
  return (cls === 'open') ? 'Open' : (cls === 'mix' ? 'Mix' : 'Fold');
}

// Context-aware preflop suggestion for the badge & modal.
// Returns: { kind: 'Open'|'3-Bet'|'Call'|'Fold', band: 'green'|'amber'|'red', src: 'JSON'|'HYBRID'|'EXPLICIT'|'FALLBACK', detail?: string }

// Context-aware preflop suggestion for the badge & modal.
// Returns: { kind: 'Open'|'3-Bet'|'4-Bet'|'Call'|'Fold', band: 'green'|'amber'|'red', src: 'JSON'|'HYBRID'|'EXPLICIT'|'FALLBACK'|'SB-3bet-or-fold' }
function classifyHeroPreflopBadge(){
  const seat = currentPosition();
  const code = heroHandCode();
  const opener = ENGINE.preflop?.openerSeat ?? null;
  const threeBetter = ENGINE.preflop?.threeBetterSeat ?? null;

  // 1) Unopened pot → use Open ranges for hero seat
  if (!opener) {
    try {
      const bucket = RANGES_JSON?.open?.[seat];
      if (bucket && bucket[code] != null) {
        const cls = freqToClass(bucket[code]); // 'open' | 'mix' | 'fold'
        if (cls === 'open') return { kind:'Open', band:'green', src:'JSON' };
        if (cls === 'mix')  return { kind:'Open', band:'amber', src:'JSON' };
        return { kind:'Fold', band:'red', src:'JSON' };
      }
    } catch(e){/* fallback below */}
    try {
      const clsMap = getClassMapForSeat(seat); // prefers explicit, then hybrid
      const cls = (clsMap.get(code) ?? 'fold');
      if (cls === 'open') return { kind:'Open', band:'green', src:'EXPLICIT' };
      if (cls === 'mix')  return { kind:'Open', band:'amber', src:'EXPLICIT' };
    } catch(e){}
    return { kind:'Fold', band:'red', src:'FALLBACK' };
  }

  // 2) Facing a 3-bet before hero acts → use vs_3bet JSON if present; else conservative fallback
  if (opener && threeBetter) {
    try {
      const key1 = `${seat}_vs_${threeBetter}_over_${opener}`;
      const key2 = `${seat}_vs_${threeBetter}`;
      const rb = RANGES_JSON?.vs_3bet?.[key1] ?? RANGES_JSON?.vs_3bet?.[key2];
      if (rb) {
        const fb = rb.four_bet ? freqToClass(rb.four_bet[code]) : null;
        const cb = rb.call     ? freqToClass(rb.call[code])     : null;
        if (fb === 'open') return { kind:'4-Bet', band:'green', src:'JSON' };
        if (fb === 'mix')  return { kind:'4-Bet', band:'amber', src:'JSON' };
        if (cb === 'open') return { kind:'Call', band:'green', src:'JSON' };
        if (cb === 'mix')  return { kind:'Call', band:'amber', src:'JSON' };
      }
    } catch(e){/* ignore */}
    const strong4b = new Set(['AA','KK','QQ','AKs','AKo']);
    if (strong4b.has(code)) return { kind:'4-Bet', band:'green', src:'FALLBACK' };
    return { kind:'Fold', band:'red', src:'FALLBACK' };
  }

  // 3) Facing an open → prefer 3-bet; else Call; else Fold
  // 3a) JSON 3-bet
  try {
    const key = `${seat}_vs_${opener}`;
    const tb = RANGES_JSON?.three_bet?.[key];
    if (tb && tb[code] != null) {
      const cls = freqToClass(tb[code]);
      if (cls === 'open') return { kind:'3-Bet', band:'green', src:'JSON' };
      if (cls === 'mix')  return { kind:'3-Bet', band:'amber', src:'JSON' };
    }
  } catch(e){/* continue */}
  // 3b) JSON Call (BB from defend.*, others from vs_open.<seat>_vs_<opener>.call)
  try {
    if (seat === 'BB') {
      const key = `BB_vs_${opener}`;
      const callBucket = RANGES_JSON?.defend?.[key];
      if (callBucket && callBucket[code] != null) {
        const cls = freqToClass(callBucket[code]);
        if (cls === 'open') return { kind:'Call', band:'green', src:'JSON' };
        if (cls === 'mix')  return { kind:'Call', band:'amber', src:'JSON' };
      }
    } else {
      const key = `${seat}_vs_${opener}`;
      const callObj = RANGES_JSON?.vs_open?.[key]?.call;
      if (callObj && callObj[code] != null) {
        const cls = freqToClass(callObj[code]);
        if (cls === 'open') return { kind:'Call', band:'green', src:'JSON' };
        if (cls === 'mix')  return { kind:'Call', band:'amber', src:'JSON' };
      }
      // SB: no JSON flat found → treat as 3-bet/fold training rule
      if (seat === 'SB') {
        return { kind:'Fold', band:'red', src:'SB-3bet-or-fold' };
      }
    }
  } catch(e){/* continue */}

  // 3c) HYBRID fallbacks (token lists you ship)
  try {
    // 3-bet hybrid (seat & opener aware)
    const lists3 = HYBRID_3BET_RANGES?.[seat]?.[opener] ?? null;
    const lm3 = listToClassMap(lists3);
    const cls3 = classFromLists(lm3, code); // 'open'|'mix'|'fold'
    if (cls3 === 'open') return { kind:'3-Bet', band:'green', src:'HYBRID' };
    if (cls3 === 'mix')  return { kind:'3-Bet', band:'amber', src:'HYBRID' };

    // Call hybrid — seat-agnostic; DO NOT apply to SB
    const listsCall = HYBRID_DEFEND_RANGES?.[opener] ?? null;
    const lmC = listToClassMap(listsCall);
    const clsC = classFromLists(lmC, code);
    if (seat !== 'SB') {
      if (clsC === 'open') return { kind:'Call', band:'green', src:'HYBRID' };
      if (clsC === 'mix')  return { kind:'Call', band:'amber', src:'HYBRID' };
    }
  } catch(e){}

  // Nothing matched → Fold
  return { kind:'Fold', band:'red', src:'FALLBACK' };
}

function setPositionDisc(){
  const pos = currentPosition();
  if (positionDisc) positionDisc.textContent = pos;
}

function setPreflopBadge() {
  if (!preflopRangeBadge) return;

  // Hide badge in Intermediate AND Expert modes, or whenever not preflop
  if (STAGES[currentStageIndex] !== 'preflop' ||
      difficulty === 'intermediate' ||
      difficulty === 'expert') {
    preflopRangeBadge.classList.add('hidden');
    return;
  }

  const rec = classifyHeroPreflopBadge(); // {kind, band}

  preflopRangeBadge.classList.remove('hidden', 'green', 'amber', 'red');
  preflopRangeBadge.textContent = `Preflop Range: ${rec.kind}`;
  preflopRangeBadge.classList.add(rec.band);
}

// ==================== Range Modal (Open / 3bet / Defend) ====================
function openRangeModal(){
  if (!rangeModalOverlay || !rangeModalBody) return;
  const seat = currentPosition();
  const heroCode = heroHandCode();
  const vsSeats = ["UTG","HJ","CO","BTN","SB"]; // opener seats

  const controlsHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
      <div class="tabbar" role="tablist" aria-label="Range mode">
        <button class="tab active" data-mode="open" role="tab" aria-selected="true">Open</button>
        <button class="tab" data-mode="3bet" role="tab">3‑bet</button>
        <button class="tab" data-mode="defend" role="tab">Defend</button>
      </div>
      <div>
        <label style="font-weight:700;margin-right:6px">vs</label>
        <select id="rangeVsSelect" class="small-select" disabled>
          ${vsSeats.map(s=>`<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
      <div><strong>Seat:</strong> ${seat} <strong>Hybrid baseline</strong> (solver‑inspired, simplified)</div>
      <div><span class="badge green">Open</span> <span class="badge amber">Mix</span> <span class="badge red">Fold</span></div>
    </div>
  `;

const defendToggleHtml = `
  <div id="defendToggle" class="tabbar" role="tablist" aria-label="Defend action" style="display:none;margin-bottom:6px">
    <button class="tab active" data-sub="call" role="tab" aria-selected="true">Call</button>
    <button class="tab" data-sub="three_bet" role="tab">3‑bet</button>
  </div>
`;



  const gridContainer = document.createElement('div');
  gridContainer.className = 'range-grid';
  const NO_DATA_HTML = `
    <div style="margin:.5rem 0;color:#9aa3b2">
      No data for this (seat, mode, vs) combination yet. Choose a different 'vs' or switch mode.
    </div>
  `;

  function classMapFromLists(lists){
    if (!lists) return null;
    const openSet = new Set((lists.open ?? []).flatMap(expandToken));
    const mixSet = new Set((lists.mix ?? []).flatMap(expandToken));
    if (openSet.size===0 && mixSet.size===0) return null;
    return buildClassMapFromSets(openSet, mixSet);
  }

  // **** JSON preference for OPEN ****
  function classMapOpen() {
           try{
                   if (hasNonEmptySeatBucket(RANGES_JSON?.open, seat)){
                  return mapFromFreqBucket(RANGES_JSON.open[seat]);
               }
          }catch(e){/* fallback */}

    const exp = (typeof EXPLICIT_OPEN !== 'undefined') ? EXPLICIT_OPEN[seat] : undefined
    if (exp && (exp.OPEN_GREEN?.size || exp.OPEN_AMBER?.size)) {
      const map = new Map();
      for (let i=0;i<RANKS_ASC.length;i++){
        for (let j=0;j<RANKS_ASC.length;j++){
          const r1=RANKS_ASC[i], r2=RANKS_ASC[j];
          let code;
          if (i===j) code=r1+r2;
          else if (i<j) code=r1+r2+'s';
          else code=r2+r1+'o';
          let cls='fold';
          if (exp.OPEN_GREEN?.has(code)) cls='open';
          else if (exp.OPEN_AMBER?.has(code)) cls='mix';
          map.set(code, cls);
        }
      }
      return map;
    }
    // Fallback: if a seat isn't defined explicitly, use hybrid tokens
    return buildClassMapForPos(seat);
  }

  // **** JSON preference for 3BET ****
  function classMap3bet(vsSeat) {
    try{
      const key = `${seat}_vs_${vsSeat}`;
      if (RANGES_JSON?.three_bet?.[key]){
        return mapFromFreqBucket(RANGES_JSON.three_bet[key]);
      }
    }catch(e){/* fallback */}
    const branch = HYBRID_3BET_RANGES[seat]?.[vsSeat] ?? null;
    return classMapFromLists(branch);
  }

// **** JSON preference for DEFEND / VS‑OPEN ****
// subAction: 'call' | 'three_bet'

	function classMapDefend(vsSeat, subAction) {
  // 3‑bet path delegates to three_bet map for all seats
  	if (subAction === 'three_bet') {
  	  return classMap3bet(vsSeat);
 	 }
  // CALL path
  	if (seat === 'BB') {
    // BB defend flats from 'defend.BB_vs_<Opener>'
  	  try{
      const key = `BB_vs_${vsSeat}`;
      if (RANGES_JSON?.defend?.[key]){
        return mapFromFreqBucket(RANGES_JSON.defend[key]);
      }
   	 }catch(e){/* fallback */}
    	const branch = HYBRID_DEFEND_RANGES[vsSeat] ?? null;
   	 return classMapFromLists(branch);
 	 } else {
    // Non‑BB: use vs_open.<Seat>_vs_<Opener>.call
  		  try{
     		 const key = `${seat}_vs_${vsSeat}`;
      		const callObj = RANGES_JSON?.vs_open?.[key]?.call;
     		 if (callObj) return mapFromFreqBucket(callObj);
   		 }catch(e){/* ignore */}
    		// no data
    		return null;
 	 }
	}

  function renderGridOrEmpty(clsMap){
    if (!clsMap) {
      gridContainer.innerHTML = NO_DATA_HTML;
      return;
    }
    const headerRow = ['','A','K','Q','J','T','9','8','7','6','5','4','3','2']
      .map((h,i)=>`<div class="${i===0?'':'hdr'}">${h}</div>`).join('');
    let html = headerRow;
    for (let i=0;i<RANKS_ASC.length;i++){
      const rowRank = RANKS_ASC[i];
      html += `<div class="hdr">${rowRank}</div>`;
      for (let j=0;j<RANKS_ASC.length;j++){
        const colRank = RANKS_ASC[j];
        let code, label;
        if (i===j){ code=rowRank+colRank; label=code; }
        else if (i<j){ code=rowRank+colRank+'s'; label=code; }
        else { code=colRank+rowRank+'o'; label=code; }
        const cls = clsMap.get(code) || 'fold';
        const clsClass = (cls==='open')?'cell-open':(cls==='mix'?'cell-mix':'cell-fold');
        const heroMark = (code===heroCode) ? ' cell-hero' : '';
        html += `<div class="cell ${clsClass}${heroMark}" title="${label}">${label}</div>`;
      }
    }
    gridContainer.innerHTML = html;
  }

const sourceLabel = (RANGES_JSON?.open?.[currentPosition()]) ? 'JSON' :
                    ((typeof EXPLICIT_OPEN !== 'undefined') ? 'Explicit' : 'Hybrid');

// (existing, unchanged in your file)
rangeModalBody.innerHTML = controlsHtml + defendToggleHtml +
  '<div style="margin-bottom:6px">' +
  '<span class="badge info">Range source: ' + sourceLabel + '</span>' +
  '</div>' +
  '<div id="rangeSeatNote" class="range-help"></div>';
rangeModalBody.appendChild(gridContainer);

// --- IMPORTANT: Grab DOM handles *after* writing innerHTML ---
const tabs = rangeModalBody.querySelectorAll('.tabbar .tab');
const vsSel = rangeModalBody.querySelector('#rangeVsSelect');
let defendSubAction = 'call';
const defendToggle = () => document.getElementById('defendToggle');

// === Context-aware initial render (replaces old "Initial render: OPEN" + BB UX) ===
const opener = ENGINE.preflop?.openerSeat ?? null;
const threeBetter = ENGINE.preflop?.threeBetterSeat ?? null;

// Ensure we have a badge classification available in this scope
let badgeRec = null;
try {
  badgeRec = classifyHeroPreflopBadge(); // { kind, band, src }
} catch (e) {
  badgeRec = null;
}

let initialMode = 'open';
let initialDefendSub = 'call';

// If a 3-bet exists, use the three-bettor as the 'vs' seat and pick the 3-bet sub-tab
if (threeBetter) {
  initialMode = 'defend';
  initialDefendSub = 'three_bet';
  if (vsSel) { vsSel.disabled = false; vsSel.value = threeBetter; }
} else if (opener) {
  initialMode = 'defend';
  initialDefendSub = (badgeRec && badgeRec.kind === '3-Bet') ? 'three_bet' : 'call';
  if (vsSel) { vsSel.disabled = false; vsSel.value = opener; }
}

// Ensure the defend sub-toggle reflects our chosen sub-action before first render
defendSubAction = initialDefendSub;

// Override setActiveMode so it sets up tabs, sub-tabs, and grid consistently
function setActiveMode(mode){
  tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-mode') === mode));

  const enableVs = (mode !== 'open');
  if (vsSel) vsSel.disabled = !enableVs;

  const dt = defendToggle();
  if (dt) dt.style.display = (mode === 'defend') ? 'inline-flex' : 'none';

  // If we're in defend mode, visually select the correct sub-tab
  if (mode === 'defend') {
    const dtEl = defendToggle();
    if (dtEl) {
      dtEl.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      const want = dtEl.querySelector(`.tab[data-sub="${defendSubAction}"]`);
      if (want) want.classList.add('active');
    }
  }

  // Compute and render the appropriate grid for this mode
  let clsMap = null;
  if (mode === 'open') {
    clsMap = classMapOpen();
  } else if (mode === '3bet') {
    clsMap = classMap3bet(vsSel ? vsSel.value : 'UTG');
  } else { // 'defend'
    clsMap = classMapDefend(vsSel ? vsSel.value : 'UTG', defendSubAction);
  }
  renderGridOrEmpty(clsMap);
}

// Wire the existing click handlers
tabs.forEach(t => t.addEventListener('click', () => setActiveMode(t.getAttribute('data-mode'))));
if (vsSel) {
  vsSel.addEventListener('change', () => {
    const active = [...tabs].find(t => t.classList.contains('active'))?.getAttribute('data-mode') || 'open';
    setActiveMode(active);
  });
}
// Sub-toggle for defend (call / 3-bet)
(function wireDefendToggle(){
  const dt = defendToggle(); if (!dt) return;
  dt.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab'); if (!btn) return;
    dt.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    defendSubAction = btn.getAttribute('data-sub') || 'call';
    setActiveMode('defend');
  });
})();

// Do the first paint using our chosen context
setActiveMode(initialMode);

// (optional) update the seat note line if you want
const noteEl = rangeModalBody.querySelector('#rangeSeatNote');
if (noteEl) {
  if (opener) {
    noteEl.textContent = `Vs ${opener}: choose Call or 3‑bet against the opener.`;
  } else {
    noteEl.textContent = `Seat: ${currentPosition()} · Hybrid baseline (solver‑inspired, simplified).`;
  }
}

   rangeModalOverlay.classList.remove('hidden');
}

function closeRangeModal(){ if (rangeModalOverlay) rangeModalOverlay.classList.add('hidden'); }
function showPosPopover(){
  if (!positionDisc || !posPopover) return;
  const pos = currentPosition();
  posPopover.textContent = POS_ONE_LINERS[pos] || pos;
  const rect = positionDisc.getBoundingClientRect();
  const x = rect.left + (rect.width/2) - 120;
  const y = rect.bottom + 8;
  posPopover.style.left = Math.max(8,x) + "px";
  posPopover.style.top = y + "px";
  posPopover.classList.remove('hidden');
}
function hidePosPopover(){ if (posPopover) posPopover.classList.add('hidden'); }

function recommendedOpenSizeRangeBb(pos){
  if (pos==='SB') return [3.0,4.0];
  if (pos==='BTN') return [2.0,2.5];
  return [2.0,2.5]; // UTG/HJ/CO
}
function sizeEvalBadgeColor(evalStr){
  if (evalStr==='Good') return 'green';
  if (evalStr && evalStr.startsWith('Slightly')) return 'amber';
  if (evalStr==='n/a') return 'gray';
  return 'red';
}
function openSizeRuleFor(pos){
  if (pos === 'SB') return "SB: raise‑only; prefer 3.0–4.0x (OOP).";
  if (pos === 'BTN') return "BTN: prefer 2.0–2.5x (pressure blinds, widen range).";
  return `${pos}: prefer 2.0–2.5x (linear opens from tighter ranges).`;
}
function buildSizeAdvice(pos, size, min, max){
  if (pos==='SB'){
    if (size<min) return "SB opens are typically larger (3–4x) to compensate for being out of position.";
    if (size>max) return "SB can open large, but 3–4x is sufficient in most lineups.";
    return "Nice. SB larger opens (3–4x) deny equity and simplify postflop play OOP.";
  }
  if (pos==='BTN'){
    if (size<min) return "BTN opens too small lose value; 2.0–2.5x is efficient vs blinds.";
    if (size>max) return "BTN usually keeps opens small (2.0–2.5x) to widen range and price defenses poorly.";
    return "Perfect. Small BTN opens (2.0–2.5x) pressure blinds while keeping range wide.";
  }
  if (size<min) return "Open is slightly small; common baselines are ~2.0–2.5x here.";
  if (size>max) return "Open is larger than typical; most baselines prefer ~2.0–2.5x in early/mid seats.";
  return "Good. Linear opens in early/mid seats usually use ~2.0–2.5x.";
}

// ==================== Equity Cheatsheet ====================
const equityModalOverlay = document.getElementById('equityModalOverlay');
const equityModalClose = document.getElementById('equityModalClose');
const equityModalBody = document.getElementById('equityModalBody');

// Simplified cheatsheet rows (you can swap back to the larger set if you prefer)
const EQUITY_CHEATSHEET = {
  scope: "Heads‑up, flop, vs one random hand; directional guide",
  rows: [
    { cls: 'Nuts / Likely Nuts', eq: '75–95%', ex: 'Sets, strong two pair, nut draws' },
    { cls: 'Strong Value',       eq: '60–75%', ex: 'Overpairs, top pair good kicker' },
    { cls: 'Medium strength',    eq: '35–55%', ex: 'Weak top pair, second pair' },
    { cls: 'Weak Showdown',      eq: '20–40%', ex: 'Ace high, underpairs' },
    { cls: 'Draws (Combo / Strong / Weak)', eq: '25–55% (~50% / ~40% / ~25%)', ex: 'Flush draws, OESDs, gutshots, backdoors' }
  ],
  adjustments: [
    { label: 'Opponent has Tight range?', delta: '−15%' },
    { label: 'Opponent has Loose range?', delta: '+10%' },
    { label: 'Domination risk?',          delta: '−20%' },
    { label: 'You dominate them?',        delta: '+10%' }
  ]
};

// Compact coach note from CBET frequency
function oneLinerNoteForFreq(freq){
  if (freq === 'High') return 'Bet small often';
  if (freq === 'Med')  return 'Mix checks & small/medium bets';
  if (freq === 'Low')  return 'Check more; size up when betting';
  return 'Mix and react to runouts';
}

function openEquityEstimatesModal(){
  if (!equityModalOverlay || !equityModalBody) return;

  // One-liner Board Read
  let moisture = '—', catLabel = 'Texture', freq = '';
  try {
    const tex = analyzeBoard(boardCards, holeCards) || {};
    moisture = tex.moistureBucket || '—';
  } catch(e){}
  try {
    const catKey = mapBoardToCategory(boardCards, holeCards);
    const guide  = CBET_GUIDE[catKey];
    if (guide){ catLabel = guide.label; freq = guide.freq; }
  } catch(e){}
  const oneLiner = `${catLabel} · ${moisture} — ${oneLinerNoteForFreq(freq)}`;

  const rowsHtml = EQUITY_CHEATSHEET.rows.map(r => `
    <tr>
      <td><strong>${r.cls}</strong></td>
      <td><span class="badge blue">${r.eq}</span></td>
      <td class="muted">${r.ex}</td>
    </tr>
  `).join('');

  const adjustmentsHtml = EQUITY_CHEATSHEET.adjustments.map(a => `
    <li>
      <span class="badge ${a.delta.trim().startsWith('+') ? 'green' : 'amber'}">${a.delta}</span>
      ${a.label}
    </li>
  `).join('');

  const headerHtml = `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
      <span class="badge info">Board read</span>
      <div style="font-weight:800">${oneLiner}</div>
    </div>
  `;

  equityModalBody.innerHTML = `
    ${headerHtml}

    <div class="eq-table-wrap">
      <table class="equity-table" role="table" aria-label="Equity estimate cheatsheet">
        <thead>
          <tr>
            <th>Hand Class</th>
            <th>Typical Equity</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>

    <div class="eq-adjustments">
      <h4>Equity Adjustments</h4>
      <ul class="eq-adj-list">${adjustmentsHtml}</ul>
      <div class="eq-footnote muted">
        These are directional nudges; apply judgment based on position, ranges, and runouts.
        Use alongside the simulator and 4&2 outs approximation.
      </div>
    </div>
  `;

  equityModalOverlay.classList.remove('hidden');
}
function closeEquityEstimatesModal(){ if (equityModalOverlay) equityModalOverlay.classList.add('hidden'); }

// ==================== Phase 2: Board → category & C-bet guide ====================
const POSTFLOP_SIZE_PRESETS = [25,33,50,66,75,100,150];
const CBET_GUIDE = {
  "A_HIGH_RAINBOW":    { label:"A‑High Rainbow",   freq:"High", sizes:[25,33],   note:"Range & nut advantage → small, frequent bets." },
  "LOW_DISCONNECTED":  { label:"Low Disconnected", freq:"High", sizes:[25,33],   note:"Deny equity to overcards; small bets perform well." },
  "PAIRED_LOW":        { label:"Paired (Low)",     freq:"Med",  sizes:[33,66],   note:"Mix checks; when betting, lean small‑to‑medium." },
  "HIGH_PAIR": { label:"High Paired (T+)", freq:"Low", sizes:[25,33], note:"Equity is flat; ranges are capped. Check often; when betting, stay small and polarized." },
  "BROADWAY_HEAVY":    { label:"Broadway‑Heavy",   freq:"Med",  sizes:[33,50],   note:"Ranges interact; favour small/medium in position." },
  "TWO_TONE_DYNAMIC":  { label:"Two‑tone / Wet",   freq:"Low",  sizes:[66,100],  note:"Lower freq; size up to tax draws." },
  "MONOTONE":          { label:"Monotone",         freq:"Low",  sizes:[66,100],  note:"Compressed equities; polar bigger bets or checks." },
  "FOUR_TO_STRAIGHT":  { label:"4‑to‑Straight",    freq:"Low",  sizes:[100,150], note:"Threat advantage → large/overbets when betting." }
};
function boardHasManyBroadways(board){
  const BW=new Set(["T","J","Q","K","A"]); let cnt=0; board.forEach(c=>{ if (BW.has(c.rank)) cnt++; }); return cnt>=2;
}
function isAHighRainbowDry(board){
  if (board.length<3) return false;
  const ranks=board.map(c=>c.rank); const hasA = ranks.includes("A");
  const suits = new Set(board.map(c=>c.suit));
  const tex = analyzeBoard(board, []);
  return hasA && suits.size>=3 && !tex.connected && !tex.fourToStraight;
}
function boardPairedRankAtMost(board, maxRankChar){
  const map={}; board.forEach(c=> map[c.rank]=(map[c.rank]??0)+1 );
  const order=["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
  const maxIdx=order.indexOf(maxRankChar);
  return Object.keys(map).some(r => map[r]>=2 && order.indexOf(r)<=maxIdx);
}
function mapBoardToCategory(board, hole){
  const tex = analyzeBoard(board, hole);
  if (tex.fourToStraight) return "FOUR_TO_STRAIGHT";
  if (tex.mono) return "MONOTONE";
  const suits = new Set(board.map(c=>c.suit));
  const twoTone = (board.length>=3 && suits.size===2 && !tex.mono);
  if (twoTone && (tex.connected || boardHasManyBroadways(board))) return "TWO_TONE_DYNAMIC";
  if (boardPairedRankAtMost(board, "9")) return "PAIRED_LOW";
  if (boardPairedRankAtMost(board, "A") && !boardPairedRankAtMost(board, "9")) return "HIGH_PAIR";
  if (isAHighRainbowDry(board)) return "A_HIGH_RAINBOW";
  if (boardHasManyBroadways(board)) return "BROADWAY_HEAVY";
  return "LOW_DISCONNECTED";
}
function openGuideModalFor(categoryKey){
  if (!guideModalOverlay || !guideModalBody) return;
  const g = CBET_GUIDE[categoryKey];
  if (!g) {
    guideModalBody.innerHTML = `
      <div style="color:#9aa3b2">No guide available for this texture (key: <code>${categoryKey || 'unknown'}</code>).</div>
    `;
    guideModalOverlay.classList.remove('hidden');
    return;
  }
  // Header labels: 25% / 33% / ... (kept)
  const hdr = ['<div class="hdr"></div>']
    .concat(POSTFLOP_SIZE_PRESETS.map(s => `<div class="hdr">${s}%</div>`))
    .join('');

  // Which bucket class applies to a given size
  const freqClass = (pct) => {
    if (g.sizes.includes(pct)) return 'freq-high';
    const near = g.sizes.some(x => Math.abs(x - pct) <= (pct >= 100 ? 25 : 17));
    return near ? 'freq-med' : 'freq-low';
  };

  const cells = POSTFLOP_SIZE_PRESETS.map(pct => {
    const klass = freqClass(pct);
    const aria = (klass === 'freq-high') ? 'High (recommended)' : (klass === 'freq-med' ? 'Medium (adjacent)' : 'Low');
    return `
      <div class="cell ${klass}" aria-label="${pct}% · ${aria}" title="${pct}% — ${aria}">
        <span class="dot">●</span>
      </div>
    `;
  }).join('');

  guideModalBody.innerHTML = `
    <div><strong>Board:</strong> ${g.label}</div>
    <div class="guide-grid" style="margin-top:6px">
      ${hdr}
      <div class="rowhdr">${g.freq} c‑bet frequency</div>
      ${cells}
    </div>
    <div class="legend">
      <span class="chip hi">High (recommended)</span>
      <span class="chip med">Medium (adjacent)</span>
      <span class="chip low">Low</span>
    </div>
    <div style="margin-top:8px;color:#9aa3b2">${g.note}</div>
  `;
  guideModalOverlay.classList.remove('hidden');
};
function closeGuideModal(){ if (guideModalOverlay) guideModalOverlay.classList.add('hidden'); }

// ===== Decision label + size rows =====
function updateDecisionLabels(){
  const stage = STAGES[currentStageIndex];
  const decRaiseLabel = document.querySelector('label[for="decRaise"]');
  const decCallLabel  = document.querySelector('label[for="decCall"]'); // <-- NEW

  if (decRaiseLabel) {
    if (stage === 'preflop') decRaiseLabel.textContent = "Raise";
    else decRaiseLabel.textContent = (toCall > 0) ? "Raise" : "Bet";
  }

  if (decCallLabel) {
    // If no price to call, show "Check"; otherwise "Call"
    decCallLabel.textContent = (toCall > 0) ? "Call" : "Check";
  }

  const isPre  = (stage === 'preflop');
  const isPost = !isPre;
  const raiseChecked = document.getElementById('decRaise')?.checked;

  if (sizePresetRow)     sizePresetRow.classList.toggle('hidden', !(isPre  && raiseChecked));
  if (sizePresetRowPost) sizePresetRowPost.classList.toggle('hidden', !(isPost && raiseChecked));
}

// Dynamically retarget preflop size pills:
// - No opener → ×BB (openers)
// - Facing opener → ×(opener's raise-to)

function updatePreflopSizePresets(){
  if (!sizePresetRow) return;

  const hero   = currentPosition();
  const opener = ENGINE?.preflop?.openerSeat ?? null;
  const pills  = Array.from(sizePresetRow.querySelectorAll('.size-bb'));

  // Ensure we have an info line under the pills
  let note = document.getElementById('preSizeContextNote');
  if (!note){
    note = document.createElement('div');
    note.id = 'preSizeContextNote';
    note.className = 'muted';
    note.style.marginTop = '6px';
    sizePresetRow.appendChild(note);
  }

  // --- Seed a permanent ×BB base the first time we see each pill ---
  // HTML should provide a data-bb initially (e.g., 2.0, 2.2, 2.5...), we copy it once.
  pills.forEach(btn => {
    const base = btn.getAttribute('data-bb-base');
    if (base == null) {
      const bbInit = btn.getAttribute('data-bb');
      if (bbInit != null) btn.setAttribute('data-bb-base', bbInit);
    }
  });

  if (!opener){
    // ========== OPENING: restore ×BB labels & attributes ==========
    pills.forEach(btn => {
      const base = parseFloat(btn.getAttribute('data-bb-base')); // permanent source of truth
      if (isFinite(base)) {
        btn.setAttribute('data-bb', String(base));   // restore data-bb
        btn.removeAttribute('data-mult');            // clear 3-bet mode
        btn.textContent = `${base.toFixed(1)}× BB`;  // label as ×BB
      }
    });
    note.textContent = 'Opening: sizes are multiples of the Big Blind (×BB).';
    // Clear any leftover 3-bet multiplier in state
    heroActions.preflop.sizeMult = null;
    return;
  }

  // ========== Facing an opener: switch to fixed × of open set ==========
  // Determine IP vs OOP (optional text note only)
  const iHero = ACTION_ORDER.indexOf(hero);
  const iOp   = ACTION_ORDER.indexOf(opener);
  const heroActsAfterOpener = (iHero > iOp);
  const heroIP = heroActsAfterOpener && hero !== 'SB' && hero !== 'BB';

  // Fixed 3-bet presets (future-proofs 4-bet UI)
  const M = [2.0, 2.2, 2.5, 3.0, 4.0, 5.0];

  // Re-label pills as × of open; store multipliers; drop transient data-bb
  pills.forEach((btn, idx) => {
    const mult = M[Math.min(idx, M.length - 1)];
    btn.setAttribute('data-mult', String(mult));
    btn.removeAttribute('data-bb');               // we'll restore from data-bb-base next time
    btn.textContent = `×${mult} of open`;
  });

  note.textContent = heroIP
    ? '3-bet sizing basis: × of opener (IP guideline ≈ ×3).'
    : '3-bet sizing basis: × of opener (OOP guideline ≈ ×4).';
}
// ==================== Phase 3 helpers/evaluators ====================
function determinePostflopAction(decision, toCall){
  if (decision==='fold') return 'fold';
  if (decision==='call') return toCall>0 ? 'call' : 'check';
  if (decision==='raise') return toCall>0 ? 'raise' : 'bet';
  return 'check';
}
function betOrRaiseLabelForStage(){
  const stage=STAGES[currentStageIndex];
  if (stage==='preflop') return 'Raise';
  return (toCall>0) ? 'Raise' : 'Bet';
}
function fmtSizeRangePct(sizes){
  if (!sizes || !sizes.length) return '';
  const sorted=[...sizes].sort((a,b)=>a-b);
  const lo=sorted[0], hi=sorted[sorted.length-1];
  const plus = (hi>=150) ? '+' : '';
  return (lo===hi) ? `${hi}%${plus}` : `${lo}–${hi}%${plus}`;
}
function boardToString(cards){ if (!cards||!cards.length) return ''; return cards.map(c=>`${c.rank}${c.suit}`).join(' '); }
function inPositionHeuristic(pos){ if (pos==='BTN' || pos==='CO') return true; if (pos==='SB'||pos==='BB'||pos==='UTG') return false; return false; }

function evalSizeAgainstGuide(chosenPct, guideSizes){
  if (chosenPct==null || !isFinite(chosenPct)) return { verdict:'n/a', detail:'No size selected.' };
  if (!guideSizes || !guideSizes.length) return { verdict:'n/a', detail:'No guide for this texture.' };
  const rec = new Set(guideSizes);
  if (rec.has(chosenPct)) return { verdict:'Good', detail:'Chosen size matches the recommended bucket.' };
  const near = guideSizes.some(x => Math.abs(x-chosenPct) <= (chosenPct>=100?25:17));
  if (near){
    if (chosenPct < Math.min(...guideSizes)) return { verdict:'Slightly small', detail:'Slightly smaller than typical for this texture.' };
    if (chosenPct > Math.max(...guideSizes)) return { verdict:'Slightly large', detail:'Slightly larger than typical for this texture.' };
    return { verdict:'Slightly off', detail:'Near the recommended bucket.' };
  }
  if (chosenPct < Math.min(...guideSizes)) return { verdict:'Too small', detail:'Much smaller than the usual sizes for this texture.' };
  return { verdict:'Too large', detail:'Much larger than the usual sizes for this texture.' };
}

function evaluateFlopCbet(catKey, isHeroPFR, pos, action, sizePct){
  const g = CBET_GUIDE[catKey];
  if (!g) return { cbetEval:'n/a', sizeEval:'n/a', note:'No guide available for this texture.' };
  if (!isHeroPFR) return { cbetEval:'Not PFR', sizeEval:'n/a', note:'You are not the preflop raiser — c‑bet guidance does not apply.' };

  const freq=g.freq; let cbetEval='Mixed';
  if (freq==='High') cbetEval = (action==='bet') ? 'Correct' : 'Missed c‑bet (okay sometimes)';
  if (freq==='Med')  cbetEval = (action==='bet') ? 'Okay (mix)' : 'Okay (mix)';
  if (freq==='Low')  cbetEval = (action==='bet') ? 'Low‑freq spot (be selective)' : 'Fine to check more';

  const ip=inPositionHeuristic(pos);
  let posNote='';
  if (ip && action==='bet' && freq!=='Low') posNote=' Being in position increases comfort for small, frequent bets.';
  if (!ip && action==='bet' && freq!=='High') posNote=' Out of position → consider more checks or larger, polar bets when you do bet.';

  const sizeRes = evalSizeAgainstGuide(sizePct, g.sizes);
  const sizeEval=sizeRes.verdict, sizeNote=sizeRes.detail;

  let note = `${g.label}: ${g.note}`;
  note += posNote ? ` ${posNote}` : '';
  if (sizeEval && sizeEval!=='n/a') note += ` Size: ${sizeEval}. ${sizeNote}`;
  return { cbetEval, sizeEval, note, recFreq:g.freq, recSizes:fmtSizeRangePct(g.sizes) };
}

function classifyTransition(prevBoard, newBoard, hole){
  const before=analyzeBoard(prevBoard,hole), after=analyzeBoard(newBoard,hole);
  const gotMonotone     = (!before.mono && after.mono);
  const nowFourToStraight = after.fourToStraight && !before.fourToStraight;
  const pairedBefore    = before.paired, pairedAfter=after.paired;
  const boardPairedUp   = (!pairedBefore && pairedAfter);
  const hiSet=new Set(["A","K","Q"]);
  const newCard=newBoard[newBoard.length-1];
  const overcardCame    = hiSet.has(newCard.rank);

  let goodForPFR=false, badForPFR=false;
  if (overcardCame) goodForPFR=true;
  if (gotMonotone || nowFourToStraight || boardPairedUp) badForPFR=true;

  return { goodForPFR, badForPFR, gotMonotone, nowFourToStraight, boardPairedUp, overcardCame };
}

// --- Classify villain hand into a simple bucket for action heuristics
function villainStrengthBucket(hole, board){
  const score = evaluate7(hole, board);
  const all = [...hole, ...board];
  const { openEnder, gutshot } = detectStraightDrawFromAllCards(all);
  const tex = analyzeBoard(board, hole);

  if (score.cat >= 2) return "strong";             // 2P+ immediate value
  if (score.cat === 1) return "medium";            // one pair
  if (tex.heroFlushDraw || openEnder) return "draw";
  if (gutshot) return "weak_draw";
  return "weak";
}

// --- Pick a villain bet size (as % pot) from guide, with a little jitter
function pickVillainSizePct(stage, board, hole){
  const catKey = mapBoardToCategory(board, hole);
  const g = CBET_GUIDE[catKey];
  let sizes = g?.sizes ?? [33,50];

  // river tends to polarise: allow upshift if g.sizes are small
  if (stage === 'river' && Math.max(...sizes) < 66) sizes = [...sizes, 66];

  let pct = sizes[Math.floor(Math.random()*sizes.length)];
  const j = VILLAIN.sizeJitter;
  const jitter = pct * ((Math.random()*2*j) - j);
  let out = Math.round(pct + jitter);
  out = Math.max(20, Math.min(200, out));
  return out;
}

// --- Probability that a seat bets, given role/frequency and strength
function villainBetProbability(seat, isPFR, stage, board, hole){
  const catKey = mapBoardToCategory(board, hole);
  const g = CBET_GUIDE[catKey];
  let base = isPFR ? (VILLAIN.betFreq[g?.freq ?? "Med"] ?? 0.45)
                   : (VILLAIN.probeFreq[g?.freq ?? "Med"] ?? 0.40);

  const strength = villainStrengthBucket(hole, board);
  if (strength === "strong") base += 0.25;
  else if (strength === "draw") base += 0.15;
  else if (strength === "weak") base -= 0.15;

  // River: push aggression a tad when strong/draws are realised
  if (stage === 'river' && (strength === "strong")) base += 0.10;

  return Math.max(0.05, Math.min(0.95, base));
}

function postflopVillainActionsUpToHero(stage){
  const heroSeat = currentPosition();
  STREET_CTX.stage = stage;
  STREET_CTX.potAtStart = pot;
  STREET_CTX.openBettor = null;
  STREET_CTX.openSizePct = null;

  // Build acting sequence from SB up to (but not including) hero
  const seq = [];
  for (const seat of POSTFLOP_ORDER){
    if (seat === heroSeat) break;
    seq.push(seat);
  }

  // Early exit if nobody before hero
  if (seq.length === 0) return;

  // Walk through seats before hero
  let pendingToCall = 0;
  let betOwner = null;

  for (const seat of seq){
    // Must be an alive villain to act
   // Must be an alive villain to act
const state = ENGINE.statusBySeat[seat];
if (state !== "in") continue;

    const hole = seatHand(seat);
    if (!hole) continue; // safety

    const isPFR = (ENGINE.preflop.openerSeat === seat);

    // If there is no live bet yet, seat may bet
    if (pendingToCall === 0){
      const p = villainBetProbability(seat, isPFR, stage, boardCards, holeCards);
      if (Math.random() < p){
        // Choose size vs current pot
        const pct = pickVillainSizePct(stage, boardCards, holeCards);
        const amt = Math.max(5, toStep5((pct/100) * pot));

        pendingToCall = amt;
        betOwner = seat;

        // Record scenario label for UI
        scenario = { label: `${seat} bets ${pct}%`, potFactor: 0 };
        STREET_CTX.openBettor = seat;
        STREET_CTX.openSizePct = pct;

        // keep looping: later seats before hero may raise/fold/call
        continue;
      } else {
        // They check; nothing to do
        continue;
      }
    } else {
      // There is a live bet; this seat decides to fold/call/raise
      const strength = villainStrengthBucket(hole, boardCards);

      // Rare raise
      const willRaise = Math.random() < VILLAIN.raiseOverBetFreq && (strength === 'strong' || strength === 'draw');
      if (willRaise){
        // Make a bigger size over pot (raise-to, not increment); prefer 75%+ on turns/rivers
        const pct = Math.max(66, pickVillainSizePct(stage, boardCards, holeCards));
        const raiseTo = Math.max(pendingToCall * 2, toStep5((pct/100) * pot)); // "to call" for hero will become this
        pendingToCall = raiseTo;
        scenario = { label: `${seat} raises to ${pct}%`, potFactor: 0 };
        betOwner = seat; // latest aggressor
        continue;
      }

      // Decide to fold if weak vs price; else call (we don't add to pot yet)
      if (strength === 'weak' || strength === 'weak_draw'){
        if (Math.random() < VILLAIN.foldFracFacingBetWeak){
          ENGINE.statusBySeat[seat] = "folded_now";
          continue;
        }
      }
      // Call (no pot add yet; hero still faces the same price)
      // (If you'd like to reflect callers in the UI, you can stash them in STREET_CTX.)
      continue;
    }
 }

// Present price to hero
toCall = toStep5(pendingToCall);
updatePotInfo(); // refresh KPI chips

// If nobody bet before hero, set a friendly scenario label
if (toCall <= 0) {
  scenario = { label: "Checks to you" };
} 
}

// Villains act behind Hero if Hero checked (or did not open the betting)
// Simulates one "betting opportunity" behind Hero: first live bettor may bet; later seats may fold/call/rare-raise.
function villainsActAfterHeroCheck(stage) {

  // If a live price already exists, do not produce another stab
  if (toCall > 0) { updatePotInfo(); return; }

  const heroSeat = currentPosition();


// Build acting sequence only for seats *after* hero; do NOT wrap.
 const order = POSTFLOP_ORDER.slice(); // ["SB","BB","UTG","HJ","CO","BTN"]
const startIdx = order.indexOf(heroSeat);
if (startIdx < 0) return;
const seq = order.slice(startIdx + 1); // act only behind Hero this street

  if (seq.length === 0) return;

  let pendingToCall = 0;

  for (const seat of seq) {
    // Must be alive
    const state = ENGINE.statusBySeat[seat];
    if (state !== "in") continue;

    const hole = seatHand(seat);
    if (!hole) continue;

    const isPFR = (ENGINE.preflop.openerSeat === seat);

    if (pendingToCall === 0) {
      // Seat may start the betting (probe/stab)
      const p = villainBetProbability(seat, isPFR, stage, boardCards, holeCards);
      if (Math.random() < p) {
        const pct = pickVillainSizePct(stage, boardCards, holeCards);
        const amt = Math.max(5, toStep5((pct/100) * pot));
        pendingToCall = amt;

        // Update scenario / context (consistent with your pre-hero pass)
        scenario = { label: `${seat} bets ${pct}%`, potFactor: 0 };
        STREET_CTX.openBettor = seat;
        STREET_CTX.openSizePct = pct;
        continue; // allow later seats to react
      } else {
        continue; // checked; move on
      }
    } else {
      // A live bet exists; this seat reacts
      const strength = villainStrengthBucket(hole, boardCards);

      // Rare raises
      const willRaise = Math.random() < VILLAIN.raiseOverBetFreq && (strength === 'strong' || strength === 'draw');
      if (willRaise) {
        const pct = Math.max(66, pickVillainSizePct(stage, boardCards, holeCards));
        const raiseTo = Math.max(pendingToCall * 2, toStep5((pct/100) * pot)); // raise-to (keeps your model)
        pendingToCall = raiseTo;
        scenario = { label: `${seat} raises to ${pct}%`, potFactor: 0 };
        continue;
      }

      // Weak hands fold some of the time; others notionally call (we do not add to pot yet; hero sees the price first)
      if ((strength === 'weak' || strength === 'weak_draw') && Math.random() < VILLAIN.foldFracFacingBetWeak) {
        ENGINE.statusBySeat[seat] = "folded_now";
      }
    }
  }

  // Present price to Hero if anyone bet/raised
  toCall = toStep5(pendingToCall);
  updatePotInfo(); // also flips Call⇄Check label via updateDecisionLabels()
  if (toCall > 0) {
    const callRadio = document.getElementById('decCall');
    if (callRadio) callRadio.checked = true;
  }

  // If nobody bet behind, set a friendly label
  if (toCall <= 0) {
    scenario = { label: "Checks through" };
  }
}
function settleVillainsAfterHero(stage, heroAction){
  // Only simulate extra callers when hero made an aggressive action without a live bet
  if (!(heroAction === 'bet' || heroAction === 'raise' || heroAction === 'call')) return;

  // If hero 'bet' (no live bet), estimate hero's bet size from pot at start of street
  if (heroAction === 'bet' && (heroActions[stage]?.sizePct != null)) {
    const pct = Number(heroActions[stage].sizePct) || 0;
    const betAmt = Math.max(5, toStep5((pct/100) * STREET_CTX.potAtStart));

    // Estimate how many villains continue behind: use currently 'in' seats excluding hero
    const aliveSeats = POSTFLOP_ORDER.filter(s => s !== currentPosition() && ENGINE.statusBySeat[s] === 'in');
    const callers = Math.round(aliveSeats.length * VILLAIN.callFracAfterHeroBet);

    // Add their calls to pot (hero's bet was already added in applyHeroContribution)
    const added = callers * betAmt;
    if (added > 0){
      pot = toStep5(pot + added);
      updatePotInfo();
    }
  }
}

function evaluateBarrel(stage, prevBoard, currBoard, isHeroPFR, pos, prevAggressive, action, sizePct){
  if (!isHeroPFR) return { barrelEval:'Not PFR', sizeEval:'n/a', note:'You are not PFR — default is to be selective with stabs.' };

  const trans = classifyTransition(prevBoard, currBoard, holeCards);
  const ip = inPositionHeuristic(pos);

  let barrelEval='Mixed', logicNote=[];
  if (trans.goodForPFR && !trans.badForPFR){
    barrelEval = (action==='bet'||action==='raise') ? 'Good continue' : 'Okay to slow down';
    logicNote.push('Overcard favours aggressor; continuing is reasonable.');
  } else if (trans.badForPFR && !trans.goodForPFR){
    barrelEval = (action==='bet'||action==='raise') ? 'Risky barrel' : 'Prudent check more';
    if (trans.gotMonotone)        logicNote.push('Board turned monotone — equities compress; reduce barrel frequency.');
    if (trans.nowFourToStraight)  logicNote.push('Four‑to‑straight appears — ranges tighten; prefer polar bets if continuing.');
    if (trans.boardPairedUp)      logicNote.push('Board paired — boats/quads live; slow down frequency.');
  } else {
    barrelEval='Mixed (neutral card)'; logicNote.push('Neutral runout — mix checks and medium‑sized barrels.');
  }

  const cat = mapBoardToCategory(currBoard, holeCards);
  const g = CBET_GUIDE[cat];
  const sizeRes = evalSizeAgainstGuide(sizePct, g ? g.sizes : null);
  const sizeEval = sizeRes.verdict, sizeNote=sizeRes.detail;

  if (!ip && (action==='bet'||action==='raise') && g && g.freq==='Low'){
    logicNote.push('OOP on low‑freq textures → check more or size up when polarized.');
  }
  let note = `${g ? g.label : 'Texture'}: ${g ? g.note : 'No guide.'}`;
  if (logicNote.length) note += ` ${logicNote.join(' ')}`;
  if (sizeEval && sizeEval!=='n/a') note += ` Size: ${sizeEval}. ${sizeNote}`;
  return { barrelEval, sizeEval, note, recFreq: g ? g.freq : '', recSizes: g ? fmtSizeRangePct(g.sizes) : '' };
}

// ==================== Phase 4: Non-PFR probe & River line ====================
function isProbeSpot(actionLabel){ return preflopAggressor!=='hero' && toCall===0 && (actionLabel==='bet' || actionLabel==='raise'); }
function evaluateProbe(stage, catKey, pos, actionLabel, sizePct){
  const ip = inPositionHeuristic(pos);
  const g = CBET_GUIDE[catKey];
  if (!g) return { probeEval:'n/a', sizeEval:'n/a', note:'No guide for this texture.' };

  let desirability='Medium';
  if (catKey==='LOW_DISCONNECTED' || catKey==='PAIRED_LOW') desirability = ip ? 'High' : 'Medium';
  if (catKey==='A_HIGH_RAINBOW' || catKey==='BROADWAY_HEAVY') desirability = 'Low';
  if (catKey==='TWO_TONE_DYNAMIC') desirability='Medium';
  if (catKey==='MONOTONE' || catKey==='FOUR_TO_STRAIGHT') desirability='Medium (polar)';

  let probeEval='Mixed';
  if (desirability.startsWith('High')) probeEval='Good probe (esp. IP)';
  else if (desirability.startsWith('Medium')) probeEval='Okay (be selective)';
  else probeEval='Risky probe (prefer checks)';

  let recSizes=g.sizes;
  if (catKey==='LOW_DISCONNECTED') recSizes=[25,33,50];
  if (catKey==='PAIRED_LOW')       recSizes=[33,50,66];
  if (catKey==='FOUR_TO_STRAIGHT' || catKey==='MONOTONE') recSizes=[66,100,150];

  const sizeRes=evalSizeAgainstGuide(sizePct ?? null, recSizes);
  const sizeEval=sizeRes.verdict, sizeNote=sizeRes.detail;

  let note = `${g.label}: Probe desirability — ${desirability}.`;
  if (ip) note += ' In position you realize equity better; probing improves EV.';
  else note += ' Out of position, prefer checks unless board is especially favourable.';
  if (sizeEval && sizeEval!=='n/a') note += ` Size: ${sizeEval}. ${sizeNote}`;
  return { probeEval, sizeEval, note, recSizes: fmtSizeRangePct(recSizes) };
}

function classifyRiverLine(actionLabel, sizePct, hole, board){
  const made = describeMadeHand(hole, board);
  const cat = made.cat, label = made.label;
  let line='Check-back', expl='';

  if (actionLabel==='bet' || actionLabel==='raise'){
    if (cat>=2){ line='Value'; expl=`Strong made hand on river (${label}). Betting for value makes sense.`; }
    else if (cat===1){ if ((sizePct??0)<=50){ line='Thin Value'; expl=`One Pair with small/medium size — thin value line.`; }
      else { line='Polar (value/bluff)'; expl=`One Pair with large size — often better as check or polar line; be selective.`; } }
    else { line='Bluff'; expl=`No made hand of strength — your river bet functions as a bluff.`; }
  } else if (actionLabel==='call'){
    if (cat>=2){ line='Value-catch'; expl=`Two Pair+ — calling to realize value vs bluffs or thin bets.`; }
    else if (cat===1){ line='Bluff-catcher'; expl=`One Pair — classic bluff-catch spot; ensure price is right.`; }
    else { line='Speculative call'; expl=`Weak hand — river calls without strength are rarely profitable.`; }
  } else if (actionLabel==='check'){
    if (cat>=2){ line='Missed value (sometimes ok)'; expl=`You hold ${label}. Consider betting unless trapping or inducing.`; }
    else if (cat===1){ line='Pot control'; expl=`Checking One Pair — reasonable to avoid thin value vs stronger ranges.`; }
    else { line='Give up'; expl=`No showdown value worth betting; check and realize whatever equity remains.`; }
  } else if (actionLabel==='fold'){
    line='Check-fold'; expl=`You chose to fold — acceptable when price is poor or range is dominated.`;
  }

  let badge='gray';
  if (line==='Value' || line==='Value-catch' || line==='Thin Value') badge='green';
  if (line==='Bluff-catcher' || line.includes('Missed') || line==='Pot control') badge='amber';
  if (line==='Bluff' || line==='Give up' || line==='Check-fold' || line==='Polar (value/bluff)') badge='purple';
  return { riverLine: line, riverExplain: expl, madeLabel: label, badge };
}

// ==================== Equity Swing Alert — helpers ====================
function equitySwingSeverity(deltaPct){
  // deltaPct = newEquity - prevEquity
  if (deltaPct <= -20) return 'red';   // big drop
  if (deltaPct <= -10) return 'amber'; // moderate drop
  if (deltaPct >=  10) return 'green'; // meaningful gain
  return null; // no alert
}
// Transition-aware swing description
function describeSwing(deltaPct, trans){
  let base;
  if (deltaPct <= -20) base = 'Big negative swing';
  else if (deltaPct <= -10) base = 'Negative swing';
  else if (deltaPct >=  10) base = 'Positive swing';
  else base = '';

  const reasons = [];
  if (trans){
    if (trans.gotMonotone)        reasons.push('board turned monotone');
    if (trans.nowFourToStraight)  reasons.push('4‑to‑straight appeared');
    if (trans.boardPairedUp)      reasons.push('board paired up');
    if (trans.overcardCame)       reasons.push('overcard hit');
  }
  if (!base) return '';
  if (reasons.length === 0){
    return base + (deltaPct < 0
      ? ' — reduce bluffing frequency / pot‑control more often.'
      : ' — consider value / pressure if supported.');
  }
  const why = reasons.join(', ');
  const steer = (deltaPct < 0)
    ? 'reduce bluffing / control pot'
    : 'consider value / pressure';
  return `${base} — ${why}; ${steer}.`;
}
function updateKpiEquitySwing(deltaPct, severity, titleText){
  const el = kpiEquitySwingEl;
  if (!el) return;
  el.classList.remove('swing-green','swing-amber','swing-red','swing-neutral');
  if (!severity){
    el.style.display = 'none';
    el.removeAttribute('title');
    return;
  }
  el.style.display = 'inline-block';
  const cls = (severity==='green') ? 'swing-green' : (severity==='amber' ? 'swing-amber' : 'swing-red');
  el.classList.add(cls);
  el.textContent = `Equity swing ${deltaPct>0?'+':''}${deltaPct.toFixed(1)}%`;
  if (titleText) el.title = titleText;
}
function insertInlineSwingBadge(deltaPct, severity, note){
  if (!severity) return;
  const col = (severity==='green') ? 'green' : (severity==='amber' ? 'amber' : 'red');
  const html = `
    <div style="margin-bottom:6px">
      <span class="badge ${col}">EQUITY SWING ${deltaPct>0?'+':''}${deltaPct.toFixed(1)}%</span>
      <span class="muted">${note}</span>
    </div>
  `;
  if (feedbackEl) feedbackEl.insertAdjacentHTML('afterbegin', html);
}

// ==================== Hand flow ====================
async function startNewHand(){
  summaryPanel.style.display = "none";
  feedbackEl.innerHTML = "";
  hintsEl.textContent = "";
  inputForm.reset();
  handHistory = [];
  updateKpiEquitySwing(0, null);

// --- RESET ALL STATUS FLAGS FOR NEW HAND ---
Object.keys(ENGINE.statusBySeat).forEach(seat => {
    ENGINE.statusBySeat[seat] = "in";
});

// Reset engine survivors
ENGINE.survivors.clear();
ENGINE.survivorsByStreet = { flop: [], turn: [], river: [] };
ENGINE.lastStreetComputed = 'preflop';

// Reset preflop metadata
ENGINE.preflop.openerSeat = null;
ENGINE.preflop.threeBetterSeat = null;
ENGINE.preflop.participants = [];

  submitStageBtn.classList.remove("hidden");
  nextStageBtn.classList.add("hidden");
  if (barSubmit) barSubmit.classList.remove("hidden");
  if (barNext) barNext.classList.add("hidden");

// Ensure ranges are in memory (URL or Local Storage), no-op if already set
await ensureRangesLoaded();
// If Local Storage has ranges, copy them into memory (guards file:// case)
if (!RANGES_JSON) {
  const raw = localStorage.getItem('trainer_ranges_json_v1');
  if (raw) { try { RANGES_JSON = JSON.parse(raw); } catch(e){} }
}

  deck = createDeck(); shuffle(deck);
  holeCards = [dealCard(), dealCard()];
  boardCards = [];
  dealtHandStr = `${holeCards[0].rank}${holeCards[0].suit} ${holeCards[1].rank}${holeCards[1].suit}`;

  // Rotate 6-max position
  heroPosIdx = (heroPosIdx + 1) % POSITIONS6.length;
  rotateLettersForNewHand();      // seats move around the table
  recomputeProfilesFromLetters(); // update engine profile map for this hand
  heroNewHand();

  preflopAggressor = null;
  heroActions.preflop = { action:null, sizeBb:null };
  heroActions.flop    = { action:null, sizePct:null, cbet:null };
  heroActions.turn    = { action:null, sizePct:null, barrel:null };
  heroActions.river   = { action:null, sizePct:null, barrel:null };

// === Phase 1 engine: build table + villains' actions up to hero (JSON‑driven) ===
const sb = toStep5(BLINDS.sb), bb = toStep5(BLINDS.bb);
initTableForNewHand();
const pf = preflopSimulateBeforeHero(); // NEW
pot = pf.potLocal;
toCall = pf.toCallLocal;
currentStageIndex = 0;
preflopAggressor = pf.openerSeat ? 'villain' : null;
scenario = { label: pf.label, potFactor: 0 };

// Persist preflop context for survivors & UI (participants were set inside preflopSimulateBeforeHero)
engineSetPreflopContext(pf.openerSeat, pf.threeBetterSeat, pf.coldCallers, pf.openToBb);
// Memo the 3-bet raise-to (in BB) for later 4-bet math (stored on ENGINE.preflop by the simulator)
try { ENGINE.preflop.threeBetToBb = (pf.threeBetterSeat ? Number(pf.threeBetToBb) : null); } catch(e){}

// Paint UI
renderCards();
setPositionDisc();
setPreflopBadge();
updatePreflopSizePresets(); // labels: ×BB for open; ×(open) for 3-bet
renderPositionStatusRow();
updatePotInfo();
updateHintsImmediate();
maybeStartTimer();

}

// Stage-aware "all folded" banner.
// Pass 'preflop' explicitly for true walks; otherwise pass the current street key.
function showAllFoldedMessage(stageKey) {
  if (!feedbackEl) return;

  // Clear any prior feedback for clarity
  feedbackEl.innerHTML = "";

  // Pretty print the stage
  const key = (stageKey || STAGES[currentStageIndex] || '').toString().toLowerCase();
  const pretty =
    key === 'preflop' ? 'Pre-flop' :
    key === 'flop'    ? 'Flop'     :
    key === 'turn'    ? 'Turn'     :
    key === 'river'   ? 'River'    :
    key.toUpperCase();

  feedbackEl.insertAdjacentHTML('beforeend', `
    <div class="walk-banner" role="status" aria-live="polite">
      <strong>All folded ${pretty} — you win the pot.</strong>
    </div>
  `);
}

// Back-compat adapter (used by preflop-walk path)
function showWalkMessage() {
  showAllFoldedMessage('preflop');
}

function advanceStage(){
  currentStageIndex++;

// degrade folded_now → folded_prev when a new street begins
Object.keys(ENGINE.statusBySeat).forEach(seat => {
    if (ENGINE.statusBySeat[seat] === "folded_now") {
        ENGINE.statusBySeat[seat] = "folded_prev";
    }
});
  feedbackEl.innerHTML = "";
  inputForm.reset();
  hintsEl.textContent = "";

  submitStageBtn.classList.remove("hidden");
  nextStageBtn.classList.add("hidden");
  if (barSubmit) barSubmit.classList.remove("hidden");
  if (barNext) barNext.classList.add("hidden");

  if (currentStageIndex >= STAGES.length){ endHand(); return; }
  const stage = STAGES[currentStageIndex];

  // --- Equity Swing: compute prev equity on previous board snapshot (include preflop) ---
const prevBoard = [...boardCards];
let prevEquity = null;
try {
  prevEquity = computeEquityStats(holeCards, prevBoard).equity;
} catch (e) { /* ignore calc errors */ }

// Deal new street + record that hero reached this street
if (stage === "flop") {
  // Defensive: if preflop had no raiser at all, ensure BB is in participants (SB is raise-or-fold)
  if (!ENGINE.preflop.openerSeat && !ENGINE.preflop.threeBetterSeat) {
    const parts = new Set(ENGINE.preflop.participants || []);
    parts.add('BB'); // only BB auto-checks to flop in unopened pot; SB does not limp
    ENGINE.preflop.participants = [...parts];
  }

  boardCards.push(dealCard(), dealCard(), dealCard());


  // Keep your existing status mapping for the flop
  applyPreflopParticipantsToStatuses();

  // NEW: track hero reaching the flop
  markStreetReached('flop');
} else if (stage === "turn") {
  boardCards.push(dealCard());

  // NEW: track hero reaching the turn
  markStreetReached('turn');
} else if (stage === "river") {
  boardCards.push(dealCard());

  // NEW: track hero reaching the river
  markStreetReached('river');
}

  // Recompute survivors for this street (villain fold/continue is deterministic)
  try { engineRecomputeSurvivorsForStreet(boardCards); } catch(e){}

// --- If no villain remains in play, end the hand immediately
{
  const hero = currentPosition();
  const anyVillainIn = ["UTG","HJ","CO","BTN","SB","BB"]
    .some(s => s !== hero && ENGINE.statusBySeat[s] === "in");
  if (!anyVillainIn) {
    renderPositionStatusRow();
    showAllFoldedMessage(stage); // <-- say "All folded Flop/Turn/River"
    endHand();
    return;
  }
}


// ---------- Preflop Walk Detection AFTER survivor recompute ----------
if (STAGES[currentStageIndex] === "flop") {
  const hero = currentPosition();
  const alive = ENGINE.survivors; // Set of seats
  const noVillainsAlive = [...alive].every(seat => seat === hero); // true if empty or only hero
  if (preflopAggressor === "hero" && noVillainsAlive) {
    Object.keys(ENGINE.statusBySeat).forEach(seat => {
      if (seat !== hero) ENGINE.statusBySeat[seat] = "folded_prev";
    });
    showAllFoldedMessage(stage); // <-- say "All folded Flop/Turn/River"
    renderPositionStatusRow();
    endHand();
    return;
  }
}
 
// === Villain actions up to hero (makes a live price and scenario label)
STREET_CTX.stage = stage;
STREET_CTX.potAtStart = pot;
postflopVillainActionsUpToHero(stage);

  // --- Compute new equity and evaluate swing (with transition reasons) ---
  let newEquity = null, delta = null;
  try {
    newEquity = computeEquityStats(holeCards, boardCards).equity;

    if (prevEquity != null && newEquity != null) {
      delta = newEquity - prevEquity; // positive = gain
      // Use same thresholds for all streets (simple); you can make street-aware if desired
      const sev = equitySwingSeverity(delta);

      let trans = null;
      try { trans = classifyTransition(prevBoard, boardCards, holeCards); } catch(e){}

      const note = describeSwing(delta, trans);

      // KPI chip (if present) + inline badge
      updateKpiEquitySwing(delta, sev, note);
      insertInlineSwingBadge(delta, sev, note);

      // store in last history row for CSV/summary later
      try {
        const last = handHistory[handHistory.length-1] || {};
        last.equitySwing = delta.toFixed(2);
        last.equitySwingBand = sev ?? '';
        last.equitySwingNote = note ?? '';
      } catch(e){}
    } else {
      updateKpiEquitySwing(0, null); // hide if no signal
    }
  } catch(e){
    updateKpiEquitySwing(0, null);
  }

  renderCards();
  renderPositionStatusRow();
  updatePotInfo();
  updateHintsImmediate();
  maybeStartTimer();
}

function renderPositionStatusRow() {
  const row = document.getElementById("positionStatusRow");
  if (!row) return;

  const heroSeat = currentPosition();
  // Show current aggressor: if a 3-bet exists, show it; else show the opener
  const pfrSeat = (ENGINE.preflop.threeBetterSeat ?? ENGINE.preflop.openerSeat ?? null);


  const seats = ["UTG","HJ","CO","BTN","SB","BB"];
  row.innerHTML = "";

  seats.forEach(seat => {
    // vertical stack: disc on top, badge below
    const stack = document.createElement("div");
    stack.className = "pos-seat-stack";

    // NEW: letter chip (above the disc)
    const letter = (LETTERS_BY_POSITION && LETTERS_BY_POSITION[seat]) ? LETTERS_BY_POSITION[seat] : "–";
    const chip = document.createElement("div");
    chip.className = "player-letter-chip";
    chip.textContent = letter;
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
 if (letter === HERO_LETTER) chip.classList.add('hero');
   
// NEW: hero vs villain click behavior
if (letter === HERO_LETTER) {
  chip.title = "Click to view your current style";
  chip.addEventListener("click", () => openHeroEvaluationPopover());
} else {
  chip.title = "Click for player style";
  chip.addEventListener("click", () => openPersonalityPopover(letter));
}
stack.appendChild(chip);



    // Disc
    const disc = document.createElement("div");
    if (seat === heroSeat) {
      disc.className = "pos-disc-villain pos-status-hero";
    } else {
      disc.className = "pos-disc-villain";
      const state = ENGINE.statusBySeat[seat];
      if (state === "in") disc.classList.add("pos-status-in");
      else if (state === "folded_now") disc.classList.add("pos-status-folded-now");
      else disc.classList.add("pos-status-folded-prev");
    }
    disc.textContent = seat;
    stack.appendChild(disc);

    // Blue PFR pill BELOW the disc (villain OR hero)
if (seat === pfrSeat) {
  const badge = document.createElement("div");
  badge.className = "pos-badge-pfr";
  badge.textContent = "PFR";

  // Accessible tooltip: visible on hover/focus, and native title for touch
  const tip = (seat === heroSeat)
    ? "Pre-flop raiser (Hero)"
    : `Pre-flop raiser (${seat})`;

  // Custom CSS tooltip
  badge.setAttribute("data-tip", tip);

  // Native tooltip + accessibility
  badge.setAttribute("title", tip);
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", tip);
  badge.setAttribute("tabindex", "0"); // allow keyboard focus to reveal tooltip

  stack.appendChild(badge);
}

    row.appendChild(stack);
  });
}

// ==================== End-of-Hand Summary (modal) ====================
// Build a compact result: winners, pot, board, and reveal policy
function buildEndHandResult(){
  const heroSeat = currentPosition();
  const allSeats = ["UTG","HJ","CO","BTN","SB","BB"];
  // Determine if hero folded at any point this hand (your history already stores this)
  const heroFolded = handHistory.some(h =>
    (h.stage === 'preflop' || h.stage === 'flop' || h.stage === 'turn' || h.stage === 'river') &&
    h.decision === 'fold'
  );

  // Seats still "in" for villains come from ENGINE.statusBySeat (hero is tracked separately)
  const aliveVillains = allSeats.filter(s => s !== heroSeat && ENGINE.statusBySeat[s] === 'in');
  const survivors = heroFolded ? aliveVillains : [...aliveVillains, heroSeat];

  const isRiver = (boardCards.length === 5);
  let winners = [];

  if (survivors.length <= 1) {
    winners = survivors.slice();
  } else if (isRiver) {
    // River showdown (or river fold with >1 alive prior to last action): compute best hand(s)
    let bestScore = null, bestSeats = [];
    for (const s of survivors){
      const hole = seatHand(s);
      if (!hole || hole.length < 2) continue;
      const sc = evaluate7(hole, boardCards); // your evaluator
      if (!bestScore){
        bestScore = sc; bestSeats = [s];
      } else {
        const cmp = compareScores(sc, bestScore); // >0 means 'sc' is better in your code
        if (cmp > 0) { bestScore = sc; bestSeats = [s]; }
        else if (cmp === 0) { bestSeats.push(s); }
      }
    }
    winners = bestSeats.length ? bestSeats : survivors.slice();
  } else {
    // Not river and multi-way — we can only say who is still alive; treat as winners list
    winners = survivors.slice();
  }

  // Decide whether to reveal villains now (re-use your REVEAL.policy)
  const policy = (typeof REVEAL !== 'undefined' && REVEAL && REVEAL.policy) ? REVEAL.policy : 'always_all';
  const revealVillains =
    policy === 'always_all' ||
    policy === 'always_remaining' ||
    (policy === 'showdown_only' && isRiver) ||
    (policy === 'on_hero_fold' && heroFolded);

  // Build payload
  return {
    pot,
    board: [...boardCards],
    winners: winners.map(seat => ({
      seat,
      hole: seatHand(seat) || null,
      // Show "winning hand" label only when river is present
      made: (isRiver && seatHand(seat))
        ? (describeMadeHand(seatHand(seat), boardCards)?.label || null)
        : null
    })),
    revealVillains
  };
}

// Render the summary modal (CSS is in your stylesheet)
function showEndHandSummary(result){
  if (!result) return;

  // Avoid duplicate modals
  const existing = document.getElementById('ehs-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'ehs-backdrop';
  backdrop.className = 'ehs-backdrop';
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  const card = document.createElement('div');
  card.className = 'ehs-card';

  const header = document.createElement('div');
  header.className = 'ehs-header';
  const streetBadge =
    (result.board.length === 5) ? 'River' :
    (result.board.length === 4) ? 'Turn' :
    (result.board.length === 3) ? 'Flop' : 'Preflop';
  header.innerHTML = `
    <div class="ehs-title">Hand Summary</div>
    <span class="ehs-badge">${streetBadge}</span>
  `;

  const body = document.createElement('div');
  body.className = 'ehs-body';

  // Pot
  const potEl = document.createElement('div');
  potEl.className = 'ehs-row ehs-pot';
  potEl.innerHTML = `Pot won: <strong>£${(result.pot ?? 0).toFixed(0)}</strong>`;
  body.appendChild(potEl);

  // Board strip
  const boardEl = document.createElement('div');
  boardEl.className = 'ehs-row';
  boardEl.innerHTML = `<div>Board:</div>`;
  const strip = document.createElement('div'); strip.className = 'ehs-board';
  (result.board || []).forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'ehs-cardchip';
    chip.textContent = c ? `${c.rank}${c.suit}` : '';
    strip.appendChild(chip);
  });
  boardEl.appendChild(strip);
  body.appendChild(boardEl);

  // Winners
  result.winners.forEach(w => {
    const div = document.createElement('div');
    div.className = 'ehs-winner';
    const madeText = (result.board.length === 5 && w.made) ? `<span class="made">• ${w.made}</span>` : '';
    div.innerHTML = `<div><span class="name">Winner: ${w.seat}</span> ${madeText}</div>`;

    // Hole cards reveal (villains if policy allows; hero always OK to show)
    const heroSeat = currentPosition();
    const shouldReveal = result.revealVillains || (w.seat === heroSeat);
    if (shouldReveal && Array.isArray(w.hole) && w.hole.length >= 2){
      const holeRow = document.createElement('div');
      holeRow.className = 'ehs-hole';
      w.hole.forEach(c => {
        const chip = document.createElement('div');
        chip.className = 'ehs-cardchip';
        chip.textContent = `${c.rank}${c.suit}`;
        holeRow.appendChild(chip);
      });
      div.appendChild(holeRow);
    }
    body.appendChild(div);
  });

  const actions = document.createElement('div');
  actions.className = 'ehs-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ehs-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => backdrop.remove());
  actions.appendChild(closeBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

function endHand(){
  clearTimer();

  // Clear KPI swing chip at hand end
  updateKpiEquitySwing(0, null);

// Villain reveal (Always remaining / Always all / Showdown-only / On hero fold)
try {
  const reveal = (REVEAL?.policy ?? 'always_all');

  const heroFolded = handHistory.some(h =>
    (h.stage === 'preflop' || h.stage === 'flop' || h.stage === 'turn' || h.stage === 'river')
    && h.decision === 'fold'
  );
  const reachedRiver = (boardCards.length === 5);

// --- HERO METRICS (end-of-hand) ---
  if (reachedRiver && !heroFolded) { markHeroShowdown(); }  // saw showdown
  if (heroFolded)                  { markHeroFolded();   }  // folded this hand

  let shouldReveal = false;
  if (reveal === 'always_remaining') shouldReveal = true;
  else if (reveal === 'always_all') shouldReveal = true;
  else if (reveal === 'showdown_only') shouldReveal = reachedRiver;
  else if (reveal === 'on_hero_fold') shouldReveal = heroFolded;

  if (shouldReveal) {
    let who = [];

    if (reveal === 'always_remaining') {
      const heroSeat = currentPosition();
      const allSeats = ["UTG","HJ","CO","BTN","SB","BB"];
      // show only villains still "in" at hand end
      who = allSeats.filter(seat => seat !== heroSeat && ENGINE.statusBySeat[seat] === "in");
    } else if (reveal === 'always_all') {
      // show all villains regardless of status
      who = TABLE.seats.filter(s => s.role === 'villain').map(s => s.seat);
    } else {
      // showdown_only / on_hero_fold → use survivorsByStreet fallback chain
      who = ENGINE.survivorsByStreet.river.length ? ENGINE.survivorsByStreet.river
          : (ENGINE.survivorsByStreet.turn.length ? ENGINE.survivorsByStreet.turn
          : ENGINE.survivorsByStreet.flop);
    }

    // Safety for 'always_remaining': if list ended empty, recompute from 'in' flags
    if ((!who || !who.length) && reveal === 'always_remaining') {
      const heroSeat = currentPosition();
      const allSeats = ["UTG","HJ","CO","BTN","SB","BB"];
      who = allSeats.filter(seat => seat !== heroSeat && ENGINE.statusBySeat[seat] === "in");
    }

    if (who && who.length) {
      const lines = who
        .map(seat => `${seat}: ${describeVillainHand(seatHand(seat))}`)
        .join(' · ');
      feedbackEl.insertAdjacentHTML(
        'beforeend',
        `<div style="margin-top:8px"><strong>Villain reveal:</strong> ${lines}</div>`
      );
    }
  }
} catch (e) {
  // Keep endHand() resilient even if something above throws
  // console.warn('Reveal block error:', e);
}


  renderPositionStatusRow();
// NEW: show end-of-hand summary modal
try {
  const result = buildEndHandResult();
  showEndHandSummary(result);
} catch (e) {
  console.warn('End-hand summary failed:', e);
}
  showSummary();
  sessionHistory.push(...handHistory);
  saveSessionHistory();
  updateSessionStats();
}

function applyHeroContribution(decision){
  const stage = STAGES[currentStageIndex];

  // Folding can end the hand, as before
  if (decision === 'fold') {
    if (SETTINGS.pot.endHandOnFold) { endHand(); }
    return;
  }

  if (decision === 'call') {
    if (toCall > 0) {
      pot = toStep5(pot + toCall);
      toCall = 0;
      updatePotInfo();
    }
    return;
  }

if (stage === 'preflop' && decision === 'raise') {
  const hero = currentPosition();
  const bb = toStep5(BLINDS.bb);
  const opener = ENGINE.preflop?.openerSeat ?? null;
  const threeBetter = ENGINE.preflop?.threeBetterSeat ?? null;

  // Record stat once (context-aware PFR/3B logic lives inside)
  updateHeroPreflop('raise');

  // Opening first-in
  if (!opener) {
    const sizeBb = Number(heroActions?.preflop?.sizeBb ?? 2.2);
    ENGINE.preflop.openerSeat = hero;
    ENGINE.preflop.openToBb   = sizeBb;
    preflopAggressor = 'hero';
    ENGINE.preflop.participants = Array.from(new Set([...(ENGINE.preflop.participants ?? []), hero]));
    scenario = { label: `Hero opened ${sizeBb.toFixed(1)}x`, potFactor: 0 };
    updatePotInfo();
    return;
  }

  // Versus an open (no 3-bettor yet) => Hero 3-bets
  if (opener && !threeBetter) {
    const openTo = toStep5((ENGINE.preflop.openToBb ?? 2.2) * bb);
    const heroIP = (["CO","BTN"].includes(hero) && !["CO","BTN"].includes(opener));
    const mult = Number(heroActions?.preflop?.sizeMult ?? (heroIP ? 3.0 : 4.0));
    const threeTo = toStep5(mult * openTo);

    ENGINE.preflop.threeBetterSeat = hero;
    ENGINE.preflop.threeBetToBb    = threeTo / bb;
    preflopAggressor = 'hero';
    ENGINE.preflop.participants = Array.from(new Set([...(ENGINE.preflop.participants ?? []), hero]));
    scenario = { 
      label: `${opener} opened ${Number(ENGINE.preflop.openToBb).toFixed(1)}x · Hero 3‑bet ${(threeTo/bb).toFixed(1)}x`,
      potFactor: 0
    };
    updatePotInfo();
    return;
  }

 // If a 3-bettor already exists here, your existing 4-bet code path handles it — keep it below.
}

// ==== POSTFLOP BET / RAISE LOGIC (stage !== 'preflop') ====
if (decision === 'raise') {
    const pct = heroActions[stage]?.sizePct ?? 50;
    const betBase = pot;
    const betAmt  = toStep5((pct/100) * betBase);

    const putIn = (toCall > 0)
        ? toStep5(toCall + betAmt)
        : betAmt;

    pot = toStep5(pot + putIn);
    toCall = 0;
    updatePotInfo();
    return;
}

} 
 

// ==================== Submit handling (with coaching) ====================
inputForm.addEventListener("submit", (e)=>{
  e.preventDefault();
  clearTimer();

  const equityInput = parseFloat(document.getElementById("equityInput").value);
  const potOddsInput = parseFloat(document.getElementById("potOddsInput").value);
  const decision = new FormData(inputForm).get("decision");
  const stage = STAGES[currentStageIndex];

// Guard: require a decision to be selected
if (!decision) {
  // Keep UI responsive: keep Submit visible if a live price exists, else allow Next
  const hasLivePrice = (toCall > 0);
  const msg = hasLivePrice
    ? 'Please choose Call / Raise / Fold to respond to the bet.'
    : 'Please choose Check / Bet / Fold before submitting.';
  feedbackEl.insertAdjacentHTML('afterbegin', `<div class="warn">${msg}</div>`);
  // Preserve buttons: if facing a price, stay on Submit; otherwise, allow Next
  submitStageBtn.classList.toggle('hidden', !hasLivePrice);
  nextStageBtn.classList.toggle('hidden',  hasLivePrice);
  if (barSubmit) barSubmit.classList.toggle('hidden', !hasLivePrice);
  if (barNext)   barNext.classList.toggle('hidden',  hasLivePrice);
  return;
}

// Decide what the action *means* before we change any pot/toCall
  const actionLabelPre   = determinePostflopAction(decision, toCall);
  const hadLivePricePre  = (toCall > 0);
  const stageNow         = STAGES[currentStageIndex];

// --- HERO METRICS (preflop) ---
if (stage === 'preflop') {
  updateHeroPreflop(decision, toCall);
}

// Keep PFR/3-bet badge in sync when hero raises preflop
if (stage === 'preflop' && decision === 'raise') {
  const heroSeat = currentPosition();
  const opener      = ENGINE?.preflop?.openerSeat ?? null;
  const threeBetter = ENGINE?.preflop?.threeBetterSeat ?? null;

  if (!opener) {
    // Hero is opening first-in: mark hero as the table PFR
    ENGINE.preflop.openerSeat = heroSeat;
    ENGINE.preflop.participants = Array.from(new Set([
      ...(ENGINE.preflop.participants || []),
      heroSeat
    ]));
  } else if (opener && !threeBetter) {
    // Hero is 3-betting vs the existing opener
    ENGINE.preflop.threeBetterSeat = heroSeat;
    ENGINE.preflop.participants = Array.from(new Set([
      ...(ENGINE.preflop.participants || []),
      heroSeat
    ]));
  }

// --- Ensure blinds see a flop when nobody raises preflop ---
// If there is still no opener after the hero's action, treat it as "checks through" preflop.
// That means BB (and SB) should be marked as participants who see the flop.
if (stage === 'preflop') {
  const opener = ENGINE?.preflop?.openerSeat ?? null;
  const threeBetter = ENGINE?.preflop?.threeBetterSeat ?? null;

  // Only when absolutely no preflop raise occurred:
  //  - no opener (so no raise to begin with)
  //  - and, by definition, no three-bet
  if (!opener && !threeBetter) {
    // Build/extend the preflop participants set
    const parts = new Set(ENGINE.preflop?.participants || []);
    // Blinds are in the hand and will see the flop when it checks through
    parts.add('BB');
    parts.add('SB');
    // (Optionally include hero if they didn't fold)
    const heroDidNotFold = (decision !== 'fold');
    if (heroDidNotFold) parts.add(currentPosition());

    ENGINE.preflop.participants = [...parts];
  }
}
  // Repaint the status row so the blue "PFR" pill reflects the hero when relevant
  renderPositionStatusRow();
}

  const equityStats = computeEquityStats(holeCards, boardCards);
  const actualEquity = equityStats.equity;
  const actualPotOdds = computePotOdds(pot, toCall);

  const equityError = equityInput - actualEquity;
  const potOddsError = potOddsInput - actualPotOdds;

  const equityBand = bandForError(equityError);
  const potOddsBand = bandForError(potOddsError);
  const decisionBandResult = decisionBand(actualEquity, actualPotOdds, decision);

  updateHintsImmediate();

  // Core feedback
  feedbackEl.innerHTML = `
    <div>
      <div><strong>Actual equity:</strong> ${actualEquity.toFixed(1)}%
        <span class="badge ${equityBand}">Equity ${equityBand}</span></div>
      <div><strong>Actual pot odds:</strong> ${actualPotOdds.toFixed(1)}%
        <span class="badge ${potOddsBand}">Pot odds ${potOddsBand}</span></div>
      <div><strong>Decision quality:</strong>
        <span class="badge ${decisionBandResult}">${decisionBandResult.toUpperCase()}</span></div>
      <div style="margin-top:8px">
        <strong>How this is calculated:</strong><br/>
        Equity is from a Monte–Carlo simulation this street sized to the number of opponents still in the hand (minimum 1).
        Trials this stage: ${equityStats.trials}.<br/>
        Pot odds use call / (pot + call), where “pot” is the pre-call pot (the number shown).
      </div>
      <div style="margin-top:8px">
        <strong>Your final hand distribution (simulated):</strong>
        ${equityStats.catBreakdown.slice(0,5).map(x=>`<span class="badge amber">${x.name}: ${x.pct.toFixed(1)}%</span>`).join(' ')}
      </div>
    </div>
  `;

  const timeUsed = difficulty==="beginner" ? null : timerSeconds - (timeLeft ?? timerSeconds);

  handHistory.push({
    stage,
    equityInput,
    equityActual: actualEquity,
    potOddsInput,
    potOddsActual: actualPotOdds,
    decision,
    equityBand,
    potOddsBand,
    decisionBand: decisionBandResult,
    timeUsed,
    handTypes: equityStats.catBreakdown.slice(0,3)
  });

// Pot accumulation using progressive + hero contributions (always £5-rounded)
 applyHeroContribution(decision);
   if (decision === 'fold') return; // endHand() may have been called

// --- NEW: Pre‑flop after‑hero resolver (no cycling; JSON‑driven) ---
if (stageNow === 'preflop' && decision !== 'fold') {
  preflopResolveAfterHero(decision);

  // Keep UX: stay on this stage, show evaluation now and expose "Next Stage"
  submitStageBtn.classList.add("hidden");
  nextStageBtn.classList.remove("hidden");
  if (barSubmit) barSubmit.classList.add("hidden");
  if (barNext) barNext.classList.remove("hidden");

  renderPositionStatusRow();
  updatePotInfo();
  updateHintsImmediate();
  // DO NOT advance stage automatically; wait for user to click "Next Stage"
  return;
}

// === Settle some field callers or allow stabs *based on the pre-action label*
if (stageNow === 'flop' || stageNow === 'turn' || stageNow === 'river') {
  if (actionLabelPre === 'bet' || actionLabelPre === 'raise') {
  
  // Existing behavior: add some callers behind
    settleVillainsAfterHero(stageNow, actionLabelPre);
  } else if (actionLabelPre === 'check') {
    // NEW: let villains stab behind your check
    villainsActAfterHeroCheck(stageNow);

 } else if (actionLabelPre === 'call' && hadLivePricePre) {
// DVE hook: let engine settle on hero CALL vs a live price, then advance
 try { settleVillainsAfterHero(stageNow, 'call'); } catch (_) {}
advanceStage();
return;

  }
}

// --- HERO METRICS (postflop) ---
if (stageNow === 'flop' || stageNow === 'turn' || stageNow === 'river') {
  updateHeroPostflop(stageNow, actionLabelPre);
}

  // ===== Phase 1: Preflop coaching & data
  try{
    if (stage==="preflop"){
      const facingBet = toCall>0;
      if (decision==="raise") preflopAggressor="hero";
      else if (decision==="call" || decision==="fold") preflopAggressor = facingBet ? "villain" : null;
      else preflopAggressor = null;

      heroActions.preflop.action = decision;

      const pos = POSITIONS6[heroPosIdx];
      const rangeClass = classifyHeroHandAtPosition();

// ---- Preflop size evaluation (render exactly one line when relevant) ----
let sizingHtml = ""; // final line to inject (either Opening or 3‑Bet), else empty

const opener      = ENGINE.preflop?.openerSeat ?? null;
const threeBetter = ENGINE.preflop?.threeBetterSeat ?? null;
const heroSeat    = currentPosition();
const heroIsOpener = (opener === heroSeat);
const facingOpen   = !!opener && !heroIsOpener;            // someone else opened
const facing3Bet   = !!opener && !!threeBetter && (threeBetter !== heroSeat); // someone 3-bet before hero

if (decision === "raise") {
  if (!opener || heroIsOpener) {
    // ===== HERO OPENING (×BB) =====
    if (heroActions.preflop.sizeBb != null) {
      const bbSel = heroActions.preflop.sizeBb;
      const [min,max] = recommendedOpenSizeRangeBb(pos);
      let evalStr = "Good";
      if (bbSel < min)            evalStr = (bbSel >= (min - 0.3)) ? "Slightly small" : "Too small";
      else if (bbSel > max)       evalStr = (bbSel <= (max + 0.5)) ? "Slightly large" : "Too large";
      const advice = buildSizeAdvice(pos, bbSel, min, max);
      sizingHtml =
        `<div>Opening size: ${bbSel.toFixed(1)}x BB — <span class="badge ${sizeEvalBadgeColor(evalStr)}">${evalStr}</span></div>` +
        (advice ? `<div style="opacity:.9">${advice}</div>` : "");
    }
  } else if (facingOpen && !facing3Bet) {
    // ===== HERO 3‑BET vs single opener (× of open) =====
    const openToBb = Number(ENGINE.preflop?.openToBb ?? 2.2);
    let chosenMult = null;
    if (heroActions.preflop.sizeMult != null) {
      chosenMult = Number(heroActions.preflop.sizeMult);
    } else if (heroActions.preflop.sizeBb != null && openToBb > 0) {
      chosenMult = Number(heroActions.preflop.sizeBb) / openToBb;
    }
    if (chosenMult != null) {
      const iHero  = ACTION_ORDER.indexOf(heroSeat);
      const iOp    = ACTION_ORDER.indexOf(opener);
      const heroIP = (iHero > iOp) && heroSeat !== 'SB' && heroSeat !== 'BB';
      const rec = heroIP ? 3.0 : 4.0;
      const diff = chosenMult - rec;

      let evalStr = "Good";
      if (Math.abs(diff) > 0.30)  evalStr = (Math.abs(diff) <= 0.60) ? (diff < 0 ? "Slightly small" : "Slightly large") : (diff < 0 ? "Too small" : "Too large");
      const tip = heroIP ? "IP guideline ≈ ×3." : "OOP guideline ≈ ×4.";
      const advice = heroIP
        ? "In position, ~×3 keeps pressure without bloating the pot."
        : "Out of position, ~×4 denies equity and avoids giving a great price.";

      sizingHtml =
        `<div>3‑Bet size: ×${chosenMult.toFixed(2)} of open — <span class="badge ${sizeEvalBadgeColor(evalStr)}">${evalStr}</span></div>` +
        `<div style="opacity:.9">${tip} ${advice}</div>`;
    }
  }
}

// ---- Insert the preflop coaching block (no n/a lines, print only what applied) ----
feedbackEl.insertAdjacentHTML('beforeend', `
  <div style="margin-top:8px">
    <strong>Preflop (6‑max ${pos}):</strong>
    <div>Range check: <span class="badge ${rangeClass==='Open'?'green':(rangeClass==='Mix'?'amber':'red')}">${rangeClass}</span></div>
    <div>PFR: ${preflopAggressor ?? 'n/a'}</div>
    ${sizingHtml}
    <div class="muted" style="opacity:.85;margin-top:4px">Opening size rule: ${openSizeRuleFor(pos)}</div>
  </div>
`);
      const last = handHistory[handHistory.length-1];
      if (last){
        last.heroPosition = pos;
        last.dealtHand = dealtHandStr;
        last.preflopRangeClass = rangeClass;
        last.preflopInRange = (rangeClass!=='Fold');
        last.preflopAggressor = preflopAggressor ?? '';
        last.preflopAction = decision;
        last.preflopSizeBb = heroActions.preflop.sizeBb ?? '';
        last.preflopSizeEval = sizeEval ?? '';
      }
    }
  } catch(e){ console.warn("Phase 1 preflop extras failed:", e); }

  // ===== Phase 3 + 4: Postflop coaching
  try{
    const pos = POSITIONS6[heroPosIdx];
    const stageIsPost = (stage==='flop'||stage==='turn'||stage==='river');

    if (stageIsPost){
     const actionLabel = actionLabelPre;               // reuse the pre-action label
     const betRaiseLabel = betOrRaiseLabelForStage();
     heroActions[stage].action = actionLabel;

      const catKey = mapBoardToCategory(boardCards, holeCards);
      let evalBlockHtml = '';

      if (stage==='flop'){
        const isHeroPFR = (preflopAggressor==='hero');
        const sizePct = heroActions.flop.sizePct ?? null;
        const flopRes = evaluateFlopCbet(catKey, isHeroPFR, pos, actionLabel, sizePct);

        evalBlockHtml += `
          <div style="margin-top:8px">
            <strong>Flop Strategy:</strong>
            <div>C‑bet: <span class="badge ${flopRes.cbetEval.includes('Correct')?'green':(flopRes.cbetEval.includes('Low‑freq')?'amber':'amber')}">${flopRes.cbetEval}</span></div>
            <div>Size: <span class="badge ${sizeEvalBadgeColor(flopRes.sizeEval)}">${flopRes.sizeEval}</span> (Rec: ${flopRes.recFreq} · ${flopRes.recSizes})</div>
            <div style="opacity:.9">${flopRes.note}</div>
          </div>
        `;

        const last = handHistory[handHistory.length-1];
        if (last){
          last.boardCards = boardToString(boardCards);
          last.boardCategory = catKey;
          last.betOrRaiseLabel = betRaiseLabel;
          last.sizePct = heroActions.flop.sizePct ?? '';
          last.cbetRecommendedFreq = flopRes.recFreq ?? '';
          last.sizingRecommendedRange = flopRes.recSizes ?? '';
          last.cbetEval = flopRes.cbetEval ?? '';
          last.sizingEval = flopRes.sizeEval ?? '';
        }
        heroActions.flop.cbet = (isHeroPFR && actionLabel==='bet');

        // Non-PFR probe on flop
        if (!isHeroPFR && isProbeSpot(actionLabel)){
          const probeRes = evaluateProbe('flop', catKey, pos, actionLabel, heroActions.flop.sizePct ?? null);
          evalBlockHtml += `
            <div style="margin-top:8px">
              <strong>Flop Probe (Non‑PFR):</strong>
              <div>Probe: <span class="badge ${probeRes.probeEval.includes('Good')?'green':(probeRes.probeEval.includes('Risky')?'red':'amber')}">${probeRes.probeEval}</span></div>
              <div>Size: <span class="badge ${sizeEvalBadgeColor(probeRes.sizeEval)}">${probeRes.sizeEval}</span> (Guide: ${probeRes.recSizes})</div>
              <div style="opacity:.9">${probeRes.note}</div>
            </div>
          `;
          if (last){ last.postflopRole='Non-PFR'; last.probeEval = probeRes.probeEval ?? ''; }
        } else {
          const last = handHistory[handHistory.length-1];
          if (last && !last.postflopRole) last.postflopRole = (preflopAggressor==='hero') ? 'PFR' : 'Caller';
        }
      }
      else if (stage==='turn'){
        const prevBoard = boardCards.slice(0,3);
        const isHeroPFR = (preflopAggressor==='hero');
        const sizePct = heroActions.turn.sizePct ?? null;
        const prevAggressive = !!heroActions.flop.cbet;
        const turnRes = evaluateBarrel('turn', prevBoard, boardCards, isHeroPFR, pos, prevAggressive, actionLabel, sizePct);

        evalBlockHtml += `
          <div style="margin-top:8px">
            <strong>Turn Strategy:</strong>
            <div>Barrel: <span class="badge ${turnRes.barrelEval.includes('Good')?'green':(turnRes.barrelEval.includes('Risky')?'amber':'amber')}">${turnRes.barrelEval}</span></div>
            <div>Size: <span class="badge ${sizeEvalBadgeColor(turnRes.sizeEval)}">${turnRes.sizeEval}</span> (Rec: ${turnRes.recFreq || '—'} ${turnRes.recSizes ? '· ' + turnRes.recSizes : ''})</div>
            <div style="opacity:.9">${turnRes.note}</div>
          </div>
        `;

        const last = handHistory[handHistory.length-1];
        if (last){
          last.boardCards = boardToString(boardCards);
          last.boardCategory = mapBoardToCategory(boardCards, holeCards);
          last.betOrRaiseLabel = betRaiseLabel;
          last.sizePct = heroActions.turn.sizePct ?? '';
          last.cbetRecommendedFreq = turnRes.recFreq ?? '';
          last.sizingRecommendedRange = turnRes.recSizes ?? '';
          last.barrelEval = turnRes.barrelEval ?? '';
          last.sizingEval = turnRes.sizeEval ?? '';
        }

        heroActions.turn.barrel = (actionLabel==='bet' || actionLabel==='raise');

        // Non-PFR probe on turn
        if (!isHeroPFR && isProbeSpot(actionLabel)){
          const probeRes = evaluateProbe('turn', mapBoardToCategory(boardCards, holeCards), pos, actionLabel, heroActions.turn.sizePct ?? null);
          evalBlockHtml += `
            <div style="margin-top:8px">
              <strong>Turn Probe (Non‑PFR):</strong>
              <div>Probe: <span class="badge ${probeRes.probeEval.includes('Good')?'green':(probeRes.probeEval.includes('Risky')?'red':'amber')}">${probeRes.probeEval}</span></div>
              <div>Size: <span class="badge ${sizeEvalBadgeColor(probeRes.sizeEval)}">${probeRes.sizeEval}</span> (Guide: ${probeRes.recSizes})</div>
              <div style="opacity:.9">${probeRes.note}</div>
            </div>
          `;
          const last = handHistory[handHistory.length-1];
          if (last){ last.postflopRole='Non-PFR'; last.probeEval = probeRes.probeEval ?? ''; }
        } else {
          const last = handHistory[handHistory.length-1];
          if (last && !last.postflopRole) last.postflopRole = (preflopAggressor==='hero') ? 'PFR' : 'Caller';
        }
      }
      else if (stage==='river'){
        const prevBoard = boardCards.slice(0,4);
        const isHeroPFR = (preflopAggressor==='hero');
        const sizePct = heroActions.river.sizePct ?? null;
        const prevAggressive = !!(heroActions.turn && heroActions.turn.barrel);
        const riverRes = evaluateBarrel('river', prevBoard, boardCards, isHeroPFR, pos, prevAggressive, actionLabel, sizePct);

        evalBlockHtml += `
          <div style="margin-top:8px">
            <strong>River Strategy:</strong>
            <div>Barrel: <span class="badge ${riverRes.barrelEval.includes('Good')?'green':(riverRes.barrelEval.includes('Risky')?'amber':'amber')}">${riverRes.barrelEval}</span></div>
            <div>Size: <span class="badge ${sizeEvalBadgeColor(riverRes.sizeEval)}">${riverRes.sizeEval}</span> (Rec: ${riverRes.recFreq || '—'} ${riverRes.recSizes ? '· ' + riverRes.recSizes : ''})</div>
            <div style="opacity:.9">${riverRes.note}</div>
          </div>
        `;

        const last = handHistory[handHistory.length-1];
        if (last){
          last.boardCards = boardToString(boardCards);
          last.boardCategory = mapBoardToCategory(boardCards, holeCards);
          last.betOrRaiseLabel = betRaiseLabel;
          last.sizePct = heroActions.river.sizePct ?? '';
          last.cbetRecommendedFreq = riverRes.recFreq ?? '';
          last.sizingRecommendedRange = riverRes.recSizes ?? '';
          last.barrelEval = riverRes.barrelEval ?? '';
          last.sizingEval = riverRes.sizeEval ?? '';
        }

        // River line classification
        const rc = classifyRiverLine(actionLabel, heroActions.river.sizePct ?? null, holeCards, boardCards);
        evalBlockHtml += `
          <div style="margin-top:8px">
            <strong>River Line:</strong>
            <span class="badge ${rc.badge}">${rc.riverLine}</span>
            <div style="opacity:.9">${rc.riverExplain}</div>
          </div>
        `;
        if (last){ last.riverLineType = rc.riverLine; last.riverMadeHand = rc.madeLabel; }
      }

      if (evalBlockHtml) feedbackEl.insertAdjacentHTML('beforeend', evalBlockHtml);

      // Store sim context
      const last = handHistory[handHistory.length-1];
      if (last){ last.numOpp = equityStats.numOpp; last.trials = equityStats.trials; }
    }
  } catch(e){ console.warn("Phase 3/4 coaching failed:", e); }

// If villains bet behind our check, there is now a live price -> keep Submit visible for our response
const lettingHeroRespondThisStreet =
  (stageNow === 'flop' || stageNow === 'turn' || stageNow === 'river') &&
  actionLabelPre === 'check' &&
  toCall > 0;

if (lettingHeroRespondThisStreet) {
  submitStageBtn.classList.remove("hidden");
  nextStageBtn.classList.add("hidden");
  if (barSubmit) barSubmit.classList.remove("hidden");
  if (barNext)   barNext.classList.add("hidden");
} else {
  submitStageBtn.classList.add("hidden");
  nextStageBtn.classList.remove("hidden");
  if (barSubmit) barSubmit.classList.add("hidden");
  if (barNext)   barNext.classList.remove("hidden");
}
});
nextStageBtn.addEventListener("click", ()=> advanceStage());

// Bottom bar mirroring
if (barSubmit) barSubmit.addEventListener("click", ()=> { inputForm.requestSubmit(); });
if (barNext)   barNext.addEventListener("click", ()=> { advanceStage(); });

// Number steppers
document.querySelectorAll(".step-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const targetId = btn.getAttribute("data-target");
    const step = parseFloat(btn.getAttribute("data-step") || "1");
    const input = document.getElementById(targetId);
    if (!input) return;
    const curr = parseFloat(input.value || "0");
    const next = Math.min(100, Math.max(0, (curr + step)));
    input.value = next.toFixed(1);
  });
});

// ==================== Summary & session ====================
function categoryLabel(key){ return (CBET_GUIDE[key]?.label) || key || '—'; }
function showSummary() {
  let html = "";
  let totalEquityErr = 0;
  let totalPotErr = 0;
  let decisionGreen = 0;

  handHistory.forEach((h) => {
    const eqErr = Math.abs(h.equityInput - h.equityActual);
    const potErr = Math.abs(h.potOddsInput - h.potOddsActual);
    totalEquityErr += eqErr;
    totalPotErr += potErr;
    if (h.decisionBand === "green") decisionGreen++;

    let block = `
      <div class="summary-row">
        <strong>${h.stage.toUpperCase()}</strong><br/>
        Equity: you ${h.equityInput.toFixed(1)}%, actual ${h.equityActual.toFixed(1)}% (err ${eqErr.toFixed(1)}%)<br/>
        Pot odds: you ${h.potOddsInput.toFixed(1)}%, actual ${h.potOddsActual.toFixed(1)}% (err ${potErr.toFixed(1)}%)<br/>
        Decision: ${h.decision.toUpperCase()} <span class="badge ${h.decisionBand}">${h.decisionBand}</span><br/>
    `;

    if (h.stage === "preflop") {
      if (h.heroPosition || h.preflopSizeEval || h.preflopRangeClass) {
        block += `
          <div style="margin-top:4px;opacity:.9">
            ${h.heroPosition ? `Pos: ${h.heroPosition} · ` : ""}Range: ${h.preflopRangeClass ?? "—"}
            ${h.preflopSizeBb ? ` · Open size: ${Number(h.preflopSizeBb).toFixed(1)}x` : ""}
            ${h.preflopSizeEval ? ` · Size eval: ${h.preflopSizeEval}` : ""}
          </div>
        `;
      }
    } else if (h.stage === "flop") {
      if (h.boardCards || h.boardCategory || h.cbetEval || h.sizingEval) {
        block += `
          <div style="margin-top:4px;opacity:.9">
            Board: ${h.boardCards ?? "—"} (${categoryLabel(h.boardCategory)})
          </div>
          <div style="opacity:.9">
            C‑bet: ${h.cbetEval ?? "—"} · Size: ${h.sizingEval ?? "—"}
            ${h.cbetRecommendedFreq || h.sizingRecommendedRange ? ` (Rec: ${h.cbetRecommendedFreq ?? "—"} · ${h.sizingRecommendedRange ?? "—"})` : ""}
          </div>
        `;
      }
    } else if (h.stage === "turn") {
      if (h.barrelEval || h.sizingEval) {
        block += `
          <div style="margin-top:4px;opacity:.9">
            Barrel: ${h.barrelEval ?? "—"} · Size: ${h.sizingEval ?? "—"}
            ${h.cbetRecommendedFreq || h.sizingRecommendedRange ? ` (Rec: ${h.cbetRecommendedFreq ?? "—"} · ${h.sizingRecommendedRange ?? "—"})` : ""}
          </div>
        `;
      }
    } else if (h.stage === "river") {
      if (h.riverLineType || h.sizingEval) {
        block += `
          <div style="margin-top:4px;opacity:.9">
            River: ${h.riverLineType ?? "—"} ${h.sizingEval ? `· Size: ${h.sizingEval}` : ""}
            ${h.cbetRecommendedFreq || h.sizingRecommendedRange ? ` (Rec: ${h.cbetRecommendedFreq ?? "—"} · ${h.sizingRecommendedRange ?? "—"})` : ""}
          </div>
        `;
      }
    }

    if (h.handTypes && h.handTypes.length) {
      block += `<div style="opacity:.8"><em>Common finishing hands:</em> ${h.handTypes.map(x=>`${x.name} ${x.pct.toFixed(1)}%`).join(' · ')}</div>`;
    }

    block += `</div><hr/>`;
    html += block;
  });

  const n = handHistory.length || 1;
  const avgEqErr = totalEquityErr / n;
  const avgPotErr = totalPotErr / n;
  const decisionAcc = (decisionGreen / n) * 100;

  html = `
    <p><strong>Average equity error:</strong> ${avgEqErr.toFixed(1)}%</p>
    <p><strong>Average pot odds error:</strong> ${avgPotErr.toFixed(1)}%</p>
    <p><strong>Decision accuracy (green only):</strong> ${decisionAcc.toFixed(1)}%</p>
    <p style="color:#95a5a6">Method: Monte‑Carlo simulation with baseline population (default 5 opponents) and street‑by‑street continuation; full 7‑card evaluation; ties share the pot.</p>
    <hr/>
  ` + html;

  summaryContent.innerHTML = html;
  summaryPanel.style.display = "block";
}

function updateSessionStats(){
  if (sessionHistory.length===0){ sessionStatsEl.textContent="No hands played yet."; return; }
  let totalEqErr=0, totalPotErr=0, greens=0;
  sessionHistory.forEach(h=>{
    totalEqErr += Math.abs(h.equityInput - h.equityActual);
    totalPotErr += Math.abs(h.potOddsInput - h.potOddsActual);
    if (h.decisionBand==='green') greens++;
  });
  const n=sessionHistory.length;
  const avgEq = totalEqErr/n, avgPot = totalPotErr/n, acc=(greens/n)*100;
  sessionStatsEl.textContent = `Session – stages: ${n}, avg equity err: ${avgEq.toFixed(1)}%, avg pot err: ${avgPot.toFixed(1)}%, decision green: ${acc.toFixed(1)}%`;
}

// ==================== LocalStorage & CSV ====================
const STORAGE_KEY = "poker_equity_trainer_history";
function saveSessionHistory(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionHistory)); } catch(e){ console.warn("Could not save history", e);} }
function loadSessionHistory(){ try{ const raw=localStorage.getItem(STORAGE_KEY); if (!raw) return; sessionHistory = JSON.parse(raw); } catch(e){ console.warn("Could not load history", e);} }
function clearSessionHistory(){
  if (!confirm("Reset all saved statistics for this device/session?")) return;
  try{ localStorage.removeItem(STORAGE_KEY); } catch(e){ console.warn("Could not clear history", e); }
  sessionHistory=[]; updateSessionStats(); summaryPanel.style.display="none"; feedbackEl.innerHTML=""; hintsEl.textContent="";
}
function downloadCsv(){
  if (sessionHistory.length===0) return;
  const headers = [
    // Core
    "stage","heroPosition","dealtHand","boardCards","boardCategory",
    "equityInput","equityActual","potOddsInput","potOddsActual",
    "decision","betOrRaiseLabel","sizePct",
    "equityBand","potOddsBand","decisionBand","timeUsed",

    // Equity swing (new)
    "equitySwing","equitySwingBand","equitySwingNote",

    // Phase 1
    "preflopRangeClass","preflopInRange","preflopAggressor","preflopAction","preflopSizeBb","preflopSizeEval",

    // Phase 3
    "cbetRecommendedFreq","sizingRecommendedRange","cbetEval","barrelEval","sizingEval",

    // Phase 4
    "postflopRole","probeEval","riverLineType","riverMadeHand",

    // Sim context
    "numOpp","trials"
  ];
  const rows=[headers.join(",")];
  sessionHistory.forEach(h=>{
    rows.push([
      h.stage ?? "", h.heroPosition ?? "", h.dealtHand ?? "", h.boardCards ?? "", h.boardCategory ?? "",
      (h.equityInput ?? "").toString(), (h.equityActual ?? "").toString(), (h.potOddsInput ?? "").toString(), (h.potOddsActual ?? "").toString(),
      h.decision ?? "", h.betOrRaiseLabel ?? "", h.sizePct ?? "",
      h.equityBand ?? "", h.potOddsBand ?? "", h.decisionBand ?? "", (h.timeUsed==null ? "" : h.timeUsed.toFixed ? h.timeUsed.toFixed(2) : h.timeUsed),

      // new swing fields
      h.equitySwing ?? "", h.equitySwingBand ?? "", (h.equitySwingNote ? `"${h.equitySwingNote.replace(/"/g,'""')}"` : ""),

      h.preflopRangeClass ?? "", (h.preflopInRange==null ? "" : (h.preflopInRange ? "true":"false")), h.preflopAggressor ?? "", h.preflopAction ?? "",
      (h.preflopSizeBb==null ? "" : (h.preflopSizeBb.toFixed ? h.preflopSizeBb.toFixed(1) : h.preflopSizeBb)), h.preflopSizeEval ?? "",

      h.cbetRecommendedFreq ?? "", h.sizingRecommendedRange ?? "", h.cbetEval ?? "", h.barrelEval ?? "", h.sizingEval ?? "",

      h.postflopRole ?? "", h.probeEval ?? "", h.riverLineType ?? "", h.riverMadeHand ?? "",

      h.numOpp ?? "", h.trials ?? ""
    ].join(","));
  });
  const blob = new Blob([rows.join("\n")], { type:"text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "poker_equity_trainer_history.csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// Villain reveal policy state
const REVEAL = {
  policy: 'always_all' // 'always_all' | 'showdown_only' | 'on_hero_fold' | 'always_remaining'
};

function createSettingsPanel(){
  const btn = document.createElement("button");
  btn.id="settingsBtn"; btn.textContent="⚙️ Settings"; btn.className="btn";
  newHandBtn.parentNode.insertBefore(btn, newHandBtn.nextSibling);

  const panel = document.createElement("div");
  panel.id = "settingsPanel";
  panel.style.cssText = "position:fixed;right:20px;top:80px;z-index:9999;background:#1f2937;color:#ecf0f1;border:1px solid #374151;border-radius:8px;padding:12px;min-width:340px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.35)";
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:600">Trainer Settings</div>
      <button id="closeSettings" class="btn">✕</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label>Baseline Opponents (6‑max: use 5)</label>
      <input type="number" id="set_playersBaseline" min="1" max="5" value="${Math.min(5, SETTINGS.sim.playersBaseline)}"/>

      <div style="grid-column:1/3;border-top:1px solid #374151;margin:8px 0"></div>

      <label>Sim Quality</label>
      <select id="set_quality">
        <option ${SETTINGS.simQualityPreset==='Mobile'?'selected':''}>Mobile</option>
        <option ${SETTINGS.simQualityPreset==='Balanced'?'selected':''}>Balanced</option>
        <option ${SETTINGS.simQualityPreset==='Accurate'?'selected':''}>Accurate</option>
        <option ${SETTINGS.simQualityPreset==='Custom'?'selected':''}>Custom</option>
      </select>

      <label>Trials – Preflop</label>
      <input type="number" id="set_trials_pre" min="500" step="500" value="${SETTINGS.trialsByStage.preflop}"/>

      <label>Trials – Flop</label>
      <input type="number" id="set_trials_flop" min="500" step="500" value="${SETTINGS.trialsByStage.flop}"/>

      <label>Trials – Turn</label>
      <input type="number" id="set_trials_turn" min="500" step="500" value="${SETTINGS.trialsByStage.turn}"/>

      <label>Trials – River</label>
      <input type="number" id="set_trials_riv" min="500" step="500" value="${SETTINGS.trialsByStage.river}"/>

      <div style="grid-column:1/3;border-top:1px solid #374151;margin:8px 0"></div>

<!-- Advanced panel toggle -->
<div style="margin-top:12px;">
  <label>
    <input type="checkbox" id="advToggleSampler" />
    Show advanced sampler diagnostics
  </label>
</div>


<div style="grid-column:1/3;border-top:1px solid #374151;margin:8px 0"></div>
<label>Villain reveal</label>
<select id="set_reveal_policy">
  <option value="always_remaining" selected>Always show remaining villains</option>
  <option value="always_all">Always show all</option>
  <option value="showdown_only">Show only at showdown</option>
  <option value="on_hero_fold">Show when hero folds</option>
</select>


      <!-- NEW: Blind editor -->
      <label>Small Blind (£)</label>
      <input type="number" id="set_sb" min="0" step="5" value="${toStep5(BLINDS.sb)}"/>

      <label>Big Blind (£)</label>
      <input type="number" id="set_bb" min="5" step="5" value="${toStep5(BLINDS.bb)}"/>

      <button id="btn_next_level" class="btn" style="grid-column:1/3">Next Blinds Level</button>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
      <button id="applySettings" class="btn">Apply</button>
    </div>
  `;
  document.body.appendChild(panel);

// --- After: panel.innerHTML = ` ... `; (keep your existing code above this line)

// A small separator
const sep = document.createElement('div');
sep.style.cssText = "grid-column:1/3;border-top:1px solid #374151;margin:8px 0";

// Container row to align with the grid
const row = document.createElement('div');
row.style.cssText = "grid-column:1/3; display:flex; gap:8px; justify-content:flex-start; align-items:center";

// The actual button
const resetBtn = document.createElement('button');
resetBtn.className = 'btn';
resetBtn.textContent = 'Reset personalities';

// Optional helper text
const hint = document.createElement('span');
hint.className = 'muted';
hint.style.opacity = '.85';
hint.textContent = '  (Re‑rolls player letters’ styles for this browser session)';

// Click handler
resetBtn.addEventListener('click', () => {
  try {
    sessionStorage.removeItem('trainer_personas_v1'); // remove current session assignment
    initSessionPersonalities();                       // re-sample personalities for this session
    recomputeProfilesFromLetters();                   // rebuild VILLAIN_PROFILE_BY_SEAT from letters
    renderPositionStatusRow();                        // redraw row so letter chips persist
    alert('Personality assignments reset for this session.');
  } catch (e) {
    console.warn('Reset personalities failed', e);
    alert('Could not reset personalities. Check console for details.');
  }
});

row.appendChild(resetBtn);
row.appendChild(hint);

// ---- Attach sampler debug listener NOW that the element exists ----
const adv = panel.querySelector('#advToggleSampler');
if (adv) {
    adv.addEventListener('change', e => {
        SHOW_SAMPLER_DEBUG = e.target.checked;
        console.log("Sampler debug =", SHOW_SAMPLER_DEBUG);
    });
}

// --- Insert Reset Personalities BEFORE the Apply button row ---
const applyRow = panel.querySelector('div[style*="justify-content:flex-end"]');
panel.insertBefore(sep, applyRow);
panel.insertBefore(row, applyRow);



  function applyQualityPreset(presetName){
    const preset = TRIALS_PRESETS[presetName]; if (!preset) return;
    SETTINGS.trialsByStage = { ...preset };
    panel.querySelector("#set_trials_pre").value = SETTINGS.trialsByStage.preflop;
    panel.querySelector("#set_trials_flop").value = SETTINGS.trialsByStage.flop;
    panel.querySelector("#set_trials_turn").value = SETTINGS.trialsByStage.turn;
    panel.querySelector("#set_trials_riv").value = SETTINGS.trialsByStage.river;
  }

  btn.addEventListener("click", () => { panel.style.display = panel.style.display==="none" ? "block" : "none"; });
  panel.querySelector("#closeSettings").addEventListener("click", () => { panel.style.display = "none"; });

  // NEW: Next blinds level (walk schedule & update fields/UI)
  panel.querySelector("#btn_next_level").addEventListener("click", () => {
    blindScheduleIdx = Math.min(BLIND_SCHEDULE.length-1, blindScheduleIdx + 1);
    const [sb, bb] = BLIND_SCHEDULE[blindScheduleIdx];
    BLINDS.sb = toStep5(sb); BLINDS.bb = toStep5(bb);
    panel.querySelector("#set_sb").value = BLINDS.sb;
    panel.querySelector("#set_bb").value = BLINDS.bb;
    updatePotInfo();
    btn.textContent = "⚙️ Settings ✓";
    setTimeout(()=>btn.textContent="⚙️ Settings", 1200);
  });

  panel.querySelector("#applySettings").addEventListener("click", () => {
    SETTINGS.sim.playersBaseline = Math.max(1, Math.min(5, parseInt(panel.querySelector("#set_playersBaseline").value,10) || 4));
   
    const chosen = panel.querySelector("#set_quality").value;
    SETTINGS.simQualityPreset = chosen;
    if (chosen!=='Custom') applyQualityPreset(chosen);
    else {
      SETTINGS.trialsByStage.preflop = Math.max(500, parseInt(panel.querySelector("#set_trials_pre").value,10)  || 4000);
      SETTINGS.trialsByStage.flop    = Math.max(500, parseInt(panel.querySelector("#set_trials_flop").value,10) || 6000);
      SETTINGS.trialsByStage.turn    = Math.max(500, parseInt(panel.querySelector("#set_trials_turn").value,10) || 8000);
      SETTINGS.trialsByStage.river   = Math.max(500, parseInt(panel.querySelector("#set_trials_riv").value,10)  || 12000);
    }


// Save villain reveal policy
const rp = panel.querySelector('#set_reveal_policy');
if (rp) REVEAL.policy = rp.value || 'always_all';

    // NEW: apply blinds (always £5-rounded)
    const newSB = toStep5(parseFloat(panel.querySelector("#set_sb").value) || BLINDS.sb);
    const newBB = toStep5(parseFloat(panel.querySelector("#set_bb").value) || BLINDS.bb);
    BLINDS = { sb: newSB, bb: newBB };

    // Try to align schedule index to the chosen blinds if they match a schedule step
    const idx = BLIND_SCHEDULE.findIndex(([sb,bb]) => sb===newSB && bb===newBB);
    blindScheduleIdx = (idx >= 0) ? idx : blindScheduleIdx;

    // Keep old toggles working
    SETTINGS.pot.addHeroCallBetweenStreets = true;  // ignored by applyHeroContribution
    SETTINGS.pot.endHandOnFold = SETTINGS.pot.endHandOnFold ?? true;

    updatePotInfo();
    btn.textContent = "⚙️ Settings ✓";
    setTimeout(()=>btn.textContent="⚙️ Settings", 1200);
  });
}

// ==================== Custom Ranges Loader & Adapter ====================
// Store & access user-imported 3-decimal frequencies; prefer these when present.
const RANGES_STORAGE_KEY = "trainer_ranges_json_v1";
let RANGES_JSON = null;

function loadRangesFromStorage(){
  try{
    const raw = localStorage.getItem(RANGES_STORAGE_KEY);
    if (!raw) return null;
    RANGES_JSON = JSON.parse(raw);
    return RANGES_JSON;
  }catch(e){ console.warn("Could not parse stored ranges JSON", e); return null; }
}
function saveRangesToStorage(obj){
  try{ localStorage.setItem(RANGES_STORAGE_KEY, JSON.stringify(obj)); }
  catch(e){ console.warn("Could not save ranges JSON", e); }
}
window.loadRangesFromFile = async function(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async (e)=>{
    const file = e.target.files?.[0]; if (!file) return;
    try{
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!obj.open || !obj.three_bet){ alert("JSON missing 'open' or 'three_bet' blocks."); return; }
      RANGES_JSON = obj; saveRangesToStorage(obj);
      alert("Ranges imported. Heatmaps will use your JSON.");
    }catch(err){ console.error("Import failed", err); alert("Import failed: invalid JSON"); }
  };
  input.click();
};

// Frequency → class thresholds (green/amber/red for the grid)
function freqToClass(f){
  const v = (typeof f === 'string') ? parseFloat(f) : (f ?? 0);
  if (v >= 0.670) return 'open';
  if (v >= 0.150) return 'mix';
  return 'fold';
}
function mapFromFreqBucket(bucketObj){
  const m = new Map();
  if (bucketObj){
    for (const [code, freq] of Object.entries(bucketObj)) m.set(code, freqToClass(freq));
  }
  return m;
}

// ===== Hosted Ranges Autoload =====
// Put your hosted JSON here (same-origin path or full URL)
const RANGES_URL = 'assets/ranges_6max.json';

// Fetch with cache & graceful fallback to localStorage and built-ins
async function fetchRangesFromUrlOnce(){
  try{
    const res = await fetch(RANGES_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const obj = await res.json();
    if (!obj.open || !obj.three_bet) throw new Error('Invalid schema: missing open/three_bet');
    RANGES_JSON = obj;                  // in-memory
    saveRangesToStorage(RANGES_JSON);   // persist for next loads
    console.log('[ranges] Loaded from URL, cached to localStorage');
    return true;
  }catch(err){
    console.warn('[ranges] URL fetch failed, will use localStorage or built-ins', err);
    return false;
  }
}

// Try URL → then localStorage (already loaded in init) → built-ins
async function ensureRangesLoaded(){
  // If already loaded (from localStorage in init), do nothing
  if (RANGES_JSON && RANGES_JSON.open && RANGES_JSON.three_bet) return;

  // Try URL autoload
  const ok = await fetchRangesFromUrlOnce();
  if (ok) return;

  // If URL failed but storage had something, keep it; else remain on built-ins
  if (!RANGES_JSON){
    const fromStore = loadRangesFromStorage();
    if (fromStore && fromStore.open && fromStore.three_bet){
      console.log('[ranges] Using previously stored ranges');
      return;
    }
    console.log('[ranges] No hosted ranges and no stored ranges; using built-ins');
  }
}



// ==================== UI wiring (Phase 1 & 2) ====================
function setupPhase1UI(){
  if (positionDisc){
    positionDisc.addEventListener('click', (e)=>{ e.stopPropagation(); if (posPopover && !posPopover.classList.contains('hidden')) { hidePosPopover(); return; } showPosPopover(); });
    document.addEventListener('click', ()=> hidePosPopover());
    window.addEventListener('scroll', ()=> hidePosPopover(), { passive:true });
  }
  if (holeCardsEl){
    holeCardsEl.style.cursor="pointer";
    holeCardsEl.title = "Tap to view preflop range heatmap";
    holeCardsEl.addEventListener('click', ()=> openRangeModal());
  }
  if (rangeModalClose) rangeModalClose.addEventListener('click', ()=> closeRangeModal());
  if (rangeModalOverlay) rangeModalOverlay.addEventListener('click', (e)=>{ if (e.target===rangeModalOverlay) closeRangeModal(); });

if (sizePresetRow){
  sizePresetRow.addEventListener('click', (e)=>{
    const btn = e.target.closest('.size-bb'); if (!btn) return;
    sizePresetRow.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const mult = parseFloat(btn.getAttribute('data-mult'));
    const bb   = parseFloat(btn.getAttribute('data-bb'));
    if (isFinite(mult)) {
      heroActions.preflop.sizeMult = mult; // 3-bet basis (× of open)
      heroActions.preflop.sizeBb   = null;
    } else {
      heroActions.preflop.sizeBb   = isFinite(bb) ? bb : null; // open basis (× BB)
      heroActions.preflop.sizeMult = null;
    }
  });
}

 ["decFold","decCall","decRaise"].forEach(id=>{
  const el=document.getElementById(id); if (!el) return;
  el.addEventListener('change', ()=>{
    const stage=STAGES[currentStageIndex];
    const isPre=(stage==='preflop'); const isRaise=document.getElementById('decRaise')?.checked;
    if (sizePresetRow) sizePresetRow.classList.toggle('hidden', !(isPre && isRaise));
    if (sizePresetRowPost) sizePresetRowPost.classList.toggle('hidden', !(!isPre && isRaise));
    if (isPre && isRaise) updatePreflopSizePresets(); // NEW
  });
});
}

function setupPhase2UI(){
  // --- Open Equity Cheatsheet by clicking on the board cards (always on)
  if (boardCardsEl){
    boardCardsEl.style.cursor = "pointer";
    boardCardsEl.title = "Tap to view equity estimate cheatsheet";
    boardCardsEl.addEventListener('click', () => openEquityEstimatesModal());
  }
  // Equity modal close handlers
  if (equityModalClose) equityModalClose.addEventListener('click', () => closeEquityEstimatesModal());
  if (equityModalOverlay) equityModalOverlay.addEventListener('click', (e) => {
    if (e.target === equityModalOverlay) closeEquityEstimatesModal();
  });

  if (sizePresetRowPost){
    sizePresetRowPost.addEventListener('click', (e)=>{
      const btn=e.target.closest('.size-pct'); if (!btn) return;
      sizePresetRowPost.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const pct=parseFloat(btn.getAttribute('data-pct'));
      const stage=STAGES[currentStageIndex];
      if (['flop','turn','river'].includes(stage)){
        heroActions[stage].sizePct = isFinite(pct) ? pct : null;
      }
    });
  }

  ["decFold","decCall","decRaise"].forEach(id=>{
    const el=document.getElementById(id); if (!el) return;
    el.addEventListener('change', updateDecisionLabels);
  });
  if (guideModalClose) guideModalClose.addEventListener('click', ()=> closeGuideModal());
  if (guideModalOverlay) guideModalOverlay.addEventListener('click', (e)=>{ if (e.target===guideModalOverlay) closeGuideModal(); });
  document.addEventListener('click', (e)=>{
    const el = e.target.closest('#boardBadgeBar'); if (!el) return;
    const catKey = mapBoardToCategory(boardCards, holeCards);
    openGuideModalFor(catKey);
  });

  // Make KPI swing chip open the cheatsheet if present
  if (kpiEquitySwingEl){
    kpiEquitySwingEl.addEventListener('click', ()=> openEquityEstimatesModal());
  }
}

// ==================== Event wiring ====================
difficultySelect.addEventListener("change", ()=>{
  difficulty = difficultySelect.value;
  clearTimer();
  if (difficulty==="beginner"){
    timerRange.disabled = true;
    if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
    if (kpiTimerEl) kpiTimerEl.textContent = "Time: —";
   } else {
           timerRange.disabled = false;

       // Default Intermediate & Expert to 59 seconds
         timerSeconds = 59;
         timerRange.value = 59;
         timerValueEl.textContent = "59";

    startTimer();
}
  updatePotInfo();
  updateHintsImmediate();
  setPreflopBadge();
});
timerRange.addEventListener("input", () => { timerSeconds = parseInt(timerRange.value, 10) || 10; timerValueEl.textContent = timerSeconds; });
newHandBtn.addEventListener("click", async () => { await startNewHand(); });
downloadCsvBtn.addEventListener("click", () => { downloadCsv(); });
closeSummaryBtn.addEventListener("click", () => { summaryPanel.style.display = "none"; });
resetStatsBtn.addEventListener("click", () => { clearSessionHistory(); });

// ==================== Init ====================
(function init(){
  loadSessionHistory();
  updateSessionStats();
 
difficulty = difficultySelect.value;

if (difficulty === "beginner") {
    timerRange.disabled = true;
    timerSeconds = 0;
    if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
} else {
    timerRange.disabled = false;
    timerSeconds = 59;
    timerRange.value = 59;
    timerValueEl.textContent = "59";
}
  // Settings, UI wiring
  createSettingsPanel();
  setupPhase1UI();
  setupPhase2UI();

  // Load any stored JSON ranges (if imported earlier)
  loadRangesFromStorage();


// NEW: Try to load hosted ranges for all users (falls back to storage/built-ins)
  ensureRangesLoaded();

initSessionPersonalities(); // <-- new: sample once per session and seat letters


  // Hide swing chip at boot
  updateKpiEquitySwing(0, null);
})();

/***************************************************
 * DETERMINISTIC POST-FLOP ENGINE (INLINE MODULE)
 * ----------------------------------------------
 * This block overrides RNG-based villain behaviour
 * with a deterministic, table-driven engine.
 *
 * It reuses your existing helpers:
 *   - analyzeBoard(board, hole)
 *   - evaluate7(hole, board)
 *   - detectStraightDrawFromAllCards(all)
 ***************************************************/

// ==== Deterministic Villain Engine (prefixed DVE_) ====
let DVE_HOST = { analyzeBoard: null, evaluate7: null, detectStraightDrawFromAllCards: null };
function DVE_bindHostFns({ analyzeBoard, evaluate7, detectStraightDrawFromAllCards }){
  DVE_HOST.analyzeBoard = analyzeBoard;
  DVE_HOST.evaluate7 = evaluate7;
  DVE_HOST.detectStraightDrawFromAllCards = detectStraightDrawFromAllCards;
}

const DVE_VILLAIN_PROFILES = {
  Honest:   { aggro: 0.85, turnAggro: 0.80, riverBluff: 0.10, caller:  1.10 },
  Standard: { aggro: 1.00, turnAggro: 1.00, riverBluff: 0.20, caller:  1.00 },
  Aggro:    { aggro: 1.20, turnAggro: 1.10, riverBluff: 0.30, caller:  0.90 },
  Nit:      { aggro: 0.70, turnAggro: 0.70, riverBluff: 0.05, caller:  0.80 },
     Station:  { aggro: 0.70, turnAggro: 0.70, riverBluff: 0.08, caller:  1.30 }, 
  Maniac:   { aggro: 1.40, turnAggro: 1.20, riverBluff: 0.45, caller:  0.80 }
};

function DVE_classifyTexture(board){
  const wetness = DVE_HOST.analyzeBoard(board, []).wetnessScore;
  if (wetness >= 3.5) return 'Wet';
  if (wetness >= 2.0) return 'Semi-Wet';
  if (wetness >= 1.0) return 'Semi-Dry';
  return 'Dry';
}

function DVE_classifyHandBucket(hole, board){
  const score = DVE_HOST.evaluate7(hole, board);
  const all = [...hole, ...board];
  const { openEnder, gutshot } = DVE_HOST.detectStraightDrawFromAllCards(all);
  const suitCount = {};
  all.forEach(c => { suitCount[c.suit] = (suitCount[c.suit]||0)+1; });
  const flushDraw = Object.values(suitCount).some(v => v === 4);

  if (score.cat >= 4) return 'StrongMade';
  if (score.cat === 3 || score.cat === 2) return 'StrongMade';
  if (score.cat === 1) return 'MediumMade';
  if (flushDraw || openEnder) return 'Draw';
  if (gutshot) return 'WeakSD';
  return 'Air';
}

const DVE_CBET_BASE = { 'Dry':0.80, 'Semi-Dry':0.65, 'Semi-Wet':0.50, 'Wet':0.35 };
const DVE_CBET_MOD  = { Air:-0.20, WeakSD:-0.10, Draw:+0.20, MediumMade:+0.10, StrongMade:+0.25 };

const DVE_TURN_BASE = { Blank:0.45, Overcard:0.35, DrawComplete:0.20, Paired:0.25 };
const DVE_TURN_MOD  = { Air:-0.30, WeakSD:-0.20, Draw:+0.10, MediumMade:+0.15, StrongMade:+0.30 };

const DVE_FOLD_THRESH = {
  flop:{
    Air:{'Dry':90,'Semi-Dry':80,'Semi-Wet':70,'Wet':60},
    WeakSD:{'Dry':60,'Semi-Dry':50,'Semi-Wet':40,'Wet':30},
    MediumMade:{'Dry':20,'Semi-Dry':15,'Semi-Wet':10,'Wet':5},
    StrongMade:{'Dry':0,'Semi-Dry':0,'Semi-Wet':0,'Wet':0}
  },
  turn:{
    Air:{'Dry':100,'Semi-Dry':100,'Semi-Wet':100,'Wet':100},
    WeakSD:{'Dry':80,'Semi-Dry':70,'Semi-Wet':60,'Wet':55},
    MediumMade:{'Dry':40,'Semi-Dry':30,'Semi-Wet':20,'Wet':15},
    StrongMade:{'Dry':5,'Semi-Dry':5,'Semi-Wet':5,'Wet':5}
  },
  river:{ Air:100, WeakSD:80, MediumMade:50, StrongMade:10 }
};

function DVE_getBetDecision(texture, bucket, profile, street, turnCardContext){
  const vp = DVE_VILLAIN_PROFILES[profile];
  if (street === 'flop'){
    let base = DVE_CBET_BASE[texture] + (DVE_CBET_MOD[bucket]||0);
    base *= vp.aggro;
    return { willBet: base >= 0.50, sizePct: base >= 0.50 ? 33 : null };
  }
  if (street === 'turn'){
    const key = turnCardContext || 'Blank';
    let base = (DVE_TURN_BASE[key] ?? DVE_TURN_BASE.Blank) + (DVE_TURN_MOD[bucket]||0);
    base *= vp.turnAggro;
    return { willBet: base >= 0.50, sizePct: base >= 0.50 ? 66 : null };
  }
  if (street === 'river'){
    if (bucket === 'StrongMade') return { willBet:true, sizePct:66 };
    if (bucket === 'MediumMade' && profile !== 'Honest') return { willBet:true, sizePct:50 };
    if (bucket === 'Air'){
      const freq = DVE_VILLAIN_PROFILES[profile].riverBluff;
      return { willBet: freq >= 0.25, sizePct: freq >= 0.25 ? 75 : null };
    }
    return { willBet:false, sizePct:null };
  }
  return { willBet:false, sizePct:null };
}

function DVE_getFoldDecision(texture, bucket, profile, street, handScore0to100){
  const adjust = DVE_VILLAIN_PROFILES[profile].caller;
  let thresh;
  if (street === 'river') thresh = (DVE_FOLD_THRESH.river[bucket] ?? 100) * adjust;
  else thresh = ((DVE_FOLD_THRESH[street]?.[bucket]?.[texture]) ?? 100) * adjust;
  return handScore0to100 < thresh ? 'fold' : 'continue';
}

function DVE_getCallDecision(texture, bucket, profile, betSize, potSize){
  const price = betSize / (potSize + betSize); // pot odds threshold

  // Crude equity proxy by bucket (directional only)
  let eqHave =
    bucket === 'Air'        ? 0.10 :
    bucket === 'WeakSD'     ? 0.22 :
    bucket === 'Draw'       ? 0.35 :
    bucket === 'MediumMade' ? 0.55 :
    /* StrongMade */          0.75;

  // Profile adjustment: 'caller' > 1.0 calls a bit wider; < 1.0 folds a bit more
  const vp = DVE_VILLAIN_PROFILES[profile] ?? DVE_VILLAIN_PROFILES.Standard;
  eqHave = Math.min(0.99, Math.max(0, eqHave * vp.caller));

  return (eqHave >= price) ? 'call' : 'fold';
}

function DVE_getVillainAction(ctx){
  const { street, villainProfile, villainHole, board, toCall, pot, turnCardContext } = ctx;
  const texture = DVE_classifyTexture(board);
  const bucket = DVE_classifyHandBucket(villainHole, board);
  const handScore = bucket==='Air'?10 : bucket==='WeakSD'?30 : bucket==='Draw'?50 : bucket==='MediumMade'?70 : 90;

  if (toCall > 0){
    const foldOrContinue = DVE_getFoldDecision(texture, bucket, villainProfile, street, handScore);
    if (foldOrContinue === 'fold') return { action:'fold' };
    const callOrFold = DVE_getCallDecision(texture, bucket, villainProfile, toCall, pot);
    if (callOrFold === 'fold') return { action:'fold' };
    return { action:'call' };
  }
  const bet = DVE_getBetDecision(texture, bucket, villainProfile, street, turnCardContext);
  if (bet.willBet) return { action:'bet', sizePct: bet.sizePct };
  return { action:'check' };
}

// ==== Per-seat villain profiles (tunable) ====

let VILLAIN_PROFILE_BY_SEAT = { UTG:'Standard', HJ:'Standard', CO:'Standard', BTN:'Standard', SB:'Standard', BB:'Standard' };

// Map our personalities to the engine profile keys
function profileKeyFor(persona) {
  if (persona === 'TAG') return 'Standard';
  if (persona === 'LAG') return 'Aggro';
  if (persona === 'STATION') return 'Station';
  if (persona === 'NIT') return 'Nit';
  if (persona === 'MANIAC') return 'Maniac';
  return 'Standard';
}

function recomputeProfilesFromLetters(){
  const map = {};
  for (const pos of ["UTG","HJ","CO","BTN","SB","BB"]) {
    const L = LETTERS_BY_POSITION[pos];
    if (L === HERO_LETTER) {
      // Hero seat: engine never uses a villain profile for hero anyway.
      continue;
    }
    const persona = SESSION_PERSONA_BY_LETTER[L];
    map[pos] = profileKeyFor(persona);
  }
  VILLAIN_PROFILE_BY_SEAT = map; // your deterministic engine reads this map
}

// ==== Override: engineRecomputeSurvivorsForStreet → no-op (keep statuses) ====
function engineRecomputeSurvivorsForStreet(board){
  try { ENGINE.lastStreetComputed = stageFromBoard(board); } catch(e) {}
  // Deterministic engine sets ENGINE.statusBySeat via action points; we don't prune here.
}

// Turn helper used by the deterministic engine
function determineTurnCardContext(prevBoard, currBoard) {
  try {
    // Reuse your existing transition analyzer
    const trans = classifyTransition(prevBoard, currBoard, holeCards);

    // First priority: board pairs on turn
    if (trans.boardPairedUp) return 'Paired';

    // Second: front-door flush completes or 4-to-straight appears
    if (trans.gotMonotone || trans.nowFourToStraight) return 'DrawComplete';

    // Third: an overcard to T/Q/K/A showed up
    if (trans.overcardCame) return 'Overcard';

    // Otherwise treat as a blank / neutral card
    return 'Blank';
  } catch (e) {
    // Fail-safe: never break the stage advance
    return 'Blank';
  }
}

// ==== Override: postflopVillainActionsUpToHero (deterministic) ====

function postflopVillainActionsUpToHero(stage){
  const heroSeat = currentPosition();
  STREET_CTX.stage = stage;
  STREET_CTX.potAtStart = pot;
  STREET_CTX.openBettor = null;
  STREET_CTX.openSizePct = null;
  STREET_CTX.openBetToCall = 0; // <-- reset live price for this street

  const seq = [];
  for (const seat of POSTFLOP_ORDER){ if (seat === heroSeat) break; seq.push(seat); }
  if (seq.length === 0) return;

  let pendingToCall = 0;
  const prevBoard = boardCards.slice(0, stage==='turn'?3:(stage==='river'?4:0));
  const turnCtx = (stage==='turn') ? determineTurnCardContext(prevBoard, boardCards) : undefined;

  for (const seat of seq){
    if (ENGINE.statusBySeat[seat] !== 'in') continue;
    const hole = seatHand(seat); if (!hole) continue;

    const ctx = {
      street: stage,
      villainProfile: VILLAIN_PROFILE_BY_SEAT[seat] ?? 'Standard',
      villainHole: hole,
      board: boardCards,
      toCall: pendingToCall,
      pot,
      turnCardContext: turnCtx
    };
    const a = DVE_getVillainAction(ctx);

    if (a.action === 'fold'){
      ENGINE.statusBySeat[seat] = 'folded_now';
      continue;
    }
    if (a.action === 'call'){
      pot = toStep5(pot + pendingToCall);
      continue;
    }
    if (a.action === 'bet'){
      const amt = Math.max(5, toStep5((a.sizePct/100) * pot));
      pendingToCall = amt;
      STREET_CTX.openBetToCall = amt;     // <-- remember live price
      pot = toStep5(pot + amt);           // <-- add bettor’s chips now
      scenario = { label: `${seat} bets ${a.sizePct}%`, potFactor: 0 };
      STREET_CTX.openBettor = seat;
      STREET_CTX.openSizePct = a.sizePct;
    }
  }

  toCall = toStep5(pendingToCall);
  updatePotInfo();
  if (toCall <= 0) scenario = { label: 'Checks to you' };
}

// ==== Override: settleVillainsAfterHero (deterministic callers behind hero) ====
function settleVillainsAfterHero(stage, heroAction){
  const hadLiveBet = (STREET_CTX.openBetToCall ?? 0) > 0;
  if (!(heroAction === 'bet' || heroAction === 'raise' || (heroAction === 'call' && hadLiveBet))) return;

  const heroSeat = currentPosition();
  const seq = []; let afterHero = false;
  for (const seat of POSTFLOP_ORDER){
    if (seat === heroSeat){ afterHero = true; continue; }
    if (afterHero) seq.push(seat);
  }

  // Price to the field:
  let toCallAmt;
  if (heroAction === 'bet' || heroAction === 'raise'){
    const betPct = (heroActions[stage]?.sizePct ?? 50);
    toCallAmt = Math.max(5, toStep5((betPct/100) * STREET_CTX.potAtStart));
  } else {
    toCallAmt = toStep5(STREET_CTX.openBetToCall); // <-- price from earlier villain bet
  }

  for (const seat of seq){
    if (ENGINE.statusBySeat[seat] !== 'in') continue;
    const hole = seatHand(seat); if (!hole) continue;

    const ctx = {
      street: stage,
      villainProfile: VILLAIN_PROFILE_BY_SEAT[seat] ?? 'Standard',
      villainHole: hole,
      board: boardCards,
      toCall: toCallAmt,
      pot
    };
    const a = DVE_getVillainAction(ctx);

    if (a.action === 'call')       pot = toStep5(pot + toCallAmt);
    else if (a.action === 'fold')  ENGINE.statusBySeat[seat] = 'folded_now';
  }
  updatePotInfo();
}

// ==== Bind host functions once helpers exist ====
(function DVE_bootstrap(){
  try { DVE_bindHostFns({ analyzeBoard, evaluate7, detectStraightDrawFromAllCards }); }
  catch(e){ console.warn('[DVE] Bind failed – ensure helpers are defined before this block runs.'); }
})();

/* === END deterministic engine block === */
