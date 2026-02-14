// ====== Core state ======
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

// ====== DOM ======
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

// ====== Mobile UX DOM ======
const kpiStageEl = document.getElementById("kpiStage");
const kpiPotEl = document.getElementById("kpiPot");
const kpiCallEl = document.getElementById("kpiToCall");
const kpiTimerEl = document.getElementById("kpiTimer");
const bottomBar = document.getElementById("bottomBar");
const barPotOdds = document.getElementById("barPotOdds");
const barSubmit = document.getElementById("barSubmitBtn");
const barNext = document.getElementById("barNextBtn");
const hintDetails = document.getElementById("hintDetails");
const hintsDetailBody = document.getElementById("hintsDetailBody");

// ====== Utility: deck & cards ======
const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const RANK_TO_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

function createDeck() {
  const d = [];
  for (let s = 0; s < SUITS.length; s++) {
    for (let r = 0; r < RANKS.length; r++) {
      d.push({ rank: RANKS[r], suit: SUITS[s] });
    }
  }
  return d;
}
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
function dealCard() { return deck.pop(); }

// ====== Betting normalization (5-quid chunks) ======
function toStep5(value) { return Math.round((Number(value) ?? 0) / 5) * 5; }
function clampNonNegative(v) { return Math.max(0, Number.isFinite(v) ? v : 0); }
function computeRoundedBetAndPot(potBefore, factor) {
  const rawBet = clampNonNegative(potBefore * factor);
  let bet = toStep5(rawBet);
  if (bet === 0 && rawBet > 0) bet = 5;
  const newPot = toStep5(potBefore + bet);
  return { bet, newPot };
}

// ====== Rendering ======
function renderCards() {
  holeCardsEl.innerHTML = "";
  boardCardsEl.innerHTML = "";
  holeCards.forEach(card => { holeCardsEl.appendChild(createCardEl(card)); });
  boardCards.forEach(card => { boardCardsEl.appendChild(createCardEl(card)); });
}
function createCardEl(card) {
  const div = document.createElement("div");
  div.className = "card";
  if (card.suit === "\u2665" || card.suit === "\u2666") div.classList.add("red");
  const rankTop = document.createElement("div"); rankTop.className = "rank"; rankTop.textContent = card.rank;
  const suitMid = document.createElement("div"); suitMid.className = "suit"; suitMid.textContent = card.suit;
  const rankBottom = document.createElement("div"); rankBottom.className = "rank"; rankBottom.textContent = card.rank;
  div.append(rankTop, suitMid, rankBottom);
  return div;
}
function updatePotInfo() {
  pot = toStep5(pot);
  toCall = toStep5(toCall);
  const stageName = STAGES[currentStageIndex].toUpperCase();

  // Desktop labels
  if (potSizeEl) potSizeEl.textContent = pot.toFixed(0);
  if (toCallEl) toCallEl.textContent = toCall.toFixed(0);
  if (stageLabelEl) stageLabelEl.textContent = stageName;
  if (scenarioLabelEl) scenarioLabelEl.textContent = scenario ? scenario.label : "—";

  // Sticky KPI bar
  if (kpiStageEl) kpiStageEl.textContent = `Stage: ${stageName}`;
  if (kpiPotEl) kpiPotEl.textContent = `Pot: £${pot.toFixed(0)}`;
  if (kpiCallEl) kpiCallEl.textContent = `To Call: £${toCall.toFixed(0)}`;
  const tl = (timeLeft==null) ? "—" : `${Math.max(0,timeLeft)}s`;
  if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${tl}`;

  // Bottom quick pot-odds snippet
  const pOdds = computePotOdds(pot, toCall);
  if (barPotOdds) barPotOdds.textContent = isFinite(pOdds) ? `Pot odds ${pOdds.toFixed(1)}%` : 'Pot odds —';
}

// ====== Timer ======
function startTimer() {
  clearTimer();
  timeLeft = timerSeconds;
  if (timerCountdownEl) timerCountdownEl.textContent = `${timeLeft}s`;
  if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${Math.max(0,timeLeft)}s`;
  timerId = setInterval(() => {
    timeLeft -= 1;
    if (timeLeft <= 0) {
      if (timerCountdownEl) timerCountdownEl.textContent = "0s";
      clearInterval(timerId);
      timerId = null;
    } else {
      if (timerCountdownEl) timerCountdownEl.textContent = `${timeLeft}s`;
    }
    if (kpiTimerEl) kpiTimerEl.textContent = `Time: ${Math.max(0,timeLeft)}s`;
  }, 1000);
}
function clearTimer() {
  if (timerId) { clearInterval(timerId); timerId = null; }
  if (timerCountdownEl) timerCountdownEl.textContent = "—";
  if (kpiTimerEl) kpiTimerEl.textContent = "Time: —";
}
function maybeStartTimer() {
  if (difficulty === "beginner") {
    clearTimer();
    if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
  } else {
    startTimer();
  }
}

// ====== Board texture & tags (BOARD-ONLY connectedness) ======
function analyzeBoard(board, hole) {
  function longestBoardRunRanks(boardCards) {
    const idxs = [...new Set(boardCards.map(c => RANKS.indexOf(c.rank)))].sort((a,b)=>a-b);
    if (idxs.length === 0) return 0;
    let run = 1, best = 1;
    for (let i=1;i<idxs.length;i++){
      if (idxs[i] === idxs[i-1]) continue;
      if (idxs[i] === idxs[i-1] + 1) { run++; best = Math.max(best, run); }
      else { run = 1; }
    }
    return best;
  }

  const boardRanksCount = {};
  const boardSuitsCount = {};
  board.forEach(c => {
    boardRanksCount[c.rank] = (boardRanksCount[c.rank] ?? 0) + 1;
    boardSuitsCount[c.suit] = (boardSuitsCount[c.suit] ?? 0) + 1;
  });

  const paired = Object.values(boardRanksCount).some(v => v >= 2);
  const suitCounts = Object.values(boardSuitsCount);
  const maxSuitOnBoard = suitCounts.length ? Math.max(...suitCounts) : 0;
  const suitKinds = Object.keys(boardSuitsCount).length;
  const mono = maxSuitOnBoard >= 3;
  const twoTone = (board.length >= 3 && suitKinds === 2 && !mono);
  const rainbow = (board.length >= 3 && suitKinds >= 3 && !mono);
  const boardRun = longestBoardRunRanks(board);

  const isFlop = board.length === 3;
  const isTurn = board.length === 4;
  const isRiver = board.length === 5;

  let connected = false;
  let semiConnected = false;
  let fourToStraight = false;
  let straightOnBoard = false;

  if (isFlop) {
    connected = (boardRun >= 3);
    if (!connected) {
      const vals = [...new Set(board.map(c => RANKS.indexOf(c.rank)))].sort((a,b)=>a-b);
      if (vals.length === 3) {
        const gaps = [vals[1]-vals[0], vals[2]-vals[1]];
        semiConnected = (gaps.includes(2) && gaps.includes(1)); // e.g., 4-6-7 or 4-5-7
      }
    }
  } else {
    const rv = new Set(board.map(c => RANK_TO_VAL[c.rank]));
    if (rv.has(14)) rv.add(1); // wheel
    const ordered = [...rv].sort((a,b)=>a-b);
    let run=1, maxRun=1;
    for (let i=1;i<ordered.length;i++){
      if (ordered[i] === ordered[i-1]) continue;
      if (ordered[i] === ordered[i-1]+1) { run++; maxRun = Math.max(maxRun, run); }
      else { run = 1; }
    }
    straightOnBoard = (isRiver && maxRun >= 5);

    run=1; maxRun=1;
    for (let i=1;i<ordered.length;i++){
      if (ordered[i] === ordered[i-1]+1) { run++; maxRun = Math.max(maxRun, run); }
      else if (ordered[i] !== ordered[i-1]) { run = 1; }
    }
    fourToStraight = (maxRun >= 4);
    connected = (!isRiver && (fourToStraight || boardRun >= 3));
  }

  // Hero-level: do YOU have a flush draw among 7 cards?
  const all = [...board, ...hole];
  const heroSuitCounts = {};
  all.forEach(c => { heroSuitCounts[c.suit] = (heroSuitCounts[c.suit] ?? 0) + 1; });
  const heroFlushDraw = Object.values(heroSuitCounts).some(v => v === 4);

  // Tags
  const tags = [];
  if (paired) tags.push({label:"Paired", sev:"amber"});
  if (mono) tags.push({label:"Monotone", sev:"amber"});
  if (twoTone) tags.push({label:"Two‑tone", sev:"green"});
  if (rainbow) tags.push({label:"Rainbow", sev:"green"});

  // Flush signalling by street
  if (isFlop && twoTone) tags.push({label:"Flush Possible", sev:"amber"});
  if ((isTurn || isRiver) && maxSuitOnBoard >= 3) {
    tags.push({label: isRiver ? "Flushy Board" : "Flush Possible", sev: isRiver ? "red" : "amber"});
  }

  if (straightOnBoard) tags.push({label:"Straight on Board", sev:"red"});
  if (fourToStraight && !straightOnBoard) tags.push({label:"4‑Straight", sev:"amber"});
  if (connected && !fourToStraight && !straightOnBoard) tags.push({label:"Connected", sev:"amber"});
  if (!connected && semiConnected) tags.push({label:"Semi‑Connected", sev:"amber"});

  // Legacy warnings
  const warnings = [];
  if (paired) warnings.push("Paired board – full house / trips possible.");
  if (mono) warnings.push("Monotone board – flush possible.");
  if (fourToStraight || connected || semiConnected) warnings.push("Straight possibilities present.");
  if (heroFlushDraw) warnings.push("You have a flush draw.");

  let drawStrength = "green";
  if (paired || mono || fourToStraight || connected || semiConnected) drawStrength = "amber";
  if ((paired && mono) || straightOnBoard) drawStrength = "red";

  return { warnings, heroFlushDraw, drawStrength, tags,
    paired, mono, connected, fourToStraight };
}

// ====== Helpers: rank counts & descriptors ======
function countRankIn(hole, board, rank) {
  let n = 0;
  hole.forEach(c => { if (c.rank === rank) n++; });
  board.forEach(c => { if (c.rank === rank) n++; });
  return n;
}
function remainingOfRank(hole, board, rank) {
  return Math.max(0, 4 - countRankIn(hole, board, rank));
}
function describeMadeHand(hole, board) {
  const score = evaluate7(hole, board);
  if (score.cat === 1) {
    const pairRank = score.ranks[0];
    return { cat: score.cat, label: `One Pair (${Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===pairRank)})` };
  }
  if (score.cat === 2) {
    const r1 = score.ranks[0], r2 = score.ranks[1];
    const n1 = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r1);
    const n2 = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r2);
    return { cat: score.cat, label: `Two Pair (${n1}s & ${n2}s)` };
  }
  if (score.cat === 3) {
    const r = score.ranks[0];
    const n = Object.keys(RANK_TO_VAL).find(k=>RANK_TO_VAL[k]===r);
    return { cat: score.cat, label: `Trips (${n}s)` };
  }
  if (score.cat === 4) return { cat: score.cat, label: "Straight" };
  if (score.cat === 5) return { cat: score.cat, label: "Flush" };
  if (score.cat === 6) return { cat: score.cat, label: "Full House" };
  if (score.cat === 7) return { cat: score.cat, label: "Quads" };
  if (score.cat === 8) return { cat: score.cat, label: "Straight Flush" };
  return { cat: score.cat, label: "High Card" };
}

// ====== Nuts detection ======
function isAbsoluteNutsOnRiver(hole, board) {
  if (board.length !== 5) return { abs:false, beaters:0 };
  const deck = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
  const heroScore = evaluate7(hole, board);
  let beaters = 0;
  for (let i=0;i<deck.length;i++){
    for (let j=i+1;j<deck.length;j++){
      const villainScore = evaluate7([deck[i], deck[j]], board);
      if (compareScores(heroScore, villainScore) < 0) { beaters++; if (beaters>0) break; }
    }
    if (beaters>0) break;
  }
  return { abs: beaters === 0, beaters };
}
function isProbableNutsPreRiver(hole, board, samples=800) {
  if (board.length === 5) return isAbsoluteNutsOnRiver(hole, board);
  const deck = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
  const heroScore = evaluate7(hole, board);
  let beaters = 0;
  for (let s=0; s<samples; s++){
    const i = Math.floor(Math.random()*deck.length);
    let j = Math.floor(Math.random()*deck.length);
    if (j===i) j = (j+1) % deck.length;
    const villainScore = evaluate7([deck[i], deck[j]], board);
    if (compareScores(heroScore, villainScore) < 0) { beaters++; break; }
  }
  return { abs:false, beaters, likely: beaters===0 };
}

// ====== STRAIGHT DRAW DETECTION (fixed) ======
/**
 * Returns { openEnder, gutshot }
 * - Open-ender = any 4 *consecutive* ranks r..r+3 present where r ∈ [2..10].
 * - Gutshot = any 5-window r..r+4 with exactly 4 present BUT not counted as OESD.
 * Also handles A-2-3-4 (needs 5) as a 4-out gutshot.
 */
function detectStraightDrawFromAllCards(allCards) {
  const vals = new Set(allCards.map(c => RANK_TO_VAL[c.rank])); // 2..14 only here
  const has = v => vals.has(v);

  // --- Open-ender: look for 4 consecutive ranks starting 2..10
  let openEnder = false;
  for (let r = 2; r <= 10; r++) {
    if (has(r) && has(r+1) && has(r+2) && has(r+3)) { openEnder = true; break; }
  }
  if (openEnder) return { openEnder:true, gutshot:false };

  // --- Gutshot: any 5-window with exactly 4 ranks present (not OESD)
  let gutshot = false;
  for (let r = 2; r <= 10; r++) {
    let count = 0;
    for (let k = 0; k < 5; k++) if (has(r+k)) count++;
    if (count === 4) { gutshot = true; break; }
  }
  // Special wheel: A-2-3-4 (needs 5)
  if (!gutshot && has(14) && has(2) && has(3) && has(4) && !has(5)) gutshot = true;
  return { openEnder:false, gutshot };
}

// ====== Hints / Outs ======
function estimateOuts(hole, board) {
  const stage = STAGES[currentStageIndex];
  const texture = analyzeBoard(board, hole);
  if (stage === "river") {
    return { strong: 0, tentative: 0, outsDetail: [], texture };
  }

  let strong = 0; let tentative = 0; const outsDetail = [];

  // Flush draw
  const all = [...hole, ...board];
  const suitCounts = {};
  all.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1; });
  const flushSuit = Object.keys(suitCounts).find(s => suitCounts[s] === 4);
  if (flushSuit) {
    const flushOuts = 9;
    if (texture.mono) { // monotone board → conservative
      tentative += flushOuts; outsDetail.push("Flush draw – 9 tentative outs (monotone board).");
    } else if (texture.paired) {
      strong += flushOuts; outsDetail.push("Flush draw – 9 strong outs. Note: paired board (boat/quads risk).");
    } else {
      strong += flushOuts; outsDetail.push("Flush draw – 9 strong outs.");
    }
  }

  // Straight draws
  const { openEnder, gutshot } = detectStraightDrawFromAllCards(all);
  if (openEnder) {
    const outs = 8;
    if (texture.mono) {
      tentative += outs; outsDetail.push("Open‑ended straight draw – 8 tentative outs (monotone board).");
    } else if (texture.paired) {
      strong += outs; outsDetail.push("Open‑ended straight draw – 8 strong outs. Note: paired board (some 'dirty' outs vs trips/boats).");
    } else {
      strong += outs; outsDetail.push("Open‑ended straight draw – 8 strong outs.");
    }
  } else if (gutshot) {
    const outs = 4;
    if (texture.mono) {
      tentative += outs; outsDetail.push("Gutshot straight draw – 4 tentative outs (monotone board).");
    } else if (texture.paired) {
      strong += outs; outsDetail.push("Gutshot straight draw – 4 strong outs. Note: paired board (dirty outs risk).");
    } else {
      strong += outs; outsDetail.push("Gutshot straight draw – 4 strong outs.");
    }
  }

  // Pair logic & promotions
  const r1 = hole[0].rank, r2 = hole[1].rank;
  const holePair = (r1 === r2);

  const boardCount = {};
  board.forEach(c => { boardCount[c.rank] = (boardCount[c.rank] ?? 0) + 1; });

  const r1OnBoard = boardCount[r1] ?? 0, r2OnBoard = boardCount[r2] ?? 0;
  const havePair = holePair || r1OnBoard > 0 || r2OnBoard > 0;

  if (!havePair) {
    const outsR1 = Math.max(0, 3 - r1OnBoard);
    const outsR2 = Math.max(0, 3 - r2OnBoard);
    if (outsR1 > 0) { tentative += outsR1; outsDetail.push(`Overcard ${r1} pair – ${outsR1} tentative outs.`); }
    if (outsR2 > 0) { tentative += outsR2; outsDetail.push(`Overcard ${r2} pair – ${outsR2} tentative outs.`); }
  }

  if (havePair) {
    const pairedRank = holePair ? r1 : (r1OnBoard > 0 ? r1 : r2);
    const seenOnBoard = boardCount[pairedRank] ?? 0;
    const holeCount = holePair ? 2 : 1;
    const trips = Math.max(0, 4 - holeCount - seenOnBoard);
    if (trips > 0) {
      if (texture.mono || texture.fourToStraight || texture.connected || texture.paired) {
        tentative += trips; outsDetail.push(`Trips (${pairedRank}) – ${trips} tentative outs (board danger).`);
      } else {
        strong += trips; outsDetail.push(`Trips (${pairedRank}) – ${trips} strong outs.`);
      }
    }

    if (!holePair) {
      const kickerRank = (pairedRank === r1 ? r2 : r1);
      const seenKick = boardCount[kickerRank] ?? 0;
      const kickerOuts = Math.max(0, 3 - seenKick);
      if (kickerOuts > 0) {
        tentative += kickerOuts;
        outsDetail.push(`Two‑pair via ${kickerRank} – ${kickerOuts} tentative outs.`);
      }
    }

    // Full-house promotions on paired boards (turn/river emphasis)
    if ((Object.values(boardCount).some(v => v >= 2)) && board.length >= 4) {
      const boardPairedRank = Object.keys(boardCount).find(k => (boardCount[k] ?? 0) >= 2);
      if (boardPairedRank) {
        const heroPairRank = pairedRank;
        const heroBoatOuts = remainingOfRank(hole, board, heroPairRank);
        if (heroBoatOuts > 0) {
          strong += heroBoatOuts;
          outsDetail.push(`Full House via ${heroPairRank} – ${heroBoatOuts} strong outs.`);
        }
        const boardBoatOuts = remainingOfRank(hole, board, boardPairedRank);
        if (boardBoatOuts > 0) {
          tentative += boardBoatOuts;
          outsDetail.push(`Full House via ${boardPairedRank} – ${boardBoatOuts} tentative outs (quads risk).`);
        }
      }
    }
  }

  return { strong, tentative, outsDetail, texture };
}

function updateHintsImmediate() {
  const stage = STAGES[currentStageIndex];
  const outsInfo = estimateOuts(holeCards, boardCards);
  const texture = outsInfo.texture;

  const boardTags = (texture.tags || []).map(t => `<span class="badge ${t.sev}">${t.label}</span>`).join(' ');
  const made = describeMadeHand(holeCards, boardCards);

  let nutsBadge = "";
  if (boardCards.length === 5) {
    const nuts = isAbsoluteNutsOnRiver(holeCards, boardCards);
    nutsBadge = nuts.abs ? `<span class="badge green">NUTS</span>` : `<span class="badge amber">Not nuts</span>`;
  } else if (boardCards.length >= 3) {
    const prob = isProbableNutsPreRiver(holeCards, boardCards, 800);
    nutsBadge = prob.likely ? `<span class="badge green">Likely Nuts</span>` : `<span class="badge amber">Beatable</span>`;
  }

  const totalOuts = outsInfo.strong + outsInfo.tentative;
  let approxEquity = null;
  if (stage === "flop") approxEquity = totalOuts * 4;
  if (stage === "turn") approxEquity = totalOuts * 2;

  const outsLines = [];
  outsLines.push(`<div><strong>Strong outs:</strong> ${outsInfo.strong}</div>`);
  outsLines.push(`<div><strong>Tentative outs:</strong> ${outsInfo.tentative}</div>`);
  if (totalOuts > 0 && approxEquity !== null) {
    outsLines.push(`<div>4 & 2 rule → approx <strong>${approxEquity.toFixed(1)}%</strong></div>`);
  }
  if (outsInfo.outsDetail.length > 0) {
    outsLines.push(`<div style="opacity:.9">${outsInfo.outsDetail.join(" ")}</div>`);
  }

  const examplePotOdds = computePotOdds(pot, toCall);
  const potLine = (stage !== "river")
    ? `<div>£${toCall.toFixed(0)} to call into £${pot.toFixed(0)} → Pot odds <strong>${examplePotOdds.toFixed(1)}%</strong></div>`
    : ``;

  // Summary (short, for mobile)
  const summaryHtml = `
    <div><strong>Board:</strong> ${boardTags || '<span class="badge green">Stable</span>'}</div>
    <div><strong>Made:</strong> ${made.label} ${nutsBadge}</div>
    <div><strong>Outs:</strong> ${outsInfo.strong} strong${outsInfo.tentative?`, ${outsInfo.tentative} tentative`:''}${(approxEquity!=null && (outsInfo.strong+outsInfo.tentative)>0)?` · ~${approxEquity.toFixed(1)}%`:""}</div>
  `;

  // Details (collapsible)
  const detailsHtml = `
    <div style="display:flex;flex-direction:column;gap:6px">
      ${outsLines.join("")}
      ${potLine}
    </div>
  `;

  if (difficulty === "beginner" || difficulty === "intermediate") {
    hintsEl.innerHTML = summaryHtml;
    if (hintsDetailBody) hintsDetailBody.innerHTML = detailsHtml;
    if (hintDetails) hintDetails.open = false;
  } else {
    hintsEl.innerHTML = "";
    if (hintsDetailBody) hintsDetailBody.innerHTML = "";
    if (hintDetails) hintDetails.open = false;
  }
}

// ====== Scenarios ======
const SCENARIOS = [
  { label: "Strong hand slow play", potFactor: 0.3 },
  { label: "Drawing hand stab", potFactor: 0.6 },
  { label: "Polarised shove", potFactor: 1.0 },
  { label: "Weird small bet", potFactor: 0.2 },
  { label: "Overbet pressure", potFactor: 1.5 }
];
function randomScenario() {
  const idx = Math.floor(Math.random() * SCENARIOS.length);
  return SCENARIOS[idx];
}

// ====== Equity & pot odds ======
function containsCard(list, card) { return list.some(c => c.rank === card.rank && c.suit === card.suit); }
function byDesc(a,b){ return b - a; }
function getCountsByRank(cards){ const m = new Map(); for (const c of cards) m.set(c.rank, (m.get(c.rank) ?? 0)+1); return m; }
function getCountsBySuit(cards){ const m = new Map(); for (const c of cards) m.set(c.suit, (m.get(c.suit) ?? 0)+1); return m; }
function ranksDesc(cards){ return cards.map(c=>RANK_TO_VAL[c.rank]).sort(byDesc); }
function uniqueRanksDesc(cards){ return [...new Set(cards.map(c=>RANK_TO_VAL[c.rank]))].sort(byDesc); }
function highestStraightHigh(rankValsSet){
  const vals = [...rankValsSet];
  if (rankValsSet.has(14)) vals.push(1);
  vals.sort((a,b)=>a-b);
  let run=1, best=0;
  for (let i=1;i<vals.length;i++){
    if (vals[i] === vals[i-1]) continue;
    if (vals[i] === vals[i-1] + 1){ run++; if (run >= 5) best = Math.max(best, vals[i]); }
    else { run = 1; }
  }
  return best;
}
/** Evaluate best 5-card hand from 7 cards. */
function evaluate7(hole, board){
  const cards = [...hole, ...board];
  const byRank = getCountsByRank(cards);
  const bySuit = getCountsBySuit(cards);
  const rankValsDesc = uniqueRanksDesc(cards);
  const rankSet = new Set(rankValsDesc);

  const suitWith5 = [...bySuit.entries()].find(([,cnt]) => cnt >= 5)?.[0];
  if (suitWith5){
    const suited = cards.filter(c => c.suit === suitWith5);
    const suitedSet = new Set(uniqueRanksDesc(suited));
    const sfHigh = highestStraightHigh(suitedSet);
    if (sfHigh) return { cat:8, ranks:[sfHigh] };
  }

  const quads = [...byRank.entries()].filter(([,c]) => c===4).map(([r])=>RANK_TO_VAL[r]).sort(byDesc);
  if (quads.length){
    const quad = quads[0];
    const kicker = rankValsDesc.find(v => v !== quad);
    return { cat:7, ranks:[quad, kicker] };
  }

  const trips = [...byRank.entries()].filter(([,c]) => c===3).map(([r])=>RANK_TO_VAL[r]).sort(byDesc);
  const pairs = [...byRank.entries()].filter(([,c]) => c===2).map(([r])=>RANK_TO_VAL[r]).sort(byDesc);

  // Full house: trips + (pair OR second trips)
  if (trips.length && (pairs.length || trips.length >= 2)){
    const topTrips = trips[0];
    const bestPair = (trips.length >= 2) ? trips[1] : pairs[0];
    return { cat:6, ranks:[topTrips, bestPair] };
  }

  if (suitWith5){
    const flushVals = ranksDesc(cards.filter(c=>c.suit===suitWith5)).slice(0,5);
    return { cat:5, ranks:flushVals };
  }

  const straightHigh = highestStraightHigh(rankSet);
  if (straightHigh) return { cat:4, ranks:[straightHigh] };

  if (trips.length){
    const t = trips[0];
    const kickers = rankValsDesc.filter(v=>v!==t).slice(0,2);
    return { cat:3, ranks:[t, ...kickers] };
  }

  if (pairs.length >= 2){
    const [p1, p2] = pairs.slice(0,2);
    const kicker = rankValsDesc.find(v => v !== p1 && v !== p2);
    return { cat:2, ranks:[p1, p2, kicker] };
  }

  if (pairs.length === 1){
    const p = pairs[0];
    const kickers = rankValsDesc.filter(v=>v!==p).slice(0,3);
    return { cat:1, ranks:[p, ...kickers] };
  }

  return { cat:0, ranks:rankValsDesc.slice(0,5) };
}
function compareScores(a,b){
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  const L = Math.max(a.ranks.length, b.ranks.length);
  for (let i=0;i<L;i++){
    const av = a.ranks[i] ?? 0;
    const bv = b.ranks[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}
function computePotOdds(pot, callAmount) { if (callAmount <= 0) return 0; return (callAmount / (pot + callAmount)) * 100; }
const CAT_NAME = {
  8:'Straight Flush', 7:'Four of a Kind', 6:'Full House',
  5:'Flush', 4:'Straight', 3:'Three of a Kind',
  2:'Two Pair', 1:'One Pair', 0:'High Card'
};

// ====== REALISM & PERFORMANCE SETTINGS ======
const SETTINGS = {
  sim: {
    playersBaseline: 4,
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

// ====== Simulation helpers ======
function popRandomCard(arr) { const i = Math.floor(Math.random() * arr.length); return arr.splice(i, 1)[0]; }
function preflopWeight(c1, c2) {
  const v1 = RANK_TO_VAL[c1.rank], v2 = RANK_TO_VAL[c2.rank];
  const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  let score = 0;
  if (hi >= 12) score += 1.0;
  if (lo >= 11) score += 0.7;
  else if (lo >= 10) score += 0.5;
  if (v1 === v2) { score += 0.9; if (hi >= 10) score += 0.1; }
  if (c1.suit === c2.suit) score += 0.25;
  const gap = Math.abs(v1 - v2);
  if (gap === 1) score += 0.15;
  else if (gap === 2) score += 0.07;
  const maxScore = 3.0, base = 0.05;
  return Math.min(1, base + (score / maxScore) * (1 - base));
}
function drawBiasedOpponentHand(deck) {
  const maxTries = 200;
  for (let tries = 0; tries < maxTries; tries++) {
    const i = Math.floor(Math.random() * deck.length);
    let j = Math.floor(Math.random() * deck.length);
    if (j === i) continue;
    const c1 = deck[i], c2 = deck[j];
    if (Math.random() <= preflopWeight(c1, c2)) {
      const hi = Math.max(i, j), lo = Math.min(i, j);
      const second = deck.splice(hi, 1)[0];
      const first = deck.splice(lo, 1)[0];
      return [first, second];
    }
  }
  return [popRandomCard(deck), popRandomCard(deck)];
}
function stageFromBoard(board) {
  if (!board || board.length === 0) return "preflop";
  if (board.length === 3) return "flop";
  if (board.length === 4) return "turn";
  return "river";
}
function villainConnected(hole, boardAtStreet) {
  const all = [...hole, ...boardAtStreet];
  const suitCounts = {}; all.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1; });
  const hasFD = Object.values(suitCounts).some(v => v === 4);

  const byRankBoard = {}; boardAtStreet.forEach(c => { byRankBoard[c.rank] = (byRankBoard[c.rank] ?? 0) + 1; });
  const pairWithBoard =
    (byRankBoard[hole[0].rank] > 0) ||
    (byRankBoard[hole[1].rank] > 0) ||
    (hole[0].rank === hole[1].rank);

  const RVAL = c => RANK_TO_VAL[c.rank];
  const vals = new Set(all.map(RVAL)); if (vals.has(14)) vals.add(1);
  let oesd = false;
  for (let start = 1; start <= 10; start++) {
    const w = [start,start+1,start+2,start+3,start+4];
    const present = w.map(v => vals.has(v));
    const cnt = present.filter(Boolean).length;
    if (cnt === 4 && (present[0] === false || present[4] === false)) { oesd = true; break; }
    if (cnt >= 5) break;
  }
  return pairWithBoard || hasFD || oesd;
}
function sampleShowdownOpponents(baselineCount, board, maybeOppHands, maybeDeck) {
  const stage = stageFromBoard(board);
  const rates = SETTINGS.sim.continueRate;

  const oppHands = maybeOppHands || [];
  const deck = maybeDeck;

  function effectiveKeepProbFor(opIdx, street) {
    let p = rates[street];
    if (SETTINGS.sim.rangeAwareContinuation && oppHands[opIdx] && deck) {
      const boardAtStreet =
        street === 'flop' ? (board.length >= 3 ? board.slice(0,3) : [deck[0], deck[1], deck[2]]) :
        street === 'turn' ? (board.length >= 4 ? board.slice(0,4) : (board.length === 3 ? [...board, deck[0]] : [])) :
        street === 'river' ? (board.length >= 5 ? board.slice(0,5) : (board.length === 4 ? [...board, deck[0]] : [])) :
        [];
      if (boardAtStreet.length >= 3) {
        const connected = villainConnected(oppHands[opIdx], boardAtStreet);
        if (connected) p = Math.min(0.95, p + 0.25);
      }
    }
    return Math.max(0, Math.min(1, p));
  }

  const survivors = [];
  for (let i = 0; i < baselineCount; i++) {
    let alive = true;
    if (stage === 'preflop') {
      alive = (Math.random() < effectiveKeepProbFor(i,'flop')) &&
              (Math.random() < effectiveKeepProbFor(i,'turn')) &&
              (Math.random() < effectiveKeepProbFor(i,'river'));
    } else if (stage === 'flop') {
      alive = (Math.random() < effectiveKeepProbFor(i,'turn')) &&
              (Math.random() < effectiveKeepProbFor(i,'river'));
    } else if (stage === 'turn') {
      alive = (Math.random() < effectiveKeepProbFor(i,'river'));
    } else {
      alive = true;
    }
    if (alive) survivors.push(i);
  }
  while (survivors.length < SETTINGS.sim.minShowdownOpponents && survivors.length < baselineCount) {
    const cand = survivors.length;
    if (!survivors.includes(cand)) survivors.push(cand);
  }
  return survivors;
}
/** Monte‑Carlo equity with survival to showdown and per‑street trials. */
function computeEquityStats(hole, board) {
  const stage = stageFromBoard(board);
  const trials = SETTINGS.trialsByStage[stage] ?? 4000;
  const BASE_OPP = SETTINGS.sim.playersBaseline;

  let wins=0, ties=0, losses=0;
  let equityAcc = 0;
  const catCount = new Map();

  for (let t = 0; t < trials; t++) {
    const simDeck = createDeck().filter(c => !containsCard(hole,c) && !containsCard(board,c));
    const opponents = [];
    for (let i = 0; i < BASE_OPP; i++) opponents.push(drawBiasedOpponentHand(simDeck));

    const survivorsIdx = sampleShowdownOpponents(BASE_OPP, board, opponents, simDeck);
    const survivors = survivorsIdx.map(i => opponents[i]);
    if (survivors.length === 0 && BASE_OPP > 0) {
      survivors.push(opponents[0]);
    }

    const need = 5 - board.length;
    const simBoard = [...board];
    for (let i = 0; i < need; i++) simBoard.push(popRandomCard(simDeck));

    const heroScore = evaluate7(hole, simBoard);
    let better = 0, equal = 0;
    for (let i = 0; i < survivors.length; i++) {
      const villainScore = evaluate7(survivors[i], simBoard);
      const cmp = compareScores(heroScore, villainScore);
      if (cmp < 0) better++;
      else if (cmp === 0) equal++;
    }
    if (better > 0) { losses++; }
    else if (equal > 0) { ties++; equityAcc += 1/(equal+1); }
    else { wins++; equityAcc += 1; }

    const cat = CAT_NAME[heroScore.cat];
    catCount.set(cat, (catCount.get(cat) ?? 0) + 1);
  }

  const winPct = (wins/trials)*100, tiePct = (ties/trials)*100, losePct = (losses/trials)*100;
  const equity = (equityAcc/trials)*100;

  const catBreakdown = [];
  for (const [k,v] of catCount.entries()) { catBreakdown.push({ name:k, pct:(v/trials)*100 }); }
  const catOrder = ['Straight Flush','Four of a Kind','Full House','Flush','Straight','Three of a Kind','Two Pair','One Pair','High Card'];
  catBreakdown.sort((a,b)=>{ const oi = catOrder.indexOf(a.name) - catOrder.indexOf(b.name); return oi !== 0 ? oi : b.pct - a.pct; });

  return { equity, winPct, tiePct, losePct, trials, catBreakdown, numOpp: Math.max(1, SETTINGS.sim.playersBaseline) };
}

// ====== Scoring ======
function bandForError(error) {
  const absErr = Math.abs(error);
  if (absErr <= 5) return "green";
  if (absErr <= 12) return "amber";
  return "red";
}
function decisionBand(equity, potOdds, decision) {
  const diff = equity - potOdds;
  const margin = 4;
  let correctDecision;
  if (diff > margin) { correctDecision = (decision === "call" || decision === "raise"); }
  else if (diff < -margin) { correctDecision = (decision === "fold"); }
  else { return "amber"; }
  return correctDecision ? "green" : "red";
}

// ====== Hand flow ======
function startNewHand() {
  summaryPanel.style.display = "none";
  feedbackEl.innerHTML = "";
  hintsEl.textContent = "";
  inputForm.reset();
  handHistory = [];

  submitStageBtn.classList.remove("hidden");
  nextStageBtn.classList.add("hidden");
  if (barSubmit) barSubmit.classList.remove("hidden");
  if (barNext) barNext.classList.add("hidden");

  deck = createDeck();
  shuffle(deck);
  holeCards = [dealCard(), dealCard()];
  boardCards = [];

  const blinds = 15;
  const increments = [5, 10];
  let extra = 0;
  const maxExtra = 100;
  while (extra < maxExtra) {
    const inc = increments[Math.floor(Math.random() * increments.length)];
    if (extra + inc > maxExtra) break;
    extra += inc;
    if (Math.random() < 0.3) break;
  }
  pot = toStep5(blinds + extra);
  toCall = toStep5(10);
  currentStageIndex = 0;
  scenario = { label: "Preflop", potFactor: 0 };

  renderCards();
  updatePotInfo();
  updateHintsImmediate();
  maybeStartTimer();
}
function advanceStage() {
  currentStageIndex++;
  feedbackEl.innerHTML = "";
  inputForm.reset();
  hintsEl.textContent = "";

  submitStageBtn.classList.remove("hidden");
  nextStageBtn.classList.add("hidden");
  if (barSubmit) barSubmit.classList.remove("hidden");
  if (barNext) barNext.classList.add("hidden");

  if (currentStageIndex >= STAGES.length) { endHand(); return; }
  const stage = STAGES[currentStageIndex];

  if (stage === "flop") { boardCards.push(dealCard(), dealCard(), dealCard()); }
  else if (stage === "turn" || stage === "river") { boardCards.push(dealCard()); }

  scenario = randomScenario();
  const { bet, newPot } = computeRoundedBetAndPot(pot, scenario.potFactor);
  toCall = bet;
  pot = newPot;

  renderCards();
  updatePotInfo();
  updateHintsImmediate();
  maybeStartTimer();
}
function endHand() {
  clearTimer();
  showSummary();
  sessionHistory.push(...handHistory);
  saveSessionHistory();
  updateSessionStats();
}

// ====== Form handling ======
inputForm.addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimer();

  const equityInput = parseFloat(document.getElementById("equityInput").value);
  const potOddsInput = parseFloat(document.getElementById("potOddsInput").value);

  // Prefer unified panel values if present
  const fd = new FormData(inputForm);
  let decision = fd.get("decision"); // legacy radios (may be hidden)

  const unifiedDecisionEl = document.getElementById('decisionUnified');
  const unifiedPctEl      = document.getElementById('betPctUnified');
  const unifiedBucketEl   = document.getElementById('betBucketUnified');

  if (unifiedDecisionEl && unifiedDecisionEl.value) {
    // 'fold' | 'check' | 'call' | 'bet' | 'raise'
    decision = unifiedDecisionEl.value;
  }
  const unifiedBetPct    = (unifiedPctEl && unifiedPctEl.value !== '') ? parseFloat(unifiedPctEl.value) : null;
  const unifiedBetBucket = (unifiedBucketEl && unifiedBucketEl.value) ? unifiedBucketEl.value : null;

  const equityStats = computeEquityStats(holeCards, boardCards);
  const actualEquity = equityStats.equity;
  const actualPotOdds = computePotOdds(pot, toCall);

  const equityError = equityInput - actualEquity;
  const potOddsError = potOddsInput - actualPotOdds;
  const equityBand = bandForError(equityError);
  const potOddsBand = bandForError(potOddsError);
  const decisionBandResult = decisionBand(actualEquity, actualPotOdds, decision);

  estimateOuts(holeCards, boardCards); // ensure texture computed
  updateHintsImmediate();

  feedbackEl.innerHTML = `
    <div>
      <div><strong>Actual equity:</strong> ${actualEquity.toFixed(1)}%
        <span class="badge ${equityBand}">Equity ${equityBand}</span>
      </div>
      <div><strong>Actual pot odds:</strong> ${actualPotOdds.toFixed(1)}%
        <span class="badge ${potOddsBand}">Pot odds ${potOddsBand}</span>
      </div>
      <div><strong>Decision quality:</strong>
        <span class="badge ${decisionBandResult}">${decisionBandResult.toUpperCase()}</span>
      </div>
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

  const stage = STAGES[currentStageIndex];
  const timeUsed = difficulty === "beginner" ? null : timerSeconds - (timeLeft ?? timerSeconds);

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
    handTypes: equityStats.catBreakdown.slice(0,3),

    // NEW (unified betting) — these can be null/undefined safely
    betPctUnified: unifiedBetPct,
    betBucketUnified: unifiedBetBucket
  });

  // Pot accumulation based on hero action
  if (SETTINGS.pot.addHeroCallBetweenStreets) {
    if (decision === "call" || (decision === "raise" && SETTINGS.pot.treatRaiseAsCall)) {
      pot = toStep5(pot + toCall);
      toCall = 0;
      updatePotInfo();
    } else if (decision === "fold" && SETTINGS.pot.endHandOnFold) {
      endHand();
      return;
    }
  }

  submitStageBtn.classList.add("hidden");
  nextStageBtn.classList.remove("hidden");
  if (barSubmit) barSubmit.classList.add("hidden");
  if (barNext) barNext.classList.remove("hidden");
});

nextStageBtn.addEventListener("click", () => { advanceStage(); });

// Bottom bar mirrors
if (barSubmit) barSubmit.addEventListener("click", () => { inputForm.requestSubmit(); });
if (barNext) barNext.addEventListener("click", () => { advanceStage(); });

// Stepper controls for number inputs
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

// ====== Summary & session ======
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

    html += `
      <div class="summary-row">
        <strong>${h.stage.toUpperCase()}</strong><br/>
        Equity: you ${h.equityInput.toFixed(1)}%, actual ${h.equityActual.toFixed(1)}% (err ${eqErr.toFixed(1)}%)<br/>
        Pot odds: you ${h.potOddsInput.toFixed(1)}%, actual ${h.potOddsActual.toFixed(1)}% (err ${potErr.toFixed(1)}%)<br/>
        Decision: ${h.decision.toUpperCase()} <span class="badge ${h.decisionBand}">${h.decisionBand}</span><br/>
        ${h.handTypes && h.handTypes.length ? `<em>Common finishing hands:</em> ${h.handTypes.map(x=>`${x.name} ${x.pct.toFixed(1)}%`).join(' · ')}` : ''}
      </div>
      <hr/>
    `;
  });

  const n = handHistory.length || 1;
  const avgEqErr = totalEquityErr / n;
  const avgPotErr = totalPotErr / n;
  const decisionAcc = (decisionGreen / n) * 100;

  html = `
    <p><strong>Average equity error:</strong> ${avgEqErr.toFixed(1)}%</p>
    <p><strong>Average pot odds error:</strong> ${avgPotErr.toFixed(1)}%</p>
    <p><strong>Decision accuracy (green only):</strong> ${decisionAcc.toFixed(1)}%</p>
    <p style="color:#95a5a6">Method: Monte–Carlo simulation with baseline population and street-by-street continuation; full 7‑card evaluation; ties share the pot.</p>
    <hr/>
  ` + html;

  summaryContent.innerHTML = html;
  summaryPanel.style.display = "block";
}
function updateSessionStats() {
  if (sessionHistory.length === 0) { sessionStatsEl.textContent = "No hands played yet."; return; }

  let totalEqErr = 0; let totalPotErr = 0; let greens = 0;
  sessionHistory.forEach((h) => {
    totalEqErr += Math.abs(h.equityInput - h.equityActual);
    totalPotErr += Math.abs(h.potOddsInput - h.potOddsActual);
    if (h.decisionBand === "green") greens++;
  });

  const n = sessionHistory.length;
  const avgEq = totalEqErr / n; const avgPot = totalPotErr / n; const acc = (greens / n) * 100;
  sessionStatsEl.textContent = `Session – stages: ${n}, avg equity err: ${avgEq.toFixed(1)}%, avg pot err: ${avgPot.toFixed(1)}%, decision green: ${acc.toFixed(1)}%`;
}

// ====== LocalStorage, CSV & Reset ======
const STORAGE_KEY = "poker_equity_trainer_history";
function saveSessionHistory() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionHistory)); } catch(e){ console.warn("Could not save history", e);} }
function loadSessionHistory() { try { const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return; sessionHistory = JSON.parse(raw); } catch(e){ console.warn("Could not load history", e);} }
function clearSessionHistory() {
  if (!confirm("Reset all saved statistics for this device/session?")) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) { console.warn("Could not clear history", e); }
  sessionHistory = [];
  updateSessionStats();
  summaryPanel.style.display = "none";
  feedbackEl.innerHTML = "";
  hintsEl.textContent = "";
}
function downloadCsv() {
  if (!sessionHistory || sessionHistory.length === 0) return;

  // --- CSV columns (legacy first, then new unified-betting fields) ---
  const headers = [
    // Legacy
    "stage",
    "equityInput",
    "equityActual",
    "potOddsInput",
    "potOddsActual",
    "decision",
    "equityBand",
    "potOddsBand",
    "decisionBand",
    "timeUsed",

    // --- New columns for unified betting / position / KPIs (optional placeholders) ---
    "position",
    "preflopInRange",
    "cbetAttempted",
    "cbetOk",
    "wasBarrelTurn",
    "barrelOkTurn",
    "wasBarrelRiver",
    "barrelOkRiver",
    "sizeBucket",
    "sizeOk",

    // numeric % of pot if present
    "betPctUnified"
  ];

  const rows = [headers.join(",")];

  sessionHistory.forEach((h) => {
    const legacy = [
      h.stage ?? "",
      safeFixed(h.equityInput, 2),
      safeFixed(h.equityActual, 2),
      safeFixed(h.potOddsInput, 2),
      safeFixed(h.potOddsActual, 2),
      h.decision ?? "",
      h.equityBand ?? "",
      h.potOddsBand ?? "",
      h.decisionBand ?? "",
      h.timeUsed == null ? "" : safeFixed(h.timeUsed, 2)
    ];

    const unified = [
      h.position ?? "",
      boolToCsv(h.preflopInRange),
      boolToCsv(h.cbetAttempted),
      h.cbetOk ?? "",
      boolToCsv(h.wasBarrelTurn),
      h.barrelOkTurn ?? "",
      boolToCsv(h.wasBarrelRiver),
      h.barrelOkRiver ?? "",
      h.sizeBucket ?? "",
      h.sizeOk ?? "",
      h.betPctUnified == null ? "" : String(h.betPctUnified)
    ];

    rows.push([...legacy, ...unified].join(","));
  });

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "poker_equity_trainer_history.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  function safeFixed(v, n) {
    const num = Number(v);
    return Number.isFinite(num) ? num.toFixed(n) : "";
  }
  function boolToCsv(v) {
    return v == null ? "" : (v ? "true" : "false");
  }
}

// ====== SETTINGS PANEL ======
function createSettingsPanel() {
  const btn = document.createElement("button");
  btn.id = "settingsBtn";
  btn.textContent = "⚙︎ Settings";
  btn.className = "btn";
  newHandBtn.parentNode.insertBefore(btn, newHandBtn.nextSibling);

  const panel = document.createElement("div");
  panel.id = "settingsPanel";
  panel.style.cssText = "position:fixed;right:20px;top:80px;z-index:9999;background:#1f2937;color:#ecf0f1;border:1px solid #374151;border-radius:8px;padding:12px;min-width:320px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:600">Trainer Settings</div>
      <button id="closeSettings" class="btn">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label>Baseline opponents</label>
      <input type="number" id="set_playersBaseline" min="1" max="5" value="${SETTINGS.sim.playersBaseline}"/>

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

      <label>Add hero call to pot</label>
      <input type="checkbox" id="set_addCall" ${SETTINGS.pot.addHeroCallBetweenStreets ? 'checked' : ''}/>

      <label>End hand on fold</label>
      <input type="checkbox" id="set_endOnFold" ${SETTINGS.pot.endHandOnFold ? 'checked' : ''}/>
    </div>

    <!-- ===== HELP / HOW IT WORKS (full guide) ===== -->
    <details class="help-section" open>
      <summary>📘 How the Trainer Works (Full Guide)</summary>
      <div class="help-body">
        <!-- (Guide content unchanged from your original) -->
      </div>
    </details>
  `;

  document.body.appendChild(panel);

  btn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  panel.querySelector("#closeSettings").addEventListener("click", () => { panel.style.display = "none"; });

  function applyQualityPreset(presetName) {
    const preset = TRIALS_PRESETS[presetName];
    if (!preset) return;
    SETTINGS.trialsByStage = { ...preset };
    panel.querySelector("#set_trials_pre").value = SETTINGS.trialsByStage.preflop;
    panel.querySelector("#set_trials_flop").value = SETTINGS.trialsByStage.flop;
    panel.querySelector("#set_trials_turn").value = SETTINGS.trialsByStage.turn;
    panel.querySelector("#set_trials_riv").value = SETTINGS.trialsByStage.river;
  }

  panel.querySelector("#applySettings")?.addEventListener("click", () => {
    SETTINGS.sim.playersBaseline = Math.max(1, Math.min(5, parseInt(panel.querySelector("#set_playersBaseline").value, 10) || 4));
    SETTINGS.sim.continueRate.flop  = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateFlop").value)  || 65) / 100)));
    SETTINGS.sim.continueRate.turn  = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateTurn").value)  || 55) / 100)));
    SETTINGS.sim.continueRate.river = Math.max(0, Math.min(1, ((parseFloat(panel.querySelector("#set_rateRiver").value) || 45) / 100)));

    SETTINGS.sim.rangeAwareContinuation = !!panel.querySelector("#set_rangeAware").checked;

    const chosen = panel.querySelector("#set_quality").value;
    SETTINGS.simQualityPreset = chosen;

    if (chosen !== 'Custom') applyQualityPreset(chosen);
    if (chosen === 'Custom') {
      SETTINGS.trialsByStage.preflop = Math.max(500, parseInt(panel.querySelector("#set_trials_pre").value, 10) || 4000);
      SETTINGS.trialsByStage.flop    = Math.max(500, parseInt(panel.querySelector("#set_trials_flop").value, 10) || 6000);
      SETTINGS.trialsByStage.turn    = Math.max(500, parseInt(panel.querySelector("#set_trials_turn").value, 10) || 8000);
      SETTINGS.trialsByStage.river   = Math.max(500, parseInt(panel.querySelector("#set_trials_riv").value, 10) || 12000);
    } else {
      applyQualityPreset(chosen);
    }

    SETTINGS.pot.addHeroCallBetweenStreets = !!panel.querySelector("#set_addCall").checked;
    SETTINGS.pot.endHandOnFold = !!panel.querySelector("#set_endOnFold").checked;

    btn.textContent = "⚙︎ Settings ✓";
    setTimeout(()=>btn.textContent="⚙︎ Settings", 1200);
  });
}

// ====== Event wiring ======
difficultySelect.addEventListener("change", () => {
  difficulty = difficultySelect.value;

  // Always reset and restart timer behaviour on difficulty change
  clearTimer();
  if (difficulty === "beginner") {
    timerRange.disabled = true;
    if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
    if (kpiTimerEl) kpiTimerEl.textContent = "Time: —";
  } else {
    timerRange.disabled = false;
    timerSeconds = parseInt(timerRange.value, 10) || 10;
    timerValueEl.textContent = timerSeconds;
    startTimer();
  }
  updatePotInfo(); // refresh KPI chips
  updateHintsImmediate();
});
timerRange.addEventListener("input", () => { timerSeconds = parseInt(timerRange.value, 10); timerValueEl.textContent = timerSeconds; });
newHandBtn.addEventListener("click", () => { startNewHand(); });
downloadCsvBtn.addEventListener("click", () => { downloadCsv(); });
closeSummaryBtn.addEventListener("click", () => { summaryPanel.style.display = "none"; });
resetStatsBtn.addEventListener("click", () => { clearSessionHistory(); });

// ====== Init ======
(function init(){
  loadSessionHistory();
  updateSessionStats();

  timerSeconds = parseInt(timerRange.value, 10);
  timerValueEl.textContent = timerSeconds;
  difficulty = difficultySelect.value;
  timerRange.disabled = true;
  if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
  createSettingsPanel();

  // Optional: relax legacy radios to avoid HTML5 validation conflicts
  document.querySelectorAll('.segmented input[name="decision"]').forEach(r => {
    r.removeAttribute('required');
  });
})();

// ====== Expose helpers for unified panel preview ======
window.computeRoundedBetAndPot = computeRoundedBetAndPot;
window.computePotOdds = computePotOdds;