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

const bottomBar = document.getElementById("bottomBar");
const barPotOdds = document.getElementById("barPotOdds");
const barSubmit = document.getElementById("barSubmitBtn");
const barNext = document.getElementById("barNextBtn");

const hintDetails = document.getElementById("hintDetails");
const hintsDetailBody = document.getElementById("hintsDetailBody");

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
    continueRate: { flop: 0.65, turn: 0.55, river: 0.45 },
    rangeAwareContinuation: true,
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
function popRandomCard(arr){ const i=Math.floor(Math.random()*arr.length); return arr.splice(i,1)[0]; }
function preflopWeight(c1,c2){
  const v1=RANK_TO_VAL[c1.rank], v2=RANK_TO_VAL[c2.rank];
  const hi=Math.max(v1,v2), lo=Math.min(v1,v2);
  let score=0;
  if (hi>=12) score+=1.0;
  if (lo>=11) score+=0.7; else if (lo>=10) score+=0.5;
  if (v1===v2){ score+=0.9; if (hi>=10) score+=0.1; }
  if (c1.suit===c2.suit) score+=0.25;
  const gap = Math.abs(v1-v2);
  if (gap===1) score+=0.15; else if (gap===2) score+=0.07;
  const maxScore=3.0, base=0.05;
  return Math.min(1, base + (score/maxScore)*(1-base));
}
function drawBiasedOpponentHand(d){
  const maxTries=200;
  for (let t=0;t<maxTries;t++){
    const i = Math.floor(Math.random()*d.length);
    let j = Math.floor(Math.random()*d.length);
    if (j===i) continue;
    const c1=d[i], c2=d[j];
    if (Math.random()<=preflopWeight(c1,c2)){
      const hi=Math.max(i,j), lo=Math.min(i,j);
      const second = d.splice(hi,1)[0];
      const first = d.splice(lo,1)[0];
      return [first,second];
    }
  }
  return [popRandomCard(d), popRandomCard(d)];
}

// ==================== Postflop Engine v1 (deterministic survivors) ====================
// Keeps villain cards fixed (TABLE.seats) and decides who continues on each street.
// Survivors are re-evaluated at flop/turn; river survivors always go to showdown.

const ENGINE = {
    survivors: new Set(),
    survivorsByStreet: { flop: [], turn: [], river: [] },
    lastStreetComputed: 'preflop',
    preflop: { openerSeat: null, threeBetterSeat: null, participants: [] },

    // track statuses: "in", "folded_now", "folded_prev"
    statusBySeat: {
        UTG: 'in',
        HJ: 'in',
        CO: 'in',
        BTN: 'in',
        SB: 'in',
        BB: 'in'
    }
};

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
    if (ENGINE.preflop.openerSeat) ENGINE.survivors.add(ENGINE.preflop.openerSeat);
    if (ENGINE.preflop.threeBetterSeat) ENGINE.survivors.add(ENGINE.preflop.threeBetterSeat);
    (ENGINE.preflop.coldCallers ?? []).forEach(seat => ENGINE.survivors.add(seat));

    // Deterministic filter
    ENGINE.survivors = new Set([...ENGINE.survivors].filter(seat => engineContinueOnStreet(seat, board)));

    // Soft guarantee: keep exactly one preflop participant if all pruned
    if (ENGINE.survivors.size === 0) {
      const pool = new Set();
      if (ENGINE.preflop.openerSeat) pool.add(ENGINE.preflop.openerSeat);
      if (ENGINE.preflop.threeBetterSeat) pool.add(ENGINE.preflop.threeBetterSeat);
      (ENGINE.preflop.coldCallers ?? []).forEach(s => pool.add(s));
      const order = ["BTN","CO","HJ","UTG","SB","BB"];
      let pick = order.find(s => pool.has(s));
      if (!pick && pool.size > 0) pick = [...pool][0];
      if (pick) ENGINE.survivors.add(pick);
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

// Small hook from Phase 1 to remember opener / 3-bettor
function engineSetPreflopContext(openerSeat, threeBetterSeat, coldCallers){
  ENGINE.preflop.openerSeat = openerSeat || null;
  ENGINE.preflop.threeBetterSeat = threeBetterSeat || null;
  ENGINE.preflop.coldCallers = Array.isArray(coldCallers) ? coldCallers.slice() : [];

  // Keep a flat list of preflop participants — used if the hand ends preflop
  const parts = [];
  if (ENGINE.preflop.openerSeat) parts.push(ENGINE.preflop.openerSeat);
  if (ENGINE.preflop.threeBetterSeat) parts.push(ENGINE.preflop.threeBetterSeat);
  (ENGINE.preflop.coldCallers || []).forEach(s => parts.push(s));
  ENGINE.preflop.participants = [...new Set(parts)];

  ENGINE.survivors.clear();
  ENGINE.survivorsByStreet = { flop: [], turn: [], river: [] };
  ENGINE.lastStreetComputed = 'preflop';
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
function sampleShowdownOpponents(baselineCount, board, maybeOppHands, maybeDeck){
  const stage = stageFromBoard(board);
  const rates = SETTINGS.sim.continueRate;
  const oppHands = maybeOppHands || [];
  const d = maybeDeck;

  function effectiveKeepProbFor(opIdx, street){
    let p = rates[street];
    if (SETTINGS.sim.rangeAwareContinuation && oppHands[opIdx] && d){
      const boardAtStreet =
        street==='flop' ? (board.length>=3 ? board.slice(0,3) : [d[0],d[1],d[2]]) :
        street==='turn' ? (board.length>=4 ? board.slice(0,4) : (board.length===3 ? [...board, d[0]] : [])) :
        street==='river' ? (board.length>=5 ? board.slice(0,5) : (board.length===4 ? [...board, d[0]] : [])) :
        [];
      if (boardAtStreet.length>=3){
        const connected = villainConnected(oppHands[opIdx], boardAtStreet);
        if (connected) p = Math.min(0.95, p+0.25);
      }
    }
    return Math.max(0, Math.min(1, p));
  }

  const survivors = [];
  for (let i=0;i<baselineCount;i++){
    let alive=true;
    if (stage==='preflop'){
      alive = (Math.random()<effectiveKeepProbFor(i,'flop')) &&
              (Math.random()<effectiveKeepProbFor(i,'turn')) &&
              (Math.random()<effectiveKeepProbFor(i,'river'));
    } else if (stage==='flop'){
      alive = (Math.random()<effectiveKeepProbFor(i,'turn')) &&
              (Math.random()<effectiveKeepProbFor(i,'river'));
    } else if (stage==='turn'){
      alive = (Math.random()<effectiveKeepProbFor(i,'river'));
    } else alive = true;
    if (alive) survivors.push(i);
  }
  while (survivors.length < SETTINGS.sim.minShowdownOpponents && survivors.length < baselineCount){
    const cand = survivors.length;
    if (!survivors.includes(cand)) survivors.push(cand);
  }
  return survivors;
}
function computeEquityStatsLegacy(hole, board){
  const stage = stageFromBoard(board);
  const trials = SETTINGS.trialsByStage[stage] ?? 4000;
  const BASE_OPP = SETTINGS.sim.playersBaseline;

  let wins=0, ties=0, losses=0; let equityAcc=0;
  const catCount = new Map();

  for (let t=0;t<trials;t++){
    const simDeck = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
    const opponents = [];
    for (let i=0;i<BASE_OPP;i++) opponents.push(drawBiasedOpponentHand(simDeck));

    const survivorsIdx = sampleShowdownOpponents(BASE_OPP, board, opponents, simDeck);
    const survivors = survivorsIdx.map(i => opponents[i]);
    if (survivors.length===0 && BASE_OPP>0) survivors.push(opponents[0]);

    const need = 5-board.length;
    const simBoard = [...board];
    for (let i=0;i<need;i++) simBoard.push(popRandomCard(simDeck));

    const heroScore = evaluate7(hole, simBoard);
    let better=0, equal=0;
    for (let i=0;i<survivors.length;i++){
      const villainScore = evaluate7(survivors[i], simBoard);
      const cmp = compareScores(heroScore, villainScore);
      if (cmp<0) better++;
      else if (cmp===0) equal++;
    }
    if (better>0) losses++;
    else if (equal>0){ ties++; equityAcc += 1/(equal+1); }
    else { wins++; equityAcc += 1; }

    const cat = CAT_NAME[heroScore.cat];
    catCount.set(cat, (catCount.get(cat)??0)+1);
  }

  const winPct = (wins/trials)*100, tiePct=(ties/trials)*100, losePct=(losses/trials)*100;
  const equity = (equityAcc/trials)*100;
  const catBreakdown=[];
  for (const [k,v] of catCount.entries()) catBreakdown.push({ name:k, pct:(v/trials)*100 });
  const catOrder = ['Straight Flush','Four of a Kind','Full House','Flush','Straight','Three of a Kind','Two Pair','One Pair','High Card'];
  catBreakdown.sort((a,b)=>{ const oi = catOrder.indexOf(a.name)-catOrder.indexOf(b.name); return oi!==0?oi:(b.pct-a.pct); });
  return { equity, winPct, tiePct, losePct, trials, catBreakdown, numOpp: Math.max(1, SETTINGS.sim.playersBaseline) };
}

// Survivor-aware MC using the actual villain hands from the engine.
// - Opponent hole cards are FIXED (from Phase 1), only runouts are sampled.
// - If no survivors are present, falls back to legacy (or injects 1 villain) to keep UI stable.
function computeEquityStats(hole, board){
  try{
  const oppHands = engineCurrentOpponents(board); // fixed villain hands this street
if (!Array.isArray(oppHands) || oppHands.length < 1) {
  // Fallback: random opponents, so training remains meaningful
  return computeEquityStatsLegacy(hole, board);
}
    const stage = stageFromBoard(board);  // you already have this helper
    const trials = SETTINGS.trialsByStage[stage] ?? 4000;

    let wins=0, ties=0, losses=0; let equityAcc=0;
    const catCount = new Map();

    for (let t=0; t<trials; t++){
      // Build runout deck without hero/villain cards & current board
      const simDeck = createDeck().filter(c => 
        !containsCard(hole,c) && !containsCard(board,c) &&
        oppHands.every(h=>!containsCard(h,c))
      );
      // Sample the remaining board (runout only)
      const need = 5 - board.length;
      const simBoard = [...board];
      for (let i=0;i<need;i++) simBoard.push(popRandomCard(simDeck));

      const heroScore = evaluate7(hole, simBoard);
      let better=0, equal=0;
      for (let i=0;i<oppHands.length;i++){
        const villainScore = evaluate7(oppHands[i], simBoard);
        const cmp = compareScores(heroScore, villainScore);
        if (cmp<0) better++;
        else if (cmp===0) equal++;
      }
      if (better>0) losses++;
      else if (equal>0){ ties++; equityAcc += 1/(equal+1); }
      else { wins++; equityAcc += 1; }

      const cat = CAT_NAME[heroScore.cat];
      catCount.set(cat, (catCount.get(cat)??0)+1);
    }

    const winPct = (wins/trials)*100, tiePct=(ties/trials)*100, losePct=(losses/trials)*100;
    const equity = (equityAcc/trials)*100;
    const catBreakdown=[];
    for (const [k,v] of catCount.entries()) catBreakdown.push({ name:k, pct:(v/trials)*100 });
    const catOrder = ['Straight Flush','Four of a Kind','Full House','Flush','Straight','Three of a Kind','Two Pair','One Pair','High Card'];
    catBreakdown.sort((a,b)=>{ const oi=catOrder.indexOf(a.name)-catOrder.indexOf(b.name); return oi!==0?oi:(b.pct-a.pct); });

    return { equity, winPct, tiePct, losePct, trials, catBreakdown, numOpp: Math.max(1, oppHands.length) };
  }catch(e){
    console.warn('[engine-mc] survivor MC failed, using legacy', e);
    return computeEquityStatsLegacy(hole, board);
  }
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
  // In this trainer, we simply add the full raise-to amount (as you do for hero).
  // This keeps accounting consistent with applyHeroContribution(...).
  return toStep5(pot + toStep5(raiseTo));
}
// Add a "call" contribution to pot
function contributeCallTo(pot, targetTo, seat){
  const already = postedBlindFor(seat);
  const callAmt = Math.max(0, toStep5(targetTo) - toStep5(already));
  return toStep5(pot + callAmt);
}

// -- Run villains up to hero
function runPreflopUpToHero(){
  const heroSeat = currentPosition();
  const sb = toStep5(BLINDS.sb), bb = toStep5(BLINDS.bb);

  let potLocal = toStep5(sb + bb);   // blinds posted
  let toCallLocal = 0;               // what hero must call when their turn arrives
  let openerSeat = null;
  let openToBb = null;               // raise-to (in BB)
  let threeBetterSeat = null;
  let threeBetToBb = null;
 let coldCallers = [];

  // Walk seats in order until hero
  for (const s of ACTION_ORDER){
    const isHero = (s === heroSeat);
    if (isHero) break; // stop before hero acts

    const seatObj = TABLE.seats.find(x => x.seat === s);
    const code = handToCode(seatObj.hand);

    if (!openerSeat){
      // No opener yet -- can this seat open?
      if (canOpen(s, code)){
        openerSeat = s;
        openToBb = standardOpenSizeBb(s);
        const raiseTo = toStep5(openToBb * bb);
        potLocal = contributeRaiseTo(potLocal, raiseTo, s);
        continue;
      }
      // otherwise fold
    } else {
      // We have an opener; 3-bet > call > fold
      if (inThreeBetBucket(s, openerSeat, code)){
        threeBetterSeat = s;
        threeBetToBb = threeBetSizeBb(openerSeat, s, openToBb);
        const rTo = toStep5(threeBetToBb * bb);
        potLocal = contributeRaiseTo(potLocal, rTo, s);
        break; // hero will face 3-bet/4-bet tree; stop here
      }
      if (inCallBucket(s, openerSeat, code)){
        // cold call to opener's raise
        const rTo = toStep5(openToBb * bb);
        potLocal = contributeCallTo(potLocal, rTo, s);
   coldCallers.push(s);
        continue;
      }
      // else fold
    }
  }

  // Compute hero toCall
  const heroBlind = (heroSeat==='SB') ? sb : (heroSeat==='BB' ? bb : 0);
  if (!openerSeat){
    // Unopened pot to hero -> hero faces BB unless hero is SB (complete) or BB (check)
    if (heroSeat === 'BB') toCallLocal = 0;
    else if (heroSeat === 'SB') toCallLocal = Math.max(0, bb - sb);
    else toCallLocal = bb;
  } else if (threeBetterSeat){
    const rTo = toStep5(threeBetToBb * bb);
    toCallLocal = Math.max(0, rTo - heroBlind);
  } else {
    const rTo = toStep5(openToBb * bb);
    toCallLocal = Math.max(0, rTo - heroBlind);
  }

  // Scenario label for the UI (coaching friendly)
  let label = 'Preflop';
  if (openerSeat && !threeBetterSeat){
    label = `${openerSeat} opened ${openToBb.toFixed(1)}x`;
    // add note if any cold-call occurred (pot would be larger than blinds+open)
    if (potLocal > toStep5(sb + bb + toStep5(openToBb * bb))) label += ' · cold call';
  } else if (openerSeat && threeBetterSeat){
    label = `${openerSeat} opened ${openToBb.toFixed(1)}x · ${threeBetterSeat} 3‑bet ${threeBetToBb.toFixed(1)}x`;
  }

  return {
    potLocal, toCallLocal, openerSeat, openToBb, threeBetterSeat, threeBetToBb, coldCallers, label
  };
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

  // Otherwise (Beginner mode & preflop): show normally
  const cls = classifyHeroHandAtPosition();

  preflopRangeBadge.classList.remove('hidden', 'green', 'amber', 'red');
  preflopRangeBadge.textContent = `Preflop Range: ${cls}`;

  if (cls === 'Open') preflopRangeBadge.classList.add('green');
  else if (cls === 'Mix') preflopRangeBadge.classList.add('amber');
  else preflopRangeBadge.classList.add('red');
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

rangeModalBody.innerHTML = controlsHtml + defendToggleHtml +
  '<div style="margin-bottom:6px">' +
  '<span class="badge info">Range source: ' + sourceLabel + '</span>' +
  '</div>' +
  '<div id="rangeSeatNote" class="range-help"></div>';
rangeModalBody.appendChild(gridContainer);

  // Initial render: OPEN
  renderGridOrEmpty(classMapOpen());

  const tabs = rangeModalBody.querySelectorAll('.tabbar .tab');
  const vsSel = rangeModalBody.querySelector('#rangeVsSelect');

let defendSubAction = 'call';
const defendToggle = () => document.getElementById('defendToggle');

function setActiveMode(mode){
  tabs.forEach(t=>t.classList.toggle('active', t.getAttribute('data-mode')===mode));
  const enableVs = (mode !== 'open');
  vsSel.disabled = !enableVs;

  // Show/hide the Defend sub‑toggle
  const dt = defendToggle();
  if (dt) dt.style.display = (mode==='defend') ? 'inline-flex' : 'none';

  let clsMap = null;
  if (mode==='open') {
    clsMap = classMapOpen();
  } else if (mode==='3bet') {
    clsMap = classMap3bet(vsSel.value);
  } else { // defend
    clsMap = classMapDefend(vsSel.value, defendSubAction);
  }
  renderGridOrEmpty(clsMap);
}



(function wireDefendToggle(){
  const dt = defendToggle(); if (!dt) return;
  dt.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab'); if (!btn) return;
    dt.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    defendSubAction = btn.getAttribute('data-sub') || 'call';
    setActiveMode('defend');
  });
})();


  tabs.forEach(t=> t.addEventListener('click', ()=> setActiveMode(t.getAttribute('data-mode'))));
  vsSel.addEventListener('change', ()=>{
    const active = [...tabs].find(t=>t.classList.contains('active'))?.getAttribute('data-mode') || 'open';
    setActiveMode(active);
  });

// ---- BB UX: default to DEFEND and add note that BB never opens ----
if (seat === 'BB') {
  const noteEl = rangeModalBody.querySelector('#rangeSeatNote');
  if (noteEl) {
    noteEl.textContent = 'BB never opens preflop — use the Defend tab (vs opener).';
  }
  // Enable the VS selector (we need a villain opener)
  vsSel.disabled = false;
  // Pick a sensible default opener to defend against
  vsSel.value = 'UTG';

  // Disable the OPEN tab to avoid confusion
  const openTab = [...tabs].find(t => t.getAttribute('data-mode') === 'open');
  if (openTab) {
    openTab.setAttribute('aria-disabled', 'true');
    openTab.classList.add('disabled');
    openTab.addEventListener('click', (e) => e.preventDefault());
  }

  // Switch the view to DEFEND

  setActiveMode('defend');
} else {
  const noteEl = rangeModalBody.querySelector('#rangeSeatNote');
  if (noteEl) noteEl.textContent = 'Vs Open: choose Call or 3‑bet against the selected opener seat.';
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
  if (!decRaiseLabel) return;
  if (stage==='preflop') decRaiseLabel.textContent = "Raise";
  else decRaiseLabel.textContent = (toCall>0) ? "Raise" : "Bet";

  const isPre = (stage==='preflop'), isPost = !isPre;
  const raiseChecked = document.getElementById('decRaise')?.checked;
  if (sizePresetRow) sizePresetRow.classList.toggle('hidden', !(isPre && raiseChecked));
  if (sizePresetRowPost) sizePresetRowPost.classList.toggle('hidden', !(isPost && raiseChecked));
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

function settleVillainsAfterHero(stage, heroAction){
  // Only simulate extra callers when hero made an aggressive action without a live bet
  if (!(heroAction === 'bet' || heroAction === 'raise')) return;

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

  preflopAggressor = null;
  heroActions.preflop = { action:null, sizeBb:null };
  heroActions.flop    = { action:null, sizePct:null, cbet:null };
  heroActions.turn    = { action:null, sizePct:null, barrel:null };
  heroActions.river   = { action:null, sizePct:null, barrel:null };

// === Phase 1 engine: build table + villains' actions up to hero ===
const sb = toStep5(BLINDS.sb), bb = toStep5(BLINDS.bb);
initTableForNewHand();
const pf = runPreflopUpToHero();
pot = pf.potLocal;
toCall = pf.toCallLocal;
currentStageIndex = 0;
preflopAggressor = pf.openerSeat ? 'villain' : null;
// Friendly label for the UI
scenario = { label: pf.label, potFactor: 0 };

engineSetPreflopContext(pf.openerSeat, pf.threeBetterSeat, pf.coldCallers);

  renderCards();
  setPositionDisc();
  setPreflopBadge();
  renderPositionStatusRow();
  updatePotInfo();
  updateHintsImmediate();
  maybeStartTimer();
}

function showWalkMessage() {
    if (!feedbackEl) return;

    // Clear any prior feedback for clarity
    // (If you prefer to keep previous lines, remove the next line)
    feedbackEl.innerHTML = "";

    // Insert the message line
    feedbackEl.insertAdjacentHTML('beforeend', `
        <div class="walk-banner" role="status" aria-live="polite">
            <strong>Everyone folds preflop — you win the pot.</strong>
        </div>
    `);
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
  } catch(e){ /* ignore calc errors */ }

  // Deal new street
  if (stage==="flop"){ boardCards.push(dealCard(), dealCard(), dealCard()); }
  else if (stage==="turn" || stage==="river"){ boardCards.push(dealCard()); }

  // Recompute survivors for this street (villain fold/continue is deterministic)
  try { engineRecomputeSurvivorsForStreet(boardCards); } catch(e){}

// --- If no villain remains in play, end the hand immediately
{
  const hero = currentPosition();
  const anyVillainIn = ["UTG","HJ","CO","BTN","SB","BB"]
    .some(s => s !== hero && ENGINE.statusBySeat[s] === "in");
  if (!anyVillainIn) {
    renderPositionStatusRow();
    showWalkMessage(); // already in your file
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
    showWalkMessage();
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
  const pfrSeat = ENGINE.preflop.openerSeat || null;  // show PFR for hero or villain

  const seats = ["UTG","HJ","CO","BTN","SB","BB"];
  row.innerHTML = "";

  seats.forEach(seat => {
    // vertical stack: disc on top, badge below
    const stack = document.createElement("div");
    stack.className = "pos-seat-stack";

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

function endHand(){
  clearTimer();

  // Clear KPI swing chip at hand end
  updateKpiEquitySwing(0, null);

// Villain reveal (Always remaining / Always all / Showdown-only / On hero fold)
try {
  const reveal = (REVEAL?.policy ?? 'always_remaining');

  const heroFolded = handHistory.some(h =>
    (h.stage === 'preflop' || h.stage === 'flop' || h.stage === 'turn' || h.stage === 'river')
    && h.decision === 'fold'
  );
  const reachedRiver = (boardCards.length === 5);

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

  if (decision === 'raise') {
    if (stage === 'preflop') {
      // Treat preflop “Raise” as an open/raise-to (size in BB)
      const bb = toStep5(BLINDS.bb);
      const sizeBB = (heroActions.preflop.sizeBb ?? 2.5);
      const target = toStep5(sizeBB * bb); // "raise to" amount
      // Hero puts full 'target' into pot when first-in; if facing completion (SB), this still functions as raise-to.
      pot = toStep5(pot + target);
      toCall = 0;
      updatePotInfo();
      return;
    } else {
      // Postflop: Bet (toCall==0) or Raise (toCall>0)
      const pct = heroActions[stage].sizePct ?? 50;
      const betBase = pot; // base is current pot
      const betAmt = toStep5((pct/100) * betBase);

      // If facing a bet, a raise is (call + extra). Keep it trainer-simple:
      // raise contribution = toCall + betAmt
      const putIn = (toCall > 0) ? toStep5(toCall + betAmt) : betAmt;

      pot = toStep5(pot + putIn);
      toCall = 0;
      updatePotInfo();
      return;
    }
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
        Equity is from a Monte–Carlo simulation this street (baseline you vs ${SETTINGS.sim.playersBaseline} opponent${SETTINGS.sim.playersBaseline===1?'':'s'}) with street-by-street continuation to showdown.
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

// === Settle some field callers when hero bets, so pot grows realistically
const actionLabel = determinePostflopAction(decision, toCall); // you already use this elsewhere
const stageNow = STAGES[currentStageIndex];
if (stageNow === 'flop' || stageNow === 'turn' || stageNow === 'river') {
  settleVillainsAfterHero(stageNow, actionLabel);
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

      let sizeEval="", sizeAdvice="";
      if (decision==="raise" && heroActions.preflop.sizeBb!=null){
        const bb = heroActions.preflop.sizeBb;
        const [min,max] = recommendedOpenSizeRangeBb(pos);
        if (bb>=min && bb<=max) sizeEval="Good";
        else if (bb<min && bb>=(min-0.3)) sizeEval="Slightly small";
        else if (bb<min) sizeEval="Too small";
        else if (bb>max && bb<=(max+0.5)) sizeEval="Slightly large";
        else sizeEval="Too large";
        sizeAdvice = buildSizeAdvice(pos, bb, min, max);
      }

      const sizeLine = (decision==="raise" && heroActions.preflop.sizeBb!=null)
        ? `<div>Open size: ${heroActions.preflop.sizeBb.toFixed(1)}x — <span class="badge ${sizeEvalBadgeColor(sizeEval)}">${sizeEval||'n/a'}</span></div>
           <div style="opacity:.9">${sizeAdvice}</div>` : "";

      feedbackEl.insertAdjacentHTML('beforeend', `
        <div style="margin-top:8px">
          <strong>Preflop (6‑max ${pos}):</strong>
          <div>Range check: <span class="badge ${rangeClass==='Open'?'green':(rangeClass==='Mix'?'amber':'red')}">${rangeClass}</span></div>
          <div>PFR: ${preflopAggressor ?? 'n/a'}</div>
          ${sizeLine}
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
      const actionLabel = determinePostflopAction(decision, toCall);
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

  submitStageBtn.classList.add("hidden");
  nextStageBtn.classList.remove("hidden");
  if (barSubmit) barSubmit.classList.add("hidden");
  if (barNext) barNext.classList.remove("hidden");
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
  policy: 'always_remaining' // 'always_all' | 'showdown_only' | 'on_hero_fold' | 'always_remaining'
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

      <label>See Flop %</label>
      <input type="number" id="set_rateFlop" min="0" max="100" value="${Math.round(SETTINGS.sim.continueRate.flop*100)}"/>

      <label>See Turn %</label>
      <input type="number" id="set_rateTurn" min="0" max="100" value="${Math.round(SETTINGS.sim.continueRate.turn*100)}"/>

      <label>See River %</label>
      <input type="number" id="set_rateRiver" min="0" max="100" value="${Math.round(SETTINGS.sim.continueRate.river*100)}"/>

      <label>Range‑aware continuation</label>
      <input type="checkbox" id="set_rangeAware" ${SETTINGS.sim.rangeAwareContinuation ? 'checked' : ''}/>

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
    SETTINGS.sim.continueRate.flop  = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateFlop").value)  || 65)/100)));
    SETTINGS.sim.continueRate.turn  = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateTurn").value)  || 55)/100)));
    SETTINGS.sim.continueRate.river = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateRiver").value) || 45)/100)));
    SETTINGS.sim.rangeAwareContinuation = !!panel.querySelector("#set_rangeAware").checked;

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
if (rp) REVEAL.policy = rp.value || 'always_remaining';

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
      const val = parseFloat(btn.getAttribute('data-bb'));
      heroActions.preflop.sizeBb = isFinite(val) ? val : null;
    });
  }

  ["decFold","decCall","decRaise"].forEach(id=>{
    const el=document.getElementById(id); if (!el) return;
    el.addEventListener('change', ()=>{
      const stage=STAGES[currentStageIndex];
      const isPre=(stage==='preflop'); const isRaise=document.getElementById('decRaise')?.checked;
      if (sizePresetRow) sizePresetRow.classList.toggle('hidden', !(isPre && isRaise));
      if (sizePresetRowPost) sizePresetRowPost.classList.toggle('hidden', !(!isPre && isRaise));
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


  // Hide swing chip at boot
  updateKpiEquitySwing(0, null);
})();
