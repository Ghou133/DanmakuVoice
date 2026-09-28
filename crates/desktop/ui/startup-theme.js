// The native host supplies the saved preference before HTML parsing starts.
// Apply it ahead of the stylesheet so even the loading page uses the right theme.
const startupTheme = window.__DANMAKUVOICE_STARTUP_THEME__;
let appearance = startupTheme?.appearance;
try {
  const cached = JSON.parse(window.sessionStorage?.getItem('danmakuvoice.startupTheme') || 'null');
  if (cached?.session === startupTheme?.session && ['dark', 'light', 'system'].includes(cached.appearance)) {
    appearance = cached.appearance;
  }
} catch { /* Browser storage may be unavailable during recovery. */ }
const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = appearance === 'dark' || (appearance !== 'light' && systemDark) ? 'dark' : 'light';
