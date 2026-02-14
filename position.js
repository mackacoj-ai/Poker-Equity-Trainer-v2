// 6-max position rotation & UI disc

import { publish } from '../core/events.js';

const POSITIONS = ['UTG','HJ','CO','BTN','SB','BB'];

let buttonIndex = 3; // start with BTN at seat 3 (arbitrary fixed hero seat at index 0)
let heroSeatIndex = 0; // hero is seat 0
let tableSeats = 6;

export function initPositions({ tableSize = 6 } = {}) {
  tableSeats = tableSize;
  buttonIndex = 3 % tableSeats;
}

export function nextHandRotateButton() {
  buttonIndex = (buttonIndex + 1) % tableSeats;
}

export function getHeroPosition() {
  // seat names relative to button: BTN, SB, BB, UTG, HJ, CO (6-max)
  // mapping seatOffset -> position
  const ring = ['BTN','SB','BB','UTG','HJ','CO']; // clockwise order from BTN
  // compute hero offset from button
  const offset = (heroSeatIndex - buttonIndex + tableSeats) % tableSeats;
  return ring[offset];
}

const POS_ONE_LINERS = {
  UTG: 'Under the Gun — worst position; you act first preflop.',
  HJ:  'Hijack — early/mid; tighten up vs strong opens.',
  CO:  'Cutoff — late; attack wide when folded to you.',
  BTN: 'Button — best position; widest opens, high info.',
  SB:  'Small Blind — out of position postflop; open tight.',
  BB:  'Big Blind — closes preflop; defend wide vs small opens.'
};

export function positionOneLiner(pos) {
  return POS_ONE_LINERS[pos] || pos;
}

// UI: render a white disc next to #holeCards
export function mountPositionDisc() {
  const host = document.getElementById('holeCards');
  if (!host) return;

  let disc = document.getElementById('posDisc');
  if (!disc) {
    disc = document.createElement('button');
    disc.id = 'posDisc';
    disc.className = 'pos-disc';
    disc.type = 'button';
    disc.title = 'Position';
    disc.addEventListener('click', () => {
      const pos = getHeroPosition();
      publish('ui:popover', {
        targetEl: disc,
        title: pos,
        body: positionOneLiner(pos)
      });
    });
    host.parentElement?.appendChild(disc);
  }

  // initial render
  updatePositionDisc();
}

export function updatePositionDisc() {
  const disc = document.getElementById('posDisc');
  if (!disc) return;
  disc.textContent = getHeroPosition();
}