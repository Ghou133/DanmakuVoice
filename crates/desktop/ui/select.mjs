import { t, ui } from './i18n.mjs';
// Keep native form values/validation, but render one themed menu only while open.
let sequence = 0;
let opened = null;
const controls = new WeakMap();

export function closeSelect() {
  if (!opened) return;
  const { trigger, menu, listeners } = opened;
  opened = null;
  listeners.abort();
  trigger.setAttribute('aria-expanded', 'false');
  trigger.removeAttribute('aria-activedescendant');
  trigger.removeAttribute('aria-controls');
  menu.remove();
}

export function stripSelects(root) {
  for (const wrapper of root.querySelectorAll('.select-control')) {
    const select = wrapper.querySelector('select');
    select.classList.remove('select-native');
    select.removeAttribute('tabindex');
    select.removeAttribute('aria-hidden');
    wrapper.replaceWith(select);
  }
}

export function mountSelects(root) {
  for (const select of root.querySelectorAll('select')) {
    if (controls.has(select)) { controls.get(select).sync(); continue; }
    const wrapper = document.createElement('div');
    wrapper.className = 'select-control';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.id = `select-trigger-${++sequence}`;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || [...select.labels].map(label => label.textContent.trim()).join(' ') || t('选择'));
    select.before(wrapper);
    wrapper.append(select, trigger);
    select.classList.add('select-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const sync = () => {
      trigger.textContent = select.selectedOptions[0]?.label || t('请选择');
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-required', String(select.required));
    };
    controls.set(select, { sync });
    sync();
    select.addEventListener('change', () => { sync(); queueMicrotask(sync); });
    select.addEventListener('invalid', event => { event.preventDefault(); trigger.focus(); trigger.setAttribute('aria-invalid', 'true'); });
    select.addEventListener('focus', () => trigger.focus());
    select.addEventListener('click', event => { event.preventDefault(); trigger.focus(); if (!select.disabled) open(); });
    const open = () => {
      if (select.disabled) return;
      closeSelect();
      const menu = document.createElement('div');
      menu.className = 'select-menu';
      menu.id = `select-menu-${sequence++}`;
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));
      menu.setAttribute('popover', 'manual');
      const listeners = new AbortController();
      const signal = listeners.signal;
      let active = select.selectedIndex;
      let search = '', typedAt = 0;
      const rows = [...select.options].map((option, index) => {
        const row = document.createElement('div');
        row.className = 'select-option';
        row.id = `${menu.id}-${index}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.selected));
        row.setAttribute('aria-disabled', String(option.disabled));
        row.textContent = option.label;
        row.hidden = option.hidden;
        menu.append(row);
        row.addEventListener('pointermove', () => { if (!option.disabled) highlight(index, false); });
        row.addEventListener('pointerdown', event => event.preventDefault());
        row.addEventListener('click', () => choose(index));
        return row;
      });
      const available = [...select.options].map((option, index) => !option.disabled && !option.hidden ? index : -1).filter(index => index >= 0);
      const highlight = (index, scroll = true) => {
        rows[active]?.classList.remove('active');
        active = index;
        rows[active]?.classList.add('active');
        if (rows[active]) trigger.setAttribute('aria-activedescendant', rows[active].id);
        if (scroll) rows[active]?.scrollIntoView({ block: 'nearest' });
      };
      const choose = index => {
        if (!available.includes(index)) return;
        const changed = select.selectedIndex !== index;
        select.selectedIndex = index;
        closeSelect();
        sync();
        trigger.removeAttribute('aria-invalid');
        trigger.focus({ preventScroll: true });
        // Re-selecting a category must also return to its overview.
        if (changed || select.id === 'settings-category') {
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      (select.closest('dialog') || document.body).append(menu);
      menu.showPopover();
      const bounds = trigger.getBoundingClientRect();
      menu.style.width = `${Math.min(Math.max(bounds.width, 180), innerWidth - 24)}px`;
      const below = innerHeight - bounds.bottom - 18;
      const above = bounds.top - 18;
      const down = below >= Math.min(menu.scrollHeight + 2, 280) || below >= above;
      menu.style.maxHeight = `${Math.max(40, Math.min(280, down ? below : above))}px`;
      menu.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - menu.offsetWidth - 12))}px`;
      menu.style.top = `${down ? bounds.bottom + 6 : Math.max(12, bounds.top - menu.offsetHeight - 6)}px`;
      opened = { trigger, menu, listeners };
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', menu.id);
      highlight(available.includes(active) ? active : available[0] ?? -1);
      trigger.addEventListener('keydown', event => {
        if (['Escape', 'Tab'].includes(event.key)) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
          closeSelect(); return;
        }
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); choose(active); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
          event.preventDefault();
          const position = available.indexOf(active);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : position + ({ ArrowDown: 1, ArrowUp: -1, PageDown: 6, PageUp: -6 }[event.key]);
          highlight(available[Math.max(0, Math.min(available.length - 1, next))] ?? -1);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          search = Date.now() - typedAt > 700 ? event.key : search + event.key;
          typedAt = Date.now();
          const match = available.find(index => select.options[index].label.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
          if (match !== undefined) highlight(match);
        }
      }, { signal });
      document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !trigger.contains(event.target)) closeSelect(); }, { capture: true, signal });
      document.addEventListener('scroll', event => { if (event.target !== menu && !menu.contains(event.target)) closeSelect(); }, { capture: true, signal });
      window.addEventListener('resize', closeSelect, { signal });
      window.addEventListener('blur', closeSelect, { signal });
    };
    trigger.addEventListener('click', event => {
      event.preventDefault();
      if (opened?.trigger === trigger) closeSelect(); else open();
    });
    trigger.addEventListener('keydown', event => {
      if (!opened && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); open();
      }
    });
  }
}
