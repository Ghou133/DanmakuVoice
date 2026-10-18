// Builds an interactive preview of the OBS overlay from the real overlay.html.
// The overlay runs unchanged inside an iframe; only its EventSource is replaced
// by an in-page feed driven by scenario buttons. Fonts come from Google Fonts
// (Noto Serif SC is the source of the bundled DV Serif subset), and the resting
// delay is shortened so it can be watched. Nothing here ships in the product.
//
// Usage: node scripts/build-overlay-demo.cjs [output.html] [--overlay-html other.html]
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--overlay-html');
const source = sourceIndex >= 0 ? path.resolve(args.splice(sourceIndex, 2)[1]) : path.join(repo, 'crates/desktop/overlay/overlay.html');
const output = path.resolve(args[0] || path.join(repo, 'target/overlay-demo/overlay-demo.html'));
const DEMO_REST_MS = 10000;

let overlay = fs.readFileSync(source, 'utf8');
const replace = (pattern, value, label, optional = false) => {
  const next = overlay.replace(pattern, value);
  if (next === overlay && !optional) throw new Error(`overlay.html no longer matches: ${label}`);
  overlay = next;
};
replace(/@font-face\{[^}]*\}\n/g, '', 'bundled @font-face rules');
replace('<style>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Noto+Serif+SC:wght@500;700;900&display=swap">\n<style>', 'style tag');
replace('const token = new URLSearchParams(location.search).get("token") || "";', 'const token = "demo";', 'token source');
replace('const REST_MS = 45000;', `const REST_MS = ${DEMO_REST_MS};`, 'resting delay', true);
const feed = `<script>
// Demo feed: stands in for /overlay/events and relays frames from the page.
class DemoSource {
  constructor() { this.readyState = 0; this.listeners = {}; window.__source = this;
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); parent.postMessage({ demo: "ready" }, "*"); }, 30); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  close() { this.readyState = 2; }
  emit(name, data) { for (const fn of this.listeners[name] || []) fn({ data: JSON.stringify(data) }); }
}
DemoSource.CONNECTING = 0; DemoSource.OPEN = 1; DemoSource.CLOSED = 2;
window.EventSource = DemoSource;
addEventListener("message", e => { const m = e.data; if (m && m.demo === "emit" && window.__source && window.__source.readyState === 1) window.__source.emit(m.name, m.data); });
setInterval(() => { const ov = document.getElementById("ov"); if (!ov) return;
  parent.postMessage({ demo: "state", rows: document.querySelectorAll("#list .item:not(.out)").length, resting: ov.classList.contains("resting"), spot: !!document.querySelector("#list .item.spot"), reading: !!document.querySelector("#list .item.reading") }, "*"); }, 300);
</script>
`;
replace('<script>\n"use strict";', feed + '<script>\n"use strict";', 'overlay script');

const embedded = overlay.replace(/<\/script/gi, '<\\/script');
const page = fs.readFileSync(path.join(__dirname, 'overlay-demo.template.html'), 'utf8')
  .replaceAll('__REST_SECONDS__', String(DEMO_REST_MS / 1000))
  .replace('__OVERLAY_SOURCE__', () => embedded);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, page);
console.log(`wrote ${path.relative(repo, output)} (${(page.length / 1024).toFixed(1)} KiB)`);
