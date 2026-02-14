// /src/app.js
// ES module that wires the unified betting panel and position disc
// into your existing app (Index.html + Script.js).

import { subscribe, publish } from './core/events.js';
import { mountUnifiedBetPanel } from './ui/actions.js';
import { initPositions, nextHandRotateButton, mountPositionDisc, updatePositionDisc } from './features/position.js';
import { categorizeFlop } from './features/boardTexture.js';
import { policyFor } from './features/cbetGuide.js';
import { bucketFromPct } from './core/config.js';

// --- DOM helpers ---
const $ = (sel) => document.querySelector(sel);

function readStage() {
  const s = $('#stageLabel');
  const t = s ? String(s.textContent || '').trim().toLowerCase() : '';
  if (t) return t;
  // fallback from board length
  const n = document.querySelectorAll('#boardCards .card').length;
  if (n === 0) return 'preflop';
  if (n === 3) return 'flop';
  if (n === 4) return 'turn';
  return 'river';
}
function readPot() {
  const n = Number($('#potSize')?.textContent || '0');
  return Number.isFinite(n) ? n : 0;
}
function readToCall() {
  const n = Number($('#toCall')?.textContent || '0');
  return Number.isFinite(n) ? n : 0;
}
function readBoardCardsFromDom() {
  const nodes = document.querySelectorAll('#boardCards .card');
  const cards = [];
  nodes.forEach(cardEl => {
    const rTop = cardEl.querySelector('.rank');
    const sMid = cardEl.querySelector('.suit');
    const rank = rTop ? rTop.textContent.trim() : '';
    const suit = sMid ? sMid.textContent.trim() : '';
    if (rank && suit) cards.push({ rank, suit });
  });
  return cards;
}

// --- Position Disc mounting ---
function mountPosition() {
  mountPositionDisc();
  updatePositionDisc();
}

// --- Betting panel + context wiring ---
function ensureHiddenInputs() {
  const form = $('#inputForm');
  if (!form) return;

  const ensure = (id, name) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('input');
      el.type = 'hidden';
      el.id = id;
      el.name = name;
      form.appendChild(el);
    }
    return el;
  };
  ensure('decisionUnified', 'decision'); // Script.js reads 'decision' from FormData
  ensure('betPctUnified', 'betPctUnified');
  ensure('betBucketUnified', 'betBucketUnified');
}

function pushContextToBetPanel() {
  const stage = readStage();
  const pot = readPot();
  const toCall = readToCall();

  // texture hint (flop only)
  let textureLabel = '—';
  let policyNote = '';
  if (stage === 'flop') {
    const board = readBoardCardsFromDom();
    const cat = categorizeFlop(board);
    const pol = policyFor(cat);
    textureLabel = `${cat}`;
    policyNote = `${pol.freq} c-bet · ${pol.preferredSizes.join(' / ')}`;
  }
  publish('betting:context', { pot, toCall, stage, textureLabel, policyNote });
}

function wireBetPreview() {
  // request { pot, pct } -> response { bet, newPot, pct }
  subscribe('bet:preview:request', ({ pot, pct }) => {
    try {
      const res = window.computeRoundedBetAndPot
        ? window.computeRoundedBetAndPot(pot, pct)
        : { bet: Math.round(pot * pct), newPot: Math.round(pot * (1 + pct)) };
      publish('bet:preview:response', { bet: res.bet, newPot: res.newPot, pct });
    } catch (e) {
      console.warn('Preview computation failed; falling back.', e);
      const bet = Math.round(pot * pct);
      const newPot = pot + bet;
      publish('bet:preview:response', { bet, newPot, pct });
    }
  });
}

function wireBetChoice() {
  subscribe('betting:choose', ({ chose, sizePct, sizeBucket }) => {
    const decisionEl = document.getElementById('decisionUnified');
    const pctEl = document.getElementById('betPctUnified');
    const bucketEl = document.getElementById('betBucketUnified');
    if (!decisionEl) return;

    decisionEl.value = chose || '';
    if (pctEl) pctEl.value = (sizePct != null ? String(sizePct) : '');
    if (bucketEl) bucketEl.value = sizeBucket || (sizePct != null ? bucketFromPct(sizePct) : '') || '';

    const submitBtn = document.getElementById('barSubmitBtn') || document.getElementById('submitStageBtn');
    if (submitBtn) submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// --- Observe DOM changes from legacy Script.js and keep panel in sync ---
function startDomObservers() {
  const emitContext = () => pushContextToBetPanel();

  const observeText = (el) => {
    if (!el) return;
    const mo = new MutationObserver(() => emitContext());
    mo.observe(el, { childList: true, characterData: true, subtree: true });
  };

  observeText(document.getElementById('stageLabel'));
  observeText(document.getElementById('potSize'));
  observeText(document.getElementById('toCall'));

  const board = document.getElementById('boardCards');
  if (board) {
    const mo = new MutationObserver(() => emitContext());
    mo.observe(board, { childList: true, subtree: true });
  }

  emitContext();
}

// --- Hook New Hand / Next Stage buttons to rotate positions & refresh ---
function wireStageButtons() {
  const newHandBtn = document.getElementById('newHandBtn');
  const nextBtn = document.getElementById('nextStageBtn');
  const barNext = document.getElementById('barNextBtn');

  if (newHandBtn) {
    newHandBtn.addEventListener('click', () => {
      setTimeout(() => {
        nextHandRotateButton();
        updatePositionDisc();
        pushContextToBetPanel();
      }, 0);
    });
  }
  const onNext = () => setTimeout(() => {
    updatePositionDisc();
    pushContextToBetPanel();
  }, 0);

  if (nextBtn) nextBtn.addEventListener('click', onNext);
  if (barNext) barNext.addEventListener('click', onNext);
}

// --- Lightweight Betting feedback append (after legacy feedback) ---
function wireSubmitFeedbackAppend() {
  const form = document.getElementById('inputForm');
  if (!form) return;

  form.addEventListener('submit', () => {
    setTimeout(() => {
      const feedback = document.getElementById('feedback');
      if (!feedback) return;

      const stage = readStage();
      if (stage === 'preflop') return;

      const decision = document.getElementById('decisionUnified')?.value || '';
      const pctStr = document.getElementById('betPctUnified')?.value || '';
      const bucket = document.getElementById('betBucketUnified')?.value || '';
      const pct = pctStr ? Number(pctStr) : null;

      if (!decision) return;

      const board = readBoardCardsFromDom();
      const cat = categorizeFlop(board);
      const pol = policyFor(cat);

      const actedAggressively = (decision === 'bet' || decision === 'raise');
      const sizeLabel = bucket ? bucket : (pct != null ? (bucketFromPct(pct) || '') : '');

      const line = document.createElement('div');
      line.style.marginTop = '6px';
      line.innerHTML =
        `<div><strong>Betting:</strong> ${actedAggressively ? 'Aggressive' : (decision === 'call' ? 'Call' : 'Check/Fold')}
         · Size: ${sizeLabel || '—'}
         · Board: ${cat} (policy: ${pol.freq}, sizes: ${pol.preferredSizes.join(' / ')})</div>`;
      feedback.appendChild(line);
    }, 0);
  }, false);
}

// --- Boot ---
function boot() {
  initPositions({ tableSize: 6 });
  mountPosition();
  mountUnifiedBetPanel();
  ensureHiddenInputs();
  wireBetPreview();
  wireBetChoice();
  startDomObservers();
  wireStageButtons();
  wireSubmitFeedbackAppend();
  pushContextToBetPanel();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}