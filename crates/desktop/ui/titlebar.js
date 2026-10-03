// Window controls live outside the app module so the window can still be moved,
// minimized and closed even if the page script fails to load.
document.addEventListener('click', event => {
  const control = event.target.closest?.('[data-window]');
  if (!control) return;
  const current = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!current) return;
  const kind = control.dataset.window;
  // Closing goes through the native close request, which runs the normal exit flow.
  if (kind === 'minimize') void current.minimize();
  else if (kind === 'maximize') void current.toggleMaximize();
  else if (kind === 'close') void current.close();
});
