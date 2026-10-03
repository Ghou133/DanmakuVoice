// The native host supplies the saved preference before HTML parsing starts.
// Apply it ahead of the stylesheet so even the loading page uses the right theme.
const startupTheme = window.__DANMAKUVOICE_STARTUP_THEME__;
let appearance = startupTheme?.appearance;
let language = startupTheme?.language === 'en' ? 'en' : 'zh-CN';
try {
  const cached = JSON.parse(window.sessionStorage?.getItem('danmakuvoice.startupTheme') || 'null');
  if (cached?.session === startupTheme?.session && ['dark', 'light', 'system'].includes(cached.appearance)) {
    appearance = cached.appearance;
    if (['zh-CN', 'en'].includes(cached.language)) language = cached.language;
  }
} catch { /* Browser storage may be unavailable during recovery. */ }
const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = appearance === 'dark' || (appearance !== 'light' && systemDark) ? 'dark' : 'light';
document.documentElement.lang = language;
document.title = language === 'en' ? 'DanmakuVoice' : '超绝可爱弹幕姬';
document.addEventListener?.('DOMContentLoaded', () => {
  const title = document.querySelector('[data-boot-title]');
  const message = document.querySelector('[data-boot-message]');
  if (title) title.textContent = document.title;
  if (message) message.textContent = language === 'en' ? 'Preparing your live room…' : '正在准备直播间…';
}, { once: true });
