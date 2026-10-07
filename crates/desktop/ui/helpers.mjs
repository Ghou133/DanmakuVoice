import { t, ui, getLanguage } from './i18n.mjs';
import { localizeDiagnostic } from './i18n-diagnostics.mjs';
// These helpers have no desktop or DOM dependency; network data is always text.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// Room reception and broadcasting are separate states. Match self by UID only;
// empty/partial lists and matching names do not prove the counter includes us.
function isAudienceSelf(snapshot, user) {
  return !user.mystery && validUid(snapshot?.account?.user_id) && validUid(user.user_id)
    && String(user.user_id) === String(snapshot.account.user_id);
}

export function audienceDisplayCount(snapshot) {
  const audience = snapshot?.live?.audience;
  if (!audience?.active || !snapshot.live.running || snapshot.network_disabled || audience.error) return null;
  if (audience.live_status === 0 || audience.live_status === 2) return '0';
  if (audience.live_status !== 1 || audience.rank_count_text == null) return null;
  const source = String(audience.rank_count_text);
  if (!(audience.users || []).some(user => isAudienceSelf(snapshot, user))) return source;
  const match = /^(\d+)(\+?)$/.exec(source);
  if (!match) return null;
  const count = BigInt(match[1]);
  // Capped text stays a bound; it never becomes an invented exact total.
  return `${count > 0n ? count - 1n : 0n}${match[2]}`;
}

export function audienceUsers(snapshot, query = '') {
  const active = snapshot?.live?.audience?.active && snapshot?.live?.running && snapshot.live.audience.live_status === 1;
  const users = active ? (snapshot.live.audience.users || []).filter(user => !isAudienceSelf(snapshot, user)) : [];
  const needle = String(query).trim().toLocaleLowerCase();
  return needle ? users.filter(user => String(user.user_name || '').toLocaleLowerCase().includes(needle) || (!user.mystery && String(user.user_id || '').includes(needle))) : users;
}

export function initial(name) {
  return Array.from(String(name || t('访客')).trim())[0] || t('访');
}

export function headerIdentity(snapshot) {
  const account = snapshot?.account;
  const loggedIn = validUid(account?.user_id);
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

// A synchronous SHA-256 lets the first restored paint decide whether to animate.
// Only its digests reach sessionStorage; fallback event keys can contain text.
function presentationDigest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const constants = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const rotate = (word, amount) => (word >>> amount) | (word << (32 - amount));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15], right = words[index - 2];
      words[index] = words[index - 16] + (rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3)) + words[index - 7] + (rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[index] + words[index]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => { state[index] = (state[index] + word) >>> 0; });
  }
  return state.map(word => word.toString(16).padStart(8, '0')).join('');
}

// Window-session recovery state is deliberately separate from the chat buffer.
// Keep the latest 512 displayed identities in each of at most eight account/room
// scopes. A native app restart starts a fresh session; reconnecting does not.
export function createLakePresentationLedger(storage, nativeSession = '') {
  const storageKey = 'danmakuvoice.lakePresented';
  const session = presentationDigest(nativeSession);
  const contexts = new Map();
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  try {
    const raw = storage?.getItem(storageKey);
    const saved = raw && raw.length <= 300000 ? JSON.parse(raw) : null;
    if (saved?.version === 1 && saved.session === session && Array.isArray(saved.contexts)) {
      for (const item of saved.contexts.slice(-8)) {
        if (!Array.isArray(item) || !digest(item[0]) || !Array.isArray(item[1])) continue;
        contexts.set(item[0], new Set(item[1].filter(digest).slice(-512)));
      }
    }
  } catch { /* Optional recovery storage may be denied or damaged. */ }
  return {
    has(context, key) { return contexts.get(presentationDigest(context))?.has(presentationDigest(key)) || false; },
    mark(context, keys) {
      const scope = presentationDigest(context);
      const seen = contexts.get(scope) || new Set();
      let changed = !contexts.has(scope);
      for (const key of keys) {
        const id = presentationDigest(key);
        if (seen.has(id)) continue;
        seen.add(id); changed = true;
        if (seen.size > 512) seen.delete(seen.values().next().value);
      }
      if (!changed) return;
      contexts.delete(scope); contexts.set(scope, seen);
      if (contexts.size > 8) contexts.delete(contexts.keys().next().value);
      try { storage?.setItem(storageKey, JSON.stringify({ version: 1, session, contexts: [...contexts].map(([id, values]) => [id, [...values]]) })); }
      catch { /* The in-memory state still prevents full-render replay. */ }
    },
  };
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
  if (snapshot.live?.running && snapshot.received_emotes_error) return ui`个人表情信息读取失败：${snapshot.received_emotes_error}；请打开表情面板重试。`;
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
  const roomReady = validUid(snapshot?.setup?.room_id);
  // Explicit offline windows exercise local setup without opening a real
  // account or live connection. Saved anonymous profiles in real windows
  // must return through login and authenticated own-room resolution.
  if (!snapshot?.network_disabled) {
    const loggedIn = validUid(snapshot?.account?.user_id);
    const legacyTarget = snapshot?.setup?.mode === 'anonymous'
      || (validUid(snapshot?.setup?.uid) && String(snapshot.setup.uid) !== String(snapshot.account?.user_id));
    if (legacyTarget || !loggedIn) return snapshot?.onboarding_done || roomReady || legacyTarget ? 'login' : 'welcome';
    if (!roomReady) return 'login';
  }
  if (snapshot?.onboarding_done) return 'main';
  if (roomReady) return snapshot.setup.tts_enabled && snapshot.presets?.some(p => p.id === snapshot.rules?.default_preset_id) ? 'ready' : 'tts';
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

// The Rust store owns session history. A missing or invalid summary contributes
// no display rows; the view must not invent an empty session or a duration.
export function broadcastSessionSummary(broadcast) {
  const item = broadcast?.last_session;
  if (!item || !Number.isSafeInteger(item.messages) || item.messages < 0
    || !Number.isSafeInteger(item.ended_observed_at) || item.ended_observed_at <= 0
    || (item.seconds != null && (!Number.isSafeInteger(item.seconds) || item.seconds < 0))) return null;
  return { messages: item.messages, seconds: item.seconds ?? null, endedAt: item.ended_observed_at };
}

export function qrLabel(qr = {}) {
  return ({ idle: t('正在生成二维码'), waiting: t('等待扫码'), scanned: t('已扫码，请在手机上确认'), complete: t('已连接'), expired: t('二维码已过期') })[qr.status] || localizeDiagnostic(qr.message) || t('等待连接');
}

export function qrNeedsRoomFallback(snapshot) {
  return snapshot?.qr?.provider === 'bilibili' && snapshot.qr.status === 'expired'
    && validUid(snapshot.account?.user_id) && !validUid(snapshot.setup?.room_id);
}
