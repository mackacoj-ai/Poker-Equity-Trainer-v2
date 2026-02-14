// Hand/session state that the new UI uses (kept light and UI-oriented).
// We don't replace your legacy state; we bridge UI actions through this object.

export const uiState = {
  positionIdx: 0,   // index into POSITIONS
  handNo: 0,
  // betting panel
  facingBet: false,
  toCall: 0,        // mirror from DOM when needed
  pot: 0,           // mirror from DOM when needed
  stage: 'preflop', // 'preflop'|'flop'|'turn'|'river'
  // chosen action
  decision: null,   // 'fold'|'check'|'call'|'bet'|'raise'
  sizePct: null,    // number like 0.33, 0.5, 0.75, 1.2
  sizeBucket: null  // 'small'|'medium'|'big'|'overbet'
};

export function resetForNewHand(nextPositionIdx) {
  uiState.positionIdx = nextPositionIdx;
  uiState.handNo += 1;
  uiState.stage = 'preflop';
  uiState.facingBet = false;
  uiState.decision = null;
  uiState.sizePct = null;
  uiState.sizeBucket = null;
}