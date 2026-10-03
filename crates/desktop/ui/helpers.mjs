import { t, ui, getLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
// These helpers have no desktop or DOM dependency; network data is always text.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function initial(name) {
  return Array.from(String(name || t('访客')).trim())[0] || t('访');
}

export function headerIdentity(snapshot) {
  const account = snapshot?.account;
  const loggedIn = !!account?.user_id;
  return {
    loggedIn,
    name: loggedIn ? String(account.name || t('哔哩哔哩用户')) : t('超绝可爱弹幕姬'),
    avatar: loggedIn && !snapshot.network_disabled ? safeMediaUrl(account.avatar_url) : '',
  };
}

export function identityColor(name) {
  let hash = 0;
  for (const point of String(name || '')) hash = ((hash * 31) + point.codePointAt(0)) >>> 0;
  return hash % 7;
}

export function eventText(event) {
  if (event.kind === 'gift') return ui`送出 ${event.gift_name || t('礼物')}${event.quantity > 1 ? ` × ${event.quantity}` : ''}`;
  if (event.kind === 'guard') return ui`开通了${event.guard_name || t('大航海')}`;
  return String(event.message ?? '');
}

export function safeMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.protocol !== 'https:' || !/^i\d+\.hdslb\.com$/i.test(url.hostname) || url.port || url.username || url.password) return '';
    if (!url.pathname.startsWith('/bfs/') || /\.svg(?:$|@)/i.test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}

export function messageParts(event) {
  const content = eventText(event);
  const emotes = (Array.isArray(event.emotes) ? event.emotes : []).slice(0, 32)
    .map(item => ({ text: String(item?.text || ''), url: safeMediaUrl(item?.url), large: item?.large === true }))
    .filter(item => item.text && item.url);
  if (!emotes.length) return [{ type: 'text', text: content }];
  const parts = [];
  let cursor = 0;
  while (cursor < content.length) {
    let earliest = content.length;
    let chosen = null;
    for (const emote of emotes) {
      const at = content.indexOf(emote.text, cursor);
      if (at >= 0 && (at < earliest || (at === earliest && emote.text.length > chosen.text.length))) {
        earliest = at;
        chosen = emote;
      }
    }
    if (!chosen) { parts.push({ type: 'text', text: content.slice(cursor) }); break; }
    if (earliest > cursor) parts.push({ type: 'text', text: content.slice(cursor, earliest) });
    parts.push({ type: 'emote', text: chosen.text, url: chosen.url, ...(chosen.large ? { large: true } : {}) });
    cursor = earliest + chosen.text.length;
  }
  return parts;
}

export function playbackCaption(queue = {}) {
  if (queue.current) return queue.current.text || t('正在播报');
  return queue.pending?.length ? ui`等待播报 · ${queue.pending.length} 条` : t('等待下一句');
}

export function playbackFallbackNotice(record) {
  if (record?.state !== 'played' || typeof record.detail !== 'string') return '';
  const match = /^指定的 (dots\.tts|GPT-SoVITS|Fish Audio|豆包) (不可用|合成失败)（([^（）；]{1,40})），本条临时使用默认 (dots\.tts|GPT-SoVITS|Fish Audio|豆包)；播报完成$/.exec(record.detail);
  if (!match) return '';
  if (getLanguage() === 'en') {
    const reason = match[2] === '不可用' ? localizeDiagnostic(match[3]) : `synthesis failed (${localizeDiagnostic(match[3])})`;
    return `${localizeDiagnostic(match[1])} ${reason}, played using preferred ${localizeDiagnostic(match[4])}`;
  }
  const reason = match[2] === '不可用' ? match[3] : ui`${match[2]}（${match[3]}）`;
  return ui`${match[1]} ${reason}，已用首选 ${match[4]} 播报`;
}

export function eventKey(event) {
  if (event.platform_event_id) return JSON.stringify([event.room_id, event.platform_event_id]);
  return JSON.stringify([event.room_id, event.observed_at_ms, event.kind, event.user_id, event.user_name, event.message, event.gift_name, event.quantity, event.price_yuan, event.guard_name]);
}

export function eventKeys(events) {
  const counts = new Map();
  return events.map(event => {
    const key = eventKey(event);
    const count = counts.get(key) || 0;
    counts.set(key, count + 1);
    return `${key}:${count}`;
  });
}

export function liveConnectionView(live = {}) {
  const running = !!live.running;
  if (live.state === 'session_expired') return { online: false, pending: false, caption: t('登录已失效'), emptyTitle: t('账号登录已失效'), emptyDescription: t('请重新扫码登录，连接后继续接收弹幕。') };
  const reconnecting = running && live.state === 'reconnecting';
  const connecting = !!live.connecting || (running && live.state === 'connecting');
  const online = running && live.state === 'connected';
  if (reconnecting) return { online, pending: true, caption: t('连接中断，正在重连'), emptyTitle: t('正在重新连接直播间…'), emptyDescription: t('连接恢复后，新消息会自动显示。') };
  if (connecting) return { online, pending: true, caption: t('正在连接'), emptyTitle: t('正在连接直播间…'), emptyDescription: t('连接成功后，新消息会自动显示。') };
  if (online) return { online, pending: false, caption: t('正在接收'), emptyTitle: t('等待新弹幕'), emptyDescription: t('直播间的新消息会实时出现在这里。') };
  return { online, pending: false, caption: t('未连接'), emptyTitle: t('尚未连接直播间'), emptyDescription: t('连接后，这里会显示收到的弹幕。') };
}

export function validUid(value) {
  const text = String(value ?? '').trim();
  return /^[1-9]\d{0,19}$/.test(text) && BigInt(text) <= 18446744073709551615n;
}

export function numericId(value) {
  if (!validUid(value) || !Number.isSafeInteger(Number(value))) throw new Error(t('此 UID 超过界面支持的精确整数范围，请检查输入。'));
  return Number(value);
}

export function errorMessage(error, fallback = 'DV-UI01') {
  const message = String(error?.message || error || t('操作没有完成，请重试。'));
  const codes = [...new Set(message.match(/\[DV-[A-Z0-9-]{2,21}\]/g) || [])];
  const prose = message.replace(/[ \t]*\[DV-[A-Z0-9-]{2,21}\]/g, '').trim();
  return `${localizeDiagnostic(prose)} ${codes.length ? codes.join(' ') : `[${fallback}]`}`;
}

export function playbackIssue(queue) {
  const last = (queue?.history || []).at(-1);
  if (last?.state !== 'failed') return '';
  // The engine supplies sanitized diagnostics, never remote bodies or credentials.
  const detail = typeof last.detail === 'string' ? last.detail.trim() : '';
  return errorMessage(detail ? ui`播报未能播放：${detail}` : t('有一条播报未能播放，请检查声音服务和输出设备。'), 'DV-Q01');
}

export function runtimeIssue(snapshot) {
  if (snapshot.live?.state === 'session_expired') return t('哔哩哔哩登录已失效，请重新扫码。 [DV-B09]');
  if (snapshot.status?.error) return errorMessage(typeof snapshot.status.error === 'string' ? snapshot.status.error : snapshot.status.message || t('连接或播放遇到问题，请查看设置。'), 'DV-X00');
  const playback = playbackIssue(snapshot.queue);
  if (playback) return playback;
  if (snapshot.live?.running && Number(snapshot.live.errors) > 0) return t('本次会话有接收或播报错误，请检查直播间和声音设置。 [DV-V05]');
  if (snapshot.live?.running && snapshot.live.no_voice > 0 && snapshot.setup?.tts_enabled) return t('有弹幕未能播报，请检查默认声音、用户绑定或关键词音效。 [DV-P02]');
  return '';
}

export function snapshotPollingPolicy(snapshot, { step = 'main', hidden = false, focused = true, busy = false, settingsOpen = false } = {}) {
  const startingLocalService = Object.values(snapshot?.local_services || {}).some(service => ['checking', 'starting'].includes(service?.state));
  const active = !!(snapshot?.live?.running || snapshot?.live?.connecting || snapshot?.queue?.current || snapshot?.queue?.pending?.length || startingLocalService);
  return { poll: !hidden && focused && !busy && (step === 'main' || settingsOpen || active), delay: hidden || !focused || !active ? 5000 : 800 };
}

export function mergeSnapshot(previous, next) {
  if (!next || typeof next !== 'object') throw new Error(t('桌面没有返回有效状态，请重新打开程序。'));
  // A poll started before an edit can arrive after that edit's command reply.
  // Keep the newer configuration and runtime together until the next poll.
  if (Number.isSafeInteger(previous?.config_revision) && Number.isSafeInteger(next.config_revision)
      && next.config_revision < previous.config_revision) return { ...previous, result: undefined };
  if (!next.config_unchanged) return next;
  if (!previous || previous.config_revision !== next.config_revision) throw new Error(t('配置状态已变化，请重试。'));
  return { ...previous, ...next, result: undefined };
}

export function uiIsActive(nativeActive, browserFocused, hidden) {
  return !hidden && (typeof nativeActive === 'boolean' ? nativeActive : browserFocused);
}

export function safeQrUrl(value) {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value) ? value : '';
}

export function startingStep(snapshot) {
  if (snapshot.onboarding_done) return 'main';
  if (snapshot.setup?.room_id) return snapshot.setup.tts_enabled && snapshot.presets?.some(p => p.id === snapshot.rules?.default_preset_id) ? 'ready' : 'tts';
  return 'welcome';
}

export function providerLabel(provider) {
  return ({ doubao: t('豆包'), fish_audio: 'Fish Audio', dots: 'dots.tts', gpt_sovits: 'GPT-SoVITS' })[provider] || provider || t('未知服务');
}

export function deviceValue(output) {
  return output && typeof output === 'object' ? output.named || '' : '';
}

export function normalizedEvents(snapshot) {
  return (Array.isArray(snapshot.live?.events) ? snapshot.live.events : []).map(item => item.event || item).filter(item => item && typeof item === 'object');
}

export function qrLabel(qr = {}) {
  return ({ idle: t('正在生成二维码'), waiting: t('等待扫码'), scanned: t('已扫码，请在手机上确认'), complete: t('已连接'), expired: t('二维码已过期') })[qr.status] || localizeDiagnostic(qr.message) || t('等待连接');
}

export function qrNeedsRoomFallback(snapshot) {
  return snapshot?.qr?.provider === 'bilibili' && snapshot.qr.status === 'expired'
    && !!snapshot.account?.user_id && !snapshot.setup?.room_id;
}
