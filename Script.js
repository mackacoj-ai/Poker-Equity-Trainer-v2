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

// ===== RANGES BOOTSTRAP =====
// Ensure RANGES_JSON is present in memory at app start by reading Local Storage.
// Safe to run multiple times (no-op if already set).
(function bootstrapRanges(){
  try {
    if (!window.RANGES_JSON) {
      const raw = localStorage.getItem('trainer_ranges_json_v1');
      if (raw) window.RANGES_JSON = JSON.parse(raw);
    }
  } catch(e){}
})();

// ==================== Load Ranges (from local JSON file) ====================
async function loadRangesFromFile() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';

    input.onchange = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const parsed = JSON.parse(text);

          localStorage.setItem('trainer_ranges_json_v1', JSON.stringify(parsed));
          window.RANGES_JSON = parsed;

          alert("Ranges JSON loaded successfully.\nStart a new hand to apply it.");
        } catch (err) {
          alert("Invalid JSON file.");
        }
      };

      reader.readAsText(file);
    };

    input.click();
  } catch (err) {
    console.error("Failed to load ranges JSON:", err);
    alert("Could not load ranges JSON.");
  }
}

// THIS LINE publishes the function to the browser global scope:
window.loadRangesFromFile = loadRangesFromFile;

// ===== Preflop Debug Toggle (console controllable) =====
window.DEBUG_PREFLOP = false;
window.enablePreflopDebug = () => { window.DEBUG_PREFLOP = true;  console.log('%cPreflop debug ON','background:#1f2937;color:#fff;padding:2px 6px;border-radius:4px'); };
window.disablePreflopDebug = () => { window.DEBUG_PREFLOP = false; console.log('%cPreflop debug OFF','background:#1f2937;color:#fff;padding:2px 6px;border-radius:4px'); };


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
function updateHeroPreflop(decision, toCall){
  // VPIP if hero voluntarily calls or raises
  if (decision === 'call' || decision === 'raise') HERO_STATS.vpip++;

  // If hero raises with no price to call → PFR; if raises facing a price → 3-bet
  if (decision === 'raise') {
    if (toCall > 0) HERO_STATS.threeBet++;
    else HERO_STATS.pfr++;
  }
}

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

// === Rank ordering for hand-code generation ===
const RANKS_ASC = ["A","K","Q","J","T","9","8","7","6","5","4","3","2"];
const RANK_INDEX = Object.fromEntries(RANKS_ASC.map((r, i) => [r, i]));

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
  const stageValue = STAGES?.[currentStageIndex] ?? "";
  const stageName = stageValue ? stageValue.toUpperCase() : "—";
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

// ========== MODULE 4 — Showdown Evaluator ==========

// Compare two describeMadeHand() results
// Returns:
//   1  if hero wins
//   -1 if villain wins
//   0  if tie
function compareMadeHands(heroMade, villainMade) {
    // First compare hand category (0=high card, 1=pair, ..., 8=straight flush)
    if (heroMade.cat > villainMade.cat) return 1;
    if (heroMade.cat < villainMade.cat) return -1;

    // Same category → compare rank arrays (e.g. [A,K,7], kicker order)
    const hRank = heroMade.ranks || [];
    const vRank = villainMade.ranks || [];
    const len = Math.max(hRank.length, vRank.length);

    for (let i = 0; i < len; i++) {
        const hr = RANK_INDEX[hRank[i]] ?? -1;
        const vr = RANK_INDEX[vRank[i]] ?? -1;
        if (hr > vr) return 1;
        if (hr < vr) return -1;
    }

    return 0; // Perfect tie
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
    },

villainRange: {
    preflop: 100,   // 100% of range before flop
    flop:    100,   // will compress after villain folds/calls/bets
    turn:    100,
    river:   100
},

};

function updateVillainRange(stage, actionType) {
    // Safety: if stage invalid, do nothing
    if (!ENGINE.villainRange) return;

    const rng = ENGINE.villainRange;

    // Normalize stage names
    const st = stage.toLowerCase();  // 'flop', 'turn', 'river'

    // Start with previous street value
    // (Flop compresses from preflop, turn compresses from flop, etc.)
    let prev = 100;
    if (st === "flop")  prev = rng.preflop;
    if (st === "turn")  prev = rng.flop;
    if (st === "river") prev = rng.turn;

    let next = prev;  // will adjust below


    // ============================
    // FLOP RANGE UPDATES
    // ============================
    if (st === "flop") {

        if (actionType === "fold") next = 0;

        // A flop check barely changes the range — still very wide
        if (actionType === "check") next = prev * 0.90;     // ~10% tighter

        // A flop call removes weak air hands, keeps mid-strength + draws
        if (actionType === "call")  next = prev * 0.70;

        // A flop bet is tighter — representing hands with equity or initiative
        if (actionType === "bet")   next = prev * 0.55;

        // A flop raise is extremely tight (value + semi-bluffs)
        if (actionType === "raise") next = prev * 0.35;
    }


    // ============================
    // TURN RANGE UPDATES
    // ============================
    if (st === "turn") {

        if (actionType === "fold") next = 0;

        // Turn check = capped range
        if (actionType === "check") next = prev * 0.85;

        // Turn call = medium-strength range + draws
        if (actionType === "call")  next = prev * 0.60;

        // Turn bet = stronger top pairs, draws, and bluffs → polarizing
        if (actionType === "bet")   next = prev * 0.45;

        // Turn raise = very polar (strongest value + some bluffs)
        if (actionType === "raise") next = prev * 0.25;
    }


    // ============================
    // RIVER RANGE UPDATES
    // ============================
    if (st === "river") {

        if (actionType === "fold") next = 0;

        // River check = maximally capped — usually calling/bluff-catching hands
        if (actionType === "check") next = prev * 0.75;

        // River call = strong bluff-catchers and medium value
        if (actionType === "call")  next = prev * 0.55;

        // River bet = polarized (nuts + bluffs)
        if (actionType === "bet")   next = prev * 0.40;

        // River raise = insanely polar (nuts or bluff)
        if (actionType === "raise") next = prev * 0.20;
    }


    // Clamp & write values
    next = Math.max(0, Math.min(100, next));

    if (st === "flop")  rng.flop  = next;
    if (st === "turn")  rng.turn  = next;
    if (st === "river") rng.river = next;
}

// === Module 3 Step 4 — Villain range context helpers ===
function rangeLabelFromPct(pct){
  if (pct >= 80) return "wide";
  if (pct >= 55) return "mid-wide";
  if (pct >= 35) return "tight/condensed";
  return "polar/tight";
}

function villainRangeContextLine(stage){
  // stage: 'flop'|'turn'|'river'
  const pct = Math.max(0, Math.min(100, Number(ENGINE?.villainRange?.[stage] ?? 100)));
  const label = rangeLabelFromPct(pct);
  // Short, solver-flavoured line you can append to notes
  const line = `Villain range ≈ ${pct.toFixed(0)}% (${label}).`;
  return { pct, label, line };
}

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
function engineSetPreflopContext(openerSeat, threeBetterSeat, coldCallers, openToBb, threeBetToBb){
  ENGINE.preflop.openerSeat = openerSeat ?? null;
  ENGINE.preflop.threeBetterSeat = threeBetterSeat ?? null;
  ENGINE.preflop.threeBetToBb    = threeBetToBb ?? null;   // <-- REQUIRED
  ENGINE.preflop.coldCallers = Array.isArray(coldCallers) ? coldCallers.slice() : [];
  ENGINE.preflop.openToBb = (openToBb == null ? null : Number(openToBb)); // NEW: opener raise-to (in BB)
  ENGINE.preflop.threeBetToBb = (threeBetToBb == null ? null : Number(threeBetToBb)); // NEW: 3-bet raise-to (in BB)
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

function sampleShowdownOpponents(baselineCount /*, board, maybeOppHands, maybeDeck */){
  // Deterministic: include all baseline opponents; no stochastic continuation.
  // (computeEquityStats() already sizes baselineCount from remaining players.)
  // Clamp to a small, sane, finite integer [0..9] to avoid invalid lengths
 let n = Number.isFinite(baselineCount) ? baselineCount : 0;
 n = Math.floor(Math.max(0, Math.min(9, n)));
 return Array.from({ length: n }, (_, i) => i);

}


function computeEquityStatsLegacy(hole, board, numOppOverride = null){
  const stage = stageFromBoard(board);
  const trials = SETTINGS.trialsByStage[stage] ?? 4000;

  // Use override if provided, otherwise fall back to baseline
  const BASE_OPP = (numOppOverride != null ? Math.max(0, numOppOverride) : SETTINGS.sim.playersBaseline);

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
  return { equity, winPct, tiePct, losePct, trials, catBreakdown, numOpp: Math.max(1, BASE_OPP) }; 
}

// TRAINING MODE: always compute equity vs random opponents,
// but size the field to match how many players are still in.
// We DO NOT look at (or remove) villains' actual hole cards here.
function computeEquityStats(hole, board){
  let numOpp = countOpponentsInPlay(board);  // from engine/discs, not hole cards
  if (numOpp === 0) {
    // For training, keep at least 1 opponent so equities remain meaningful pre-showdown
    numOpp = 1;
  }
  return computeEquityStatsLegacy(hole, board, numOpp);
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

function hasNonEmptySeatBucket(obj, seat) {
  const b = obj?.[seat];
  return b && typeof b === 'object' && Object.keys(b).length > 0;
}

// **** MODIFIED to prefer JSON frequencies when loaded ****

function getClassMapForSeat(seat) {
    // JSON-only. If no JSON for this seat, return null.
    try {
        if (hasNonEmptySeatBucket(RANGES_JSON?.open, seat)) {
            return mapFromFreqBucket(RANGES_JSON.open[seat]);
        }
    } catch (e) {
        /* ignore */
    }

    // No fallback: pure JSON engine.
    return null;
}

// ==================== Preflop Engine v1 (deterministic) ====================
// Uses RANGES_JSON + built-ins to simulate villain actions up to hero's turn.
// Priority: 3-bet > call > fold. Sizing: simple, deterministic (see below).

// ===== Preflop v2 helpers (JSON-frequency aware) =====

// Safe read of frequency from a bucket (0..1), else null
//// REPLACE your jsonFreq() with this upgraded version

//// Add this near the top of preflop code:

function determineOpenerFromHistory(actions) {
    for (const a of actions) {
        if (a.stage === 'preflop' && a.decision === 'raise') {
            return a.seat;
        }
    }
    return null;
}

function freqToAction(freq) {
    if (freq == null) return 'fold';
    if (freq === 0) return 'fold';
    if (freq === 1) return 'pure';
    return 'mix';
}

// Safe read of frequency from a bucket. Accepts 0..1 or 0..100.
function jsonFreq(bucket, code) {
  try {
    if (!bucket) return null;
    const v = bucket[code];
    if (v === undefined || v === null) return null;
    let n = Number(v);
    if (!Number.isFinite(n)) return null;
    // Normalize 0..100% → 0..1
    if (n > 1) n = n / 100;
    return Math.max(0, Math.min(n, 1));
  } catch {
    return null;
  }
}

// ===== CLEAN JSON LOOKUP HELPERS (Preflop Engine v3) =====

// --- OPEN frequencies (RFI) ---
function getJsonOpenFreq(seat, code) {
  try {
    const bucket = RANGES_JSON?.open?.[seat];
    return jsonFreq(bucket, code);
  } catch { return null; }
}

// --- 3‑BET frequencies vs opener ---
function getJsonThreeBetFreq(seat, openerSeat, code) {
  try {
    const key = `${seat}_vs_${openerSeat}`;
    const bucket = RANGES_JSON?.three_bet?.[key];
    return jsonFreq(bucket, code);
  } catch { return null; }
}

// --- CALL frequencies vs opener ---
function getJsonCallFreq(seat, openerSeat, code) {
  try {
    // BB uses defend table
    if (seat === "BB") {
      const key = `BB_vs_${openerSeat}`;
      const bucket = RANGES_JSON?.defend?.[key];
      return jsonFreq(bucket, code);
    }

    // Others use vs_open.<seat>_vs_<opener>.call
    const key = `${seat}_vs_${openerSeat}`;
    const bucket = RANGES_JSON?.vs_open?.[key]?.call;
    return jsonFreq(bucket, code);
  } catch { return null; }
}

// --- Consolidated decision: should this seat CALL? ---
// Returns either a frequency number 0..1 or null
function getJsonCallDecision(seat, openerSeat, code) {
  // BB uses defend table
  if (seat === "BB") {
    const key = `BB_vs_${openerSeat}`;
    try {
      const bucket = RANGES_JSON?.defend?.[key];
      return jsonFreq(bucket, code);
    } catch {
      return null;
    }
  }

  // Non-BB uses vs_open.<Seat>_vs_<Opener>.call table
  try {
    const key = `${seat}_vs_${openerSeat}`;
    const bucket = RANGES_JSON?.vs_open?.[key]?.call;
    return jsonFreq(bucket, code);
  } catch {
    return null;
  }
}

// --- Consolidated decision: should this seat CALL? ---
function jsonCallDecision(seat, openerSeat, code) {
  return getJsonCallFreq(seat, openerSeat, code);
}

// Decide a mixed action with Math.random() once per check
function takeWithFreq(freq) {
  if (freq == null) {
    if (window.DEBUG_PREFLOP) console.log('%c[PF·TAKE] ✖ SKIP (freq=null)','color:#ef4444');
  }
  const roll = Math.random();
  const ok = (freq != null) && (roll <= freq);
  if (window.DEBUG_PREFLOP) {
    console.log(
      '%c[PF·TAKE] ' + (ok ? '✔ TAKE' : '✖ SKIP'),
      ok ? 'color:#22c55e' : 'color:#ef4444',
      { roll: Number(roll.toFixed(4)), freq }
    );
  }
  return ok;
}

// Global Function - Build keys like "HJ_vs_UTG"
function vsKey(seat, opener) {
  return `${seat}_vs_${opener}`;
}

// Compute a raise-to (in chips) from ×BB
function bbToChips(bbMult) {
  const bb = toStep5(BLINDS.bb);
  return toStep5(bbMult * bb);
}

// Record/extend preflop participants safely (unique)
function addPreflopParticipant(seat) {
  const parts = new Set(ENGINE.preflop?.participants || []);
  parts.add(seat);
  ENGINE.preflop.participants = [...parts];
}

// Append a small string to scenario label
function appendScenarioNote(note) {
  try {
    if (!note) return;
    if (!scenario) scenario = { label: note, potFactor: 0 };
    else scenario.label = scenario.label ? `${scenario.label} · ${note}` : note;
  } catch (e) {}
}


// Conservative 4-bet top (Option A)
const STRONG_4B = new Set(['AA', 'KK', 'QQ', 'AKs', 'AKo']);

// Compute a 4-bet raise-to (× of 3-bet size)
function fourBetSizeBb(openerSeat, threeBetterSeat, threeBetToBb) {
  // Simple heuristic: 2.2x–2.5x 3-bet size depending on position
  const ipSeats = new Set(['BTN', 'CO']); // rough IP heuristic
  const openerIP = ipSeats.has(openerSeat) && !ipSeats.has(threeBetterSeat);
  const mult = openerIP ? 2.2 : 2.5;
  return Math.max(3.8 * (ENGINE.preflop?.openToBb || 2.2), mult * threeBetToBb);
}

// Training mode: behind-hero JSON 3-bet hands are flatted (no second hero decision)
const TRAINING_FLAT_3BET_AFTER_HERO = true;

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
  const freq = getJsonOpenFreq(seat, code);
  return freq != null && freq > 0;
}

function inThreeBetBucket(s, openerSeat, code){
    const freq = getJsonThreeBetFreq(s, openerSeat, code);
    return freq !== null && freq > 0;
}

function inCallBucket(seat, openerSeat, code){
    if (seat === 'BB') {
        const freq = getJsonDefendFreqBB(openerSeat, code);
        return freq !== null && freq > 0;
    } else {
        const freq = getJsonCallFreq(seat, openerSeat, code);
        return freq !== null && freq > 0;
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

// ===== PREFLOP ENGINE v3 — VILLAINS BEFORE HERO =====
function runPreflopUpToHero() {
  const heroSeat = currentPosition();
  const sb = toStep5(BLINDS.sb);
  const bb = toStep5(BLINDS.bb);

  let potLocal = sb + bb;
  let toCallLocal = 0;

  let openerSeat = null;
  let openToBb = null;
  let threeBetterSeat = null;
  let threeBetToBb = null;
  const coldCallers = [];

  for (const seat of ACTION_ORDER) {
    if (seat === heroSeat) break; // stop when arriving at hero

    const seatObj = TABLE.seats.find(x => x.seat === seat);
    if (!seatObj || !seatObj.hand) continue;

    const code = handToCode(seatObj.hand);

    // === NO OPEN YET → consider OPEN RANGE ===
    if (!openerSeat) {
      const freqOpen = getJsonOpenFreq(seat, code);
  if (window.DEBUG_PREFLOP) console.log('[PF·RFI]', { seat, code, freqOpen }); // [DBG]
      if (takeWithFreq(freqOpen)) {
        openerSeat = seat;
        openToBb = standardOpenSizeBb(seat);
if (window.DEBUG_PREFLOP) console.log('%c[PF] OPENER SET','color:#60a5fa', { openerSeat, openToBb }); // [DBG]
        potLocal = contributeRaiseTo(potLocal, bbToChips(openToBb), seat);
        continue;
      }
      // otherwise fold
      continue;
    }

    // === WE HAVE AN OPENER → consider 3-BET ===
    if (!threeBetterSeat) {
      const freq3 = getJsonThreeBetFreq(seat, openerSeat, code);
      if (window.DEBUG_PREFLOP) console.log('[PF·3BET]', { seat, openerSeat, code, key: `${seat}_vs_${openerSeat}`, freq3 }); // [DBG]
 if (takeWithFreq(freq3)) {
        threeBetterSeat = seat;
        threeBetToBb = threeBetSizeBb(openerSeat, seat, openToBb);
 if (window.DEBUG_PREFLOP) console.log('%c[PF] 3BETTER SET','color:#60a5fa', { threeBetterSeat, threeBetToBb }); // [DBG]
        potLocal = contributeRaiseTo(potLocal, bbToChips(threeBetToBb), seat);
        break; // stop at the 3-bet
      }
    }


// === NO 3-BET → consider CALL ===
    const freqCall = getJsonCallDecision(seat, openerSeat, code);
    const callKey = (seat === 'BB') ? `BB_vs_${openerSeat}` : `${seat}_vs_${openerSeat}`;
    if (window.DEBUG_PREFLOP) console.log('[PF·CALL]', { seat, openerSeat, code, key: callKey, freqCall }); // [DBG]
    if (takeWithFreq(freqCall)) {
      potLocal = contributeCallTo(potLocal, bbToChips(openToBb), seat);
      coldCallers.push(seat);
      continue;
    }

    // else fold
  }

  // Compute the price hero faces
  const heroBlind = (heroSeat === "SB") ? sb : (heroSeat === "BB" ? bb : 0);

  if (!openerSeat) {
    toCallLocal = (heroSeat === "BB") ? 0 : (heroSeat === "SB") ? Math.max(0, bb - sb) : bb;
  } else if (threeBetterSeat) {
    const rTo = bbToChips(threeBetToBb);
    toCallLocal = Math.max(0, rTo - heroBlind);
  } else {
    const rTo = bbToChips(openToBb);
    toCallLocal = Math.max(0, rTo - heroBlind);
  }

 if (window.DEBUG_PREFLOP) console.log('[PF·UPTO·RESULT]', { openerSeat, openToBb, threeBetterSeat, threeBetToBb, coldCallers, toCallLocal }); // [DBG]

  return {
    potLocal,
    toCallLocal,
    openerSeat,
    openToBb,
    threeBetterSeat,
    threeBetToBb,
    coldCallers,
    label:
      (!openerSeat) ? "Unopened Pot"
      : (!threeBetterSeat)
        ? `${openerSeat} opened ${openToBb.toFixed(1)}x`
        : `${openerSeat} opened ${openToBb.toFixed(1)}x · ${threeBetterSeat} 3‑bet ${threeBetToBb.toFixed(1)}x`
  };
}

// ===== PREFLOP ENGINE v3 — VILLAINS AFTER HERO =====
function runPreflopAfterHero(heroDecision) {
  if (STAGES[currentStageIndex] !== "preflop") return;

  const heroSeat = currentPosition();
  const sb = toStep5(BLINDS.sb);
  const bb = toStep5(BLINDS.bb);

  let openerSeat = ENGINE.preflop.openerSeat;
  let threeBetterSeat = ENGINE.preflop.threeBetterSeat;
  let openToBb = ENGINE.preflop.openToBb;
  let threeBetToBb = ENGINE.preflop.threeBetToBb;

  const startIdx = ACTION_ORDER.indexOf(heroSeat);
  const afterHeroSeq = [];
  for (let k = (startIdx + 1) % ACTION_ORDER.length; k !== startIdx; k = (k + 1) % ACTION_ORDER.length) {
    afterHeroSeq.push(ACTION_ORDER[k]);
  }
  const newCallers = [];
  if (window.DEBUG_PREFLOP) console.log('[PF·AFTER] heroDecision=', heroDecision, 'openerSeat=', openerSeat, 'openToBb=', openToBb, 'seq=', afterHeroSeq); // [DBG]

  for (const seat of afterHeroSeq) {
    const seatObj = TABLE.seats.find(x => x.seat === seat);
    if (!seatObj || !seatObj.hand) continue;

    const code = handToCode(seatObj.hand);
    if (window.DEBUG_PREFLOP) console.log('[PF·AFTER] seat=', seat, 'code=', code); // [DBG]

    // If hero opened & no opener existed previously
    if (!openerSeat && heroDecision === "raise") {
      openerSeat = heroSeat;
      openToBb = heroActions.preflop.sizeBb ?? standardOpenSizeBb(heroSeat);


// FIX: reset stale 3-bet metadata when hero is opener
  threeBetterSeat = null;
    ENGINE.preflop.threeBetterSeat = null;
    ENGINE.preflop.threeBetToBb = null;

      if (window.DEBUG_PREFLOP) console.log('%c[PF] HERO SET AS OPENER','color:#60a5fa', { openerSeat, openToBb }); // [DBG]
    }

    if (openerSeat && !threeBetterSeat) {
      const freq3 = getJsonThreeBetFreq(seat, openerSeat, code);
      if (window.DEBUG_PREFLOP) console.log('[PF·AFTER·3BET]', { seat, openerSeat, code, key:`${seat}_vs_${openerSeat}`, freq3 }); // [DBG]
      if (takeWithFreq(freq3)) {
        threeBetterSeat = seat;
        threeBetToBb = threeBetSizeBb(openerSeat, seat, openToBb);
        pot = contributeRaiseTo(pot, bbToChips(threeBetToBb), seat);
        if (window.DEBUG_PREFLOP) console.log('%c[PF] 3BET TAKEN','color:#60a5fa', { threeBetterSeat, threeBetToBb }); // [DBG]
        newCallers.push(seat); // just a visual tag in your code
        continue;
      }

      const freqCall = getJsonCallDecision(seat, openerSeat, code);
      const callKey = (seat === 'BB') ? `BB_vs_${openerSeat}` : `${seat}_vs_${openerSeat}`;
      if (window.DEBUG_PREFLOP) console.log('[PF·AFTER·CALL]', { seat, openerSeat, code, key:callKey, freqCall }); // [DBG]
      if (takeWithFreq(freqCall)) {
        pot = contributeCallTo(pot, bbToChips(openToBb), seat);
        newCallers.push(seat);
        if (window.DEBUG_PREFLOP) console.log('%c[PF] CALL TAKEN','color:#22c55e', { seat }); // [DBG]
        continue;
      }

      ENGINE.statusBySeat[seat] = "folded_now";
      if (window.DEBUG_PREFLOP) console.log('%c[PF] FOLD','color:#ef4444', { seat }); // [DBG]
      continue;
    }

    // Facing hero 3-bet (hero as 3-bettor)
    if (threeBetterSeat && heroSeat === threeBetterSeat) {
      const freqCall = getJsonCallDecision(seat, openerSeat, code);
      const callKey = (seat === 'BB') ? `BB_vs_${openerSeat}` : `${seat}_vs_${openerSeat}`;
      if (window.DEBUG_PREFLOP) console.log('[PF·AFTER·CALLvs3B]', { seat, openerSeat, code, key:callKey, freqCall }); // [DBG]
      if (takeWithFreq(freqCall)) {
        pot = contributeCallTo(pot, bbToChips(threeBetToBb), seat);
        newCallers.push(seat);
        if (window.DEBUG_PREFLOP) console.log('%c[PF] CALL vs 3B TAKEN','color:#22c55e', { seat }); // [DBG]
        continue;
      }
      ENGINE.statusBySeat[seat] = "folded_now";
      if (window.DEBUG_PREFLOP) console.log('%c[PF] FOLD vs 3B','color:#ef4444', { seat }); // [DBG]
    }
  }

  toCall = 0;
  ENGINE.preflop.openerSeat = openerSeat;
  ENGINE.preflop.threeBetterSeat = threeBetterSeat;
  ENGINE.preflop.openToBb = openToBb;
  ENGINE.preflop.threeBetToBb = threeBetToBb;

  ENGINE.preflop.participants = Array.from(
    new Set([
      ...(ENGINE.preflop.participants ?? []),
      openerSeat,
      threeBetterSeat,
      heroSeat,
      ...newCallers
    ].filter(Boolean))
  );

  if (window.DEBUG_PREFLOP) console.log('[PF·AFTER·RESULT]', {
    openerSeat, openToBb, threeBetterSeat, threeBetToBb,
    newCallers, participants: ENGINE.preflop.participants
  }); // [DBG]

  updatePotInfo();
  renderPositionStatusRow();
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
function classifyHeroPreflopBadge(){
  const seat = currentPosition();
  const code = heroHandCode();
  const opener = ENGINE.preflop?.openerSeat ?? null; // set in startNewHand() via engineSetPreflopContext(...)
 const threeBetter = ENGINE.preflop?.threeBetterSeat ?? null;
 
 // --- 1) Unopened pot -> use Open ranges for hero seat ---
  if (!opener) {
    // Prefer JSON open
    try {
      const bucket = RANGES_JSON?.open?.[seat];
      if (bucket && bucket[code] != null) {
        const cls = freqToClass(bucket[code]); // 'open' | 'mix' | 'fold'
        if (cls === 'open')  return { kind:'Open', band:'green', src:'JSON' };
        if (cls === 'mix')   return { kind:'Open', band:'amber', src:'JSON' };
        return { kind:'Fold', band:'red', src:'JSON' };
      }
    } catch(e){/* fallback below */}
   
// No JSON → automatically fold
return { kind:'Fold', band:'red', src:'JSON-missing' };

  // Conservative fallback (safe default): only top value hands 4-bet; everything else folds.
  const strong4b = new Set(['AA','KK','QQ','AKs','AKo']);
  if (strong4b.has(code)) return { kind:'4-Bet', band:'green', src:'FALLBACK' };
  return { kind:'Fold', band:'red', src:'FALLBACK' };
}

  // --- 2) Facing an open -> prefer 3-bet if available, else Call, else Fold ---
  // 2a) JSON 3-bet
  try {

   const key3 = vsKey(seat, opener);
   const tb = RANGES_JSON?.three_bet?.[key3];
    if (tb && tb[code] != null) {
      const cls = freqToClass(tb[code]);
      if (cls === 'open') return { kind:'3-Bet', band:'green', src:'JSON' };
      if (cls === 'mix')  return { kind:'3-Bet', band:'amber', src:'JSON' };
    }
  } catch(e){/* fallback next */}

  // 2b) JSON Call (BB uses defend.BB_vs_<opener>; others use vs_open.<seat>_vs_<opener>.call)
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
   
      const keyVs = vsKey(seat, opener);
      const callObj = RANGES_JSON?.vs_open?.[keyVs]?.call;
      if (callObj && callObj[code] != null) {
        const cls = freqToClass(callObj[code]);
        if (cls === 'open') return { kind:'Call', band:'green', src:'JSON' };
        if (cls === 'mix')  return { kind:'Call', band:'amber', src:'JSON' };
      }
    }
  } catch(e){/* fallback next */}

  // 2c) HYBRID fallbacks (token lists you already ship)
  try {
    // 3-bet hybrid
    const lists3 = HYBRID_3BET_RANGES?.[seat]?.[opener] ?? null;
    const lm3 = listToClassMap(lists3);
    const cls3 = classFromLists(lm3, code); // 'open'|'mix'|'fold'
    if (cls3 === 'open') return { kind:'3-Bet', band:'green', src:'HYBRID' };
    if (cls3 === 'mix')  return { kind:'3-Bet', band:'amber', src:'HYBRID' };

    // Call hybrid
    const listsCall = HYBRID_DEFEND_RANGES?.[opener] ?? null; // defend maps keyed by opener seat
    const lmC = listToClassMap(listsCall);
    const clsC = classFromLists(lmC, code);
    if (clsC === 'open') return { kind:'Call', band:'green', src:'HYBRID' };
    if (clsC === 'mix')  return { kind:'Call', band:'amber', src:'HYBRID' };
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
    // JSON-only open-range map.
    try {
        if (hasNonEmptySeatBucket(RANGES_JSON?.open, seat)) {
            return mapFromFreqBucket(RANGES_JSON.open[seat]);
        }
    } catch (e) {
        /* ignore */
    }

    // No fallback.
    return null;
}

  // **** JSON preference for 3BET ****
  function classMap3bet(vsSeat) {
    try {
        const key = vsKey(seat, vsSeat);
        const bucket = RANGES_JSON?.three_bet?.[key];
        if (bucket) return mapFromFreqBucket(bucket);
    } catch (e) {
        /* ignore */
    }

    return null;
}

// **** JSON preference for DEFEND / VS‑OPEN ****
// subAction: 'call' | 'three_bet'

function classMapDefend(vsSeat, subAction) {
    // 3‑bet defend → use JSON three_bet
    if (subAction === 'three_bet') {
        return classMap3bet(vsSeat);
    }

    // CALL defend
    // BB uses defend.BB_vs_<opener>
    if (seat === 'BB') {
        try {
            const key = `BB_vs_${vsSeat}`;
            const bucket = RANGES_JSON?.defend?.[key];
            if (bucket) return mapFromFreqBucket(bucket);
        } catch (e) {
            /* ignore */
        }
        return null;
    }

    // Non‑BB calls: vs_open.<Seat>_vs_<opener>.call
    try {
        const key = vsKey(seat, vsSeat);
        const bucket = RANGES_JSON?.vs_open?.[key]?.call;
        if (bucket) return mapFromFreqBucket(bucket);
    } catch (e) {
        /* ignore */
    }

    return null;
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

const sourceLabel = 'JSON';

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
const badgeRec = classifyHeroPreflopBadge(); 

let initialMode = 'open';
let initialDefendSub = 'call';

// If a 3-bet exists, use the three-bettor as the 'vs' seat and pick the 3-bet sub-tab
if (threeBetter) {
  initialMode = 'defend';
  initialDefendSub = 'three_bet';
  if (vsSel) { vsSel.disabled = false; vsSel.value = threeBetter; }
} else if (opener) {
  initialMode = 'defend';
  initialDefendSub = (badgeRec.kind === '3-Bet') ? 'three_bet' : 'call';
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

// === Improved Board → Category mapping (Option A refinement) ===
function mapBoardToCategory(board, hole) {
    const tex = analyzeBoard(board, hole);   // your detailed texture engine
    const ranks = board.map(c => c.rank);

    // ---- 1. Four-to-straight takes absolute priority ----
    if (tex.fourToStraight) {
        return "FOUR_TO_STRAIGHT";
    }

    // ---- 2. Monotone boards (always low-frequency spots) ----
    if (tex.mono) {
        return "MONOTONE";
    }

    // ---- 3. Two-tone dynamic boards (connected OR broadway-heavy) ----
    const suits = new Set(board.map(c => c.suit));
    const twoTone = (board.length >= 3 && suits.size === 2 && !tex.mono);

    if (twoTone && (tex.connected || boardHasManyBroadways(board))) {
        return "TWO_TONE_DYNAMIC";
    }

    // ---- 4. Low paired vs high paired ----
    const pairedRankCounts = {};
    board.forEach(c => pairedRankCounts[c.rank] = (pairedRankCounts[c.rank] ?? 0) + 1);

    const pairedRanks = Object.entries(pairedRankCounts)
        .filter(([, count]) => count >= 2)
        .map(([r]) => r);

    if (pairedRanks.length > 0) {
        const pr = pairedRanks[0]; // only one pair possible on flop
        const order = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
        const idx = order.indexOf(pr);

        // Low paired = <=9
        if (idx <= order.indexOf("9")) return "PAIRED_LOW";

        // High paired = T+
        return "HIGH_PAIR";
    }

    // ---- 5. A-high rainbow dry (solver favourite) ----
    const hasAce = ranks.includes("A");
    const suitsCount = new Set(board.map(c => c.suit)).size;
    const isRainbow = (suitsCount >= 3);

    if (hasAce && isRainbow && !tex.connected && !tex.fourToStraight) {
        return "A_HIGH_RAINBOW";
    }

    // ---- 6. Broadway-heavy (Q-J-T or two+ broadways) ----
    if (boardHasManyBroadways(board)) {
        return "BROADWAY_HEAVY";
    }

    // ---- 7. Default fallback: low disconnected boards ----
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

    //
    // === STEP 1 — Summary bar (Module 2.4) ===
    //
    const summaryHtml = `
      <div style="
        display:flex;
        align-items:center;
        gap:10px;
        padding:8px 0;
        border-bottom:1px solid #3a3f4b;
        margin-bottom:10px;
      ">
        <span class="badge info">Board Category</span>
        <div style="font-weight:700">${g.label}</div>
        <span class="badge blue">${g.freq} frequency</span>
        <span class="badge gray">${fmtSizeRangePct(g.sizes)} sizing</span>
      </div>
    `;

    //
    // === STEP 2 — Category explanation ===
    //
    const explanationHtml = `
      <div style="color:#9aa3b2; margin-bottom:10px; font-size:0.95rem;">
        ${g.note}
      </div>
    `;

    //
    // === Build the headers for size grid ===
    //
    const hdr = ['<div class="hdr"></div>']
      .concat(POSTFLOP_SIZE_PRESETS.map(s => `<div class="hdr">${s}%</div>`))
      .join('');

    //
    // === Grid rows ===
    //
    const freqClass = (pct) => {
        if (g.sizes.includes(pct)) return 'freq-high';
        const near = g.sizes.some(x => Math.abs(x - pct) <= (pct >= 100 ? 25 : 17));
        return near ? 'freq-med' : 'freq-low';
    };

    const cells = POSTFLOP_SIZE_PRESETS.map(pct => {
        const klass = freqClass(pct);

        // === STEP 4 — Improved accessibility tooltips ===
        const aria =
            klass === 'freq-high'
                ? 'High frequency — recommended small bet'
                : klass === 'freq-med'
                ? 'Medium frequency — mixed strategy'
                : 'Low frequency — seldom bet on this texture';

        return `
          <div class="cell ${klass}" title="${aria}" aria-label="${aria}">
            <span class="dot">●</span>
          </div>
        `;
    }).join('');

    //
    // === Write modal HTML (header + explanation + grid) ===
    //
    guideModalBody.innerHTML = `
      ${summaryHtml}
      ${explanationHtml}

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
    `;

    //
    // === STEP 5 — Example Strategy Banner ===
    //
    guideModalBody.insertAdjacentHTML(
      'beforeend',
      `
      <div style="
         margin-top:12px;
         padding:10px;
         background:#1f2937;
         border-radius:6px;
         color:#cdd3dd;
         font-size:0.95rem;
      ">
        <strong>Example Strategy:</strong>
        ${
          g.freq === 'High'
            ? 'Frequent small bets with strong range advantage.'
            : g.freq === 'Med'
            ? 'Mix checks and small/medium bets depending on range interaction.'
            : 'Check most hands; when betting, use larger polarized bets.'
        }
      </div>
      `
    );

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

function evaluateFlopCbet(catKey, isHeroPFR, pos, action, sizePct) {
    const g = CBET_GUIDE[catKey];
    if (!g) {
        return { cbetEval:"n/a", sizeEval:"n/a", note:"No guide available for this texture." };
    }
    if (!isHeroPFR) {
        return { cbetEval:"Not PFR", sizeEval:"n/a", note:"You were not the preflop raiser — flop c‑bet guidance does not apply." };
    }

    const freq = g.freq; // "High"|"Med"|"Low"
    let cbetEval = "Mixed";
    if (freq === "High") cbetEval = (action === "bet") ? "Correct (frequent c‑bet)" : "Missed c‑bet (okay sometimes)";
    else if (freq === "Med") cbetEval = (action === "bet") ? "Good (mixing spot)" : "Okay (mixing spot)";
    else if (freq === "Low") cbetEval = (action === "bet") ? "Risky c‑bet (low‑freq texture)" : "Correct (check more often)";

    const sizeRes = evalSizeAgainstGuide(sizePct, g.sizes);
    const sizeEval = sizeRes.verdict ?? "n/a";
    const sizeNote = sizeRes.detail ?? "";

    const ip = inPositionHeuristic(pos);
    let positionalNote = "";
    if (ip) {
        if (freq === "High" && action === "bet") positionalNote = " You are in position — small, frequent bets perform well.";
        if (freq === "Low"  && action === "bet") positionalNote = " Being in position helps, but this is still a low‑frequency texture.";
    } else {
        if (action === "bet" && freq !== "High") positionalNote = " Out of position → consider more checks or larger, polar bets.";
    }

    // === NEW (M3·S4): Append villain range context (flop) ===
    const rng = villainRangeContextLine("flop");

    let note = `${g.label}: ${g.note}`;
    if (positionalNote) note += ` ${positionalNote}`;
    if (sizeEval !== "n/a") note += ` Size: ${sizeEval}. ${sizeNote}`;
    note += ` ${rng.line}`;

    return {
        cbetEval,
        sizeEval,
        note,
        recFreq: freq,
        recSizes: fmtSizeRangePct(g.sizes),
        // NEW: expose the range numbers (for handHistory / CSV)
        villainRangePct: rng.pct,
        villainRangeLabel: rng.label
    };
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

    // Base frequencies from your existing guide
    let base = isPFR 
        ? (VILLAIN.betFreq[g?.freq ?? "Med"] ?? 0.45)
        : (VILLAIN.probeFreq[g?.freq ?? "Med"] ?? 0.40);

    // === NEW: IP vs OOP adjustment ===
    const heroSeat = currentPosition();
    const VAL = ACTION_ORDER.indexOf(seat);
    const HA = ACTION_ORDER.indexOf(heroSeat);

    const villainIsIP = VAL > HA;
    if (villainIsIP) {
        base += 0.05;   // small IP bump
    } else {
        base -= 0.05;   // small OOP tightening
    }

    // === NEW: Board moisture tuning ===
    const tex = analyzeBoard(board, hole);
    if (tex.moistureBucket === "Wet") base -= 0.10;
    if (tex.moistureBucket === "Semi-wet") base -= 0.05;

    // === NEW: Villain profile tuning ===
    const letter = LETTERS_BY_POSITION?.[seat];
    const persona = SESSION_PERSONA_BY_LETTER?.[letter];

    if (persona === "MANIAC") base += 0.25;
    if (persona === "LAG") base += 0.10;
    if (persona === "STATION") base -= 0.10;
    if (persona === "NIT") base -= 0.15;

// === NEW: Range-tightness adjustment ===
const tightness = ENGINE.villainRange?.[stage] ?? 100;
const rangePressure = (100 - tightness) / 300;
base -= rangePressure;

    // Clamp to safe range
    base = Math.max(0.05, Math.min(0.95, base));

    return base;
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
     
// === Improved raise logic ===
const strength = villainStrengthBucket(hole, boardCards);
const tex = analyzeBoard(boardCards, holeCards);

// Get villain persona for more realistic behaviour
const letter = LETTERS_BY_POSITION?.[seat];
const persona = SESSION_PERSONA_BY_LETTER?.[letter];

// Base chance to raise (from your VILLAIN settings)
let raiseChance = VILLAIN.raiseOverBetFreq;

// Persona adjustments
if (persona === "MANIAC") raiseChance += 0.15;
if (persona === "LAG")    raiseChance += 0.05;
if (persona === "STATION")raiseChance -= 0.05;
if (persona === "NIT")    raiseChance -= 0.10;

// Texture-based caps
if (tex.moistureBucket === "Wet") raiseChance *= 0.50;
if (tex.fourToStraight)           raiseChance *= 0.40;
if (tex.mono)                     raiseChance *= 0.30;

// === NEW: range-tightness dampening ===
const tightness = ENGINE.villainRange?.[stage] ?? 100;
raiseChance -= (100 - tightness) / 250;

// Clamp to safe range
raiseChance = Math.max(0.01, Math.min(0.50, raiseChance));

// FINAL raise decision
const willRaise = Math.random() < raiseChance &&
    (strength === 'strong' || strength === 'draw');

if (willRaise) {
    // Raise-to sizing (not raise increment)
    const pct = Math.max(66, pickVillainSizePct(stage, boardCards, holeCards));
    const raiseTo = Math.max(pendingToCall * 2, toStep5((pct / 100) * pot));
    pendingToCall = raiseTo;

    scenario = { label: `${seat} raises to ${pct}%`, potFactor: 0 };

    continue;   // Continue processing later seats
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

  // Build acting sequence starting after hero, wrapping around to just before hero
  const order = POSTFLOP_ORDER.slice(); // ["SB","BB","UTG","HJ","CO","BTN"]
  const startIdx = order.indexOf(heroSeat);
  if (startIdx < 0) return;

  const seq = [];
  for (let k = (startIdx + 1) % order.length; k !== startIdx; k = (k + 1) % order.length) {
    seq.push(order[k]);
  }
  if (seq.length === 0) return;

  let pendingToCall = 0;

  for (const seat of seq) {
    // Must be alive
    const state = ENGINE.statusBySeat[seat];
    if (state !== "in") continue;

    const hole = seatHand(seat);
    if (!hole) continue;

    const isPFR = (ENGINE.preflop.openerSeat === seat);

    // -------------------------
    // No live price -> probe or check
    // -------------------------
    if (pendingToCall === 0) {
      // Context
      const tex = analyzeBoard(boardCards, holeCards);
      const letter = LETTERS_BY_POSITION?.[seat];
      const persona = SESSION_PERSONA_BY_LETTER?.[letter];

      // Base model
      let p = villainBetProbability(seat, isPFR, stage, boardCards, holeCards);

      // Multiway dampening (don’t stab into crowds)
      const aliveOthers = POSTFLOP_ORDER
        .filter(s2 => s2 !== heroSeat && s2 !== seat && ENGINE.statusBySeat[s2] === 'in').length;
      if (aliveOthers >= 2) p -= 0.15;       // 3+ way
      else if (aliveOthers === 1) p -= 0.05; // exactly one other villain alive

      // IP/OOP nudges (small)
      const iVill = ACTION_ORDER.indexOf(seat);
      const iHero = ACTION_ORDER.indexOf(heroSeat);
      const villainIsIP = iVill > iHero;
      p += villainIsIP ? 0.05 : -0.05;

      // Texture dampening (scary boards → fewer stabs)
      if (tex.moistureBucket === 'Wet') p -= 0.10;
      if (tex.fourToStraight)           p -= 0.12;
      if (tex.mono)                     p -= 0.10;
      if (tex.paired)                   p -= 0.05;

      // Persona nudges
      if (persona === 'MANIAC')  p += 0.15;
      if (persona === 'LAG')     p += 0.05;
      if (persona === 'STATION') p -= 0.08;
      if (persona === 'NIT')     p -= 0.12;

      // Range‑tightness effect (Module 3 Step 3)
      const tightness = ENGINE.villainRange?.[stage] ?? 100;
      p -= (100 - tightness) / 300;

      // Difficulty (Module 2.5)
      if (difficulty === "beginner") p -= 0.10;
      if (difficulty === "expert")   p += 0.10;

      // Clamp
      p = Math.max(0.02, Math.min(0.85, p));

      // Fire the probe?
      if (Math.random() < p) {
        // Choose size vs current pot (still do NOT add to pot here)
        const pct = pickVillainSizePct(stage, boardCards, holeCards);
        const amt = Math.max(5, toStep5((pct/100) * pot));

        pendingToCall = amt;
        scenario = { label: `${seat} bets ${pct}%`, potFactor: 0 };
        STREET_CTX.openBettor = seat;
        STREET_CTX.openSizePct = pct;
        STREET_CTX.openBetToCall = amt;

        // Call #2 insert: probe updates the range as a "bet"
        updateVillainRange(stage, "bet");
        continue; // allow later seats to respond
      }

      // Otherwise: explicitly register a CHECK and move on
      updateVillainRange(stage, "check");
      continue;
    }

    // -------------------------
    // Live price exists -> fold / notionally call / raise
    // -------------------------
    const tex = analyzeBoard(boardCards, holeCards);
    const letter = LETTERS_BY_POSITION?.[seat];
    const persona = SESSION_PERSONA_BY_LETTER?.[letter];

    // Improved raise logic (Module 2.2) + range‑tightness
    let raiseChance = VILLAIN.raiseOverBetFreq;

    // Persona adjustments
    if (persona === "MANIAC")  raiseChance += 0.15;
    if (persona === "LAG")     raiseChance += 0.05;
    if (persona === "STATION") raiseChance -= 0.05;
    if (persona === "NIT")     raiseChance -= 0.10;

    // Texture caps
    if (tex.moistureBucket === "Wet") raiseChance *= 0.50;
    if (tex.fourToStraight)           raiseChance *= 0.40;
    if (tex.mono)                     raiseChance *= 0.30;

    // Range‑tightness dampening (raises shrink more aggressively)
    const tightness2 = ENGINE.villainRange?.[stage] ?? 100;
    raiseChance -= (100 - tightness2) / 250;

    // Clamp
    raiseChance = Math.max(0.01, Math.min(0.50, raiseChance));

    // Bucket strength and decide whether to raise
    const strength = villainStrengthBucket(hole, boardCards);
    const willRaise = (strength === 'strong' || strength === 'draw') && (Math.random() < raiseChance);

    if (willRaise) {
      // “Raise‑to” model: at least 2x current price, or a size derived from % pot
      const pct = Math.max(66, pickVillainSizePct(stage, boardCards, holeCards));
      const raiseTo = Math.max(pendingToCall * 2, toStep5((pct / 100) * pot));

      pendingToCall = raiseTo;
      STREET_CTX.openBetToCall = raiseTo;
      scenario = { label: `${seat} raises to ${pct}%`, potFactor: 0 };

      // Call #2 insert: raising updates the range
      updateVillainRange(stage, "raise");
      continue;
    }

    // Weak hands fold some of the time; others notionally call (no pot add yet)
    if ((strength === 'weak' || strength === 'weak_draw') && Math.random() < VILLAIN.foldFracFacingBetWeak) {
      ENGINE.statusBySeat[seat] = "folded_now";

      // Call #2 insert: folding updates the range
      updateVillainRange(stage, "fold");
      // NOTE: strong/medium hands that "notionally call" are left untouched here;
      // we update range on actual pot moves in settleVillainsAfterHero(stage,...)
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

function settleVillainsAfterHero(stage, heroAction) {
  // Only simulate extra callers when hero starts the betting this street (no live price before hero).
  // This mirrors the original design: one decision per street for hero.
  if (!(stage === 'flop' || stage === 'turn' || stage === 'river')) return;
  if (heroAction !== 'bet') return;

  // Require a size to determine the live price others face
  const pct = Number(heroActions?.[stage]?.sizePct ?? 0);
  if (!isFinite(pct) || pct <= 0) return;

  // Price to call is based on the pot at the start of the street (your model)
  const betAmt = Math.max(5, toStep5((pct / 100) * STREET_CTX.potAtStart));

  // Build acting sequence strictly AFTER hero, wrapping back to just before hero
  const heroSeat = currentPosition();
  const order = POSTFLOP_ORDER.slice(); // ["SB","BB","UTG","HJ","CO","BTN"]
  const startIdx = order.indexOf(heroSeat);
  if (startIdx < 0) return;

  const seq = [];
  for (let k = (startIdx + 1) % order.length; k !== startIdx; k = (k + 1) % order.length) {
    seq.push(order[k]);
  }
  if (seq.length === 0) return;

  // Context shared for all decisions behind hero
  const tex = analyzeBoard(boardCards, holeCards);
  const newCallers = [];

  // Walk the seats after hero and decide call/fold
  for (const seat of seq) {
    // Must be alive to act
    if (ENGINE.statusBySeat[seat] !== 'in') continue;

    // Base call probability from your settings (training simplification)
    let pCall = Number(VILLAIN.callFracAfterHeroBet ?? 0.35);

    // Persona nudges
    const letter = LETTERS_BY_POSITION?.[seat];
    const persona = SESSION_PERSONA_BY_LETTER?.[letter];
    if (persona === 'MANIAC')  pCall += 0.10;
    if (persona === 'LAG')     pCall += 0.05;
    if (persona === 'STATION') pCall += 0.15;
    if (persona === 'NIT')     pCall -= 0.15;

    // Texture nudges (on dynamic boards calling is a bit more attractive)
    if (tex.moistureBucket === 'Wet')  pCall += 0.05;
    if (tex.fourToStraight)            pCall += 0.03;
    if (tex.mono)                      pCall += 0.02;

    // Range‑tightness influence (Module 3 Step 3): tighter ranges continue more
    const tightness = ENGINE.villainRange?.[stage] ?? 100; // 0–100
    pCall += (100 - tightness) / 300; // up to ~0.33 boost if very tight

    // Difficulty nudges (Module 2.5)
    if (difficulty === "beginner") pCall -= 0.08;
    if (difficulty === "expert")   pCall += 0.08;

    // Clamp to sane range
    pCall = Math.max(0.02, Math.min(0.95, pCall));

    // Decide
    if (Math.random() < pCall) {
      // CALL: add this villain's call to the pot now
      pot = toStep5(pot + betAmt);
      newCallers.push(seat);

      // Range update: they continued
      updateVillainRange(stage, "call");
    } else {
      // FOLD for visuals and downstream logic
      ENGINE.statusBySeat[seat] = "folded_now";

      // Range update: they folded
      updateVillainRange(stage, "fold");
    }
  }

  // Nice label updates for the UI (as in your earlier logic)
  if (newCallers.length === 1) appendScenarioNote(`${newCallers[0]} calls`);
  if (newCallers.length > 1) appendScenarioNote(`${newCallers.length} callers`);

  // After hero acts and we settle behind, hero has no price to call
  toCall = 0;
  updatePotInfo();   // refresh KPI chips, labels, etc.
}

function evaluateBarrel(stage, prevBoard, currBoard, isHeroPFR, pos, prevAggressive, action, sizePct) {
    if (!isHeroPFR) {
        return { barrelEval:"Not PFR", sizeEval:"n/a", note:"You were not the preflop aggressor — selective stabbing recommended.", recFreq:"", recSizes:"" };
    }
    const trans = classifyTransition(prevBoard, currBoard, holeCards);
    const catKey = mapBoardToCategory(currBoard, holeCards);
    const g = CBET_GUIDE[catKey];
    const ip = inPositionHeuristic(pos);

    let barrelEval = "Mixed";
    let reasons = [];
    if (trans.goodForPFR && !trans.badForPFR) {
        barrelEval = (action === "bet" || action === "raise") ? "Good continue" : "OK to slow down";
        reasons.push("Turn/River card improves aggressor advantage.");
    } else if (trans.badForPFR && !trans.goodForPFR) {
        barrelEval = (action === "bet" || action === "raise") ? "Risky barrel" : "Prudent check more";
        reasons.push("This card heavily favours the caller’s range.");
    } else {
        barrelEval = "Mixed (neutral runout)";
        reasons.push("Neutral card — mix checks/bets.");
    }

    const sizeRes = evalSizeAgainstGuide(sizePct, g ? g.sizes : null);
    const sizeEval = sizeRes.verdict ?? "n/a";
    const sizeNote = sizeRes.detail ?? "";

    let posNote = "";
    if (ip) {
        if ((action === "bet" || action === "raise") && g && g.freq === "High") posNote = "Being in position supports continued pressure.";
    } else {
        if (action === "bet" && g && g.freq !== "High") posNote = "Out of position — prefer checks or larger polar bets when continuing.";
    }

    // === NEW (M3·S4): Append villain range context (use stage param: 'turn' or 'river') ===
    const stageKey = (stage === "turn" ? "turn" : "river");  // guard if someone calls with 'river'
    const rng = villainRangeContextLine(stageKey);

    let note = `${g ? g.label : "Texture"}: ${g ? g.note : "No guide available."}`;
    if (reasons.length) note += " " + reasons.join(" ");
    if (posNote) note += " " + posNote;
    if (sizeEval !== "n/a") note += ` Size: ${sizeEval}. ${sizeNote}`;
    note += ` ${rng.line}`;

    return {
        barrelEval,
        sizeEval,
        note,
        recFreq: g ? g.freq : "",
        recSizes: g ? fmtSizeRangePct(g.sizes) : "",
        // NEW:
        villainRangePct: rng.pct,
        villainRangeLabel: rng.label
    };
}

// ==================== Phase 4: Non-PFR probe & River line ====================
function isProbeSpot(actionLabel){ return preflopAggressor!=='hero' && toCall===0 && (actionLabel==='bet' || actionLabel==='raise'); }

function evaluateProbe(stage, catKey, pos, actionLabel, sizePct){
    const ip = inPositionHeuristic(pos);
    const g = CBET_GUIDE[catKey];
    if (!g) return { probeEval:'n/a', sizeEval:'n/a', note:'No guide for this texture.', recSizes:'' };

    // Desirability (unchanged from your Module 2.3 patch)
    let desirability = 'Medium';
    if (catKey === 'LOW_DISCONNECTED')  desirability = ip ? 'High' : 'Medium';
    if (catKey === 'PAIRED_LOW')        desirability = ip ? 'High' : 'Medium';
    if (catKey === 'A_HIGH_RAINBOW')    desirability = 'Low';
    if (catKey === 'BROADWAY_HEAVY')    desirability = 'Low';
    if (catKey === 'TWO_TONE_DYNAMIC')  desirability = ip ? 'Medium' : 'Low';
    if (catKey === 'MONOTONE')          desirability = 'Low';
    if (catKey === 'FOUR_TO_STRAIGHT')  desirability = 'Low';

    let probeEval = 'Mixed';
    if (actionLabel === 'bet' || actionLabel === 'raise') {
        if (desirability === 'High') probeEval = 'Good probe (esp. IP)';
        else if (desirability === 'Medium') probeEval = 'Okay (be selective)';
        else probeEval = 'Risky probe (prefer checks)';
    } else {
        if (desirability === 'High') probeEval = 'Okay to check sometimes';
        else if (desirability === 'Medium') probeEval = 'Fine to check';
        else probeEval = 'Correct to check';
    }

    let recSizes = g.sizes;
    if (catKey === 'LOW_DISCONNECTED') recSizes = [25,33];
    if (catKey === 'PAIRED_LOW')       recSizes = [33,50];
    if (catKey === 'BROADWAY_HEAVY')   recSizes = [33,50];
    if (catKey === 'TWO_TONE_DYNAMIC') recSizes = [50,66];
    if (catKey === 'MONOTONE')         recSizes = [66,100];
    if (catKey === 'FOUR_TO_STRAIGHT') recSizes = [66,100,150];

    const sizeRes = evalSizeAgainstGuide(sizePct ?? null, recSizes);
    const sizeEval = sizeRes.verdict ?? 'n/a';
    const sizeNote = sizeRes.detail ?? '';

    // === NEW (M3·S4): Append villain range context (use current street key)
    const stageKey = (stage === 'flop' ? 'flop' : stage === 'turn' ? 'turn' : 'river');
    const rng = villainRangeContextLine(stageKey);

    let note = `${g.label}: `;
    if (desirability === 'High')   note += 'Good candidate to stab, especially in position. ';
    if (desirability === 'Medium') note += 'Selective probing; rely on overcards/backdoors. ';
    if (desirability === 'Low')    note += 'Usually prefer checks; stab with equity/backdoors. ';
    note += ip ? 'IP realizes equity better. ' : 'OOP: mix in more checks; when betting, be polar. ';
    if (sizeEval !== 'n/a') note += `Size: ${sizeEval}. ${sizeNote}`;
    note += ` ${rng.line}`;

    return {
        probeEval,
        sizeEval,
        note,
        recSizes: fmtSizeRangePct(recSizes),
        // NEW:
        villainRangePct: rng.pct,
        villainRangeLabel: rng.label
    };
}

// === Improved River Line Evaluation  ===
function classifyRiverLine(actionLabel, sizePct, hole, board) {
    const made = describeMadeHand(hole, board);
    const cat = made.cat;
    const tex = analyzeBoard(board, hole);
    const ip = inPositionHeuristic(currentPosition());

    const isNuts = isAbsoluteNutsOnRiver(hole, board).abs;
    const strongValue = (cat >= 2);
    const midValue = (cat === 1);
    const weakSD = (cat === 0);
    const scary = tex.mono || tex.fourToStraight || tex.paired;

    let sizingIntent = "small";
    if (sizePct >= 75 && sizePct < 125) sizingIntent = "medium";
    if (sizePct >= 125) sizingIntent = "large";

    let line = "", expl = "", badge = "gray";

    if (actionLabel === 'fold') {
        return { riverLine:"Fold", riverExplain:"You chose to fold — acceptable when your range is capped or price is poor.", madeLabel:made.label, badge:"red" };
    }

    if (actionLabel === 'bet' || actionLabel === 'raise') {
        if (isNuts) { line="Value (Nuts)"; expl="You hold the nuts — betting for maximum value is ideal."; badge="green"; }
        else if (strongValue) {
            if (scary) { line="Thin / Protection Value"; expl="Board is scary, but your made hand is strong enough to value bet cautiously."; badge="green"; }
            else { line="Value"; expl="Strong made hand — betting for value is correct."; badge="green"; }
        } else if (midValue) {
            if (scary) { line="Polar Bet (Bluff or thin value)"; expl="One pair on a dangerous river — this should be a polar bet, chosen selectively."; badge="amber"; }
            else if (sizingIntent === "small") { line="Thin Value"; expl="Small bet targeting weaker bluff‑catchers — appropriate thin value line."; badge="green"; }
            else { line="Polar Bluff"; expl="Large bet with marginal value — typically a polarized (bluff/value) line."; badge="purple"; }
        } else {
            line="Bluff"; expl="No showdown value — betting functions as a bluff."; badge="purple";
        }
    } else if (actionLabel === 'check') {
        if (isNuts) { line="Missed Value"; expl="You hold the nuts — checking misses significant value."; badge="amber"; }
        else if (strongValue) { line="Slowplay / Induce"; expl= ip ? "Checking strong value in position can induce bluffs." : "OOP check with strong value can be used to bluff‑catch or induce."; badge="green"; }
        else if (midValue) { line="Pot Control"; expl="One pair — checking avoids thin value bets against stronger ranges."; badge="amber"; }
        else { line="Give Up / Realize Equity"; expl="High card — checking is correct to take a cheap showdown."; badge="gray"; }
    } else {
        return { riverLine:"Check", riverExplain:"River spot defaults to a neutral check.", madeLabel:made.label, badge:"gray" };
    }

    // === NEW (M3·S4): tack on villain range context for river
    const rng = villainRangeContextLine("river");
    expl += ` ${rng.line}`;

    return { riverLine:line, riverExplain:expl, madeLabel:made.label, badge };
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
ENGINE.preflop.threeBetToBb = null;     // <-- REQUIRED
ENGINE.preflop.openToBb = null;         // <-- strongly recommended

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

engineSetPreflopContext(pf.openerSeat, pf.threeBetterSeat, pf.coldCallers, pf.openToBb, pf.threeBetToBb);

  renderCards();
  setPositionDisc();
  setPreflopBadge();

// NEW: mark early preflop folders (before Hero) as red on the discs
(function markPreflopFolders(){
  const hero = currentPosition();
  // Build list of seats that act before hero in preflop order
  const before = [];
  for (const s of ACTION_ORDER) { if (s === hero) break; before.push(s); }

  // Seats that are definitely still live before hero: opener, 3-bettor, cold callers (if any)
  const keep = new Set();
  if (pf.openerSeat) keep.add(pf.openerSeat);
  if (pf.threeBetterSeat) keep.add(pf.threeBetterSeat);
  (pf.coldCallers || []).forEach(s => keep.add(s));

  // Mark seats that acted before hero and did NOT continue as folded_now (red)
  before.forEach(seat => {
    ENGINE.statusBySeat[seat] = keep.has(seat) ? "in" : "folded_now";
  });
})();

updatePreflopSizePresets(); // NEW: set correct basis (×BB vs × of open)
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
  const policy = (typeof REVEAL !== 'undefined' && REVEAL && REVEAL.policy) ? REVEAL.policy : 'always_remaining';
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

// === MERGED SHOWDOWN — Winners + Hero (separate red box if losing) ===

// Precompute hero info once
const heroSeat = currentPosition();
const heroHole = seatHand(heroSeat);
const heroMade = (heroHole && heroHole.length >= 2)
  ? describeMadeHand(heroHole, result.board)
  : null;

// Build a Set for fast "is winner" lookup
const winnerSeats = new Set(result.winners.map(w => w.seat));

//
// 1) WINNER BOX(ES) — green
//
result.winners.forEach(w => {

  const div = document.createElement('div');
  div.className = 'ehs-winner';

  const madeText = (result.board.length === 5 && w.made)
    ? `<span class="made">• ${w.made}</span>`
    : '';

  div.innerHTML = `
    <div><span class="name">Winner: ${w.seat}</span> ${madeText}</div>
  `;

  // Winner hole cards
  if (Array.isArray(w.hole) && w.hole.length >= 2) {
    const winRow = document.createElement('div');
    winRow.className = 'ehs-hole';
    winRow.innerHTML = `
      <div class="ehs-cardchip">${w.hole[0].rank}${w.hole[0].suit}</div>
      <div class="ehs-cardchip">${w.hole[1].rank}${w.hole[1].suit}</div>
    `;
    div.appendChild(winRow);
  }

  body.appendChild(div);
});

//
// 2) HERO LOSER BOX — red (only if hero is NOT a winner)
//
if (!winnerSeats.has(heroSeat) && heroHole && heroHole.length >= 2) {

  const hdiv = document.createElement('div');
  hdiv.className = 'ehs-loser';

  const heroMadeText = (result.board.length === 5 && heroMade)
    ? `<span class="made">• ${heroMade.label}</span>`
    : '';

  hdiv.innerHTML = `
    <div><span class="name">Your Hand</span> ${heroMadeText}</div>
  `;

  const heroRow = document.createElement('div');
  heroRow.className = 'ehs-hole';
  heroRow.innerHTML = `
    <div class="ehs-cardchip">${heroHole[0].rank}${heroHole[0].suit}</div>
    <div class="ehs-cardchip">${heroHole[1].rank}${heroHole[1].suit}</div>
  `;
  hdiv.appendChild(heroRow);

  body.appendChild(hdiv);
}

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
  const reveal = (REVEAL?.policy ?? 'always_remaining');

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

  if (decision === 'raise') {
if (stage === 'preflop') {
  const bb = toStep5(BLINDS.bb);
  const heroSeat = currentPosition();
  const opener = ENGINE.preflop?.openerSeat ?? null;

  // Chips hero already posted from blinds
  const heroAlready = (heroSeat === 'SB') ? toStep5(BLINDS.sb)
                    : (heroSeat === 'BB') ? toStep5(BLINDS.bb)
                    : 0;

  // *** KEY FIX ***
  const heroIsOpener = (opener === heroSeat);
  const facingOpen   = !!opener && !heroIsOpener;

  if (!opener || heroIsOpener) {
    // ===== OPENING raise: ×BB basis =====
    const sizeBB = (heroActions.preflop.sizeBb ?? 2.5);
    const raiseTo = toStep5(sizeBB * bb);            // raise-to in chips
    const putIn   = Math.max(0, raiseTo - heroAlready);
    pot   = toStep5(pot + putIn);
    toCall = 0;
    updatePotInfo();

    ENGINE.preflop.openerSeat = heroSeat;
    ENGINE.preflop.openToBb   = sizeBB;

    return;
  } else {
    // ===== 3-BET vs opener: × of opener's raise-to =====
    const openToBb = Number(ENGINE.preflop?.openToBb ?? 2.2); // safe default if sim didn't store
    const iHero    = ACTION_ORDER.indexOf(heroSeat);
    const iOp      = ACTION_ORDER.indexOf(opener);
    const heroIP   = (iHero > iOp) && heroSeat !== 'SB' && heroSeat !== 'BB';
    const defaultMult = heroIP ? 3.0 : 4.0;
    const mult     = (heroActions.preflop.sizeMult != null) ? heroActions.preflop.sizeMult : defaultMult;

    const raiseToBb = mult * openToBb;               // raise-to in BB
    const raiseTo   = toStep5(raiseToBb * bb);       // chips
    const putIn     = Math.max(0, raiseTo - heroAlready);
    pot   = toStep5(pot + putIn);
    toCall = 0;
    updatePotInfo();

// NEW: persist hero 3-bet metadata so behind seats have a valid price
    ENGINE.preflop.threeBetterSeat = heroSeat;
    ENGINE.preflop.threeBetToBb    = raiseToBb;

    return;
  }
}

else {
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

// Decide what the action *means* before we change any pot/toCall
     const actionLabelPre = determinePostflopAction(decision, toCall);
     const stageNow = STAGES[currentStageIndex];

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

// === NEW: complete preflop by letting seats BEHIND hero respond (call-only after hero)
if (stageNow === 'preflop') {
  runPreflopAfterHero(decision);
}

// === Settle some field callers or allow stabs *based on the pre-action label*
if (stageNow === 'flop' || stageNow === 'turn' || stageNow === 'river') {
  if (actionLabelPre === 'bet' || actionLabelPre === 'raise') {
    // Existing behavior: add some callers behind
    settleVillainsAfterHero(stageNow, actionLabelPre);
  } else if (actionLabelPre === 'check') {
    // NEW: let villains stab behind your check
    villainsActAfterHeroCheck(stageNow);
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
        last.preflopSizeEval = (typeof sizeEval !== 'undefined' ? sizeEval : '');
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

if (stage==='flop') {
  const isHeroPFR = (preflopAggressor==='hero');
  const sizePct   = heroActions.flop.sizePct ?? null;
  const pos       = POSITIONS6[heroPosIdx];
  const actionLbl = actionLabelPre;         // 'bet' | 'raise' | 'check' | 'call' | 'fold'

  let evalBlockHtml = '';

  // --- C-bet evaluation (PFR only)
  const cbet = evaluateFlopCbet(mapBoardToCategory(boardCards, holeCards), isHeroPFR, pos, actionLbl, sizePct);
  evalBlockHtml += `
    <div style="margin-top:8px">
      <strong>Flop Strategy:</strong>
      <div>C‑bet: <span class="badge ${cbet.cbetEval.includes('Correct')?'green':(cbet.cbetEval.includes('Risky')?'red':'amber')}">${cbet.cbetEval}</span></div>
      <div>Size: <span class="badge ${sizeEvalBadgeColor(cbet.sizeEval)}">${cbet.sizeEval}</span> (Rec: ${cbet.recFreq} · ${cbet.recSizes})</div>
      <div style="opacity:.9">${cbet.note}</div>
    </div>
  `;

  // --- Optional probe coaching (Non‑PFR + Hero bet/check conditions)
  if (!isHeroPFR && isProbeSpot(actionLabelPre)) {
    const probe = evaluateProbe('flop', mapBoardToCategory(boardCards, holeCards), pos, actionLbl, sizePct);
    evalBlockHtml += `
      <div style="margin-top:8px">
        <strong>Flop Probe (Non‑PFR):</strong>
        <div>Probe: <span class="badge ${probe.probeEval.includes('Good')?'green':(probe.probeEval.includes('Risky')?'red':'amber')}">${probe.probeEval}</span></div>
        <div>Size: <span class="badge ${sizeEvalBadgeColor(probe.sizeEval)}">${probe.sizeEval}</span> (Guide: ${probe.recSizes})</div>
        <div style="opacity:.9">${probe.note}</div>
      </div>
    `;
  }

  // --- Hand history fields (standardized)
  const last = handHistory[handHistory.length-1];
  if (last){
    last.boardCards            = boardToString(boardCards);
    last.boardCategory         = mapBoardToCategory(boardCards, holeCards);
    last.betOrRaiseLabel       = betOrRaiseLabelForStage();
    last.sizePct               = sizePct ?? '';
    last.cbetEval              = cbet.cbetEval ?? '';
    last.sizingEval            = cbet.sizeEval ?? '';
    last.cbetRecommendedFreq   = cbet.recFreq ?? '';
    last.sizingRecommendedRange= cbet.recSizes ?? '';
  last.villainRangeFlopPct = flopRes.villainRangePct ?? '';
  last.villainRangeFlopLbl = flopRes.villainRangeLabel ?? '';
    if (!isHeroPFR && isProbeSpot(actionLabelPre)) {
      last.postflopRole        = 'Non-PFR';
      // Keep a short probe marker; detailed text is already in feedback
      last.probeEval           = 'Probed';
    } else {
      last.postflopRole        = (preflopAggressor==='hero') ? 'PFR' : 'Caller';
    }
  }

  // --- Inject into feedback
  if (difficulty !== "expert" && evalBlockHtml) {
    feedbackEl.insertAdjacentHTML('beforeend', evalBlockHtml);
}
}

else if (stage==='turn') {
  const prevBoard = boardCards.slice(0,3);
  const isHeroPFR = (preflopAggressor==='hero');
  const sizePct   = heroActions.turn.sizePct ?? null;
  const pos       = POSITIONS6[heroPosIdx];
  const actionLbl = actionLabelPre;

  let evalBlockHtml = '';

  // --- Turn barrel evaluation (uses your improved Step 2)
  const tRes = evaluateBarrel('turn', prevBoard, boardCards, isHeroPFR, pos, !!heroActions.flop.cbet, actionLbl, sizePct);
  evalBlockHtml += `
    <div style="margin-top:8px">
      <strong>Turn Strategy:</strong>
      <div>Barrel: <span class="badge ${tRes.barrelEval.includes('Good')?'green':(tRes.barrelEval.includes('Risky')?'amber':'amber')}">${tRes.barrelEval}</span></div>
      <div>Size: <span class="badge ${sizeEvalBadgeColor(tRes.sizeEval)}">${tRes.sizeEval}</span> (Rec: ${tRes.recFreq || '—'} ${tRes.recSizes ? '· ' + tRes.recSizes : ''})</div>
      <div style="opacity:.9">${tRes.note}</div>
    </div>
  `;

  // --- Optional probe coaching (Non‑PFR)
  if (!isHeroPFR && isProbeSpot(actionLabelPre)) {
    const probe = evaluateProbe('turn', mapBoardToCategory(boardCards, holeCards), pos, actionLbl, sizePct);
    evalBlockHtml += `
      <div style="margin-top:8px">
        <strong>Turn Probe (Non‑PFR):</strong>
        <div>Probe: <span class="badge ${probe.probeEval.includes('Good')?'green':(probe.probeEval.includes('Risky')?'red':'amber')}">${probe.probeEval}</span></div>
        <div>Size: <span class="badge ${sizeEvalBadgeColor(probe.sizeEval)}">${probe.sizeEval}</span> (Guide: ${probe.recSizes})</div>
        <div style="opacity:.9">${probe.note}</div>
      </div>
    `;
  }

  // --- Hand history fields
  const last = handHistory[handHistory.length-1];
  if (last){
    last.boardCards            = boardToString(boardCards);
    last.boardCategory         = mapBoardToCategory(boardCards, holeCards);
    last.betOrRaiseLabel       = betOrRaiseLabelForStage();
    last.sizePct               = sizePct ?? '';
    last.barrelEval            = tRes.barrelEval ?? '';
    last.sizingEval            = tRes.sizeEval ?? '';
    last.cbetRecommendedFreq   = tRes.recFreq ?? '';
    last.sizingRecommendedRange= tRes.recSizes ?? '';
 last.villainRangeTurnPct = tRes.villainRangePct ?? '';
 last.villainRangeTurnLbl = tRes.villainRangeLabel ?? '';
    if (!isHeroPFR && isProbeSpot(actionLabelPre)) {
      last.postflopRole        = 'Non-PFR';
      last.probeEval           = 'Probed';
    } else if (!last.postflopRole) {
      last.postflopRole        = (preflopAggressor==='hero') ? 'PFR' : 'Caller';
    }
  }

if (difficulty !== "expert" && evalBlockHtml) {
    feedbackEl.insertAdjacentHTML('beforeend', evalBlockHtml);
}
}


else if (stage==='river') {
  const prevBoard = boardCards.slice(0,4);
  const isHeroPFR = (preflopAggressor==='hero');
  const sizePct   = heroActions.river.sizePct ?? null;
  const pos       = POSITIONS6[heroPosIdx];
  const actionLbl = actionLabelPre;

  let evalBlockHtml = '';

  // --- River barrel evaluation uses evaluateBarrel for consistency of notes (freq/size framing)
  const rRes = evaluateBarrel('river', prevBoard, boardCards, isHeroPFR, pos, !!(heroActions.turn && heroActions.turn.barrel), actionLbl, sizePct);
  evalBlockHtml += `
    <div style="margin-top:8px">
      <strong>River Strategy:</strong>
      <div>Barrel: <span class="badge ${rRes.barrelEval.includes('Good')?'green':(rRes.barrelEval.includes('Risky')?'amber':'amber')}">${rRes.barrelEval}</span></div>
      <div>Size: <span class="badge ${sizeEvalBadgeColor(rRes.sizeEval)}">${rRes.sizeEval}</span> (Rec: ${rRes.recFreq || '—'} ${rRes.recSizes ? '· ' + rRes.recSizes : ''})</div>
      <div style="opacity:.9">${rRes.note}</div>
    </div>
  `;

  // --- River line classification (Step 4)
  const rc = classifyRiverLine(actionLbl, sizePct ?? null, holeCards, boardCards);
  evalBlockHtml += `
    <div style="margin-top:8px">
      <strong>River Line:</strong>
      <span class="badge ${rc.badge}">${rc.riverLine}</span>
      <div style="opacity:.9">${rc.riverExplain}</div>
    </div>
  `;

  // --- Hand history fields
  const last = handHistory[handHistory.length-1];
  if (last){
    last.boardCards            = boardToString(boardCards);
    last.boardCategory         = mapBoardToCategory(boardCards, holeCards);
    last.betOrRaiseLabel       = betOrRaiseLabelForStage();
    last.sizePct               = sizePct ?? '';
    last.barrelEval            = rRes.barrelEval ?? '';
    last.sizingEval            = rRes.sizeEval ?? '';
    last.cbetRecommendedFreq   = rRes.recFreq ?? '';
    last.sizingRecommendedRange= rRes.recSizes ?? '';
    last.riverLineType         = rc.riverLine;
    last.riverMadeHand         = rc.madeLabel;
 last.villainRangeRiverPct = rRes.villainRangePct ?? '';
 last.villainRangeRiverLbl = rRes.villainRangeLabel ?? '';

  }

  if (difficulty !== "expert" && evalBlockHtml) {
    feedbackEl.insertAdjacentHTML('beforeend', evalBlockHtml);
}
}

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
difficultySelect.addEventListener("change", () => {
    difficulty = difficultySelect.value;

    // --- BEGINNER MODE ---
    if (difficulty === "beginner") {
        clearTimer();
        timerRange.disabled = true;
        if (timerCountdownEl) timerCountdownEl.textContent = "No timer in Beginner Mode";
        if (kpiTimerEl) kpiTimerEl.textContent = "Time: —";

        // Show live hints in beginner
        if (hintsEl) hintsEl.style.display = "block";
        updateHintsImmediate();
    }

    // --- INTERMEDIATE MODE ---
    if (difficulty === "intermediate") {
        timerRange.disabled = false;

        timerSeconds = 59;
        timerRange.value = 59;
        timerValueEl.textContent = "59";
        startTimer();

        // Hide live hints
        if (hintsEl) hintsEl.style.display = "none";
        if (hintsEl) hintsEl.innerHTML = "";
    }

    // --- EXPERT MODE ---
    if (difficulty === "expert") {
        timerRange.disabled = false;

        timerSeconds = 59;
        timerRange.value = 59;
        timerValueEl.textContent = "59";
        startTimer();

        // Strict no-help mode
        if (hintsEl) hintsEl.style.display = "none";
        if (hintsEl) hintsEl.innerHTML = "";
    }

    // Always update pot + preflop badge logic
    updatePotInfo();
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
const act = a?.action ?? 'check'; // default to 'check' if engine returns nothing

// --- No live price -> villain can BET or CHECK (fold is rare but keep guard)
if (pendingToCall === 0) {
  if (act === 'bet') {
    // OPEN BET
    const amt = Math.max(5, toStep5((a.sizePct / 100) * pot));
    pendingToCall = amt;
    STREET_CTX.openBetToCall = amt;     // remember live price for hero
    pot = toStep5(pot + amt);           // add bettor’s chips now (your current model)
    scenario = { label: `${seat} bets ${a.sizePct}%`, potFactor: 0 };
    STREET_CTX.openBettor = seat;
    STREET_CTX.openSizePct = a.sizePct;

    updateVillainRange(stage, "bet");
    continue;
  }

  if (act === 'fold') {
    // (Uncommon, but keep robust)
    ENGINE.statusBySeat[seat] = 'folded_now';
    updateVillainRange(stage, "fold");
    continue;
  }

  // Otherwise treat as CHECK
  updateVillainRange(stage, "check");
  continue;
}

// --- There IS a live price -> villain can FOLD, CALL, or RAISE
if (act === 'fold') {
  ENGINE.statusBySeat[seat] = 'folded_now';
  updateVillainRange(stage, "fold");
  continue;
}

if (act === 'call') {
  pot = toStep5(pot + pendingToCall);
  updateVillainRange(stage, "call");
  continue;
}

if (act === 'bet') {
  // TREAT AS RAISE (since a live price exists)
  // "Raise-to" model: at least 2x current price, or a size derived from pct of pot
  const raiseTo = Math.max(
    pendingToCall * 2,
    toStep5((a.sizePct / 100) * pot)
  );
  const extra = Math.max(0, raiseTo - pendingToCall);
  pendingToCall = raiseTo;
  STREET_CTX.openBetToCall = raiseTo;

  // Add only the extra over the call (your pot model adds the bettor’s chips now)
  pot = toStep5(pot + extra);

  scenario = { label: `${seat} raises to ${a.sizePct}%`, potFactor: 0 };
  STREET_CTX.openBettor = seat;
  STREET_CTX.openSizePct = a.sizePct;

  updateVillainRange(stage, "raise");
  continue;
}

// Fallback (shouldn’t happen): treat as check when something unexpected occurs
updateVillainRange(stage, "check");

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
