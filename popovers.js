// Minimal popover utility (positioned under target)

let current;

export function showPopover({ targetEl, title, body }) {
  hidePopover();

  const rect = targetEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'mini-popover';
  pop.innerHTML = `
    <div class="mini-popover__title">${title ?? ''}</div>
    <div class="mini-popover__body">${body ?? ''}</div>
  `;
  document.body.appendChild(pop);

  const top = rect.bottom + window.scrollY + 6;
  const left = rect.left + window.scrollX;
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  current = pop;

  function onDoc(e){
    if (!pop.contains(e.target) && e.target !== targetEl) hidePopover();
  }
  setTimeout(()=>document.addEventListener('mousedown', onDoc, { once: true }), 0);
}

export function hidePopover() {
  if (current) {
    current.remove();
    current = null;
  }
}