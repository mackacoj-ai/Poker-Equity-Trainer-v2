// Render cards utility

export function renderCardRow(el, cards) {
  el.innerHTML = '';
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'card';
    if (c.suit === '\u2665' || c.suit === '\u2666') div.classList.add('red');
    const rTop = document.createElement('div'); rTop.className = 'rank'; rTop.textContent = c.rank;
    const sMid = document.createElement('div'); sMid.className = 'suit'; sMid.textContent = c.suit;
    const rBot = document.createElement('div'); rBot.className = 'rank'; rBot.textContent = c.rank;
    div.append(rTop, sMid, rBot);
    el.appendChild(div);
  }
}
