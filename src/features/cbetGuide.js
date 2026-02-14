// Texture -> cbet policy (freq + preferred size buckets + notes)

export const CBET_POLICIES = {
  'A-high-dry':             { freq: 'high',   preferredSizes: ['small'],                notes: 'Range advantage; bet small often.' },
  'KQ-high-dry':            { freq: 'med',    preferredSizes: ['small'],                notes: 'Still favours IP; UTG checks K-high more.' },
  'Paired':                 { freq: 'med',    preferredSizes: ['small','medium'],       notes: 'Leverage cap; careful OOP.' },
  'Monotone':               { freq: 'medlow', preferredSizes: ['small'],                notes: 'Nut advantage matters; stab with high suit.' },
  'Low-disconnected':       { freq: 'med',    preferredSizes: ['small','medium'],       notes: 'CO/BTN stab more than UTG.' },
  'Low-connected-two-tone': { freq: 'low',    preferredSizes: ['medium','big'],         notes: 'Equity wide; bet bigger when you do.' },
  'Dynamic-straighty':      { freq: 'low',    preferredSizes: ['big','overbet'],        notes: 'Polarize or check.' },
  'Dynamic-flushy':         { freq: 'low',    preferredSizes: ['big'],                  notes: 'Many continues; choose hands carefully.' },
  'Other':                  { freq: 'med',    preferredSizes: ['small','medium'],       notes: 'Default.' }
};

export function policyFor(textureCat) {
  return CBET_POLICIES[textureCat] || CBET_POLICIES['Other'];
}
