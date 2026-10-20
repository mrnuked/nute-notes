// Resolve the note at the moment of use; never retain private vault data here.
export function createNoteMenu(menu, { getNote, onAction, beforeOpen = () => {}, isUnlocked = () => false }) {
  const doc = menu.ownerDocument, win = doc.defaultView;
  const pin = menu.querySelector('[data-action="pin"]'), restore = menu.querySelector('[data-action="restore"]'), remove = menu.querySelector('[data-action="delete"]');
  const protect = menu.querySelector('[data-action="protect"]'), unprotect = menu.querySelector('[data-action="unprotect"]');
  let targetId = null, anchor = null, holdTimer = null;
  const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.hidden);
  function cancelHold() { win.clearTimeout(holdTimer); holdTimer = null; }
  function close(returnFocus = false) {
    cancelHold(); const previous = anchor;
    previous?.classList.remove('context-target'); previous?.setAttribute('aria-expanded', 'false');
    menu.hidden = true; targetId = null; anchor = null;
    if (returnFocus && previous?.isConnected) previous.focus({ preventScroll: true });
  }
  function open(id, card, x, y) {
    close(); const note = getNote(id);
    if (!note || !card.isConnected) return;
    beforeOpen(); targetId = id; anchor = card;
    card.classList.add('context-target'); card.setAttribute('aria-expanded', 'true');
    pin.hidden = note.deleted !== null; restore.hidden = note.deleted === null;
    protect.hidden = note.deleted !== null && !note.pin; unprotect.hidden = note.deleted !== null || !note.pin;
    protect.querySelector('span').textContent = !note.pin ? 'Установить PIN-код' : isUnlocked(note) ? 'Закрыть заметку' : 'Открыть заметку';
    pin.querySelector('span').textContent = note.pinned ? 'Открепить заметку' : 'Прикрепить заметку';
    pin.querySelector('i').className = `ph ph-${note.pinned ? 'push-pin-slash' : 'push-pin'}`;
    remove.querySelector('span').textContent = note.deleted === null ? 'Удалить' : 'Удалить навсегда';
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect(), edge = 8;
    menu.style.left = `${Math.max(edge, Math.min(x, win.innerWidth - bounds.width - edge))}px`;
    menu.style.top = `${Math.max(edge, Math.min(y, win.innerHeight - bounds.height - edge))}px`;
    items()[0]?.focus({ preventScroll: true });
  }
  function bind(card, id) {
    card.dataset.noteId = id;
    card.setAttribute('aria-haspopup', 'menu'); card.setAttribute('aria-controls', menu.id); card.setAttribute('aria-expanded', 'false');
    card.addEventListener('contextmenu', event => {
      if (!getNote(id)) return;
      event.preventDefault(); const rect = card.getBoundingClientRect();
      open(id, card, event.clientX || rect.left + 24, event.clientY || rect.top + 24);
    });
    card.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); const rect = card.getBoundingClientRect(); open(id, card, rect.left + 24, rect.top + 24);
    });
    let startX = 0, startY = 0, suppressClick = false;
    card.addEventListener('pointerdown', event => {
      cancelHold(); suppressClick = false;
      if (event.pointerType !== 'touch' || !event.isPrimary) return;
      startX = event.clientX; startY = event.clientY;
      holdTimer = win.setTimeout(() => { suppressClick = true; open(id, card, startX, startY); }, 550);
    });
    card.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancelHold(); });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) card.addEventListener(event, cancelHold);
    card.addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  }
  menu.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !menu.contains(button)) return;
    const id = targetId, note = getNote(id), action = button.dataset.action;
    close(true);
    if (!note || (['pin','unprotect'].includes(action) && note.deleted !== null) || (action === 'protect' && note.deleted !== null && !note.pin) || (action === 'unprotect' && !note.pin) || (action === 'restore' && note.deleted === null)) return;
    const result = onAction(action, id);
    const restoreFocus = () => {
      if (!menu.hidden || doc.activeElement !== doc.body || !getNote(id)) return;
      [...doc.querySelectorAll('.note-card')].find(card => card.dataset.noteId === id)?.focus({ preventScroll: true });
    };
    if (result?.then) result.then(restoreFocus); else restoreFocus();
  });
  menu.addEventListener('keydown', event => {
    const buttons = items(), index = buttons.indexOf(doc.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  doc.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) close(); }, true);
  doc.addEventListener('focusin', event => { if (!menu.hidden && !menu.contains(event.target)) close(); });
  doc.addEventListener('keydown', event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Tab') close(true);
  });
  doc.addEventListener('scroll', event => { if (!menu.contains(event.target)) close(); }, true);
  win.addEventListener('resize', () => close()); win.addEventListener('blur', () => close());
  return { bind, close };
}
