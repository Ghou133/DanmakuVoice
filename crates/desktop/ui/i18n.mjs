import { english } from './i18n-en.mjs';

let language = 'zh-CN';
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = new RegExp(Object.keys(english).sort((a, b) => b.length - a.length).map(escapePattern).join('|'), 'gu');

export function normalizeLanguage(value) { return value === 'en' ? 'en' : 'zh-CN'; }
export function getLanguage() { return language; }
export function setLanguage(value) {
  const next = normalizeLanguage(value);
  const changed = next !== language;
  language = next;
  return changed;
}

// Use only for application-owned static copy, never usernames, paths, chat,
// editable speech templates, voice names, or arbitrary interpolated values.
export function t(source) {
  if (language !== 'en') return source;
  return english[source] ?? String(source).replace(phrases, phrase => english[phrase]);
}

// Translate static parts independently; interpolated data is preserved verbatim.
export function ui(strings, ...values) {
  return strings.reduce((result, part, index) => result + t(part) + (index < values.length ? values[index] : ''), '');
}
