// Small custom component kit: nothing here uses a native form control or browser dialog.
const layer = () => document.getElementById('layer');

export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}

const CHECK = '<svg viewBox="0 0 12 12"><path d="M2 6.5l2.6 2.6L10 3.5"/></svg>';

export function checkbox(checked, onChange, label) {
  const b = h('button', { class: 'chk', type: 'button', role: 'checkbox', 'aria-checked': String(!!checked), 'aria-label': label || 'Toggle' });
  b.innerHTML = CHECK;
  b.addEventListener('click', (e) => { e.stopPropagation(); const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  return b;
}

/** Custom dropdown; `items` is [{value,label}]. */
export function dropdown(items, value, onChange) {
  const cur = () => items.find((i) => i.value === value) || items[0];
  const btn = h('button', { class: 'dd-btn', type: 'button', 'aria-haspopup': 'listbox', text: cur().label });
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    menu(items.map((i) => ({ label: i.label, hint: i.value === value ? '✓' : '', run: () => { value = i.value; btn.textContent = cur().label; onChange(value); } })), r.left, r.bottom + 4, r.width);
  });
  return h('div', { class: 'dd' }, btn);
}

let openMenu = null;
/** Closes the open menu, if any. Returns whether one was open. */
export function closeMenu() { if (!openMenu) return false; openMenu.remove(); openMenu = null; return true; }

/** Context/dropdown menu. items: {label, hint, run, disabled} or '-' for a separator. */
export function menu(items, x, y, minWidth) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  if (minWidth) m.style.minWidth = minWidth + 'px';
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    m.append(h('button', { type: 'button', role: 'menuitem', disabled: it.disabled, onClick: () => { closeMenu(); it.run && it.run(); } }, h('span', { text: it.label }), it.hint && h('kbd', { text: it.hint })));
  }
  layer().append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = m;
  return m;
}
addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
addEventListener('blur', closeMenu);

let toasts;
export function toast(text, kind = '') {
  if (!toasts || !toasts.isConnected) { toasts = h('div', { class: 'toasts' }); layer().append(toasts); }
  toasts.replaceChildren(); // one at a time, shown over the status bar so it never covers a control
  const t = h('div', { class: 'toast ' + kind, text });
  toasts.append(t);
  setTimeout(() => t.remove(), 3200);
}

/** Promise-based modal replacing alert/confirm/prompt. Resolves with the button id (or text for prompts). */
function restoreFocus(el) { if (el && el.isConnected) el.focus(); } // closing a dialog hands the keyboard back
export function modal({ title, body, buttons = [{ id: 'ok', label: 'OK', primary: true }], input, focus = 'confirm' }) {
  if (layer().querySelector('.scrim')) return Promise.resolve(null); // one dialog at a time
  const prev = document.activeElement;
  return new Promise((resolve) => {
    const field = input ? h('input', { class: 'input mono selectable', type: 'text', value: input.value || '', placeholder: input.placeholder || '', autocomplete: 'off', spellcheck: 'false' }) : null;
    const scrim = h('div', { class: 'scrim center' });
    const done = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); restoreFocus(prev); resolve(v); };
    const actions = h('div', { class: 'mactions' }, buttons.map((b) => h('button', { class: 'btn ' + (b.danger ? 'danger' : b.primary ? 'primary' : ''), type: 'button', text: b.label, onClick: () => done(field && b.primary ? field.value : b.id) })));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(buttons.find((b) => b.cancel)?.id ?? null); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.stopPropagation(); const p = buttons.find((b) => b.primary || b.danger); if (p) done(field ? field.value : p.id); }
    };
    document.addEventListener('keydown', onKey, true);
    const x = h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onClick: () => done(buttons.find((b) => b.cancel)?.id ?? null) });
    x.innerHTML = '<svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" fill="none"/></svg>';
    scrim.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, x, h('h3', { text: title }), typeof body === 'string' ? h('p', { text: body }) : body, field, actions));
    layer().append(scrim);
    // Dangerous actions put the focus on Cancel so a stray Enter cannot confirm them.
    (field || (focus === 'cancel' ? actions.firstElementChild : actions.querySelector('.primary, .danger')) || actions.lastElementChild)?.focus();
  });
}
export const confirmBox = (title, body, yes = 'OK', danger = false, focusCancel = false) =>
  modal({ title, body, focus: focusCancel ? 'cancel' : 'confirm', buttons: [{ id: 'no', label: 'Cancel', cancel: true }, { id: 'yes', label: yes, primary: !danger, danger }] }).then((v) => v === 'yes');

/** Custom radio group (no native radio inputs). items: [{value,label}]. */
export function radios(items, value, onChange) {
  const wrap = h('div', { class: 'radios', role: 'radiogroup' });
  const pick = (v) => { if (v === value) return; value = v; draw(); onChange(v); wrap.querySelector('[aria-checked=true]')?.focus(); };
  function draw() {
    wrap.replaceChildren(...items.map((it, i) => {
      const b = h('button', { class: 'radio', type: 'button', role: 'radio', 'aria-checked': String(it.value === value), tabindex: it.value === value ? '0' : '-1', dataset: { v: it.value } }, h('i'), it.label);
      b.addEventListener('click', () => pick(it.value));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (d) { e.preventDefault(); pick(items[(i + d + items.length) % items.length].value); }
      });
      return b;
    }));
  }
  draw();
  return wrap;
}
