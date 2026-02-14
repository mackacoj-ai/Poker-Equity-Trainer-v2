// Inject & wire the Unified Betting Panel

import { publish, subscribe } from '../core/events.js';
import { contextLabels } from '../features/betting.js';
import { BUCKET_LABEL, pctForBucket, bucketFromPct } from '../core/config.js';

export function mountUnifiedBetPanel() {
  const form = document.getElementById('inputForm');
  if (!form) return;

  // Hide legacy segmented radios if present
  const seg = form.querySelector('.segmented');
  if (seg) seg.classList.add('hidden');

  let panel = document.getElementById('unifiedBetPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'unifiedBetPanel';
    panel.className = 'bet-panel';
    panel.innerHTML = `
      <div class="bet-row">
        <button type="button" class="btn bet-fold" id="btnFold">Fold</button>
        <button type="button" class="btn bet-mid" id="btnMid">Check</button>
        <button type="button" class="primary bet-agg" id="btnAgg">Bet</button>
      </div>

      <div class="bet-sizes">
        <div class="bucket-selector" id="bucketSelector">
          <label><input type="radio" name="bucket" value="small"> ${BUCKET_LABEL.small}</label>
          <label><input type="radio" name="bucket" value="medium"> ${BUCKET_LABEL.medium}</label>
          <label><input type="radio" name="bucket" value="big"> ${BUCKET_LABEL.big}</label>
          <label><input type="radio" name="bucket" value="overbet"> ${BUCKET_LABEL.overbet}</label>
        </div>
        <div class="preset-row">
          <button type="button" class="btn preset" data-pct="0.33">25–33%</button>
          <button type="button" class="btn preset" data-pct="0.50">45–55%</button>
          <button type="button" class="btn preset" data-pct="0.75">65–100%</button>
          <button type="button" class="btn preset" data-pct="1.25">110%+</button>
        </div>
        <div class="bet-preview" id="betPreview">Preview: —</div>
      </div>

      <div class="bet-hint" id="betHint">
        <span id="textureHint">ⓘ Board: —</span>
      </div>
    `;
    // Insert before submit buttons (desktop) or at end of form
    const submitBtn = document.getElementById('submitStageBtn');
    if (submitBtn?.parentElement) {
      submitBtn.parentElement.parentElement.insertBefore(panel, submitBtn.parentElement);
    } else {
      form.appendChild(panel);
    }
  }

  const btnFold = panel.querySelector('#btnFold');
  const btnMid  = panel.querySelector('#btnMid');
  const btnAgg  = panel.querySelector('#btnAgg');
  const bucketSelector = panel.querySelector('#bucketSelector');
  const presetRow = panel.querySelector('.preset-row');
  const preview = panel.querySelector('#betPreview');

  let latestContext = { pot: 0, toCall: 0, stage: 'preflop' };
  let selectedBucket = null;
  let selectedPct = null;

  function refreshLabels() {
    const { passiveLeft, middle, agg } = contextLabels({ toCall: latestContext.toCall });
    btnFold.textContent = passiveLeft;
    btnMid.textContent  = middle;
    btnAgg.textContent  = agg;
  }

  function computePreview() {
    // depends on pot and selectedPct; pot math is delegated to host via event
    const pct = selectedPct ?? pctForBucket(selectedBucket);
    if (!pct) { preview.textContent = 'Preview: —'; return; }
    publish('bet:preview:request', { pot: latestContext.pot, pct });
    // host will respond with 'bet:preview:response'
  }

  // listen for context updates from host app (pot, toCall, stage, texture hint)
  subscribe('betting:context', (ctx) => {
    latestContext = { ...latestContext, ...ctx };
    refreshLabels();
  });

  // host app returns rounded bet & new pot for preview
  subscribe('bet:preview:response', ({ bet, newPot, pct }) => {
    preview.textContent = `Preview: ${btnAgg.textContent} (${Math.round(pct*100)}%) = £${bet} → New Pot: £${newPot}`;
  });

  // actions
  btnFold.addEventListener('click', () => {
    publish('betting:choose', { chose: 'fold' });
  });
  btnMid.addEventListener('click', () => {
    const facingBet = (latestContext.toCall || 0) > 0;
    publish('betting:choose', { chose: facingBet ? 'call' : 'check' });
  });
  btnAgg.addEventListener('click', () => {
    const facingBet = (latestContext.toCall || 0) > 0;
    const pct = selectedPct ?? pctForBucket(selectedBucket);
    const bucket = bucketFromPct(pct ?? 0);
    publish('betting:choose', {
      chose: facingBet ? 'raise' : 'bet',
      sizePct: pct ?? null,
      sizeBucket: bucket ?? null
    });
  });

  // bucket selection
  bucketSelector.addEventListener('change', (e) => {
    const val = panel.querySelector('input[name="bucket"]:checked')?.value || null;
    selectedBucket = val;
    selectedPct = null;
    computePreview();
  });

  // preset buttons
  presetRow.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPct = parseFloat(btn.getAttribute('data-pct') || '0');
      selectedBucket = null; // preset overrides bucket
      // uncheck radios
      panel.querySelectorAll('input[name="bucket"]').forEach(r => r.checked = false);
      computePreview();
    });
  });

  refreshLabels();
}
